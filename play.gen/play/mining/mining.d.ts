/** Mining: out to a belt, ice field or gas cloud, fill the hold, come back, stow, service. */
import type { SurveySystemResponse, SurveyedPoi, V2CargoItem } from '@spacemolt/lib';
import type { Outcome, Row } from '../types.ts';
export interface Gathered {
    poi_id: string;
    base_id: string;
    trips: number;
    /** What came aboard over all trips, measured from `GameState['cargo']` before and after
     * each mining leg (never from `MineResponse`, which carries no yield). */
    yield: Row[];
    /** What reached the store (or the market, with `then:'sell'`). */
    settled: Row[];
    /** How the mining leg ended on the last trip. */
    ended: 'full' | 'depleted' | 'stopped' | 'tired' | 'threat' | 'blocked' | 'failed';
    /** The hold at the end. */
    cargo: V2CargoItem[];
    /** The store's count of `until.item` when the function returned, if `until` was given. */
    held?: number;
}
/** The paste-able sale of what was stowed: the take is in the store, not the hold. */
export declare const sellStowed: (rows: Row[]) => string[];
/** One gather trip by default: fly to `poi`, mine until the hold is full (or the site is
 * dry), fly back to `base` (default: the base you left), dock, stow the take,
 * service. Over the raw legs it adds: every leg named for an end state and re-entered from
 * the live world, the take measured from cargo reads, each leg's fuel checked against its route, a streamed
 * yield line every ≤2 minutes, stop between ticks, and Tired ending the loop after the
 * return leg.
 *
 * - `until: {item, quantity}`: repeat trips until the store at `base` holds that much of
 *   `item`, up to `maxTrips` (default 6). Read from `storage/view` between trips.
 * - `then: 'stow' | 'sell'`: what to do with the take at the base. Default `stow`; `sell`
 *   withdraws the stowed take and sells it, row by row.
 * The take is what the site gives: at the base every hold row whose item is one of the
 * belt's own resources is stowed, whichever trip mined it, and nothing else is touched.
 * The trip ends stowed and docked, so the hold — `now.cargo` — is empty: read the take from
 * `gained.items` (measured) or `detail.settled` (what reached the store), never `now.cargo`.
 *
 * Mining while docked is refused by the game, so a station POI as `poi` is `refused`.
 * Trains mining (+ deep_core_mining with a power-3+ laser), piloting, navigation. */
/** How a trip is named in the journal and the run record. `maxTrips` bounds trips whether or
 * not `until` is given (default: 6 with `until`, 1 without), so it is named whenever it was
 * actually passed — not naming it left a pilot reading its own record unable to see that
 * `maxTrips:2` with no `until` was honored, not silently dropped to one trip. */
export declare const tripLabel: (opts: {
    poi: string;
    base?: string;
    until?: {
        item: string;
        quantity: number;
    };
    maxTrips?: number;
    then?: "stow" | "sell";
}) => string;
export declare function gatherUntil(opts: {
    poi: string;
    base?: string;
    until?: {
        item: string;
        quantity: number;
    };
    maxTrips?: number;
    then?: 'stow' | 'sell';
}): Promise<Outcome<Gathered>>;
/** Survey the system you are in for hidden deep-core deposits. Not built in slice 1. */
export declare function survey(): Promise<Outcome<{
    response: SurveySystemResponse;
    deposits: SurveyedPoi[];
}>>;
