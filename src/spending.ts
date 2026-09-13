import {evaluateRules,type Decision} from './rules.ts';
import type {Job} from './execution-store.ts';

const paidFields:Record<string,string>={'spacemolt/refuel':'cost','spacemolt/repair':'cost','spacemolt/buy':'total_cost'};
export interface SpendingEvidence {
  gross_spend:number|null;
  known_gross_spend:number;
  unpriced_actions:{job_id:string;action_index:number;action:string;reason:string}[];
}
export interface BudgetSpending extends SpendingEvidence {policy_decision:Decision;owner_job_id:string;max_spend:number;credit_reserve:number}
export const isPaidCommand=(action:string,params:unknown={})=>action in paidFields||
  (action==='spacemolt/craft'&&params!==null&&typeof params==='object'&&
    'id' in params&&typeof params.id==='string'&&(!('dry_run' in params)||params.dry_run!==true));
const costEvidence=(action:string)=>action==='spacemolt/buy'?'accepted lifetime credits_spent counter interval covering the market subtotal':paidFields[action]??'escrowed.labor and escrowed.fee or refreshed lifetime credits_spent counter interval';
const validCost=(cost:unknown):cost is number=>typeof cost==='number'&&Number.isFinite(cost)&&cost>=0;

export function withCraftSpendEvidence(reply:any,before:unknown,after?:unknown,phase:'accepted'|'refreshed'='accepted'):any {
  const result=reply?.structuredContent??reply?.delta?.details??reply;
  if(!result||typeof result!=='object')return reply;
  const receipt={...result,_hermes_spending:{source:'lifetime_credits_spent_interval',phase,before,after}};
  return reply.structuredContent?{...reply,structuredContent:receipt}:
    reply.delta?.details?{...reply,delta:{...reply.delta,details:receipt}}:receipt;
}

/** Buy total_cost excludes sales tax. Count the full observed debit interval conservatively. */
export function commandSpend(action:string,reply:any,params:unknown={}):number|null {
  const field=paidFields[action];
  if(!isPaidCommand(action,params))return 0;
  const result=reply?.structuredContent??reply?.delta?.details??reply;
  if(action==='spacemolt/buy') {
    const evidence=result?._hermes_spending;
    if(evidence?.source!=='lifetime_credits_spent_interval'||!validCost(result?.total_cost)||
      evidence.market_subtotal!==result.total_cost||!validCost(evidence.before)||!validCost(evidence.after))return null;
    const total=evidence.after-evidence.before;
    // Other asynchronous debits may share the interval; income cannot conceal spending.
    return validCost(total)&&total>=result.total_cost?total:null;
  }
  if(action==='spacemolt/craft') {
    const escrow=result?.escrowed;
    if(result?.kind!=='job'||!escrow||typeof escrow!=='object')return null;
    if(('labor' in escrow&&!validCost(escrow.labor))||('fee' in escrow&&!validCost(escrow.fee)))return null;
    if(validCost(escrow.labor)&&validCost(escrow.fee)) {
      const total=escrow.labor+escrow.fee;
      return validCost(total)?total:null;
    }
    const evidence=result._hermes_spending;
    if(evidence?.source!=='lifetime_credits_spent_interval'||evidence.phase!=='refreshed'||
      !validCost(evidence.before)||!validCost(evidence.after))return null;
    const total=evidence.after-evidence.before,known=(escrow.labor??0)+(escrow.fee??0);
    return validCost(total)&&total>=known?total:null;
  }
  const cost=result?.[field!];
  return validCost(cost)?cost:null;
}
export function requireCommandSpend(action:string,reply:unknown,params:unknown={}):number {
  const cost=commandSpend(action,reply,params);
  if(cost===null)throw new Error(`Unpriced accepted ${action}: authoritative ${costEvidence(action)} required before further spending`);
  return cost;
}

/** Each journal entry contributes once, even when recovery retains two replies. */
export function jobSpending(job:Job):SpendingEvidence {
  let known=0;
  const unpriced:SpendingEvidence['unpriced_actions']=[];
  job.actions.forEach((entry,action_index)=>{
    if(!isPaidCommand(entry.action,entry.params))return;
    const result=entry.result as Record<string,unknown>|undefined;
    if(entry.accepted_result===undefined&&entry.status==='confirmed'&&result?.fatal===false&&result.action_completed===false&&result.outcome_unknown===false)return;
    const cost=commandSpend(entry.action,entry.accepted_result??entry.result,entry.params);
    if(cost===null)unpriced.push({job_id:job.id,action_index,action:entry.action,reason:`Authoritative ${costEvidence(entry.action)} unavailable; wallet changes are not cost evidence`});
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
  const policy_decision=evaluateRules({phase:'budget',context:job.context,ownerLimits:owner.context.limits});
  const {limits}=policy_decision;
  return {policy_decision,owner_job_id:ownerId,max_spend:limits.max_spend!,
    credit_reserve:limits.credit_reserve!,
    gross_spend:unpriced.length?null:known,known_gross_spend:known,unpriced_actions:unpriced};
}
