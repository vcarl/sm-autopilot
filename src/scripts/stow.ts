import {stow,type Ctx,type JobOutcome,type StowParams} from '../jobs/index.ts';

/** What the dispatch tool asks the agent for, and what the runner validates before loading. */
export const params={
  type:'object',
  description:'Deposit the hold into the store at the base the ship is docked at. Never sells.',
  properties:{
    base_id:{type:'string',
      description:'Optional: the base to stow at. It must be the one the ship is docked at.'},
    items:{type:'array',items:{type:'string'},
      description:'Optional: the item ids to stow. Default: everything in the hold.'},
  },
  required:[],
};

export default async (ctx:Ctx,args:StowParams):Promise<JobOutcome>=>{
  // A run's `keep` is the hold it started with, which for every other script is the pilot's
  // own cargo and for this one is exactly what it was dispatched to deposit.
  const outcome=await stow({...ctx,keep:[]},args);
  const rows=outcome.yield??[];
  const took=rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');
  const base=String((outcome.result as {base_id?:string}|undefined)?.base_id??'this base');
  return {job:'stow',outcome:outcome.outcome,result:outcome.result,
    reason:rows.length
      ?`stowed ${rows.length} item${rows.length===1?'':'s'} at ${base}: ${took}`
      :outcome.outcome==='done'?`nothing to stow at ${base}`:String(outcome.reason)};
};
