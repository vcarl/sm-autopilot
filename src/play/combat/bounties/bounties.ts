/** Pirate bounties: single bounty ~2,000 cr, three-kill sweeps ~5,000, medium contracts
 * 6,000–8,000. Intermediate stage and up: needs a hull that can take a hit. */
import type {ActiveMissionInfo,V2NearbyPirate} from '@spacemolt/lib';
import type {Outcome} from '../../types.ts';
import type {Fight} from '../hunting.ts';

export interface Patrolled {
  /** The bounty mission this patrol was flown for, if any. */
  mission?:ActiveMissionInfo;
  systems:string[];
  seen:V2NearbyPirate[];
  fights:Fight[];
  bounty_credits:number;
}

/** Sweep `systems` (default: the police ≤ 20 neighbours one jump out) for pirates at or
 * below `maxTier`, fight each with `hunt`'s rules, and come home. Takes a bounty mission's
 * targets first when one is active. Refused without insurance when the fitted value exceeds
 * `max_spend`, or in Cautious mood.
 * Trains bounty_hunting, weapons, gunnery, tactics, shields, armor. Costs fuel, ammunition,
 * hull. Tired ends the sweep after the current system. */
export function patrol(opts?:{systems?:string[];maxTier?:number;fights?:number}):Promise<Outcome<Patrolled>> {throw new Error('unimplemented');}
