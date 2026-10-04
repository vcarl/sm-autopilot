/** Rest: dock at a base and bring the ship up. It ends nothing and opens nothing — the goal and
 * the stance are the pilot's to set with `spacemolt_reflect`, and no state waits on a rest.
 *
 * `reflection()` is the read a script takes when it wants to branch on how its runs have gone.
 */
import {Effect} from 'effect';
import {reflectReportEffect,type ReflectReport} from '../reflect.ts';
import {journalRun} from '../run-record.ts';
import {Game,classify} from './game.ts';
import {acct,edge,jobEffect,pilot,runtimeDir} from './runtime.ts';
import {asBase,serviceEffect,type Serviced} from './service.ts';
import {goToEffect} from './travel.ts';
import type {Outcome} from './types.ts';

/** The stagnation signals, the skills that would move, what is held and what is owed, as a read. */
export function reflection():Promise<Outcome<ReflectReport>> {return edge(reflectionEffect());}

/** `reflection` as an Effect, for `edge` and for converted callers; never in a barrel. */
export const reflectionEffect=()=>jobEffect<ReflectReport,Game>('reflection','',Effect.gen(function*() {
  const runtime=runtimeDir();
  // The report re-reads the account first, through the binding's own seam; what that seam threw is classified as `command` classifies it.
  const report=yield* reflectReportEffect(acct(),pilot(),runtime).pipe(
    Effect.catchTag('SeamFailed',failed=>Effect.suspend(()=>Effect.fail(classify('refresh')(failed.cause)))));
  // The rows the next reflection measures skill movement against.
  if(runtime&&report.skills?.length)journalRun(runtime,{skills:report.skills},'reflection_read');
  return {status:'done' as const,did:`the runs in review: ${report.stagnation.length
    ?report.stagnation.join('; '):'nothing is repeating'}`,detail:report};
}));

/** Put in and bring the ship up: `goTo(base)` first when a base is named, then `service()` at the
 * counter the ship is docked at. Not docked and no base named: `service` says so. */
export function rest(base?:string):Promise<Outcome<Serviced>> {return edge(restEffect(base));}

/** `rest` as an Effect, for `edge` and for converted callers; never in a barrel. */
export const restEffect=(base?:string)=>jobEffect<Serviced,Game>('rest',base??'',Effect.gen(function*() {
  if(base) {
    const trip=yield* goToEffect(base);
    if(trip.status!=='done')return {status:trip.status,did:`did not reach ${base}`,why:trip.why??trip.did,
      detail:{base:asBase({}),issued:[],spent:0,short:[],cleared_tired:false},next:trip.next};
  }
  const done=yield* serviceEffect();
  return {status:done.status,did:done.did,...done.why===undefined?{}:{why:done.why},detail:done.detail,next:done.next};
}));
