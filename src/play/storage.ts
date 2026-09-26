/** Station storage: custody that survives death, readable from anywhere, moved only when
 * docked. Never sells, never buys. */
import type {V2CargoItem,ViewStorageResponse} from '@spacemolt/lib';
import {disposable,miningInventory} from '../mining-inventory.ts';
import {details} from '../response-details.ts';
import {acct,checkStop,command,job,step,wanted} from './runtime.ts';
import type {Outcome,Row,Want} from './types.ts';

export interface Moved {
  base_id:string;
  /** What moved, measured from the hold before and after. */
  moved:Row[];
  /** What did not move, with the reason: `not held`, `not in store`, `no room`, or the game's
   * refusal. The first two mean the end state already holds, so they do not spoil the status. */
  short:{item_id:string;requested:number;moved:number;why:string}[];
  /** The hold and the store after the last move. */
  cargo:V2CargoItem[];
  store:ViewStorageResponse;
}

const ITEM_CAP=40;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** The store's reply, items capped: a menu fact, not a transcript. */
async function view(stationId?:string):Promise<ViewStorageResponse> {
  const reply=details(await command('spacemolt_storage/view',stationId?{station_id:stationId}:{})) as ViewStorageResponse;
  return {...reply,items:(reply.items??[]).slice(0,ITEM_CAP),locations:reply.locations??[],ships:reply.ships??[]};
}
const held=(rows:{item_id:string;quantity:number}[],item:string)=>rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);

/** The counter a deposit or withdraw needs: docked, at a base with `storage`. */
async function counter(fn:string):Promise<{docked:string}|{refused:string}> {
  const docked=acct().state.location?.docked_at;
  if(!docked)return {refused:`${fn} needs a docked ship: no station store is reachable from space`};
  const base=details(await command('spacemolt/get_base',{}));
  const services=(Array.isArray(base.services)?base.services:[]).map(String);
  if(!services.includes('storage'))return {refused:`${docked} has no storage counter`};
  return {docked};
}

/** One counter move (deposit or withdraw), row by row; the hold after each send is the
 * evidence, never the reply's claim. */
async function move(fn:'stow'|'withdraw',items:Want[]):Promise<Outcome<Moved>> {
  const action=fn==='stow'?'spacemolt_storage/deposit':'spacemolt_storage/withdraw';
  return job<Moved>(fn,items.map(row=>`${row.quantity??'all'} ${row.item_id}`).join(', '),async()=>{
    const empty=():Moved=>({base_id:acct().state.location?.docked_at??'',moved:[],short:[],
      cargo:(acct().state.cargo??[]) as V2CargoItem[],store:{} as ViewStorageResponse});
    const want=wanted(items);
    if('refused' in want)return {status:'refused',did:`${fn} nothing`,why:want.refused,detail:empty()};
    const asked=want.rows;
    if(!asked.length)return {status:'refused',did:`${fn} nothing`,why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    const at=await counter(fn);
    if('refused' in at)return {status:'refused',did:`${fn} nothing`,why:at.refused,detail:empty()};
    let store=await view();
    let carried=miningInventory(acct().state);
    const moved:Row[]=[],short:Moved['short']=[];
    for(const row of asked) {
      checkStop();
      const free=(acct().state.ship?.cargo_capacity??0)-(acct().state.ship?.cargo_used??0);
      const available=fn==='stow'?disposable(acct().state)[row.item_id]??0:held(store.items,row.item_id);
      const quantity=Math.min(row.quantity===Infinity?available:row.quantity,available,fn==='withdraw'?Math.max(0,free):Infinity);
      if(quantity<=0) {
        short.push({item_id:row.item_id,requested:row.quantity,moved:0,
          why:available<=0?(fn==='stow'?'not held':'not in store'):'no room'});
        continue;
      }
      const before=carried[row.item_id]??0;
      try {await command(action,{item_id:row.item_id,quantity});}
      catch(error){short.push({item_id:row.item_id,requested:row.quantity,moved:0,why:message(error)});continue;}
      await acct().refresh();
      carried=miningInventory(acct().state);
      const delta=Math.abs((carried[row.item_id]??0)-before);
      if(delta>0){moved.push({item_id:row.item_id,quantity:delta});step(`${fn} ${delta} ${row.item_id}`);}
      if(delta<row.quantity&&row.quantity!==Infinity)
        short.push({item_id:row.item_id,requested:row.quantity,moved:delta,
          why:delta===0?`${action.split('/')[1]} did not clear`:available<row.quantity?(fn==='stow'?'not held':'not in store'):'no room'});
      if((acct().state.location?.docked_at??null)!==at.docked){short.push({item_id:row.item_id,requested:row.quantity,moved:delta,why:`no longer docked at ${at.docked}`});break;}
    }
    if(moved.length)store=await view();
    const detail:Moved={base_id:at.docked,moved,short,cargo:(acct().state.cargo??[]) as V2CargoItem[],store};
    const verb=fn==='stow'?'stowed':'withdrew';
    // A row that is not there means the end state already holds: it is said in `did`, not a refusal.
    const already=short.filter(row=>row.why==='not held'||row.why==='not in store');
    const blocked=short.filter(row=>!already.includes(row));
    const nothing=`nothing to ${fn}: ${already.map(row=>`${row.item_id} ${row.why}`).join(', ')}`;
    const summary=moved.length
      ?`${verb} ${moved.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} at ${at.docked}${already.length?`; ${nothing}`:''}`
      :blocked.length?`${verb} nothing at ${at.docked}`:`${nothing} at ${at.docked}`;
    const why=blocked.map(row=>`${row.item_id}: ${row.why}`).join('; ');
    return {status:blocked.length?(moved.length?'partial':'refused'):'done',did:summary,...why?{why}:{},detail};
  });
}

/** Deposit the named rows from the hold into the store here. Over `storage/deposit` it
 * adds: the `storage` counter checked first, each row bounded by what the hold shows, and
 * the store re-read after. Omit a row's `quantity` to mean all held. Refused when not docked
 * or nothing was named; a row not aboard is `short` and `done`: there was nothing to stow. */
export function stow(items:Want[]):Promise<Outcome<Moved>> {return move('stow',items);}

/** Take rows out of the store here into the hold. Over `storage/withdraw` it adds: the
 * counter check, each row bounded by the store's count and the hold's room, and the reason
 * the rest stayed. Omit a row's `quantity` to mean all stored. Refused when not docked; a row
 * the store does not hold is `short` and `done`. Costs nothing. */
export function withdraw(items:Want[]):Promise<Outcome<Moved>> {return move('withdraw',items);}

/** Read the store at this base, or at a named base or station POI without going there. Works
 * undocked and in another system. `locations` is the whole account's map of holdings. Over
 * `storage/view` it adds: items capped at 40 rows (the count is in `next`). Reads only. */
export function storage(baseId?:string):Promise<Outcome<ViewStorageResponse>> {
  return job<ViewStorageResponse>('storage',baseId??'',async()=>{
    const reply=details(await command('spacemolt_storage/view',baseId?{station_id:baseId}:{})) as ViewStorageResponse;
    const total=(reply.items??[]).length;
    const detail={...reply,items:(reply.items??[]).slice(0,ITEM_CAP),locations:reply.locations??[],ships:reply.ships??[]};
    return {status:'done',did:`read the store at ${reply.base_id||'(not docked)'}: ${total} item rows, ${detail.ships.length} ships, holdings at ${detail.locations.length} bases`,
      detail,next:total>ITEM_CAP?[`${total-ITEM_CAP} more rows not shown; account().commands.spacemolt_storage.view for all`]:[]};
  });
}
