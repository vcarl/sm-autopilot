/** Sealed-package freight: accept a contract, carry the package, deliver it. Builds the
 * carrier tier (probationary → licensed at 5 deliveries → trusted → prime), which is the
 * only thing that raises the liability you may carry. */
import type { CarrierProfile, ShippingActiveContract, ShippingListing, ShippingProfileResponse, ShippingSettlementResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from '../game.ts';
import type { Outcome } from '../types.ts';
/** The board here, filtered to what you may take and can carry, beside your carrier record. */
export interface Board {
    /** `ShippingListing.eligible` already says whether your tier allows it; `reason` says why not. */
    listings: (ShippingListing & {
        /** Fuel `find_route` quotes to the destination, and whether the deadline is reachable. */
        fuel: number;
        reachable: boolean;
        /** Package size against your free cargo. */
        fits: boolean;
        /** `reserved_exposure`: what carrying it puts against your tier's allowance. */
        liability: number;
        /** `base_reward` less the fuel bill at this base's `fuel_price_all_in`. */
        net: number;
    })[];
    profile: ShippingProfileResponse;
    active: ShippingActiveContract[];
}
/** Every sealed package occupies exactly 100 cargo, whatever is inside (docs/guides/packages). */
export declare const PACKAGE_CARGO = 100;
/** The shipping board at this base (`shipping/list`), your profile and your active
 * contracts. Each listing carries a route quote so you can see fuel against
 * `contract.base_reward`; listings your tier, your liability allowance or
 * `permissions.max_liability` refuse are dropped, and what is left is sorted by net reward
 * per fuel unit. Reads only. `next` names the best three.
 *
 * `reachable` is fuel only — whether the tank covers the quoted route.
 * The lib gives a deadline in ticks and a route in jumps with no published tick cost per
 * jump, so a deadline is not checked here; read `deadline_ticks` yourself. */
export declare function freightBoard(opts?: {
    destination?: string;
    limit?: number;
}): Promise<Outcome<Board>>;
/** `freightBoard` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal or a lost reply on a
 * read ends it naming the action and the code; a destination that is no place is an unroutable listing, not a failed board. */
export declare const freightBoardEffect: (opts?: {
    destination?: string;
    limit?: number;
}) => Effect.Effect<Outcome<Board>, never, Game | import("../runtime.ts").Run>;
export interface Hauled {
    contract: ShippingActiveContract['contract'];
    settlement?: ShippingSettlementResponse;
    profile_after: CarrierProfile;
    /** Which leg the function ended on. */
    leg: 'accepted' | 'loaded' | 'delivered';
}
/** One package, board to delivery: `shipping/get`, `shipping/accept`, `storage/withdraw
 * package:<id>` (an accepted package sits in your store at the origin; it is not aboard
 * until withdrawn), `goTo(destination_base_id)`, `shipping/deliver`.
 *
 * Idempotent per leg, re-entered from the live world: an active contract skips the accept,
 * a package already aboard skips the withdraw, standing at the destination skips the flight.
 *
 * Refused when `profile.debt_blocks_acceptance`, when the contract's liability exceeds
 * `permissions.max_liability` or the tier's limits, or when the package will not fit — each
 * with the numbers, and nothing sent past the check. Never accepts a contract it cannot
 * complete: failure is a debt and a tier demotion.
 *
 * Costs fuel; pays `carrier_payout` plus speed bonus, measured into `gained.credits`.
 * Tired mid-haul: the leg in flight finishes, the package stays where it is, and the
 * function returns `partial` with the contract still active; `service()` then `haul` again
 * with the same id resumes. A reply lost on the accept or the delivery is never re-sent:
 * the active list is read to see whether it landed, and a delivery that may have is `partial`. */
export declare function haul(shipmentId: string): Promise<Outcome<Hauled>>;
/** `haul` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal ends it naming the action and
 * the code; a lost reply on the accept or the deliver is never re-sent, and the active list is re-read. */
export declare const haulEffect: (shipmentId: string) => Effect.Effect<Outcome<Hauled>, never, Game | import("../runtime.ts").Run>;
