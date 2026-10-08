/** What this pilot knows of the world beyond the ship: `world.db` in the runtime dir, one SQLite file the
 * bridge opens once and is the only writer of (freighters in its process share the handle). Two kinds of
 * fact, each kept by the reads and acts that already happen:
 *
 * - `markets` + `books`: every base's market book as last read here, top `LEVELS` levels a side, each
 *   level stamped `since`, the first tick it was seen at that price unbroken. Kept by count (`BASES`),
 *   never by age: a consumer discounts by age itself.
 * - `stores`: what the account's station storage holds, per base and item, as the game last said:
 *   a `storage/view` replaces a base, a deposit/withdraw/buy-to-storage reply sets an item.
 * - `facilities`: the public facilities seen at each base, one row per facility type, with its fee per run
 *   when a `facility/list` there said it; a `no_facility` refusal adds the one it names, fee unknown.
 *
 * Every read is a pure function over these tables. The journal stays the telemetry record: a book read
 * is still a `book` line in `books.jsonl`, a store change a `store` line. */
import type { MarketListingItem, OrderLevel } from '@spacemolt/lib';
import { DatabaseSync } from 'node:sqlite';
import type { RememberedBook } from './market.ts';
/** Levels kept a side: what `books.jsonl` journals too. A row's `buy_quantity`/`sell_quantity` keep the whole depth. */
export declare const LEVELS = 10;
/** A level as kept: the game's, plus the first tick it was seen at this price, unbroken across reads. */
export type Level = OrderLevel & {
    since?: number;
};
/** A level's `since`, when it carries one. */
export declare const sinceOf: (level: OrderLevel) => number | undefined;
/** The runtime dir's db, opened (and migrated) on first use; undefined without a dir, or when it cannot be opened.
 * A file deleted under an open handle is reopened, so a fresh dir at the same path starts fresh. */
export declare function worldDb(dir: string | undefined): DatabaseSync | undefined;
/** Every dir with an open db, for the test that proves each is a throwaway. */
export declare const openDirs: () => string[];
/** Every base's book, newest read first. */
export declare function readBooks(dir: string | undefined): RememberedBook[];
/** A fresh read of `book.base_id`, replacing what was kept: each level the last read had at the same price keeps its `since`. */
export declare function keepBook(dir: string | undefined, book: RememberedBook): void;
/** One kept row, rewritten in place (a fill taken off it); a row not kept stays not kept. */
export declare function keepRow(dir: string | undefined, base_id: string, row: MarketListingItem): void;
/** What one base's store holds, as last said, with when. */
export interface Stored {
    base_id: string;
    item_id: string;
    quantity: number;
    tick: number | null;
    at: string;
}
/** Every stored row, every base, by base then item. */
export declare function readStores(dir: string | undefined): Stored[];
/** One base's stored rows. */
export declare const storedAt: (dir: string | undefined, base_id: string) => Stored[];
/** Units of each item stored anywhere. */
export declare function storedTotals(dir: string | undefined): Record<string, number>;
/** What one landed command says of the account's stores, kept: a `storage/view` replaces its base, and a view's
 * `locations` whose `item_count` disagrees with what is kept (or a base kept that it does not list) has that base
 * re-read with `view(station_id)` — read-only, from anywhere — or emptied; a deposit sets the item to the reply's
 * `storage_total`, a withdraw to its `storage_remaining`, a buy delivered to storage adds `delivered_to_storage`.
 * `docked` is where the ship is, for the replies that do not name a base. Never throws. */
export declare function noteStore(dir: string | undefined, docked: string | undefined, action: string, params: Record<string, unknown> | undefined, reply: unknown, view?: (station: string) => Promise<unknown>): Promise<void>;
/** One side's top at one base: price, units at that price, the book's age in ticks against `now` (null untagged),
 * and since when that price has stood (null for a level kept before stamps). */
export interface Quoted {
    base_id: string;
    price: number;
    quantity: number;
    age: number | null;
    since: number | null;
}
/** Everything known of one item: aboard, stored by base, and each base's best bid and ask, best first. */
export interface ItemView {
    item_id: string;
    aboard: number;
    stored: {
        base_id: string;
        quantity: number;
        at: string;
    }[];
    bids: Quoted[];
    asks: Quoted[];
}
export declare function itemView(dir: string | undefined, item_id: string, aboard: number, now: number): ItemView;
/** Where `need` units of an input come from, cheapest first: the hold, then the store at `here`, then other stores
 * (free, but a trip), then the cheapest known ask. What a recipe's inputs are sourced by. */
export declare function inputSources(view: ItemView, need: number, here: string | undefined): {
    from: string;
    quantity: number;
    price: number;
}[];
/** Every base's stores with the best known bid for each item there (anywhere), largest stored value first. */
export declare function holdings(dir: string | undefined, now: number): {
    base_id: string;
    item_id: string;
    quantity: number;
    bid: Quoted | null;
}[];
/** A public facility seen at a base. `type` is the facility definition id; a row learnt from a `no_facility`
 * refusal has only the name the server gave, as both `type` and `name`, and no fee. `tick` is when it was seen. */
export interface FacilitySeen {
    base_id: string;
    type: string;
    name: string;
    system_id?: string;
    recipe_id?: string;
    fee_per_run?: number;
    output_per_run?: number;
    queued_runs?: number;
    backlog_ticks?: number;
    tick?: number;
    at: string;
}
/** Every facility row kept, every base. */
export declare function readFacilities(dir: string | undefined): FacilitySeen[];
/** A `facility/list` reply, kept as `base_id`'s whole facility book: each public facility type there at its lowest fee
 * per run. The reply's own `base_id` wins over the one passed. Never throws. */
export declare function rememberFacilities(dir: string | undefined, base_id: string, system_id: string | undefined, reply: unknown, tick: number | undefined): void;
/** A `no_facility` refusal for `recipe_id`, which names the nearest public facility that makes it ("… is made in a Alloy
 * Foundry … Nearest public one: Crimson War Citadel in Krynn (1 jump(s) away) …"), kept as that station having it, fee
 * unknown. A row already kept there is left alone; a text that does not read keeps nothing. Never throws. */
export declare function rememberNoFacility(dir: string | undefined, recipe_id: string, text: string, tick: number | undefined): void;
