// D2 fuel units kept beyond the quoted route. Job admission and other mood
// margins are separate consumers; Tired can still make its resupply trip.
const fuelReserves=Object.freeze({
  Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0,
});
export type Mood=keyof typeof fuelReserves;

export function resolveFuelReserve(mood:Mood):number {
  if(!Object.hasOwn(fuelReserves,mood))throw new Error('Unknown travel mood');
  return fuelReserves[mood];
}
