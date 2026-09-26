/** Rest: dock at a base and bring the ship up. It ends nothing and opens nothing — the goal and
 * the stance are the pilot's to set with `spacemolt_reflect`, and no state waits on a rest.
 *
 * `reflection()` is the read a script takes when it wants to branch on how its runs have gone.
 */
import {reflectReport,type ReflectReport} from '../reflect.ts';
import {journalRun} from '../run-record.ts';
import {acct,command,job,pilot,runtimeDir} from './runtime.ts';
import {service,type Serviced} from './service.ts';
import {goTo} from './travel.ts';
import type {GetBaseResponse} from '@spacemolt/lib';
import type {Outcome} from './types.ts';

/** The stagnation signals, the skills that would move, what is held and what is owed, as a read. */
export function reflection():Promise<Outcome<ReflectReport>> {
  return job<ReflectReport>('reflection','',async()=>{
    const runtime=runtimeDir(),report=await reflectReport(acct(),command,pilot(),runtime);
    // The rows the next reflection measures skill movement against.
    if(runtime&&report.skills?.length)journalRun(runtime,{skills:report.skills},'reflection_read');
    return {status:'done',did:`the runs in review: ${report.stagnation.length
      ?report.stagnation.join('; '):'nothing is repeating'}`,detail:report};
  });
}

/** Put in and bring the ship up: `goTo(base)` first when a base is named, then `service()` at the
 * counter the ship is docked at. Not docked and no base named: `service` says so. */
export function rest(base?:string):Promise<Outcome<Serviced>> {
  return job<Serviced>('rest',base??'',async()=>{
    if(base) {
      const trip=await goTo(base);
      if(trip.status!=='done')return {status:trip.status,did:`did not reach ${base}`,why:trip.why??trip.did,
        detail:{base:{} as GetBaseResponse,issued:[],spent:0,short:[],cleared_tired:false},next:trip.next};
    }
    const done=await service();
    return {status:done.status,did:done.did,...done.why===undefined?{}:{why:done.why},detail:done.detail,next:done.next};
  });
}
