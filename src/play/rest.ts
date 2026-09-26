/** Rest: the one act that ends a shift (N6), and the only thing that touches the stance.
 *
 * **Ending a shift and opening the next one are one call.** They were two, and the seam between
 * them was where a pilot got lost: `rest()` cleared the record, and the pilot then had to be asked
 * in a fresh model turn what came next. A pilot whose objective told it to go hunting talked itself
 * out of answering, sat at rest with `{stance:null, mood:null}`, and burned a whole juncture on 38
 * refusals (live 2026-09-25). Requiring the next shift to be named makes that state unreachable on
 * the normal path rather than something to guard after the fact.
 *
 * Two callers, one rule. A script calls `rest({goal, stance, mood})` as its last line and ends its
 * own shift and opens the next without a model round-trip. The runner calls `restNow` with no next
 * shift, at a juncture and at the end of a run that left the pilot Tired and docked — a script that
 * BROKE cannot know the next goal, so that path still leaves the record empty on purpose, the run
 * guard refuses the next run, and `spacemolt_reflect` is the unattended recovery. That argumentless
 * form is deliberately not exported: reaching it from a script would recreate the empty record by
 * accident.
 *
 * Admissibility is the menu's own rest verdict (R5) in both paths, so what the menu offers and what
 * rest accepts cannot drift.
 */
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {reflectReport,type ReflectReport} from '../reflect.ts';
import {REST_JOB,STANCES,evaluateMenu} from '../rules-table.ts';
import {journalRun} from '../run-record.ts';
import {ServiceBlocked,serviceShip} from '../servicing.ts';
import {factsNow} from './menu.ts';
import {serviceElsewhere} from './service.ts';
import {acct,bind,command,isBound,job,pilot,runtimeDir,setPilot,unbind,
  type Mood,type Pilot,type Stance} from './runtime.ts';
import type {Outcome} from './types.ts';

/** The moods a shift may open in: every stance's own initial moods, and nothing else. Relaxed is
 * rest-like and Tired is imposed, so neither can start one (D2/D3). */
export const JOB_MOODS:readonly Mood[]=Object.freeze(
  [...new Set(STANCES.flatMap(row=>row.initial_moods))]);

/** The next shift, named by the pilot as it puts this one down. Required on the script's path: a
 * rest that names nothing is the state this call exists to make unreachable. */
export interface NextShift {goal:string;stance:Stance;mood:Mood;
  /** Retire the objective carried in, because this shift finished it. The goal named here is what
   * the next shift pursues instead — it is never a shift of its own. */
  objective_done?:boolean}

export interface Rested {
  shift_ended:boolean;
  at_rest:boolean;
  /** What the shift is put down with: the settings the record no longer carries. */
  cleared:{stance?:Stance;mood?:Mood;goal?:string};
  /** The shift this call opened, when it opened one. Absent on the runner's own argumentless rest,
   * which is the path a broken script leaves behind. */
  opened?:{goal:string;stance:Stance;mood:Mood};
  /** The objective this rest retired, when `objective_done` said so. */
  retired?:string;
  /** False when the evening was put down on a ship this base could not bring up, which is
   * what reflection is told rather than keeping the shift open forever. */
  serviced:boolean;
}

/** The next shift as the rules will accept it, or why they will not. Both entry points — the
 * barrel's `rest()` and the bridge's `rest` request, which is how `spacemolt_reflect` reaches this
 * — go through here, so a stance the rules cannot start work in is refused identically on both.
 * That record would be exactly as unusable as the empty one this call exists to prevent. */
export function validateNext(asked:Partial<NextShift>|undefined):{next:NextShift}|{error:string} {
  const goal=String(asked?.goal??'').trim();
  const stance=STANCES.find(row=>row.name.toLowerCase()===String(asked?.stance??'').trim().toLowerCase())?.name;
  const mood=JOB_MOODS.find(one=>one.toLowerCase()===String(asked?.mood??'').trim().toLowerCase());
  if(!goal)return {error:'a shift opens with a goal; name what this one will do to advance the objective'};
  if(!stance)return {error:`${asked?.stance} is not a stance; one of ${STANCES.map(row=>row.name).join(', ')}`};
  if(!mood)return {error:`${asked?.mood} is not a mood a shift can open in; one of ${JOB_MOODS.join(', ')}`};
  return {next:{goal,stance,mood,...asked?.objective_done?{objective_done:true}:{}}};
}

/** A refusal that names what would clear it: the bases `goTo` can still reach and what they post,
 * never a trip taken on the pilot's behalf (rest must not fly). `fixable` is exactly whether any
 * option is offered — the only two shapes the model's next move needs to tell apart: a program it
 * can run now, or a shift that has nothing left to try and waits for the next juncture.
 *
 * `serviceElsewhere` reads through the runtime's own globals (`acct()`, `command`), which is fine
 * called from a script's `rest()` — already bound, for the run in flight — but restNow is also
 * the runner's own way in, with no run in flight and nothing bound. Binding here only when
 * nothing already is keeps both callers working without the reentrant `bind()` that would reset
 * the outer run's own counters mid-run. */
async function refuseWithOptions(account:ReadinessAccount,send:ReadinessCommand,who:Pilot,
  write:(next:Pilot)=>void,runtime:string|undefined,reason:string,
  docked?:string):Promise<{rested:false;reason:string;fixable:boolean}> {
  const already=isBound();
  if(!already)bind({account,command:send,pilot:()=>who,setPilot:write,...runtime?{runtime}:{},emit:()=>{}});
  let options:Awaited<ReturnType<typeof serviceElsewhere>>;
  try {options=await serviceElsewhere(docked);}
  finally {if(!already)unbind();}
  const reason_=options.length
    ?`${reason}; try instead: ${options.map(row=>`${row.call} — ${row.why}`).join('; ')}`
    :reason;
  return {rested:false,reason:reason_,fixable:options.length>0};
}

