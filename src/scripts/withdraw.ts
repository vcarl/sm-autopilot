import {withdraw,type Ctx,type JobOutcome,type WithdrawParams} from '../jobs/index.ts';

/** What the dispatch tool asks the agent for, and what the runner validates before loading. */
export const params={
  type:'object',
  description:'Take items out of the store at the base the ship is docked at, into the hold. Never buys.',
  properties:{
    items:{type:'array',
      description:'The rows to take out of the store: item ids with the quantity of each.',
      items:{type:'object',
        properties:{item_id:{type:'string',description:'The item to take out.'},
          quantity:{type:'integer',minimum:1,description:'How many units to take.'}},
        required:['item_id','quantity']}},
    base_id:{type:'string',
      description:'Optional: the base to withdraw at. It must be the one the ship is docked at.'},
  },
  required:['items'],
};

export default async (ctx:Ctx,args:WithdrawParams):Promise<JobOutcome>=>{
  const outcome=await withdraw(ctx,args);
  const rows=outcome.yield??[];
  const took=rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');
  const result=outcome.result as {base_id?:string;short?:{item_id:string;why:string}[]}|undefined;
  const base=String(result?.base_id??'this base');
  const why=(result?.short??[]).map(row=>`${row.item_id} ${row.why}`).join(', ');
  return {job:'withdraw',outcome:outcome.outcome,result:outcome.result,
    reason:rows.length
      ?`withdrew ${took} at ${base}`
      :outcome.outcome==='done'?`nothing to withdraw at ${base}: ${why||'nothing was asked for'}`
        :String(outcome.reason)};
};
