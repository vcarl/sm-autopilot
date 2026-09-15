/** One withdraw, at the counter the ship is already at: the station store into the hold.
 *
 * Stow's inverse, and the other half of moving an input to the bench that wants it: withdraw
 * here, fly, stow there. It never buys and never deposits — the market and the store are
 * separate counters, and this one only moves cargo out of the store.
 *
 * Every step is named for an end state and sends nothing when that state already holds, so a
 * request for what the store does not have, or for more than the hold has room for, is `done`
 * having moved what it could and said why the rest stayed.
 */
import {details} from '../response-details.ts';
import {miningInventory} from '../mining-inventory.ts';
import type {MineYieldRow} from '../mine.ts';
import type {Ctx,JobOutcome} from './ctx.ts';
import {storage} from './helpers.ts';

export interface WithdrawParams {
  /** The rows to take out of the store here. */
  items:{item_id:string;quantity:number}[];
  /** Optional: the base to withdraw at. It must be the one the ship is docked at — this job
   * is a counter, not a trip. */
  base_id?:string;
}

interface Short {item_id:string;requested:number;moved:number;why:'not in store'|'no room'}

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const held=(rows:{item_id:string;quantity:number}[],item:string)=>
  rows.find(row=>row.item_id===item)?.quantity??0;

export async function withdraw(ctx:Ctx,params:WithdrawParams):Promise<JobOutcome> {
  await ctx.check('withdraw');
  ctx.progress({last_job:'withdraw',last_step:'counter'});
  const done=(outcome:JobOutcome):JobOutcome=>{ctx.jobs.push(outcome);return outcome;};
  const failed=(reason:string)=>done({job:'withdraw',outcome:'failed',reason});

  const asked:MineYieldRow[]=(params.items??[])
    .map(row=>({item_id:String(row.item_id),quantity:Number(row.quantity)}))
    .filter(row=>row.item_id&&Number.isFinite(row.quantity)&&row.quantity>0);
  if(!asked.length)throw new Error('withdraw requires items: the rows to take out of the store');

  await ctx.account.refresh();
  const docked=ctx.account.state.location?.docked_at??null;
  if(!docked)return failed('withdraw needs a docked ship: no station store is reachable from space');
  if(params.base_id&&String(params.base_id)!==docked)
    return failed(`withdraw was asked for ${params.base_id}, but the ship is docked at ${docked}`);
  let services:string[];
  try {
    const base=details(await ctx.command('spacemolt/get_base',{}));
    services=(Array.isArray(base.services)?base.services:[]).map(String);
  } catch(error){return failed(`${docked} would not say what it offers: ${message(error)}`);}
  if(!services.includes('storage'))
    return failed(`${docked} has no storage counter; the store is at a base that has one`);

  ctx.progress({last_job:'withdraw',last_step:'withdraw'});
  let view=await storage(ctx,docked);
  let carried=miningInventory(ctx.account.state);
  const free=()=>{const {ship}=ctx.account.state;
    return (ship?.cargo_capacity??0)-(ship?.cargo_used??0);};
  let room=free();
  const took:MineYieldRow[]=[],short:Short[]=[],gaps:string[]=[];
  for(const row of asked) {
    const store=held(view.items,row.item_id);
    const quantity=Math.min(row.quantity,store,Math.max(0,room));
    if(quantity<=0) {
      short.push({item_id:row.item_id,requested:row.quantity,moved:0,
        why:store<=0?'not in store':'no room'});
      continue;
    }
    const before=carried[row.item_id]??0;
    try {await ctx.command('spacemolt_storage/withdraw',{item_id:row.item_id,quantity});}
    catch(error){gaps.push(`${row.item_id}: ${message(error)}`);continue;}
    // The reply's claim is not evidence; the hold after the send is.
    await ctx.account.refresh();
    carried=miningInventory(ctx.account.state);
    const moved=(carried[row.item_id]??0)-before;
    if(moved>0)took.push({item_id:row.item_id,quantity:moved});
    else gaps.push(`${row.item_id}: the withdraw did not clear, nothing reached the hold`);
    if(moved<row.quantity)
      short.push({item_id:row.item_id,requested:row.quantity,moved,
        why:store<row.quantity?'not in store':'no room'});
    room=free();
    if((ctx.account.state.location?.docked_at??null)!==docked) {
      gaps.push(`withdrawing stopped: no longer docked at ${docked}`);
      break;
    }
  }

  // The store is where the cargo came from, so the store is read again for what is left.
  if(took.length) {
    ctx.progress({last_job:'withdraw',last_step:'verify'});
    try {view=await storage(ctx,docked);}
    catch(error){gaps.push(`the store at ${docked} would not answer after the withdraws: ${message(error)}`);}
  }

  const result={base_id:docked,withdrawn:took.length,short,cargo_free:free()};
  if(gaps.length)return done({job:'withdraw',outcome:'failed',yield:took,result,
    reason:`withdraw did not finish at ${docked}: ${gaps.join('; ')}`});
  const why=short.map(row=>`${row.item_id} ${row.why}`).join(', ');
  return done({job:'withdraw',outcome:'done',yield:took,result,
    reason:took.length
      ?`withdrew ${took.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} at ${docked}`
        +(short.length?`; short: ${why}`:'')
      :`nothing to withdraw at ${docked}: ${why||'nothing was asked for'}`});
}
