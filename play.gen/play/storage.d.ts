/** Station storage: custody that survives death, readable from anywhere, moved only when
 * docked. Never sells, never buys. */
import type { V2CargoItem, ViewStorageResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from './game.ts';
import type { Outcome, Row, Want } from './types.ts';
export interface Moved {
    base_id: string;
    /** What moved, measured from the hold before and after. */
    moved: Row[];
    /** What did not move, with the reason: `not held`, `not in store`, `no room`, or the game's
     * refusal. The first two mean the end state already holds, so they do not spoil the status. */
    short: {
        item_id: string;
        requested: number;
        moved: number;
        why: string;
    }[];
    /** The hold and the store after the last move. */
    cargo: V2CargoItem[];
    store: ViewStorageResponse;
}
/** Units of each row that fit `room` cargo: every want when they all fit, else each row's
 * share of the room in proportion to its footprint, floored, the leftover handed out in order. */
export declare function share(room: number, wants: number[], sizes: number[]): number[];
export declare const stowEffect: (items: Want[]) => Effect.Effect<Outcome<Moved>, never, Game>;
export declare const withdrawEffect: (items: Want[]) => Effect.Effect<Outcome<Moved>, never, Game>;
/** Deposit the named rows from the hold into the store here. Over `storage/deposit` it
 * adds: the `storage` counter checked first, each row bounded by what the hold shows, and
 * the store re-read after. Omit a row's `quantity` to mean all held. Refused when not docked
 * or nothing was named; a row not aboard is `short` and `done`: there was nothing to stow. */
export declare function stow(items: Want[]): Promise<Outcome<Moved>>;
/** Take rows out of the store here into the hold. Over `storage/withdraw` it adds: the
 * counter check, each row bounded by the store's count and the hold's room counted in each
 * item's cargo `size`, and the reason the rest stayed. Rows that together overfill the hold
 * share its room in proportion to their footprint: each moves partly, the rest `short` with
 * `no room`, and the status is `partial`. Omit a row's `quantity` to mean all stored. Refused when not docked; a row
 * the store does not hold is `short` and `done`. Costs nothing. */
export declare function withdraw(items: Want[]): Promise<Outcome<Moved>>;
export declare const storageEffect: (baseId?: string) => Effect.Effect<Outcome<ViewStorageResponse>, never, Game>;
/** Read the store at this base, or at a named base or station POI without going there. Works
 * undocked and in another system. `locations` is the whole account's map of holdings. Over
 * `storage/view` it adds: items capped at 40 rows (the count is in `next`). Reads only. */
export declare function storage(baseId?: string): Promise<Outcome<ViewStorageResponse>>;
