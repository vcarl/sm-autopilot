import { Effect } from 'effect';
import type { ReadinessAccount } from './readiness.ts';
import { Game } from './play/game.ts';
/** `quoted` is the station's posted price for the quantity offered, seen before anything
 * was sent. `cleared` is the wallet delta measured between authoritative reads. They are
 * never the same number by construction, and a reply's own total_earned is neither. */
export interface SettledSale {
    item_id: string;
    quantity: number;
    quoted: number;
    cleared: number;
}
export interface SettledMove {
    item_id: string;
    quantity: number;
}
/** Offered but not confirmed by the post-state. `quoted` is null when nothing was quoted. */
export interface UnsettledRow {
    item_id: string;
    quantity: number;
    quoted: number | null;
    gap: string;
}
export interface SettleOutcome {
    sold: SettledSale[];
    deposited: SettledMove[];
    /** The station will not buy it and has no storage to take it: it is still in the hold. */
    held: SettledMove[];
    unsettled: UnsettledRow[];
    credits_before: number;
    credits_after: number;
}
/** Sell or deposit the hold at the station the ship is docked at.
 *
 * Money moves against an observed book, and only the post-state says a sale happened:
 * `quoted` comes from the market read before anything is sent, `cleared` from the wallet
 * and cargo deltas between authoritative reads afterwards. A sale whose post-state shows
 * an unmoved wallet or an unmoved hold is unsettled with the gap, never reported as
 * income. A lost reply is reconciled from that same post-state — gone and paid is
 * cleared, anything else is unsettled with the gap and the cause — so a mutation is never
 * re-sent after a lost reply, and nothing is repeated blind. Items on `keep` are the pilot's own: fitted
 * spares, cabins, anything the caller is carrying on purpose. They are never offered, and
 * neither are the fuel cells the reserve keeps aboard (`disposable`).
 */
export declare const settleCargoEffect: (account: ReadinessAccount, options?: {
    keep?: string[];
}) => Effect.Effect<SettleOutcome, import("./play/codes.ts").GameError, Game>;
