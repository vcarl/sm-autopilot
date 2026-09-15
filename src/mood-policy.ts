// D2 fuel units kept beyond the quoted route. Job admission and other mood
// margins are separate consumers; Tired can still make its resupply trip.
const fuelReserves=Object.freeze({
  Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0,
});
export type Mood=keyof typeof fuelReserves;
/** Operator-owned units, separate from numeric script allocations. */
export interface OperatorFuelPolicy {fuelReserveFloor?:number}

export function resolveFuelReserve(mood:Mood,operatorPolicy:OperatorFuelPolicy={}):number {
  if(!Object.hasOwn(fuelReserves,mood))throw new Error('Unknown travel mood');
  const floor=operatorPolicy.fuelReserveFloor;
  if(floor!==undefined&&(typeof floor!=='number'||!Number.isFinite(floor)||floor<0))
    throw new Error('Operator fuel reserve floor must be a finite non-negative number');
  return Math.max(fuelReserves[mood],floor??0);
}
