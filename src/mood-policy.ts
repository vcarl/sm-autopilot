// D2 fuel units kept beyond the quoted route. Job admission and other mood
// margins are separate consumers; Tired can still make its resupply trip.
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
/** Standing bounds, in units, separate from numeric script allocations. */
export interface StandingFuelPolicy {fuelReserveFloor?:number}

export function resolveFuelReserve(mood:Mood,standingPolicy:StandingFuelPolicy={}):number {
  if(!Object.hasOwn(fuelReserves,mood))throw new Error('Unknown travel mood');
  const floor=standingPolicy.fuelReserveFloor;
  if(floor!==undefined&&(typeof floor!=='number'||!Number.isFinite(floor)||floor<0))
    throw new Error('Standing fuel reserve floor must be a finite non-negative number');
  return Math.max(fuelReserves[mood],floor??0);
}

/** The margin a mood's ship has crossed, if any: fuel under the reserve, hull under the walk-away
 * line, credits under the standing reserve. ponytail: the fuel line is a flat reserve, not a route
 * home; `serviceElsewhere` (play/service.ts) prices the route when a service is refused.
 * ponytail: `crossed` has no hysteresis. A ship sitting exactly on a line flips per command; add a
 * band if the journal ever shows it chattering. */
export function crossed(mood:Mood,ship:{fuel:number;hull:number;max_hull:number}|undefined,
  credits:number,creditReserve=0):string|null {
  if(!ship)return null;
  if(ship.fuel<resolveFuelReserve(mood))return `fuel ${ship.fuel} under the ${mood} reserve ${resolveFuelReserve(mood)}`;
  const line=Math.floor(resolveWalkAway(mood)*ship.max_hull);
  if(ship.hull<line)return `hull ${ship.hull}/${ship.max_hull} under the ${mood} walk-away line ${line}`;
  if(credits<creditReserve)return `credits ${credits} under the reserve ${creditReserve}`;
  return null;
}

/** The mood, derived and never stored: the working mood the caller names (the stance's own), or
 * Tired while the ship is past that mood's margins. Resupply clears it by changing the facts. */
export function moodNow(working:Mood,ship:{fuel:number;hull:number;max_hull:number}|undefined,
  credits:number,creditReserve=0):{mood:Mood;tired_by?:string} {
  const why=crossed(working,ship,credits,creditReserve);
  return why?{mood:'Tired',tired_by:why}:{mood:working};
}
