/** Rest: the one act that ends a shift (N6), and the only thing that touches the stance.
 *
 * Two callers, one rule. A script calls `rest()` as its last line and ends its own shift
 * without a model round-trip; the runner calls `restNow` directly at a juncture, and again at
 * the end of a run that left the pilot Tired and docked, so a script that threw before its
 * `rest()` line cannot leave a pilot that can never reflect. Admissibility is the menu's own
 * rest verdict (R5) in both paths, so what the menu offers and what rest accepts cannot drift.
 */
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {REST_JOB,evaluateMenu} from '../rules-table.ts';
import {journalRun} from '../run-record.ts';
import {factsNow} from './menu.ts';
import {acct,command,job,pilot,runtimeDir,setPilot,type Mood,type Pilot,type Stance} from './runtime.ts';
import type {Outcome} from './types.ts';

export interface Rested {
  shift_ended:boolean;
  at_rest:boolean;
  /** What the shift is put down with: the settings the record no longer carries. */
  cleared:{stance?:Stance;mood?:Mood;goal?:string};
  /** False when the evening was put down on a ship this base could not bring up, which is
   * what reflection is told rather than keeping the shift open forever. */
  serviced:boolean;
}

/** The act itself, on explicit deps so the runner can call it with no runtime bound. */
export async function restNow(account:ReadinessAccount,send:ReadinessCommand,who:Pilot,
  write:(next:Pilot)=>void,runtime?:string):Promise<{rested:false;reason:string}|({rested:true}&Rested)> {
  const facts=await factsNow(account,send,who,runtime);
  const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
  if(!verdict?.admissible)return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
  const {stance,mood,goal,mood_before_tired:_m,tired_forced:_t,...kept}=who;
  write(kept);
  const cleared={...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
  if(runtime)journalRun(runtime,cleared,'rest');
  return {rested:true,shift_ended:true,at_rest:true,cleared,
    serviced:facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull};
}

/** End the shift from inside a script: the last line of a run that has nothing left to do.
 * Docked at a base, on a ship this base has brought as far up as it can. It clears the stance,
 * the mood and the goal — a Tired the world imposed included — and the next juncture reflects.
 * Refused, it says what is still missing and the shift stays open. */
export function rest():Promise<Outcome<Rested>> {
  return job<Rested>('rest','',async()=>{
    const done=await restNow(acct(),command,pilot(),setPilot,runtimeDir());
    if(!done.rested)return {status:'refused',did:'the shift is still open',why:done.reason,
      detail:{shift_ended:false,at_rest:false,cleared:{},serviced:false}};
    const {rested:_r,...detail}=done;
    return {status:'done',did:`the shift ended at rest: ${Object.entries(detail.cleared)
      .map(([key,value])=>`${key} ${value}`).join(', ')||'nothing was set'} put down`,
      detail,next:['the next juncture reflects: a goal, a stance and the mood that fits it',
        ...detail.serviced?[]:['the ship is short of a full tank or hull; reflection is told so']]};
  });
}
