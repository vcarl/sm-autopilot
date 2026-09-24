/** More than one hull. One character flies one ship; the rest sit parked at stations, safe
 * from your death, and `switch_ship` at a shipyard swaps which one you fly. Several ships
 * flying at once is several characters, which is a runtime question, not a library one
 * (DESIGN.md "Fleet"). */
import type {ListShipsResponse,StoredShip,SwitchShipResponse,V2Ship} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

/** Every ship you own and where it is parked (`ship/list_ships`), with the active one
 * marked and, for each parked hull, the base's shipyard service (needed to switch). Reads
 * only. `next` says which parked hull would suit the current stance. */
export function ships():Promise<Outcome<ListShipsResponse&{active:V2Ship;parked:(StoredShip&{base_id:string;shipyard:boolean})[]}>> {throw new Error('unimplemented');}

/** Swap to a hull parked at the station you are docked at. Needs a shipyard service here.
 * The hold moves to this base's store first (`stow`), modules stay on their own hulls, and
 * the new hull is serviced and insured before the
 * function returns. Refused undocked, without a shipyard, or when `minimum_crew` is unmet.
 * Costs the service; trains nothing. */
export function switchShip(shipId:string):Promise<Outcome<{switched:SwitchShipResponse;ship:V2Ship}>> {throw new Error('unimplemented');}
