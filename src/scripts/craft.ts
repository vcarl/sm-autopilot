import {craft,type Ctx,type CraftParams,type JobOutcome} from '../jobs/index.ts';

/** What the dispatch tool asks the agent for, and what the runner validates before loading. */
export const params={
  type:'object',
  description:'One craft at this base: quote, commit the escrow, wait for the queue, confirm the output in storage. Never sells.',
  properties:{
    recipe_id:{type:'string',description:'The recipe to run, as spacemolt_recipes listed it.'},
    quantity:{type:'integer',minimum:1,
      description:'How many units of the output to ask for. The server answers with the runs it will do.'},
    facility_id:{type:'string',
      description:'Optional: the facility to run it at, when the recipe names one.'},
  },
  required:['recipe_id','quantity'],
};

export default async (ctx:Ctx,args:CraftParams):Promise<JobOutcome>=>{
  // The job's sentence already names the recipe, the runs, what was made and what it cost at
  // which base, and its refusals name themselves: the script is the dispatch surface, not a
  // second voice over the same craft.
  const outcome=await craft(ctx,args);
  return {...outcome,job:'craft'};
};
