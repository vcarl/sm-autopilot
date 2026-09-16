/** The hangar: modules on the ship you fly, and the next hull. */
import type {CommissionQuoteResponse,InsurancePolicy,ShipClass,ShipListing,V2Module,V2Ship} from '@spacemolt/lib';
import type {Outcome} from './types.ts';

export interface Fit {
  installed:string[];removed:string[];
  /** The fitted modules after the change. */
  modules:V2Module[];
  /** The grid after the change: `cpu_used/cpu_capacity`, `power_used/power_capacity`. */
  ship:Pick<V2Ship,'cpu_used'|'cpu_capacity'|'power_used'|'power_capacity'|'utility_slots'|'weapon_slots'|'defense_slots'>;
  /** Module ids that would not fit and why. */
  short:{id:string;why:string}[];
}

/** Install and/or remove modules while docked. Ids are `module_id`s from the hold or this
 * base's store (a stored module is withdrawn first). Refused over CPU or power capacity,
 * with the numbers. Removed modules go to the hold, or the store when the hold is full.
 * Costs nothing. Fitting to 90%+ `power_used/power_capacity` trains engineering passively;
 * `next` says how far under the grid you are. */
export function refit(change:{install?:string[];remove?:string[]}):Promise<Outcome<Fit>> {throw new Error('unimplemented');}

/** A player listing or a yard commission, each beside the class it is and one line on how
 * it compares with the hull you fly ("cargo +110, speed -1, minimum_crew 1"). */
export type ForSale=
  |{kind:'listing';listing:ShipListing;class:ShipClass;versus:string}
  |{kind:'commission';quote:CommissionQuoteResponse;class:ShipClass;versus:string};

/** Hulls for sale within a budget, here or at a named base: `ship/browse_ships` listings and
 * `ship/commission_quote` for classes this yard can build. Budget defaults to credits minus
 * `permissions.credit_reserve`. Sorted by `cargo_capacity` per credit, because cargo
 * multiplies every loop. Reads only. Flags crew traps: a class whose `minimum_crew` exceeds
 * your crew capacity is listed with a warning, not hidden. */
export function shipsForSale(opts?:{budget?:number;baseId?:string;classId?:string}):Promise<Outcome<{for_sale:ForSale[]}>> {throw new Error('unimplemented');}

export interface Purchase {
  /** The hull you now fly, when the switch happened; otherwise the one you still fly. */
  ship:V2Ship;
  price:number;
  switched:boolean;
  /** The previous hull's id and where it is parked. */
  previous:{ship_id:string;base_id:string};
  policy?:InsurancePolicy;
}

/** Buy a listed hull (`listing_id`) or commission a class (`class_id` with `commission:true`)
 * and, when this base has a shipyard, switch to it, move the hold across, refit what fits,
 * recruit to `minimum_crew`, and buy insurance. Refused when the price takes the wallet
 * under `credit_reserve` or over `max_spend`, or when `minimum_crew` cannot be met here. A
 * commission that stalls in `sourcing` is `partial` with `materials_to_source` named. Costs
 * the price; trains nothing. `next` says what modules did not fit the new grid. */
export function buyShip(id:string,opts?:{commission?:boolean;switchTo?:boolean}):Promise<Outcome<Purchase>> {throw new Error('unimplemented');}
