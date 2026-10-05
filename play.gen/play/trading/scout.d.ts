/** Scouting: going to read the books nobody has read lately. A route can only be planned over a
 * book someone read, the faction ledger covers a fraction of the stations, and `get_map` lists
 * systems but not their bases, so a base is learned from a book, a `find_route`, the faction's
 * intel map (`query_intel`), or a `get_system` in its own system. `candidates` is the one choice
 * of where to go next, read by the pilot's `scoutMarkets` and by a waiting freighter's host alike. */
import { Effect } from 'effect';
import { Game } from '../game.ts';
import { Stopped } from '../runtime.ts';
import type { Outcome } from '../types.ts';
import { type Seat } from './trading.ts';
/** ponytail: how far scouting looks, in jumps from where the ship is. Tunable. */
export declare const SCOUT_JUMPS = 4;
/** Where scouting may go: a base known by id with no book (`unknown`), a system on the map within
 * range whose bases were never listed (`unexplored`, no `base_id`), or a base whose freshest book,
 * ledger or memory, is older than `IGNORE_TICKS` (`stale`, `age` in ticks). */
export interface Candidate {
    kind: 'unknown' | 'unexplored' | 'stale';
    system_id: string;
    base_id?: string;
    jumps: number;
    age?: number;
    /** The game's words when this base last refused the dock (`docking.json`): it ranks last. */
    refused?: string;
}
/** The id a candidate is flown to by. */
export declare const target: (row: Candidate) => string;
/** Every candidate within `jumps` of the ship's system, unknown and unexplored first, then stale,
 * then bases that refused the dock (`docking.json`); nearer first, a base before a system. Books are aged against `now`. Reads only, through `seat`:
 * `get_map` once, the faction ledger (`farBooks`) and intel map (`query_intel`, each base it names
 * kept in `places.json`), and the runtime's `places.json`, `explored.json` and market memory. A
 * system with a base already placed counts as explored; its other bases are listed by the
 * `explore` after a hop there. */
export declare const candidatesEffect: (seat: Seat, now: number, jumps?: number) => Effect.Effect<Candidate[], import("../codes.ts").GameError | Stopped, Game>;
/** The system the ship is in, listed live (`get_system`): each base's place kept in the seat's `places.json`,
 * the system kept in its `explored.json`. The base ids; none, journalled to the seat, when the reply does not read. */
export declare const exploreEffect: (seat: Seat) => Effect.Effect<string[], import("../codes.ts").GameError, Game>;
export interface Scouted {
    /** Bases whose book was read, remembered and filed, in order. */
    filed: string[];
    /** Systems flown to for their bases, in order, and the bases each listed. */
    explored: {
        system_id: string;
        bases: string[];
    }[];
    /** Candidates still within range after the last hop. */
    left: number;
}
/** Go and read the nearest books nobody has read lately: up to `max` hops (default 3), each to the
 * next `candidates` row within `jumps` (default `SCOUT_JUMPS`, 4), re-chosen after every hop. A base
 * is flown to with `goTo` and its book read (remembered and filed, as `prices()` does); a system is
 * flown to and its bases listed and kept, so the next hop can dock at one. Never buys or sells.
 * Docked, ages are read against the live book's tick; undocked, against `tickNow`. Refused in a mood
 * that may not start a job. A hop that fails is said and skipped; `partial` when one did. A base that
 * refused the dock is not flown to, and `did` names it. Trains navigation. */
export declare function scoutMarkets(opts?: {
    jumps?: number;
    max?: number;
}): Promise<Outcome<Scouted>>;
/** `scoutMarkets` as an Effect, for `edge`; never in a barrel. A stop, a refusal or a lost reply ends the scout naming the
 * action and the code (every command here is a read, and a leg's own loss is `goTo`'s to re-observe). */
export declare const scoutMarketsEffect: (opts?: {
    jumps?: number;
    max?: number;
}) => Effect.Effect<Outcome<Scouted>, never, Game | import("../runtime.ts").Run>;
