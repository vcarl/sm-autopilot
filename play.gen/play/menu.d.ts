/** The menu: anti-stagnation guidance, not a list of admissible jobs. Every move is a real
 * library call with literal arguments taken from the present, passed through the same rules
 * the helper applies (`jobStop`, the mood's margins, permissions, Tired); a move the rules
 * refuse is under `not_now` with the reason. The juncture delivers it once, headed by the
 * stagnation `menuDue` names. Reads only; writes nothing (DESIGN §4). */
import { Effect, Schema } from 'effect';
import type { ReadinessAccount } from '../readiness.ts';
import { type CounterName } from '../rules-table.ts';
import { type DockRefusal } from './places.ts';
import { Game } from './game.ts';
import { type Pilot } from './runtime.ts';
import { type Near } from './exploration/exploration.ts';
import type { Status } from './types.ts';
export type Advances = 'knowledge' | 'skill' | 'credits' | 'influence' | 'ship' | 'objective';
export interface Move {
    call: string;
    why: string;
    advances: Advances;
}
/** `neighbours` are the systems one jump out, for the juncture's Present line: a pilot that can
 * read them there need not spend a run looking. */
export interface Menu {
    stagnation?: string;
    moves: Move[];
    not_now: {
        move: string;
        why: string;
    }[];
    neighbours?: Near[];
    places?: Places;
}
/** What this pilot knows of the map, for the juncture's Places line: how much of it has been
 * flown, the systems a look found no base in, and the bases that refused a dock. Live 2026-09-30
 * (kvothe): with nowhere else to keep it, the goal became a lossy breadcrumb list, ~341 of 462
 * jumps were repeats, and refused bases were retried hours apart. */
export interface Places {
    visited?: number;
    systems?: number;
    stationless: string[];
    refused: ({
        base_id: string;
    } & DockRefusal)[];
}
export declare function placesKnown(runtime: string | undefined, map?: {
    visited?: boolean;
}[]): Places;
/** One run as the menu remembers it: the first work call `main()` made, how it ended, what
 * the whole run gained, and where the ship ended up. Written by `run` into the journal. */
declare const Work: Schema.Struct<{
    readonly fn: Schema.String;
    readonly arg: Schema.String;
    readonly status: Schema.Literals<readonly ["done", "partial", "refused", "failed"]>;
    readonly credits: Schema.Number;
    readonly items: Schema.Number;
    readonly xp: Schema.Number;
    readonly at: Schema.optionalKey<Schema.String>;
}>;
export interface RunSummary extends Schema.Schema.Type<typeof Work> {
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
/** The last `limit` runs, oldest first. */
export declare function recentRuns(runtime: string, limit?: number): RunSummary[];
/** Why the menu is due, or null when a productive loop should stay quiet: the last three
 * runs repeat one call, the last two did not end done, or the last gained nothing. The sentence is the menu's `stagnation` line. */
export declare function menuDue(runs: RunSummary[]): string | null;
/** Whether Piloting clears a hull class's `piloting_required`, and by how much when it does
 * not: the line `not_now` names, or null when the class asks nothing this pilot's skill has
 * not already cleared (including a class that asks nothing at all), or when the Piloting skill
 * itself is unread — `get_skills` failed and its section was left out, so `piloting` is
 * `undefined` here, not 0; an unknown level is not a gap, it is offered as before. */
export declare function pilotingGap(required: number | undefined, piloting?: {
    level: number;
    xp: number;
    next_level_xp?: number;
}): string | null;
/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A dock ends the engagement (safety.dock
 * says so), so a docked ship observes no threat — otherwise one NPC brawling outside a busy
 * station would hold the menu at safety-only forever, with no rest and no resupply on it.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate — counting them would
 * refuse every job the Hunter woke up to do. Upgrade when the spec names the statuses. */
export declare function threatsHere(location: ReadinessAccount['state']['location'], docked: string | null): string[];
/** The facts the rules table reads, assembled from live state and the pilot record. The
 * menu and `jobStop` read them the same way, so what one refuses the other does.
 *
 * The stance decides which counters are worth a round trip: only a Hunter's J8 reads
 * `observed.targets`, only a Carrier's J4/J5 read the board, only a Trader's J6 reads a
 * spread, so those reads are behind the stance that consumes them and a menu build costs the
 * same as before for everyone else. Every one of them is a `look`: a counter that refuses
 * leaves its field absent, which is the answer the rule already gave before it was wired.
 * So are the refresh (the cached state stands), `get_system` (no sites), `get_base` (no counters, no posted prices) and
 * the route quote (no sites). */
export declare const factsNowEffect: (account: ReadinessAccount, who: Pilot, runtime?: string) => Effect.Effect<{
    mood: import("./runtime.ts").Mood;
    place: {
        board?: {
            contracts?: {
                id: string;
                cargo: number;
                liability: number;
            }[];
            passengers?: number;
        };
        sites: {
            serviced_base?: boolean;
            resource?: string;
            poi_id: string;
            quoted_fuel: number;
        }[];
        service_prices?: {
            fuel?: number;
            hull?: number;
        };
        counters: CounterName[];
        workshop: boolean;
        base_id?: string;
        kind: "base" | "poi" | "space";
    };
    holdings: {
        fuel: number;
        max_fuel: number;
        hull: number;
        max_hull: number;
        cargo_free: number;
        credits: number;
        inputs: string[];
    };
    obligations: {
        passengers: number;
    } | {
        passengers?: never;
    };
    permissions: {
        credit_reserve?: number;
        max_liability?: number;
    };
    observed: {
        threats?: string[];
        targets?: string[];
        spread?: {
            item_id: string;
            base_id: string;
            margin: number;
            age: number;
        };
    };
    stance?: import("./runtime.ts").Stance;
}, never, Game>;
export declare const leadCall: (who: Pilot) => string;
/** The menu from where the ship stands: the present in one read, the last ten runs, the
 * skills, the store, and when docked the board, the market and the yard. At most five
 * moves, ranked with the move that clears a stated blocker first, then to break the repetition
 * seen, then by what the goal names, then by what similar runs measured. Under Tired: only service here or the nearest serviced base. */
export declare const menuEffect: (runtime?: string) => Effect.Effect<{
    places?: Places;
    neighbours?: Near[];
    moves: Move[];
    not_now: {
        move: string;
        why: string;
    }[];
    stagnation?: string;
}, never, Game>;
/** The menu as text: one line per move with the call in backticks, then what is not on it. */
export declare function renderMenu(built: Menu): string;
export {};