/** The act itself, on explicit deps so the runner can call it with no runtime bound. */
export async function restNow(account:ReadinessAccount,send:ReadinessCommand,who:Pilot,
  write:(next:Pilot)=>void,runtime?:string,
  next?:NextShift):Promise<{rested:false;reason:string;fixable?:boolean}|({rested:true}&Rested)> {
  let facts=await factsNow(account,send,who,runtime);
  if(facts.place.kind==='base'&&!(facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull)) {
    const counter=evaluateMenu(facts).find(row=>row.job==='J12 Home, serviced');
    if(!counter?.admissible)
      return refuseWithOptions(account,send,who,write,runtime,
        `refuel and repair first — ${counter?.reason??'this counter cannot service the ship'}`,
        facts.place.base_id);
    // The bill fits: bring the ship up before deciding whether rest is admissible, rather than
    // handing the model a refusal it would only clear by writing the exact program this already
    // is. `service()`'s own job wrapper is a script-runtime primitive (bind()); restNow runs
    // outside a run, on the same explicit deps as the rest of this call, so it drives
    // `serviceShip` directly, the same act at one layer down.
    try {
      const mood=who.mood??'Cautious';
      const done=await serviceShip(account,send,{mood,creditReserve:who.permissions?.credit_reserve??0,...runtime?{runtime}:{}});
      if(runtime)journalRun(runtime,{issued:done.issued,spent:done.spent,fuel:done.fuel,hull:done.hull,cells:done.cells},'service');
    } catch(error) {
      if(!(error instanceof ServiceBlocked))throw error;
      return refuseWithOptions(account,send,who,write,runtime,
        `refuel and repair first — ${error.blockers.join('; ')}`,facts.place.base_id);
    }
    facts=await factsNow(account,send,who,runtime);
  }
  const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
  if(!verdict?.admissible)
    return refuseWithOptions(account,send,who,write,runtime,verdict?.reason??'rest is not admissible here',
      facts.place.kind==='base'?facts.place.base_id:undefined);
  const {stance,mood,goal,mood_before_tired:_m,tired_forced:_t,objective_done:_d,...kept}=who;
  // One write, not two: the record never passes through the state with no stance and no mood, so
  // nothing reading it between the two can see a pilot that cannot work.
  const retired=next?.objective_done||who.objective_done?kept.objective:undefined;
  if(retired)delete kept.objective;
  write(next?{...kept,goal:next.goal,stance:next.stance,mood:next.mood}:kept);
  const cleared={...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
  if(runtime)journalRun(runtime,{...cleared,...next?{opened:next}:{},...retired?{retired}:{}},'rest');
  return {rested:true,shift_ended:true,at_rest:!next,cleared,
    ...next?{opened:{goal:next.goal,stance:next.stance,mood:next.mood}}:{},
    ...retired?{retired}:{},
    serviced:facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull};
}

/** The same material the juncture's reflection shows, as a read a script can take before it chooses
 * its next shift: the stagnation signals, the skills that would move, what is held and what is owed.
 *
 * It does not make the choice as well-informed as a model turn at the juncture — a script is
 * authored before the shift runs, so it can branch on this but it cannot reason about it. It is what
 * makes a `rest({goal, stance, mood})` written in advance answerable to how the shift actually
 * went, rather than chosen blind. */
export function reflection():Promise<Outcome<ReflectReport>> {
  return job<ReflectReport>('reflection','',async()=>{
    const report=await reflectReport(acct(),command,pilot(),runtimeDir());
    return {status:'done',did:`the shift in review: ${report.stagnation.length
      ?report.stagnation.join('; '):'nothing is repeating'}`,detail:report,
      next:['rest({goal, stance, mood}) ends this shift and opens the next one in one call']};
  });
}

/** End this shift and open the next one, as the last line of a run that has nothing left to do.
 * Docked at a base, on a ship this base has brought as far up as it can.
 *
 * `goal`, `stance` and `mood` are required, and that is the point: a rest that named nothing left a
 * pilot at rest with an empty record, which is a pilot every job refuses. Pass `objective_done` to
 * retire the objective this shift finished, alongside the goal that replaces it.
 *
 * `reflection()` is the read to take first if the choice should answer to how the shift went.
 * Refused, it says what is missing and the shift stays open — the record is not touched. */
export function rest(next:NextShift):Promise<Outcome<Rested>> {
  const nothing:Rested={shift_ended:false,at_rest:false,cleared:{},serviced:false};
  return job<Rested>('rest',`${next?.stance??'?'} ${next?.mood??'?'}`,async()=>{
    const refuse=(why:string)=>({status:'refused' as const,did:'the shift is still open',why,detail:nothing});
    const checked=validateNext(next);
    if('error' in checked)return refuse(checked.error);
    const {goal,stance,mood}=checked.next;
    const done=await restNow(acct(),command,pilot(),setPilot,runtimeDir(),checked.next);
    if(!done.rested)return refuse(done.reason);
    const {rested:_r,...detail}=done;
    return {status:'done',
      did:`the shift ended and the next opened: ${stance}, ${mood} — ${goal}${detail.retired?`; objective "${detail.retired}" retired`:''}`,
      detail,next:['the next wake starts working in this stance; no reflection is needed',
        ...detail.serviced?[]:['the ship is short of a full tank or hull; the next shift starts short']]};
  });
}
