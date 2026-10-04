import type { ReadinessCommand } from '../../readiness.ts';
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
}
/** The id a candidate is flown to by. */
export declare const target: (row: Candidate) => string;
/** Every candidate within `jumps` of the ship's system, unknown and unexplored first, then stale;
 * nearer first, a base before a system. Books are aged against `now`. Reads only, through `seat`:
 * `get_map` once, the faction ledger (`farBooks`) and intel map (`query_intel`, each base it names
 * kept in `places.json`), and the runtime's `places.json`, `explored.json` and market memory. A
 * system with a base already placed counts as explored; its other bases are listed by the
 * `explore` after a hop there. */
export declare function candidates(seat: Seat, now: number, jumps?: number): Promise<Candidate[]>;
/** The system the ship is in, listed live (`get_system`): each base's place kept in `places.json`,
 * the system kept in `explored.json`. The base ids. */
export declare function explore(send: ReadinessCommand, dir: string | undefined): Promise<string[]>;
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
 * Refused when not docked (ages are read against a counter's tick) or in a mood that may not start
 * a job. A hop that fails is said and skipped; `partial` when one did. Trains navigation. */
export declare function scoutMarkets(opts?: {
    jumps?: number;
    max?: number;
}): Promise<Outcome<Scouted>>;
