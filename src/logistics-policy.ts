import type {ExecutionContext,Mood} from './execution-policy.ts';

export interface LogisticsPolicy {
  version:string;max_route_jumps:number;max_liability:number;credit_reserve:number;
}
const allocations:Record<Mood,{jumps:number;liability:number}>={
  Relaxed:{jumps:1,liability:500},Cautious:{jumps:1,liability:500},
  Focused:{jumps:2,liability:1000},Opportunistic:{jumps:2,liability:1000},
  Aggressive:{jumps:2,liability:2000},Tired:{jumps:0,liability:0},
};
/** The allocation caps failure debt; reserved exposure is checked against carrier capacity separately. */
export function logisticsPolicy(context:ExecutionContext):LogisticsPolicy {
  const allocation=allocations[context.mood];
  return {version:'one-destination-2',max_route_jumps:allocation.jumps,
    max_liability:allocation.liability,credit_reserve:context.limits.credit_reserve};
}
