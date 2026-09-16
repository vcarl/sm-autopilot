import {SpacemoltError,type GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {miningInventory,miningYield} from './mining-inventory.ts';
import {replyLost} from './command-boundary.ts';

export interface MineYieldRow {item_id:string;quantity:number}
export interface MineOutcome {
  /** `full` is the end state the step is named for; `depleted` is the site running out,
   * which is not the pilot failing; `failed` is anything that needs a human's reading. */
  outcome:'full'|'depleted'|'failed'|'stopped';
  /** Measured between authoritative reads, per item. Never a reply's claim. */
  yield:MineYieldRow[];
  /** Mine commands that came back with a reply. A rejection is not a cycle. */
  cycles:number;
  reason?:string;
}

/** The site is out, not the pilot. Codes observed across the mine command's rejections. */
const DEPLETED=new Set(['depleted','resource_depleted','deposit_too_sparse','no_common_ores','no_resources']);
const FULL=new Set(['cargo_full','hold_full']);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const rejection=(error:unknown)=>error instanceof SpacemoltError?error.code:'';
const cause=(error:unknown)=>{
  const named=error instanceof SpacemoltError?error.code:(error as Error)?.name;
  return `${named||'error'}: ${(error as Error)?.message??String(error)}`;
};

/** A reply may carry the server's own "that hold is full" token; a unit that will not
 * fit ends the step even though `cargo_used` is still short of capacity. */
const replyIsFull=(reply:unknown)=>{
  const body=details(reply);
  return body?.cargo_full===true||FULL.has(String(body?.kind??''))||FULL.has(String(body?.code??''));
};

/** Mine at the POI the ship is already at until the hold is full.
 *
 * Idempotent by its end state (S42): a hold that is already full sends nothing. The
 * hold filling, a `cargo_full` reply and a `cargo_full` rejection are the same success.
 * Yield is the cargo delta between the authoritative read that opened the step and the
 * one that closed it, so an over-claiming reply — or one whose post-state never moved —
 * contributes nothing.
 */
export interface MineOptions {
  /** Asked before every tick: a reason to stop (the pilot, Tired) ends the step `stopped`. */
  stop?:()=>string|null;
  /** After every tick, with the running yield: what a long loop says while it works. */
  onCycle?:(yield_:MineYieldRow[],cycles:number)=>void;
}

export async function mineToFull(account:ReadinessAccount,command:ReadinessCommand,options:MineOptions={}):Promise<MineOutcome> {
  const site=(state:GameState)=>{
    const {ship,location,cargo}=state??{};
    if(!ship||!location||!Array.isArray(cargo))throw new Error('Authoritative ship, location and cargo required before mining');
    if(!finite(ship.cargo_used)||!finite(ship.cargo_capacity))throw new Error('Authoritative cargo capacity required before mining');
    return {ship_id:ship.id,system_id:location.system_id,poi_id:location.poi_id,
      docked_at:location.docked_at??null,in_transit:Boolean(location.in_transit),
      incapacitated:Boolean(ship.incapacitated),full:ship.cargo_used>=ship.cargo_capacity};
  };

  await account.refresh();
  const start=site(account.state),opening=miningInventory(account.state);
  let cycles=0,carried=opening;
  const done=(outcome:MineOutcome['outcome'],reason?:string):MineOutcome=>({
    outcome,cycles,
    yield:Object.entries(miningYield(opening,carried)).sort(([a],[b])=>a<b?-1:1)
      .map(([item_id,quantity])=>({item_id,quantity})),
    ...reason===undefined?{}:{reason},
  });
  /** What the world did without a command behind it, in the words of the observation. */
  const displaced=(now:ReturnType<typeof site>)=>
    now.ship_id!==start.ship_id?`ship changed from ${start.ship_id} to ${now.ship_id}`:
    now.incapacitated?'ship incapacitated':
    now.docked_at?`docked at ${now.docked_at}`:
    now.in_transit?'in transit':
    !now.poi_id?'not at a POI':
    now.system_id!==start.system_id||now.poi_id!==start.poi_id?
      `at ${now.system_id}/${now.poi_id}, no longer at ${start.system_id}/${start.poi_id}`:undefined;

  const blocked=displaced(start);
  if(blocked)return done('failed',`cannot mine: ${blocked}`);
  if(start.full)return done('full');

  for(;;) {
    const halt=options.stop?.();
    if(halt)return done('stopped',halt);
    let reply:unknown;
    try {
      reply=await command('spacemolt/mine',{});
    } catch(error) {
      const code=rejection(error);
      await account.refresh();
      carried=miningInventory(account.state);
      if(DEPLETED.has(code))return done('depleted',`mine rejected: ${cause(error)}`);
      if(FULL.has(code))return done('full',`mine rejected: ${cause(error)}`);
      // The reply is gone, not the outcome: the take may have landed. Read, never re-send.
      if(replyLost(error)&&!displaced(site(account.state))&&site(account.state).full)
        return done('full',`reconciled after ${cause(error)}`);
      return done('failed',`mine failed: ${cause(error)}`);
    }
    cycles++;
    const before=carried;
    await account.refresh();
    carried=miningInventory(account.state);
    options.onCycle?.(done('full').yield,cycles);
    const now=site(account.state);
    const drift=displaced(now);
    if(drift)return done('failed',`mining interrupted: ${drift}`);
    if(now.full)return done('full');
    if(replyIsFull(reply))return done('full','mine reported a full hold');
    if(!Object.keys(miningYield(before,carried)).length)return done('depleted','mine reply showed no cargo change');
  }
}
