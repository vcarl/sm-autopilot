/** Hunting: wildlife anywhere (legal everywhere), pirates in low-police space. The only loops
 * that train weapons, gunnery, tactics, and — by being hit — shields and armor. */
import type {CreatureInfo,EnrichedWreck,GetBattleStatusResponse,V2NearbyPirate} from '@spacemolt/lib';
import type {Outcome,Row} from '../types.ts';

export interface Fight {
  target:CreatureInfo|V2NearbyPirate;
  /** The last `battle/status` read before the battle ended. */
  last_status?:GetBattleStatusResponse;
  outcome:'down'|'escaped'|'broke off'|'unresolved';
  hull_before:number;hull_after:number;
  /** The wreck it left and what was looted from it. */
  wreck?:EnrichedWreck;loot:Row[];
}

export interface Hunted {
  poi_id:string;base_id:string;
  fights:Fight[];
  /** What reached the store. */
  stowed:Row[];
  /** Why the loop ended: `asked` fights done, nothing there, hull line, hold full, tired. */
  ended:'asked'|'nothing here'|'hull'|'hold full'|'stopped'|'tired';
}

/** Out to `poi`, take up to `fights` fights (default 1) against creatures (default) or
 * pirates (`target:'pirate'`, only with `permissions.may_attack` including it), loot what
 * fits, back to `base` (default: the base you left, then home), stow, service.
 *
 * Nothing at the habitat is `done` with `fights: []` and `ended:'nothing here'` — the trip
 * was made, the fact was learned — and the return leg skips the service.
 *
 * Which fight: a creature that is `in_combat` or `branded` is declined; a named `species` is
 * one you have fought before and admits a creature the scan cannot say the speed of; without
 * it, only a creature slower than the ship is taken. Pirates: never anything named
 * `[POLICE]`, never a player, never above your `tier`. The battle is the game's; this
 * watches `battle/status`, advances while out of reach, and retreats the moment `hull`
 * crosses the mood's walk-away fraction (Cautious 0.95 … Aggressive 0.80). A ship that
 * escapes at 30% hull keeps everything.
 *
 * Refused before flying without a fitted weapon (`V2Module.type === 'weapon'`) holding
 * ammunition (`current_ammo > 0`), and with no free cargo for loot. Costs fuel, ammunition,
 * hull. Trains weapons, gunnery, tactics, shields, armor, xenobiology (creatures),
 * bounty_hunting (pirates). Tired (ammunition or hull through the margin) ends the loop
 * after the current fight and comes home. */
export function hunt(opts:{poi:string;fights?:number;species?:string;target?:'creature'|'pirate';base?:string}):Promise<Outcome<Hunted>> {throw new Error('unimplemented');}
