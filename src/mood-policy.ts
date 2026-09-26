// D2 fuel reserve, in units: the line under which the runtime imposes Tired (D3), and so the
// trigger for resupply. It is not a travel margin; a trip is admitted on its route cost alone
// (operator's decision, 2026-09-26).
const fuelReserves=Object.freeze({
  Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0,
});
export type Mood=keyof typeof fuelReserves;
// D2 max spend per job, in credits. Tired's row reads "service only": the resupply
// leg is bounded by the wallet and the standing reserve, never by a job budget a
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
export function resolveFuelReserve(mood:Mood):number {
  if(!Object.hasOwn(fuelReserves,mood))throw new Error('Unknown travel mood');
  return fuelReserves[mood];
}
