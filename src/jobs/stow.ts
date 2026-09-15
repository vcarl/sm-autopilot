/** One stow, at the counter the ship is already at: the hold into the station store.
 *
 * A gather stows its own take because the trip ends there; this is the same deposit as its
 * settle step, standing on its own, for the hold a gather left behind — the cargo that was
 * already aboard, or a take a station with no store sent home in the hold. It never sells and
 * never withdraws: the market and the store are separate counters, and this one only moves
 * cargo in.
 *
 * Every step is named for an end state and sends nothing when that state already holds, so a
 * re-run on a hold that is already empty is `done` with nothing stowed rather than a second
 * deposit.
 */
import {details} from '../response-details.ts';
import {miningInventory} from '../mining-inventory.ts';
import type {MineYieldRow} from '../mine.ts';
import type {Ctx,JobOutcome} from './ctx.ts';
import {storage} from './helpers.ts';

export interface StowParams {
  /** Optional: the base to stow at. It must be the one the ship is docked at — this job is a
   * counter, not a trip. */
  base_id?:string;
  /** Optional: the item ids to stow. Default: the whole hold except `ctx.keep`. */
  items?:string[];
}

const message=(error:unknown)=>error instanceof Error?error.message:String(error);

export async function stow(ctx:Ctx,params:StowParams={}):Promise<JobOutcome> {
  await ctx.check('stow');
  ctx.progress({last_job:'stow',last_step:'counter'});
  const done=(outcome:JobOutcome):JobOutcome=>{ctx.jobs.push(outcome);return outcome;};
  const failed=(reason:string)=>done({job:'stow',outcome:'failed',reason});

  await ctx.account.refresh();
  const docked=ctx.account.state.location?.docked_at??null;
  if(!docked)return failed('stow needs a docked ship: no station store is reachable from space');
  if(params.base_id&&String(params.base_id)!==docked)
    return failed(`stow was asked for ${params.base_id}, but the ship is docked at ${docked}`);
  let services:string[];
  try {
    const base=details(await ctx.command('spacemolt/get_base',{}));
    services=(Array.isArray(base.services)?base.services:[]).map(String);
  } catch(error){return failed(`${docked} would not say what it offers: ${message(error)}`);}
  if(!services.includes('storage'))
    return failed(`${docked} has no storage counter; the hold stays aboard until a base that has one`);

  // What a deposit here may move: the hold, less the pilot's own, less anything not named.
  const own=new Set(ctx.keep);
  const named=params.items?.length?new Set(params.items.map(String)):null;
  let carried=miningInventory(ctx.account.state);
  const rows:MineYieldRow[]=Object.entries(carried)
    .filter(([item_id,quantity])=>quantity>0&&!own.has(item_id)&&(!named||named.has(item_id)))
    .sort(([a],[b])=>a<b?-1:1).map(([item_id,quantity])=>({item_id,quantity}));

  ctx.progress({last_job:'stow',last_step:'deposit'});
  const stowed:MineYieldRow[]=[],gaps:string[]=[];
  for(const row of rows) {
    // Bounded by what the live read still shows aboard: a resumed job whose deposit already
    // landed sees nothing to send and sends nothing.
    const quantity=Math.min(row.quantity,carried[row.item_id]??0);
    if(quantity<=0)continue;
    const before=carried[row.item_id]??0;
    try {await ctx.command('spacemolt_storage/deposit',{item_id:row.item_id,quantity});}
    catch(error){gaps.push(`${row.item_id}: ${message(error)}`);continue;}
    // The reply's claim is not evidence; the hold after the send is.
    await ctx.account.refresh();
    carried=miningInventory(ctx.account.state);
    const moved=before-(carried[row.item_id]??0);
    if(moved>0)stowed.push({item_id:row.item_id,quantity:moved});
    else gaps.push(`${row.item_id}: deposit did not clear, ${before} still aboard`);
    if((ctx.account.state.location?.docked_at??null)!==docked) {
      gaps.push(`stowing stopped: no longer docked at ${docked}`);
      break;
    }
  }

  // The store is where the cargo went, so the store is what says it arrived.
  if(stowed.length) {
    ctx.progress({last_job:'stow',last_step:'verify'});
    try {
      const view=await storage(ctx);
      const held=new Map(view.items.map(item=>[item.item_id,item.quantity]));
      for(const row of stowed)
        if((held.get(row.item_id)??0)<row.quantity)
          gaps.push(`${row.item_id}: ${row.quantity} left the hold but the store at ${docked} does not show it`);
    } catch(error){gaps.push(`the store at ${docked} would not answer after the deposits: ${message(error)}`);}
  }

  const {ship}=ctx.account.state;
  const remaining=Object.entries(carried).filter(([,quantity])=>quantity>0)
    .sort(([a],[b])=>a<b?-1:1).map(([item_id,quantity])=>({item_id,quantity}));
  const result={base_id:docked,stowed:stowed.length,remaining,
    cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0)};
  if(gaps.length)return done({job:'stow',outcome:'failed',yield:stowed,result,
    reason:`stow did not finish at ${docked}: ${gaps.join('; ')}`});
  return done({job:'stow',outcome:'done',yield:stowed,result,
    reason:stowed.length
      ?`stowed ${stowed.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} at ${docked}`
      :`nothing to stow at ${docked}`});
}
