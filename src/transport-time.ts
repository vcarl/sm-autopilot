export interface TransportTimeBudget {start_tick:number;max_ticks:number;last_observed_tick:number}
export interface TransportTimeCheck {
  status:'ready'|'blocked';observed_tick:unknown;limitation:string;reason?:string;
  budget?:TransportTimeBudget;start_tick?:number;max_ticks?:number;elapsed_ticks?:number;remaining_ticks?:number;overrun_ticks?:number;
}
const tick=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;

/** Observed server ticks bound further work, never an already accepted transit. */
export function checkTransportTime(currentTick:unknown,maxTicks:number,previous:TransportTimeBudget|undefined,allowStart:boolean):TransportTimeCheck {
  const check:TransportTimeCheck={observed_tick:currentTick,status:'blocked',
    limitation:'Observed server tick, not a continuous clock or preflight ETA. A submitted movement may exceed the allocation; finish or reconcile it before deciding on another leg.'};
  if(!tick(currentTick)||!tick(maxTicks))return {...check,reason:'Authoritative server tick and positive operating allocation required',budget:previous};
  if(!previous&&!allowStart)return {...check,reason:'Original transport tick baseline unavailable; do not reset elapsed allowance on resume'};
  const budget=previous??{start_tick:currentTick,max_ticks:maxTicks,last_observed_tick:currentTick};
  if(!tick(budget.start_tick)||!tick(budget.max_ticks)||!tick(budget.last_observed_tick)||budget.last_observed_tick<budget.start_tick||currentTick<budget.last_observed_tick)return {...check,reason:'Transport tick evidence regressed or original allocation is invalid',budget:previous};
  const elapsed=currentTick-budget.start_tick,effective=Math.min(budget.max_ticks,maxTicks);
  return {...check,budget:{...budget,last_observed_tick:currentTick},start_tick:budget.start_tick,
    max_ticks:effective,elapsed_ticks:elapsed,remaining_ticks:Math.max(0,effective-elapsed),overrun_ticks:Math.max(0,elapsed-effective),
    status:elapsed<effective?'ready':'blocked',reason:elapsed<effective?undefined:'Observed transport elapsed-tick allocation exhausted; no further productive movement'};
}
