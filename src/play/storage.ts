/** Station storage: custody that survives death, readable from anywhere, moved only when
 * docked. Never sells, never buys. */
import type {V2CargoItem,ViewStorageResponse} from '@spacemolt/lib';
import {Data,Effect,Result,Schema,Struct} from 'effect';
import {disposable,miningInventory} from '../mining-inventory.ts';
import {replyBody} from '../storage.ts';
import {DockBlocked} from '../dock.ts';
import * as Wire from '../wire.gen.ts';
import {counter as dockedHere} from './counter.ts';
import {Game,attempt,field,type GameError} from './game.ts';
import {acct,checkStop,edge,jobEffect,step,wanted,type Said,type Stopped} from './runtime.ts';
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

/** A field of the view reply this file reads did not decode against the spec. A named value, folded into the Outcome by the twin. */
export class OffSpec extends Data.TaggedError('OffSpec')<{readonly action:string;readonly message:string}> {}

// Only what this file reads: the live server omits spec fields (`hint`, as U12 found of get_base), so a
// whole-reply decode would refuse real stores. `ships` and `locations` are only counted.
const View=Wire.ViewStorageResponse.mapFields(fields=>({...Struct.pick(fields,['base_id']),
  items:Schema.Array(Wire.CargoItem_14.schema.mapFields(Struct.pick(['item_id','quantity','size']))),
  ships:Schema.Array(Wire.StoredShip.mapFields(Struct.pick([]))),locations:Schema.Array(Wire.StorageLocation_1.mapFields(Struct.pick([])))}));
const decodeView=Schema.decodeUnknownEffect(View);
const noView=():ViewStorageResponse=>({action:'view_storage',base_id:'',hint:'',items:[],locations:[],ships:[]});

/** The store's reply, items capped: a menu fact, not a transcript. `total` is the uncapped row count. */
const read=(stationId?:string)=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt_storage/view',stationId?{station_id:stationId}:{}));
  yield* decodeView(body).pipe(Effect.mapError(error=>new OffSpec({action:'spacemolt_storage/view',message:error.message})));
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const reply=body as ViewStorageResponse; // cast: frozen surface (ViewStorageResponse)
  return {total:reply.items.length,view:{...reply,items:reply.items.slice(0,ITEM_CAP)}};
});
const view=(stationId?:string)=>read(stationId).pipe(Effect.map(result=>result.view));
/** A reply off the spec is `failed`, saying so: not a defect, not a crash. */
export const folded=<D>(fn:string,empty:()=>D,body:Effect.Effect<Said<D>,GameError|Stopped|OffSpec,Game>)=>body.pipe(Effect.catchTag('OffSpec',
  (error):Effect.Effect<Said<D>>=>Effect.succeed({status:'failed',did:`${fn} broke`,why:`${error.action}: reply off spec — ${error.message}`,detail:empty()})));
/** Cargo one unit of `item` occupies, from the store's or the hold's row; one when neither says. */
const sizeOf=(item:string,rows:{item_id:string;size?:number}[])=>Number(rows.find(row=>row.item_id===item&&Number(row.size)>0)?.size)||1;

/** Units of each row that fit `room` cargo: every want when they all fit, else each row's
 * share of the room in proportion to its footprint, floored, the leftover handed out in order. */
export function share(room:number,wants:number[],sizes:number[]):number[] {
  const size=(i:number)=>sizes[i]??1;
  const total=wants.reduce((sum,want,i)=>sum+want*size(i),0);
  if(total<=room)return wants;
  let left=room;
  const caps=wants.map((want,i)=>{const cap=Math.floor(room*want/total);left-=cap*size(i);return cap;});
  return caps.map((cap,i)=>{const more=Math.min((wants[i]??0)-cap,Math.floor(left/size(i)));left-=more*size(i);return cap+more;});
}
const held=(rows:{item_id:string;quantity:number}[],item:string)=>rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);

