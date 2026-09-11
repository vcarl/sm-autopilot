import type {Job} from './execution-store.ts';

const paidFields:Record<string,string>={'spacemolt/refuel':'cost','spacemolt/repair':'cost','spacemolt/buy':'total_cost'};
export interface SpendingEvidence {
  gross_spend:number|null;
  known_gross_spend:number;
  unpriced_actions:{job_id:string;action_index:number;action:string;reason:string}[];
}
export interface BudgetSpending extends SpendingEvidence {owner_job_id:string;max_spend:number;credit_reserve:number}
export const isPaidCommand=(action:string)=>action in paidFields;

/** These pinned response fields are totals. Refuel tax is already in cost. */
export function commandSpend(action:string,reply:any):number|null {
  const field=paidFields[action];
  if(!field)return 0;
  const result=reply?.structuredContent??reply?.delta?.details??reply;
  const cost=result?.[field];
  return typeof cost==='number'&&Number.isFinite(cost)&&cost>=0?cost:null;
}
export function requireCommandSpend(action:string,reply:unknown):number {
  const cost=commandSpend(action,reply);
  if(cost===null)throw new Error(`Unpriced accepted ${action}: authoritative ${paidFields[action]} required before further spending`);
  return cost;
}

/** Each journal entry contributes once, even when recovery retains two replies. */
export function jobSpending(job:Job):SpendingEvidence {
  let known=0;
  const unpriced:SpendingEvidence['unpriced_actions']=[];
  job.actions.forEach((entry,action_index)=>{
    if(!isPaidCommand(entry.action))return;
    const result=entry.result as Record<string,unknown>|undefined;
    if(entry.accepted_result===undefined&&entry.status==='confirmed'&&result?.fatal===false&&result.action_completed===false&&result.outcome_unknown===false)return;
    const cost=commandSpend(entry.action,entry.accepted_result??entry.result);
    if(cost===null)unpriced.push({job_id:job.id,action_index,action:entry.action,reason:`Authoritative ${paidFields[entry.action]} unavailable; wallet changes are not cost evidence`});
    else known+=cost;
  });
  return {gross_spend:unpriced.length?null:known,known_gross_spend:known,unpriced_actions:unpriced};
}

/** Cleanup receipts own their costs, but draw from the original job's allowance. */
export function jobBudget(job:Job,jobs:Job[]):BudgetSpending {
  const ownerId=job.budget_owner_id??job.id;
  const owner=jobs.find(candidate=>candidate.id===ownerId);
  if(!owner)throw new Error('Cleanup spending owner is unavailable');
  const expenses=jobs.filter(candidate=>candidate.id===ownerId||candidate.budget_owner_id===ownerId).map(jobSpending);
  const known=expenses.reduce((total,expense)=>total+expense.known_gross_spend,0);
  const unpriced=expenses.flatMap(expense=>expense.unpriced_actions);
  return {owner_job_id:ownerId,max_spend:owner.context.limits.max_spend,
    credit_reserve:Math.max(owner.context.limits.credit_reserve,job.context.limits.credit_reserve),
    gross_spend:unpriced.length?null:known,known_gross_spend:known,unpriced_actions:unpriced};
}
