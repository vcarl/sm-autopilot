import { Effect } from 'effect';
import type { ReadinessAccount } from './readiness.ts';
import { Game } from './play/game.ts';
export interface MineYieldRow {
    item_id: string;
    quantity: number;
}
export interface MineOutcome {
    /** `full` is the end state the step is named for; `depleted` is the site running out,
     * which is not the pilot failing; `failed` is anything that needs a human's reading. */
    outcome: 'full' | 'depleted' | 'failed' | 'stopped';
    /** Measured between authoritative reads, per item. Never a reply's claim. */
    yield: MineYieldRow[];
    /** Mine commands that came back with a reply. A rejection is not a cycle. */
    cycles: number;
    reason?: string;
}
/** Mine at the POI the ship is already at until the hold is full.
 *
 * Idempotent by its end state (S42): a hold that is already full sends nothing. The
 * hold filling, a `cargo_full` reply and a `cargo_full` rejection are the same success.
 * Yield is the cargo delta between the authoritative read that opened the step and the
 * one that closed it, so an over-claiming reply — or one whose post-state never moved —
 * contributes nothing.
 */
export interface MineOptions {
    /** Asked before every tick: a reason to stop (the pilot, Tired) ends the step `stopped`. */
    stop?: () => string | null;
    /** After every tick, with the running yield: what a long loop says while it works. */
    onCycle?: (yield_: MineYieldRow[], cycles: number) => void;
}
export declare const mineToFullEffect: (account: ReadinessAccount, options?: MineOptions) => Effect.Effect<MineOutcome, import("./play/codes.ts").GameError, Game>;
