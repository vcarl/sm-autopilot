/** Sealed-package freight: accept a contract, carry the package, deliver it. Builds the
 * carrier tier (probationary → licensed at 5 deliveries → trusted → prime), which is the
 * only thing that raises the liability you may carry. */
import type {CarrierProfile,ShippingActiveContract,ShippingListing,ShippingProfileResponse,ShippingSettlementResponse} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

/** The board here, filtered to what you may take and can carry, beside your carrier record. */
export interface Board {
  /** `ShippingListing.eligible` already says whether your tier allows it; `reason` says why not. */
  listings:(ShippingListing&{
    /** Fuel `find_route` quotes to the destination, and whether the deadline is reachable. */
    fuel:number;reachable:boolean;
    /** Package size against your free cargo. */
    fits:boolean;
  })[];
  profile:ShippingProfileResponse;
  active:ShippingActiveContract[];
}

/** The shipping board at this base (`shipping/list`), your profile and your active
 * contracts. Each listing carries a route quote so you can see fuel against
 * `contract.base_reward`. Reads only. `next` names the best reward-per-fuel listing that is
 * eligible, fits, and is inside `permissions.max_liability`. */
export function freightBoard():Promise<Outcome<Board>> {throw new Error('unimplemented');}

export interface Hauled {
  contract:ShippingActiveContract['contract'];
  settlement?:ShippingSettlementResponse;
  profile_after:CarrierProfile;
  /** Which leg the function ended on. */
  leg:'accepted'|'loaded'|'delivered';
}

/** One package, board to delivery: `shipping/accept`, `storage/withdraw package:<id>` (an
 * accepted package sits in your store at the origin; it is not aboard until withdrawn),
 * `goTo(destination_base_id)`, `shipping/deliver`. Idempotent per leg: an active contract
 * whose package is already aboard re-enters at the flight.
 *
 * Refused when `profile.debt_blocks_acceptance`, when the contract's liability exceeds
 * `permissions.max_liability` or the tier's per-package limit, when the package will not
 * fit, or when the route cannot make the deadline at the mood's fuel reserve. Never accepts a
 * contract it cannot complete: failure is a debt and a tier demotion.
 *
 * Costs fuel; pays `carrier_payout` plus speed bonus, measured into `gained.credits`.
 * Trains navigation and piloting. Tired mid-haul: the package stays aboard and the function
 * returns `partial` at the nearest serviced base; `haul` again after `service()` resumes. */
export function haul(shipmentId:string):Promise<Outcome<Hauled>> {throw new Error('unimplemented');}
