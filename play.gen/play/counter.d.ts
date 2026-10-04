/** Whether there is a station counter where the ship is, and getting to it: every helper that
 * needs a counter (market, board, store, service) asks here, so "not docked" is either fixed by
 * a dock or said with where the ship actually is. */
import type { SystemPoi } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from './game.ts';
/** The part of a `get_system` row the counter reads. A row is kept when it has an `id`, and takes
 * each other field when it is a string: a partial row costs nothing, a malformed one only its field. */
export type PoiRow = Pick<SystemPoi, 'id' | 'base_id'> & Partial<Pick<SystemPoi, 'name'>>;
/** The POI the ship is at, as this system's own listing (`get_system`) has it — a row with
 * `base_id` has a station — and the bases elsewhere in the system. One read. */
export declare const hereEffect: () => Effect.Effect<{
    bases: string[];
    row?: PoiRow;
}, import("./codes.ts").GameError, Game>;
/** `belt (Inner Belt)`: the id the pilot writes and the name prose gives it. */
export declare const named: (id: string | undefined, row?: PoiRow) => string;
export declare const others: (bases: string[]) => string;
/** Docked already, or docked now when a base sits at this POI; otherwise why not, naming the
 * POI, the system, and the bases in this system. */
export declare const counterEffect: () => Effect.Effect<{
    docked: string;
    refused?: never;
} | {
    refused: string;
    docked?: never;
}, import("./codes.ts").GameError | import("../travel.ts").TravelBlocked | import("../travel.ts").ArrivalUnresolved | import("../dock.ts").DockBlocked, Game>;
