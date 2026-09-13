import {evaluateRules,deniedTexts,type Decision} from './rules.ts';
export interface TransportTimeBudget {start_tick:number;max_ticks:number;last_observed_tick:number}
export interface TransportTimeCheck {
  policy_decision:Decision;status:'ready'|'blocked';observed_tick:unknown;limitation:string;reason?:string;
  budget?:TransportTimeBudget;start_tick?:number;max_ticks?:number;elapsed_ticks?:number;remaining_ticks?:number;overrun_ticks?:number;
}
const tick=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;

/** Observed server ticks bound further work, never an already accepted transit. */
export function checkTransportTime(currentTick:unknown,maxTicks:number,previous:TransportTimeBudget|undefined,allowStart:boolean):TransportTimeCheck {
  const check:Omit<TransportTimeCheck,'policy_decision'>={observed_tick:currentTick,status:'blocked',
    limitation:'Observed server tick, not a continuous clock or preflight ETA. A submitted movement may exceed the allocation; finish or reconcile it before deciding on another leg.'};
  const invalid=(reason:string,budget?:TransportTimeBudget)=>{const policy_decision=evaluateRules({phase:'checkpoint',action:'transport',readiness:[reason]});return {...check,reason,budget,policy_decision};};
  if(!tick(currentTick)||!tick(maxTicks))return invalid('Authoritative server tick and positive operating allocation required',previous);
  if(!previous&&!allowStart)return invalid('Original transport tick baseline unavailable; do not reset elapsed allowance on resume');
  const budget=previous??{start_tick:currentTick,max_ticks:maxTicks,last_observed_tick:currentTick};
  if(!tick(budget.start_tick)||!tick(budget.max_ticks)||!tick(budget.last_observed_tick)||budget.last_observed_tick<budget.start_tick||currentTick<budget.last_observed_tick)return invalid('Transport tick evidence regressed or original allocation is invalid',previous);
  const elapsed=currentTick-budget.start_tick;
  const decision=evaluateRules({phase:'checkpoint',action:'transport',policyLimits:{max_ticks:Math.min(budget.max_ticks,maxTicks)},time:{elapsed,maximum:Math.min(budget.max_ticks,maxTicks)}});
  const effective=decision.limits.max_ticks!;
  return {...check,policy_decision:decision,budget:{...budget,last_observed_tick:currentTick},start_tick:budget.start_tick,
    max_ticks:effective,elapsed_ticks:elapsed,remaining_ticks:Math.max(0,effective-elapsed),overrun_ticks:Math.max(0,elapsed-effective),
    status:decision.allowed?'ready':'blocked',reason:decision.allowed?undefined:deniedTexts(decision).join('; ')};
}
