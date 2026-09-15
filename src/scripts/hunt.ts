import {hunt,type Ctx,type HuntParams,type JobOutcome} from '../jobs/index.ts';

/** What the dispatch tool asks the agent for, and what the runner validates before loading. */
export const params={
  type:'object',
  description:'One hunt, dock to dock: out to a habitat, take the fights the rules admit, loot what fits, home, stow, service. Needs a fitted module of type weapon with rounds for its ammo_type.',
  properties:{
    poi_id:{type:'string',
      description:'The habitat to work: the POI the creatures are at, in this system or another.'},
    species:{type:'string',
      description:'Optional: the species to take. A species you have fought before is a kind you know; without one, a creature whose speed the scan does not give is declined.'},
    fights:{type:'integer',minimum:1,
      description:'Optional: how many fights to take before coming home. Default one.'},
    base_id:{type:'string',
      description:'Optional: the base the loot is stowed at; defaults to the dock the ship left, then home.'},
  },
  required:['poi_id'],
};

export default async (ctx:Ctx,args:HuntParams):Promise<JobOutcome>=>{
  const outcome=await hunt(ctx,args);
  const result=outcome.result as {poi_id?:string;fights?:number;base_id?:string;hull?:number;
    hull_before?:number;loot?:{item_id:string;quantity:number}[]}|undefined;
  if(outcome.outcome!=='done'||!result)return {...outcome,job:'hunt'};
  const loot=(result.loot??[]).map(row=>`${row.quantity} ${row.item_id}`).join(', ');
  return {job:'hunt',outcome:outcome.outcome,result:outcome.result,
    reason:`hunted ${result.fights} at ${result.poi_id}: ${loot||'no loot'}, hull ${result.hull_before}→${result.hull}, stowed at ${result.base_id}`};
};
