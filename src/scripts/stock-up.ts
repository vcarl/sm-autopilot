import {gatherUntil,type Ctx,type JobOutcome} from '../jobs/index.ts';

/** Fill the home store to several targets at one site, one target at a time.
 *
 * A script has a job's signature, so this composes `gather-until` the way `gather-until`
 * composes `gather`: one call, one outcome read the same way. That call is ONE entry in the
 * run's job list under its own name — its trips travel inside it, under `result.jobs` — so
 * the agent reads targets, not every trip of every target.
 */
export const params={
  type:'object',
  description:'Gather at one site until the store holds each of several targets, in the order given.',
  properties:{
    poi_id:{type:'string',description:'The mining site to work, target after target.'},
    targets:{type:'array',description:'What the store must hold, as {item_id, quantity}, in order.',
      items:{type:'object',properties:{item_id:{type:'string'},quantity:{type:'integer',minimum:1}},
        required:['item_id','quantity']}},
    max_runs:{type:'integer',minimum:1,description:'Most trips to make for any one target.'},
    base_id:{type:'string',description:'Optional: the base the take is stowed and counted at.'},
  },
  required:['poi_id','targets','max_runs'],
};

interface Args {poi_id:string;targets:{item_id:string;quantity:number}[];max_runs:number;base_id?:string}

export default async (ctx:Ctx,args:Args):Promise<JobOutcome>=>{
  const stocked:Record<string,unknown>[]=[];
  for(const target of args.targets) {
    const jobs:JobOutcome[]=[];
    const out=await gatherUntil({...ctx,jobs},{poi_id:args.poi_id,max_runs:args.max_runs,...target,
      ...args.base_id===undefined?{}:{base_id:args.base_id}});
    ctx.jobs.push({...out,result:{...out.result,jobs}});
    stocked.push({item_id:target.item_id,...out.result});
    // The target that did not finish is the run's outcome; the runner reads it off ctx.jobs.
    if(out.outcome!=='done')return {job:'stock-up',outcome:out.outcome,reason:out.reason,result:{stocked}};
  }
  return {job:'stock-up',outcome:'done',result:{stocked},
    reason:`stocked ${stocked.length} target${stocked.length===1?'':'s'} at ${args.poi_id}`};
};