/** The counter a deposit or withdraw needs: docked, at a base with `storage`. */
const counter=Effect.gen(function*() {
  // A DockBlocked out of the dock inside is the counter's own refusal, said as the counter says it.
  const at=yield* attempt('counter',()=>dockedHere()).pipe( // bridge: U31 (counter.ts still awaits the command seam)
    Effect.catchDefect(thrown=>thrown instanceof DockBlocked?Effect.succeed({refused:thrown.message}):Effect.die(thrown)));
  if('refused' in at)return at;
  const docked=at.docked;
  const services=field(replyBody(yield* (yield* Game).command('spacemolt/get_base',{})),'services');
  if(!(Array.isArray(services)?services.map(String):[]).includes('storage'))return {refused:`${docked} has no storage counter`};
  return {docked};
});

/** One counter move (deposit or withdraw), row by row; the hold after each send is the
 * evidence, never the reply's claim. A reply that is lost is never re-sent: the hold is re-read
 * and says what landed. */
const moveEffect=(fn:'stow'|'withdraw',items:Want[])=>{
  const action=fn==='stow'?'spacemolt_storage/deposit':'spacemolt_storage/withdraw';
  return jobEffect<Moved,Game>(fn,items.map(row=>`${row.quantity??'all'} ${row.item_id}`).join(', '),folded<Moved>(fn,()=>({base_id:'',moved:[],short:[],cargo:acct().state.cargo??[],store:noView()}),Effect.gen(function*() {
    const game=yield* Game;
    const refresh=attempt('refresh',()=>acct().refresh());
    const empty=():Moved=>({base_id:acct().state.location?.docked_at??'',moved:[],short:[],
      cargo:acct().state.cargo??[],store:noView()});
    const asking=wanted(items);
    if('refused' in asking)return {status:'refused',did:`${fn} nothing`,why:asking.refused,detail:empty()};
    const asked=asking.rows;
    if(!asked.length)return {status:'refused',did:`${fn} nothing`,why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    const at=yield* counter;
    if('refused' in at)return {status:'refused',did:`${fn} nothing`,why:at.refused,detail:empty()};
    let store=yield* view();
    let carried=miningInventory(acct().state);
    const free=()=>Math.max(0,(acct().state.ship?.cargo_capacity??0)-(acct().state.ship?.cargo_used??0));
    const plan=asked.map(row=>{
      const size=sizeOf(row.item_id,[...store.items??[],...acct().state.cargo??[]]);
      const avail=fn==='stow'?disposable(acct().state)[row.item_id]??0:held(store.items,row.item_id);
      return {row,size,avail,want:Math.min(row.quantity,avail)};
    });
    // Rows the hold cannot take whole share its room by cargo footprint, not first come first served.
    const caps=fn==='withdraw'?share(free(),plan.map(p=>p.want),plan.map(p=>p.size)):plan.map(p=>p.want);
    const moved:Row[]=[],short:Moved['short']=[];
    for(const [i,{row,size,avail:available,want}] of plan.entries()) {
      checkStop();
      let quantity=Math.min(caps[i]??want,fn==='withdraw'?Math.floor(free()/size):Infinity);
      if(quantity<=0) {
        short.push({item_id:row.item_id,requested:row.quantity,moved:0,
          why:available<=0?(fn==='stow'?'not held':'not in store'):'no room'});
        continue;
      }
      const before=carried[row.item_id]??0;
      const send=(count:number)=>Effect.result(game.command(action,{item_id:row.item_id,quantity:count}));
      let lost:string|undefined;
      const sent=yield* send(quantity);
      if(Result.isFailure(sent)) {
        const error=sent.failure;
        if(error._tag==='ReplyLost')lost=error.action;
        else {
          // No size on record and the game counts one: "Need 96 but only 75 available" for 48
          // is size 2, so 37 fit. One retry at that, never a second guess.
          const full=/Need (\d+) but only (\d+) available/.exec(error.message);
          const fits=full?Math.floor(Number(full[2])/(Number(full[1])/quantity)):0;
          if(fits<=0||fits>=quantity){short.push({item_id:row.item_id,requested:row.quantity,moved:0,why:`${error.code}: ${error.message}`});continue;}
          quantity=fits;
          const again=yield* send(quantity);
          if(Result.isFailure(again)) {
            const second=again.failure;
            if(second._tag==='ReplyLost')lost=second.action;
            else {short.push({item_id:row.item_id,requested:row.quantity,moved:0,why:`${second.code}: ${second.message}`});continue;}
          }
        }
      }
      yield* refresh;
      carried=miningInventory(acct().state);
      const delta=Math.abs((carried[row.item_id]??0)-before);
      if(delta>0){moved.push({item_id:row.item_id,quantity:delta});step(`${fn} ${delta} ${row.item_id}`);}
      if(delta<row.quantity&&(row.quantity!==Infinity||delta<available))
        short.push({item_id:row.item_id,requested:row.quantity,moved:delta,
          why:lost&&delta<want?`reply lost on ${lost}; state re-read`:delta===0?`${action.split('/')[1]} did not clear`:delta<want?'no room':fn==='stow'?'not held':'not in store'});
      if((acct().state.location?.docked_at??null)!==at.docked){short.push({item_id:row.item_id,requested:row.quantity,moved:delta,why:`no longer docked at ${at.docked}`});break;}
    }
    // What moved has landed: a re-read off the spec keeps the store read before, and says so.
    let unread='';
    if(moved.length)store=yield* view().pipe(Effect.catchTag('OffSpec',error=>Effect.sync(()=>{unread=`store not re-read: ${error.action}: reply off spec — ${error.message}`;return store;})));
    const detail:Moved={base_id:at.docked,moved,short,cargo:acct().state.cargo??[],store};
    const verb=fn==='stow'?'stowed':'withdrew';
    // A row that is not there means the end state already holds: it is said in `did`, not a refusal.
    const already=short.filter(row=>row.why==='not held'||row.why==='not in store');
    const blocked=short.filter(row=>!already.includes(row));
    const nothing=`nothing to ${fn}: ${already.map(row=>`${row.item_id} ${row.why}`).join(', ')}`;
    const summary=moved.length
      ?`${verb} ${moved.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} at ${at.docked}${already.length?`; ${nothing}`:''}`
      :blocked.length?`${verb} nothing at ${at.docked}`:`${nothing} at ${at.docked}`;
    const why=[...blocked.map(row=>`${row.item_id}: ${row.why}`),...unread?[unread]:[]].join('; ');
    return {status:blocked.length?(moved.length?'partial':'refused'):'done',did:summary,...why?{why}:{},detail};
  })));
};

export const stowEffect=(items:Want[])=>moveEffect('stow',items);
export const withdrawEffect=(items:Want[])=>moveEffect('withdraw',items);

/** Deposit the named rows from the hold into the store here. Over `storage/deposit` it
 * adds: the `storage` counter checked first, each row bounded by what the hold shows, and
 * the store re-read after. Omit a row's `quantity` to mean all held. Refused when not docked
 * or nothing was named; a row not aboard is `short` and `done`: there was nothing to stow. */
export function stow(items:Want[]):Promise<Outcome<Moved>> {return edge(stowEffect(items));}

/** Take rows out of the store here into the hold. Over `storage/withdraw` it adds: the
 * counter check, each row bounded by the store's count and the hold's room counted in each
 * item's cargo `size`, and the reason the rest stayed. Rows that together overfill the hold
 * share its room in proportion to their footprint: each moves partly, the rest `short` with
 * `no room`, and the status is `partial`. Omit a row's `quantity` to mean all stored. Refused when not docked; a row
 * the store does not hold is `short` and `done`. Costs nothing. */
export function withdraw(items:Want[]):Promise<Outcome<Moved>> {return edge(withdrawEffect(items));}

export const storageEffect=(baseId?:string)=>jobEffect<ViewStorageResponse,Game>('storage',baseId??'',folded<ViewStorageResponse>('storage',noView,Effect.gen(function*() {
  const {total,view:detail}=yield* read(baseId);
  return {status:'done',did:`read the store at ${detail.base_id||'(not docked)'}: ${total} item rows, ${detail.ships.length} ships, holdings at ${detail.locations.length} bases`,
    detail,next:total>ITEM_CAP?[`${total-ITEM_CAP} more rows not shown; account().commands.spacemolt_storage.view for all`]:[]};
})));
/** Read the store at this base, or at a named base or station POI without going there. Works
 * undocked and in another system. `locations` is the whole account's map of holdings. Over
 * `storage/view` it adds: items capped at 40 rows (the count is in `next`). Reads only. */
export function storage(baseId?:string):Promise<Outcome<ViewStorageResponse>> {return edge(storageEffect(baseId));}
