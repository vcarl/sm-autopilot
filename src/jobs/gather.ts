/** One gather job, dock to dock: out to the site, mine the hold full, home, settle, service.
 *
 * The steps live in `gather-job.ts`, where each one is named for an end state and sends
 * nothing when that state already holds — which is what makes re-running a script after a
 * restart safe, and why nothing here re-issues anything. This is the job as a script sees
 * it: a call that takes the site, answers with one outcome, and is admissible only if the
 * rules still allow another job.
 */
import {gatherJob,type GatherPlan} from '../gather-job.ts';
import {miningInventory} from '../mining-inventory.ts';
import type {Ctx,JobOutcome} from './ctx.ts';
import {route} from './helpers.ts';

export interface GatherParams {
  /** The mining site to work: an asteroid belt or field, in this system or another. */
  poi_id:string;
  /** The base the take is stowed at. Defaults to the dock the ship is at, then the pilot's home. */
  base_id?:string;
  /** Item ids the job must leave in the hold. Defaults to the hold the run started with. */
  keep?:string[];
}

/** Where the trip starts and ends, resolved from live state so a script names only a site.
 * Home is where the ore is stowed, not a limit on where it is mined. */
async function plan(ctx:Ctx,params:GatherParams):Promise<GatherPlan> {
  const sitePoi=String(params.poi_id??'');
  if(!sitePoi)throw new Error('gather requires a poi_id: the mining site to work');
  await ctx.account.refresh();
  const site=await route(ctx,sitePoi);
  const homeBase=String(params.base_id??ctx.account.state.location?.docked_at??ctx.home??'');
  if(!homeBase)throw new Error('gather needs a base_id to stow at: pass one or set a home');
  const home=await route(ctx,homeBase);
  return {
    home:{system_id:String(home.target_system),poi_id:String(home.target_poi),base_id:homeBase},
    site:{system_id:String(site.target_system),poi_id:sitePoi},
    mood:ctx.mood,
    // The hold the run started with is the pilot's own. Taken from the run record rather
    // than from the hold in front of us: a resumed run is standing at the belt with its own
    // take aboard, and that take is not cargo to be kept out of the store.
    keep:params.keep?.map(String)??[...ctx.keep],
  };
}

export async function gather(ctx:Ctx,params:GatherParams):Promise<JobOutcome> {
  await ctx.check('gather');
  const resume=ctx.resuming();
  const sheet=await plan(ctx,params);
  ctx.progress({last_job:'gather',last_step:'travel'});
  const result=await gatherJob(ctx.account,ctx.command,sheet,resume?{resume:true}:{});
  const outcome:JobOutcome={job:'gather',outcome:result.outcome,yield:result.yield,
    ...result.moved?{moved:result.moved}:{},
    ...result.reason===undefined?{}:{reason:result.reason}};
  ctx.jobs.push(outcome);
  ctx.progress({last_job:'gather',last_step:result.steps.at(-1)?.name});
  return outcome;
}

/** What the runner records as the pilot's own hold when a run starts. */
export const ownHold=(state:Parameters<typeof miningInventory>[0]):string[]=>
  Object.keys(miningInventory(state));
