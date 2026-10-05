/** The market counter at the base you are docked at. Prices are read live at the moment of
 * the act, never from a plan. */
import type { BuyResponse, EstimatePurchaseResponse, MarketListingItem, SellResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from './game.ts';
import type { Outcome, Want } from './types.ts';
/** The lib's per-item book (`best_buy`, `best_buy_qty`, `best_sell`, `best_sell_qty`,
 * `spread`) plus your own position, which the market does not know. */
export type Quote = MarketListingItem & {
    held: number;
    stored: number;
};
/** A book this pilot has stood in front of, kept so the next base knows what the last one
 * paid. The game publishes no cross-station prices — `view_market` and `analyze_market` are
 * both "here" — so memory is the only far price a factionless pilot can have. Kept in `world.db`
 * (world.ts), every base, never evicted by age: a consumer discounts by age itself. */
export interface RememberedBook {
    base_id: string;
    at: string;
    tick?: number;
    /** The system the base is in, as the ship stood there: what lets `routes()` count jumps between
     * two far bases from the map alone. Absent on entries written before it was kept. */
    system_id?: string;
    items: MarketListingItem[];
}
/** How old an entry written before books carried a tick is taken to be. An assumption for
 * pre-ageing files, not a measurement: old enough for the pilot to distrust, not old enough
 * to be worth dropping a price nothing else can supply. */
export declare const LEGACY_AGE = 20;
/** Age in ticks, computed at read and never stored. An untagged entry reads as `LEGACY_AGE`.
 * A tick that ran backwards — server restart, season rollover — would read as a negative age,
 * which is nonsense to hand a pilot, so it clamps to 0: "as fresh as this call". */
export declare const ticksOld: (tick: number | undefined, now: number) => number;
/** The best remembered bid for an item at a base other than `here`, with its age — the query
 * `sell`'s did and the menu's sell rows both ran per item against a fresh `knownBooks()` read
 * (an 8 MB parse each). Callers read `knownBooks()` once and pass the result in. */
export interface FarBid {
    base_id: string;
    best_buy: number;
    best_buy_qty: number;
    age: number;
}
export declare function bestFarBid(books: RememberedBook[], item_id: string, here: string | null | undefined, tick: number): FarBid | undefined;
/** ponytail: with no `maxEach`, a buy is refused over OVERPAY × the cheapest ask remembered at another
 * base. A first guess: tune it from the refusals (the call's `why`) and the `ref_*` on `trade` quotes.
 * Live 2026-10-04 (kvothe 09:12Z, run b7ad2c0a): supply bought 69 iron_ore at 999 while
 * confederacy_central_command was remembered asking 2 for 32,928. */
export declare const OVERPAY = 1.05;
/** The cheapest ask remembered for `units` of `item_id` at a base other than `here`: the average a
 * walk of each book's asks pays, among books deep enough for all of them; else, when none is, the
 * lowest top ask. `age` in ticks when the current tick is known. */
export interface CheapAsk {
    base_id: string;
    price: number;
    depth: number;
    age: number | null;
}
export declare function cheapestAsk(books: readonly RememberedBook[], item_id: string, units: number, here: string | null | undefined, now: number): CheapAsk | undefined;
/** Why `cost` for `units` of `item_id` here is too dear, if it is: over `maxEach` each when given, else over
 * OVERPAY × the cheapest ask remembered elsewhere (none known: no cap). `ref` is that ask, for the quote. */
export declare function overpay(item_id: string, units: number, cost: number, maxEach: number | undefined, here: string): {
    why?: string;
    ref?: CheapAsk;
};
/** ` at 6633 each, under the 7153 top bid (2 deep)` when `quantity` fetched `earned` materially under
 * the top of the book read before the sale; '' otherwise. A thin book is walked down its levels.
 * Live 2026-10-01 (kvothe 14:45Z): 10 plasma_injector filled at 6,633 against a 7,153 bid 2 deep, −5.2k unsaid. */
export declare function slipped(top: {
    best_buy: number;
    best_buy_qty: number;
} | undefined, quantity: number, earned: number): string;
export declare const marketTick: () => number;
/** Every book read in this runtime dir, newest base first. Empty without a runtime. The
 * directory is an argument so a caller outside a bound run (the juncture's `factsNow`) can
 * read the same memory. */
export declare const knownBooks: (dir?: string | undefined) => RememberedBook[];
/** Keep `base_id`'s book, read at `tick` in `system_id`, in `dir`'s market memory, and its place.
 * What `book()` does for the pilot, and a freighter's host for a book it scouted. */
export declare function rememberBook(dir: string | undefined, base_id: string, system_id: string | undefined, items: MarketListingItem[], tick: number): void;
/** This pilot's own fill, taken off `base_id`'s remembered book: `n` units off the top of its bids (a
 * sale) or asks (a buy), so the next plan does not count units it already sold into or bought off.
 * Live 2026-10-03 (kvothe, run bc564bea): 137 solarian_biotic bought for b495…'s bids as remembered
 * before run a803ae2b sold 128 into them; 16 were left, and 121 rode on with no known buyer. */
export declare function debitBook(dir: string | undefined, base_id: string, item_id: string, side: 'bids' | 'asks', n: number): void;
/** The book here, whole, read once and filtered in memory: one 190 KB reply beats twenty
 * filtered ones against the rate limit, and the pilot never sees it. Every read is also
 * written to this runtime's market memory, which is what `spreads()` reads, and filed to the
 * faction's trade ledger once per tick when there is one. */
export declare const bookEffect: () => Effect.Effect<Map<string, MarketListingItem>, import("./codes.ts").GameError, Game>;
/** What things are worth here. Default: every item in the hold and in this base's store.
 * Pass item ids for others. Capped at 40 rows. Over `view_market` it adds: the filter to
 * what you hold, your held/stored counts beside each book, and the cap. Reads only. `next`
 * names the best thing to sell here by `best_buy × min(best_buy_qty, held)`. */
export declare const pricesEffect: (items?: string[]) => Effect.Effect<Outcome<{
    quotes: Quote[];
}>, never, Game | import("./runtime.ts").Run>;
export declare function prices(items?: string[]): Promise<Outcome<{
    quotes: Quote[];
}>>;
export interface Sold {
    base_id: string;
    /** One `SellResponse` per row that sold: `total_earned`, `quantity_sold`, `xp_gained`. */
    fills: SellResponse[];
    /** Not sold and why: `no buyer`, `under floor`, `not held`, or the game's refusal. */
    short: {
        item_id: string;
        requested: number;
        sold: number;
        why: string;
    }[];
    total: number;
}
/** Sell the named rows at market price, here. The pilot names what it sells; nothing is
 * sold by default. Over `spacemolt/sell` it adds: the book read before anything moves so a
 * row with no buyer is never touched, `from:'store'` (withdraw and sell in hold-sized batches
 * until the named rows are gone), a per-item `floor` on `best_buy`, and the wallet measured
 * for `gained.credits`.
 *
 * - `items`: rows to sell; omit a row's `quantity` to mean all of it.
 * - `from:'store'`: take the rows out of the store here and sell them, one hold-load at a
 *   time, however many loads it takes. Rows with no buyer (or under `floor`) stay in the
 *   store, unwithdrawn, and `did` says so. Default `'hold'`.
 * - `floor`: per-item minimum `best_buy`; below it the row is skipped, not dumped.
 *
 * Trains trading (xp scales with credit volume). Not docked or no market here: `refused`. */
export declare const sellEffect: (items: Want[], opts?: {
    from?: "hold" | "store";
    floor?: Record<string, number>;
}) => Effect.Effect<Outcome<Sold>, never, Game | import("./runtime.ts").Run>;
export declare function sell(items: Want[], opts?: {
    from?: 'hold' | 'store';
    floor?: Record<string, number>;
}): Promise<Outcome<Sold>>;
export interface Bought {
    /** The preview the spend was checked against (`total_cost`, `sales_tax`, `unfilled`). */
    estimate: EstimatePurchaseResponse;
    /** The fill, when one happened. */
    bought?: BuyResponse;
}
/** Buy at market price, here, after an `estimate_purchase` preview. Over `spacemolt/buy` it
 * adds: the estimate read first and refused when `total_cost` would take the wallet under
 * `permissions.credit_reserve` or over `maxEach × quantity` — with no `maxEach`, over `OVERPAY` × the
 * cheapest ask remembered at another base, named with its age; the refusal names the numbers. A **module** is checked against the ship's grid first —
 * free slot of its kind, CPU and power — and refused when it could not be fitted, with
 * `next` saying what to remove; `{force:true}` skips that check for a pilot buying a spare.
 * Trains trading. Tired or Relaxed: refused. */
export declare const buyEffect: (itemId: string, quantity: number, opts?: {
    deliverTo?: "cargo" | "storage";
    maxEach?: number;
    force?: boolean;
}) => Effect.Effect<Outcome<Bought>, never, Game | import("./runtime.ts").Run>;
export declare function buy(itemId: string, quantity: number, opts?: {
    deliverTo?: 'cargo' | 'storage';
    maxEach?: number;
    force?: boolean;
}): Promise<Outcome<Bought>>;
