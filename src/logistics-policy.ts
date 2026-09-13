import {evaluateRules} from './rules.ts';
import type {ExecutionContext} from './execution-policy.ts';

export interface LogisticsPolicy {
  version:string;max_route_jumps:number;max_liability:number;credit_reserve:number;
}
/** Logistics consumes the same mood rules as every other execution boundary. */
export function logisticsPolicy(context:ExecutionContext):LogisticsPolicy {
  const {limits}=evaluateRules({phase:'catalog',context,action:'transport'});
  return {version:'one-destination-2',max_route_jumps:limits.max_route_jumps!,
    max_liability:limits.max_liability!,credit_reserve:limits.credit_reserve!};
}
