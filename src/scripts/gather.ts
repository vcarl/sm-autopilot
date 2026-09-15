import {gather,type Ctx,type GatherParams,type ScriptResult} from '../jobs/index.ts';

/** What the dispatch tool asks the agent for, and what the runner validates before loading. */
export const params={
  type:'object',
  description:'One gather job, dock to dock: out to the site, mine the hold full, home, stow the take, service.',
  properties:{
    poi_id:{type:'string',
      description:'The mining site to work: an asteroid belt or field, in this system or another.'},
    base_id:{type:'string',
      description:'Optional: the base the take is stowed at. Defaults to the dock the ship is at, then home.'},
  },
  required:['poi_id'],
};

export default async (ctx:Ctx,args:GatherParams):Promise<ScriptResult>=>{
  const outcome=await gather(ctx,args);
  const took=(outcome.yield??[]).map(row=>`${row.quantity} ${row.item_id}`).join(', ');
  return {reason:`gather done: ${took||'nothing mined (hold full)'}`};
};
