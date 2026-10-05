/** The menu: the few concrete acts open from where the ship stands, each a call the pilot can paste and the raw facts
 * it rests on — credits, minutes, jumps, the age of its books, who issues a mission. Offers, never refusals: nothing
 * here stops a run. Each generator offers at most one move, so the choice is between different kinds of act; they rank
 * by the credits a minute their own facts state, and one slot keeps the move the objective leads with. Reads only, but
 * for the book memory every book read keeps. */
import { Effect } from 'effect';
import type { ReadinessAccount } from '../readiness.ts';
import { Game } from './game.ts';
import { type Pilot } from './runtime.ts';
import type { Status } from './types.ts';
/** Which generator offered a move. */
export type Gen = 'route' | 'again' | 'settle' | 'missions' | 'explore';
/** One offer: an id within this juncture, the call to paste, its facts as data (journalled), and as words (printed). */
export interface Move {
    id: string;
    gen: Gen;
    call: string;
    facts: {
        credits: number;
        minutes: number;
    } & Record<string, unknown>;
    said: string;
}
/** `held` is each active mission led by its next step, for the juncture's Missions block. */
export interface Held {
    title: string;
    next: string;
    expires_at?: string;
}
export interface Menu {
    moves: Move[];
    held?: {
        max: number;
        missions: Held[];
    };
}
/** One run as the journal keeps it: the first work call `main()` made, how it ended, what the whole run gained, where the
 * ship ended up, and the work call as written when its job keeps it. Written by `run` into the journal. */
export interface RunSummary {
    fn: string;
    arg: string;
    call?: string;
    status: Status;
    credits: number;
    items: number;
    xp: number;
    at?: string;
}
/** The run that just ended, from the runtime's record of top-level calls. `status` is the run's
 * own final status — trusted, UNLESS it is only there because some later top-level call read
 * that way itself, which is a different call's outcome, not this one's, AND that later call's
 * status is worse than the work call's own. Live: a `gatherUntil` that finished `done` was
 * reported `refused`, because the program went on to call `completeMissions()`, the server
 * refused it, and that refusal (worse than `done`) became the run's own status — the work call's
 * own record (`calls`, kept per top-level call) said `done` all along. The reverse also happens:
 * a `gatherUntil` that came back `refused` (hold full) followed by a `sell` that finished `done`
 * — the run's `done` is not worse than the work call's `refused`, so the run's status (the real
 * outcome) wins and the work call is not stamped with its own stale refusal.
 * An explicit final `outcome()` the program composes itself is not a later call — nothing pushes
 * one to `calls` — so its verdict still stands over the first work call's mechanical status. */
export declare function runSummary(status: Status): RunSummary | null;
export declare const leadCall: (who: Pilot) => string;
/** The moves block's size, so it is never what a full context gives up: 4 lines of about 160 characters. */
export declare const MOVES = 4, MOVES_CHARS = 640;
/** The menu from where the ship stands. */
export declare const menuEffect: (runtime?: string) => Effect.Effect<{
    held: {
        max: number;
        missions: {
            expires_at?: string;
            title: string;
            next: string;
        }[];
    };
    moves: Move[];
} | {
    held?: never;
    moves: Move[];
}, never, Game>;
/** The moves as text, one line each; empty when there are none. */
export declare const renderMenu: (built: Menu) => string;
/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A docked ship observes no threat.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate. Upgrade when the spec names the statuses. */
export declare function threatsHere(location: ReadinessAccount['state']['location'], docked: string | null): string[];
