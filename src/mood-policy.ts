// D2 fuel units kept beyond the quoted route. Job admission and other mood
// margins are separate consumers; Tired can still make its resupply trip.
const fuelReserves=Object.freeze({
  Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0,
});
export type Mood=keyof typeof fuelReserves;
// D2 max spend per job, in credits. Tired's row reads "service only": the resupply
// leg is bounded by the wallet and the operator's reserve, never by a job budget a
// Tired pilot is forbidden to earn.
const serviceSpend=Object.freeze({
  Relaxed:500,Cautious:500,Focused:1000,Opportunistic:1000,Aggressive:2000,Tired:Infinity,
});
export function resolveServiceSpend(mood:Mood):number {
  if(!Object.hasOwn(serviceSpend,mood))throw new Error('Unknown service mood');
  return serviceSpend[mood];
}
// D2 hull retreat fraction: walk away from a fight below this share of max hull.
// Away from a dock it is the walk-away line, not a service target (D3).
const retreatHull=Object.freeze({
  Relaxed:.90,Cautious:.95,Focused:.90,Opportunistic:.90,Aggressive:.80,Tired:.95,
});
export function resolveWalkAway(mood:Mood):number {
  if(!Object.hasOwn(retreatHull,mood))throw new Error('Unknown walk-away mood');
  return retreatHull[mood];
}
/** Operator-owned units, separate from numeric script allocations. */
export interface OperatorFuelPolicy {fuelReserveFloor?:number}

export function resolveFuelReserve(mood:Mood,operatorPolicy:OperatorFuelPolicy={}):number {
  if(!Object.hasOwn(fuelReserves,mood))throw new Error('Unknown travel mood');
  const floor=operatorPolicy.fuelReserveFloor;
  if(floor!==undefined&&(typeof floor!=='number'||!Number.isFinite(floor)||floor<0))
    throw new Error('Operator fuel reserve floor must be a finite non-negative number');
  return Math.max(fuelReserves[mood],floor??0);
}
