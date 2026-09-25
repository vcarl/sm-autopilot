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
import {factsNow} from './menu.ts';
import {acct,command,job,pilot,runtimeDir,setPilot,type Mood,type Pilot,type Stance} from './runtime.ts';
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

/** The act itself, on explicit deps so the runner can call it with no runtime bound. */
export async function restNow(account:ReadinessAccount,send:ReadinessCommand,who:Pilot,
  write:(next:Pilot)=>void,runtime?:string,
  next?:NextShift):Promise<{rested:false;reason:string}|({rested:true}&Rested)> {
  const facts=await factsNow(account,send,who,runtime);
  const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
  if(!verdict?.admissible)return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
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
