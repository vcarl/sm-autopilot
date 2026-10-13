/** The arena: consequence-free matches on the normal battle engine — ship and crew restored after, only ammo and fuel
 * spent. Live (kvothe 2026-10-09..13): 13 matches, 0 won, 12 ended by our own flee — 11 of them the run's close
 * disengaging a match the program had returned from, which forfeits it. Every one was a hand-written loop; this is the
 * one the library owns. */
import type { ArenaObjective } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from '../game.ts';
import type { Outcome } from '../types.ts';
import { type Battled } from './hunting.ts';
/** One arena match, as the loop fought it and as `arena.status` scored it. */
export interface ArenaMatch {
    /** The NPC challenge (`arena.challenges`), or the duel's own challenge id. */
    challenge_id: string;
    name: string;
    /** How the challenge is won beyond knocking out every enemy; absent for a duel, which has none. */
    objective?: ArenaObjective;
    battle: Battled;
    /** Lifetime `arena_wins`/`arena_losses`, read before the match and after it. No `battle_ended` push has been seen
     * for an arena battle, so this delta is the only score there is. */
    record: {
        before: {
            wins: number;
            losses: number;
        };
        after: {
            wins: number;
            losses: number;
        };
    };
    /** The delta read as one word: `neither` when both stood still — a stalemate counts for neither. */
    result: 'win' | 'loss' | 'neither';
}
/** Fight an NPC arena challenge to its end. `challenge` names one from `arena.challenges`; without it, the first
 * unlocked one held here that is not yet won, else the first unlocked one here. A match already holding the ship is
 * fought as it stands. The rules it can check before spending the call are checked — ship tier against
 * `max_ship_tier`/`min_ship_tier` — and a ship that breaks one is `refused` naming the rule, as the server would; an
 * empty magazine is reloaded from the hold first. Then `fight`, and `fightBattle`'s loop at floor 0: no walk-away line,
 * no flee, because fleeing forfeits and nothing is lost by losing. The result is the `arena.status` record before
 * against after. */
export declare function arena(opts?: {
    challenge?: string;
}): Promise<Outcome<ArenaMatch>>;
export declare const arenaEffect: (opts?: {
    challenge?: string;
}) => Effect.Effect<Outcome<ArenaMatch>, never, Game | import("../runtime.ts").Run>;
/** Challenge a player to a duel and fight it if they accept. `challenge` then `arena.status` once a tick for up to
 * `waitMs` (default two minutes): a `battle_id` there is the accept; the outgoing challenge gone without one is a
 * decline or a lapse. Not accepted in time, the challenge is withdrawn (`cancel`) and the outcome is `partial`. Then the
 * same loop as `arena()`: floor 0, no flee. */
export declare function duel(opts: {
    player: string;
    max_side_size?: number;
    waitMs?: number;
}): Promise<Outcome<ArenaMatch>>;
