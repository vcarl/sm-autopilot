import {SpacemoltError,type GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {miningInventory} from './mining-inventory.ts';
import {replyLost} from './command-boundary.ts';

/** `quoted` is the station's posted price for the quantity offered, seen before anything
 * was sent. `cleared` is the wallet delta measured between authoritative reads. They are
 * never the same number by construction, and a reply's own total_earned is neither. */
export interface SettledSale {item_id:string;quantity:number;quoted:number;cleared:number}
export interface SettledMove {item_id:string;quantity:number}
/** Offered but not confirmed by the post-state. `quoted` is null when nothing was quoted. */
export interface UnsettledRow {item_id:string;quantity:number;quoted:number|null;gap:string}
export interface SettleOutcome {
  sold:SettledSale[];
  deposited:SettledMove[];
  /** The station will not buy it and has no storage to take it: it is still in the hold. */
  held:SettledMove[];
  unsettled:UnsettledRow[];
  credits_before:number;
  credits_after:number;
}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const cause=(error:unknown)=>{
  const named=error instanceof SpacemoltError?error.code:(error as Error)?.name;
  return `${named||'error'}: ${(error as Error)?.message??String(error)}`;
};

/** The counter as the game sees it: who is docked where, with what, holding how much. */
function read(state:GameState) {
  const {ship,location,player}=state??{};
  if(!ship||!location)throw new Error('Authoritative ship and location required before settling cargo');
  if(!finite(player?.credits))throw new Error('Authoritative wallet credits required before settling cargo');
  return {ship_id:ship.id,docked_at:location.docked_at??null,credits:player.credits,
    cargo:miningInventory(state)};
}

/** Sell or deposit the hold at the station the ship is docked at.
 *
 * Money moves against an observed book, and only the post-state says a sale happened:
 * `quoted` comes from the market read before anything is sent, `cleared` from the wallet
 * and cargo deltas between authoritative reads afterwards. A sale whose post-state shows
 * an unmoved wallet or an unmoved hold is unsettled with the gap, never reported as
 * income. A lost reply is reconciled from that same post-state — gone and paid is
 * cleared, nothing moved earns exactly one re-issue, anything else is unsettled — so an
 * ambiguous send is never repeated blind. Items on `keep` are the pilot's own: fitted
 * spares, cabins, anything the caller is carrying on purpose. They are never offered.
 */
export async function settleCargo(account:ReadinessAccount,command:ReadinessCommand,
  options:{keep?:string[]}={}):Promise<SettleOutcome> {
  const keep=new Set(options.keep??[]);
  await account.refresh();
  const start=read(account.state);
  if(!start.docked_at)throw new Error('Settling cargo requires a docked ship; no station counter is reachable');

  let now=start,drift='';
  const outcome:SettleOutcome={sold:[],deposited:[],held:[],unsettled:[],
    credits_before:start.credits,credits_after:start.credits};

  const book=new Map<string,number>();
  for(const row of details(await command('spacemolt_market/view_market',{})).items??[])
    if(typeof row?.item_id==='string'&&finite(row.buy_price)&&row.buy_price>0)book.set(row.item_id,row.buy_price);

  // Probed only when something the station will not buy turns up, and only once.
  let storage:boolean|undefined;
  const hasStorage=async()=>{
    if(storage===undefined) {
      try {storage=Array.isArray(details(await command('spacemolt_storage/view',{})).items);}
      catch {storage=false;}
    }
    return storage;
  };

  /** Send one mutation, then read the world. The reply's claim is not evidence. */
  const move=async(item_id:string,action:string,params:Record<string,unknown>)=>{
    const before=now;
    let lost='',rejected='';
    try {await command(action,params);}
    catch(error) {
      if(!replyLost(error))rejected=cause(error);
      else lost=cause(error);
    }
    if(!rejected) {
      await account.refresh();
      now=read(account.state);
      outcome.credits_after=now.credits;
      if(now.ship_id!==start.ship_id)drift=`ship changed from ${start.ship_id} to ${now.ship_id}`;
      else if(now.docked_at!==start.docked_at)drift=now.docked_at?`docked at ${now.docked_at}, no longer at ${start.docked_at}`:`no longer docked at ${start.docked_at}`;
    }
    return {credits:now.credits-before.credits,
      cargo:(before.cargo[item_id]??0)-(now.cargo[item_id]??0),rejected,lost};
  };
  type Move=Awaited<ReturnType<typeof move>>;
  const gap=(verb:string,result:Move)=>result.rejected||
    `${verb} did not clear: cargo -${result.cargo}, credits ${result.credits>=0?'+':''}${result.credits}${result.lost?` after ${result.lost}`:''}`;

  for(const [item_id,quantity] of Object.entries(start.cargo).sort(([a],[b])=>a<b?-1:1)) {
    if(keep.has(item_id)||quantity<=0)continue;
    const price=book.get(item_id);
    if(drift) {
      outcome.unsettled.push({item_id,quantity,quoted:price===undefined?null:price*quantity,
        gap:`settling stopped: ${drift}`});
      continue;
    }
    if(price===undefined) {
      if(!await hasStorage()) {outcome.held.push({item_id,quantity});continue;}
      let result=await move(item_id,'spacemolt_storage/deposit',{item_id,quantity});
      if(result.lost&&!result.cargo&&!drift)result=await move(item_id,'spacemolt_storage/deposit',{item_id,quantity});
      if(result.cargo>0)outcome.deposited.push({item_id,quantity:result.cargo});
      else outcome.unsettled.push({item_id,quantity,quoted:null,gap:gap('deposit',result)});
      continue;
    }
    const quoted=price*quantity;
    let result=await move(item_id,'spacemolt/sell',{id:item_id,quantity});
    // Nothing moved at all: the send is the only thing that went missing. One re-issue.
    if(result.lost&&!result.cargo&&!result.credits&&!drift)result=await move(item_id,'spacemolt/sell',{id:item_id,quantity});
    if(result.cargo>0&&result.credits>0)outcome.sold.push({item_id,quantity:result.cargo,quoted,cleared:result.credits});
    else outcome.unsettled.push({item_id,quantity,quoted,gap:gap('sale',result)});
  }
  return outcome;
}
