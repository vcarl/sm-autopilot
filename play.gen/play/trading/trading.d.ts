/** Buy low here, sell high there. Trading xp scales with credit volume, so this is also the
 * fastest skill to raise once you have capital. Markets move between look and act.
 *
 * The one thing the game will not tell you: what another station pays. `view_market` and
 * `analyze_market` both answer "here", `view_orders` answers "your own orders", and the only
 * cross-station price feed in the lib is a faction's trade ledger
 * (`spacemolt_intel/query_trade_intel`), which needs a faction with a trade-intel facility
 * and answers with other pilots' submitted observations, not live books. So `spreads()`
 * reads the ledger when there is one and otherwise remembers: every `book()` read is written
 * to this runtime's market memory, and the second visit knows what the first one saw.
 */
import type { MarketListingItem, OrderLevel, SellResponse } from '@spacemolt/lib';
import { Effect, Schema } from 'effect';
import type { ReadinessAccount } from '../../readiness.ts';
import { Game, type GameError } from '../game.ts';
import { Stopped, type Said } from '../runtime.ts';
import type { Outcome, Row } from '../types.ts';
/** `inFaction` for a seat, the skip journalled to the seat's runtime. */
export declare const seatInFaction: (seat: Seat) => boolean;
/** A line to the seat's journal for the developers: a pilot's `step` needs a bound run, which a freighter's host does not
 * have. A freighter's line carries its name, so it is never stamped with the pilot's run. */
export declare const seatLine: (seat: Seat, facts: Record<string, unknown>, event: string) => void;
/** Whose connection and files a search reads through: the pilot's for `routes()`, or a freighter's
 * own when its host re-plans it, so a host loop never touches the play runtime. It sends through the
 * `Game` it runs under. */
export interface Seat {
    account: ReadinessAccount;
    runtime: string | undefined;
    /** The freighter's name, when the seat is one: its journal lines carry it. */
    freighter?: string;
    /** The live book where the ship is docked, and the tick it was read on, when the seat reads it its own way (a
     * freighter's host does). Absent: the pilot's `bookEffect`, which also remembers and files what it reads. */
    book?: Effect.Effect<{
        items: Map<string, MarketListingItem>;
        tick: number;
    }, GameError, Game>;
    /** Throws to end a search early. */
    stop(): void;
}
/** The pilot's seat: the play runtime. */
export declare const pilotSeat: () => Seat;
/** The seat's stop as an Effect: the pilot's `Stopped` is the typed stop, any other throw is a bug and dies with its value. */
export declare const halt: (seat: Seat) => Effect.Effect<void, Stopped, never>;
/** One item and one buyer known for it, with the trip to that buyer priced and ranked. */
export interface Spread {
    item_id: string;
    /** Hold plus this base's store: what a sale there would actually be worth. */
    held: number;
    /** The base that pays `best_buy`. `here` when it is this counter. */
    base_id: string;
    best_buy: number;
    best_buy_qty: number;
    /** How the price was learned: a live local book, a faction ledger entry another pilot
     * filed, or a book this pilot read on an earlier visit. */
    source: 'here' | 'faction ledger' | 'remembered';
    /** How stale it is: `live`, or an age in ticks against the tick this call read. An entry
     * written before books carried a tick reads as `LEGACY_AGE` ticks old. */
    seen: string;
    /** The route quote to that base: fuel units and jumps. Zero for `here`. */
    fuel: number;
    jumps: number;
    /** `best_buy × min(best_buy_qty, held)` less the fuel bill at this base's all-in price. */
    net: number;
    /** `0.5 ^ (age / HALF_LIFE)`: 1 for a live book. */
    confidence: number;
    /** What rows rank by, as `routes()` rows do: `max(confidence, 1/64) × net / max(1, jumps)`. */
    score: number;
}
/** Buyers listed per item, best score first. */
export declare const BUYERS = 3;
/** What each item in the hold is worth at the best buyers this pilot knows of, anywhere, and
 * what the trip there costs: up to `BUYERS` rows an item, ranked as `routes()` ranks a one-stop
 * route, by trust-weighted net per jump. Default items: everything in the hold and in this base's
 * store. Reads only.
 *
 * Three sources, every buyer in them weighed: this base's live book; the faction trade ledger
 * (`query_trade_intel`) when the pilot has a faction that runs one; and the books this pilot
 * has read at other bases, remembered by `book()` in the runtime dir. Only the last is
 * guaranteed, so `did` always says which sources answered. A price that is not live is a
 * memory, and the far book may have moved — `tradeRun` re-reads before it sells.
 *
 * Refused when not docked: without a local book there is nothing to compare against. */
export declare function spreads(items?: string[]): Promise<Outcome<{
    spreads: Spread[];
    sources: string[];
}>>;
type Spreads = {
    spreads: Spread[];
    sources: string[];
};
/** `spreads` as an Effect, for `edge` and for converted callers; never in a barrel. */
export declare const spreadsEffect: (items?: string[]) => Effect.Effect<Outcome<Spreads>, never, Game | import("../runtime.ts").Run>;
/** One bid known for an item: where, how much, how deep, how old, and how far. */
export interface Buyer {
    item_id: string;
    base_id: string;
    best_buy: number;
    best_buy_qty: number;
    source: Spread['source'];
    /** Ticks since the book was read; 0 for this counter's live book. */
    age: number;
    /** Jumps from where you are, on the map; null when the base could not be placed. */
    jumps: number | null;
}
/** Who buys `items`: the highest bids known for each, anywhere — this counter's live book when
 * docked, the faction ledger, the books remembered — up to `BUYERS` an item, with each book's age and
 * the jumps there. Held or not, docked or not. Reads only.
 * Live 2026-09-30 (kvothe): hours flown system to system, `prices(['aluminum_ore'])` at each, hunting
 * a buyer the market memory already held. */
export declare const buyersEffect: (items: string | readonly string[]) => Effect.Effect<Outcome<{
    buyers: Buyer[];
}>, never, Game | import("../runtime.ts").Run>;
export declare function buyers(items: string | readonly string[]): Promise<Outcome<{
    buyers: Buyer[];
}>>;
/** ponytail: undocked there is no live tick to age a book against; the newest book known, advanced
 * at ten seconds a tick since it was read, stands in. A docked call measures it from the live book. */
export declare function tickNow(dir?: string | undefined): number;
/** A ledger entry as this file reads it: the base, its system, the tick it was filed and its top of book per item. Picked
 * from the spec's entry, because the live server omits spec fields and sends `null` for an empty item list. */
export declare const LedgerEntry: Schema.Struct<{
    readonly items: Schema.optionalKey<Schema.NullOr<Schema.$Array<Schema.Struct<{
        readonly item_id: Schema.String;
        readonly best_buy: Schema.Number;
        readonly best_sell: Schema.Number;
        readonly buy_volume: Schema.Number;
        readonly sell_volume: Schema.Number;
    }>>>>;
    readonly base_id: Schema.String;
    readonly system_id: Schema.String;
    readonly submitted_at_tick: Schema.Number;
}>;
export type LedgerEntry = typeof LedgerEntry.Type;
/** A book row as far as a source can say: a ledger entry has the top of book and volumes, no levels. */
export type Listing = Pick<MarketListingItem, 'item_id' | 'best_buy' | 'best_buy_qty' | 'best_sell' | 'best_sell_qty'> & Partial<Pick<MarketListingItem, 'buy_orders' | 'sell_orders'>>;
/** A ledger entry's rows as book rows: its top of book and volumes. */
export declare const ledgerItems: (entry: Pick<LedgerEntry, "items">) => Listing[];
/** A book at another base, with its age in ticks against `now`, and its system when the memory kept it. */
interface FarBook {
    base_id: string;
    source: 'faction ledger' | 'remembered';
    age: number;
    system_id?: string;
    items: Listing[];
}
/** Every far book this pilot may know: the faction ledger's whole books, then the books
 * remembered at other bases, one per base — the fresher copy when both have it. What `spreads()`,
 * `routes()`, `tradeRun` and `assign` all read. A ledger entry comes back with an empty
 * `system_id`, as does a memory written before books kept one; the memory's system for that base
 * stands in, else the kept place (`places.json`), else none. */
export declare const farBooksEffect: (here: string, now: number, seat?: Seat) => Effect.Effect<FarBook[], Stopped, Game>;
/** Ticks for a far end's trust to halve: an hour at ten seconds a tick. NPC books move rarely,
 * so an hour-old price still counts half. */
export declare const HALF_LIFE = 360;
/** A stop's book as the planner reads it. No `items`: nothing is known of that base's book. */
export interface Book {
    base_id: string;
    source: Spread['source'];
    age: number;
    items?: Map<string, Listing>;
}
/** Units sold at one stop and what they fetch there, level by level. */
export interface Sale {
    item_id: string;
    quantity: number;
    revenue: number;
}
/** Units taken on at one stop and what they cost at the asks (0 from the store). */
export interface Buy {
    item_id: string;
    quantity: number;
    cost: number;
}
/** What the plan does at one stop. */
export interface Leg {
    at: string;
    /** Where this stop's book came from and its age in ticks, as `Spread.source`; `here`/0 when live. */
    source: Spread['source'];
    age: number;
    /** Held goods sold here: each whose trusted bid here is at least its best trusted bid later on
     * the route, and at least half the best trusted bid at any base known off it. */
    sold: Sale[];
    /** Each item taken here, and the totals: units, and what they cost at the asks (0 from the store). */
    buys: Buy[];
    bought: number;
    cost: number;
    /** Tax on those buys; null when no rate is known. Only the docked base's rate is readable, so
     * `routes()` prices a far stop's buy at it, and says so in the row's `why`. */
    sales_tax: number | null;
}
/** A held row left aboard, and `why`: the better bid known off the route, when there is one. */
export type Unsold = Row & {
    why?: string;
};
/** A whole route from the hold you have. `net` = `revenue − cost − sales_tax` (known taxes only). */
export interface Plan {
    legs: Leg[];
    /** What is still aboard after the last stop: no stop on the route bids for it as well as a base
     * off the route does (named in `why`), or nobody known bids at all. Not in the net. */
    unsold: Unsold[];
    revenue: number;
    cost: number;
    sales_tax: number | null;
    net: number;
}
/** One stop handed to `plan`: its book, the items it may take on, and the tax on taking them. */
export interface PlanStop {
    book: Book;
    buy?: readonly string[];
    /** A cap on all of `buy` together. */
    quantity?: number;
    /** Where each `buy` item comes from when not the market's asks: the store, as one level at price 0. */
    asks?: Record<string, OrderLevel[]>;
    /** Sales tax on `buy`; null when not known, which sizes it untaxed. */
    rate: number | null;
}
/** ponytail: a unit is not sold for under 1/DUMP of the best trusted bid a base off the route
 * posts. Off-route bids are not weighed by the trip there, so a flat ratio stands in for it: a
 * bid a jump away a little over this one still sells here, and `routes()` ranks the trip. Tunable. */
export declare const DUMP = 2;
/** The route from the hold you have and `free` room: `decide` at each stop, then the hold and the
 * books move by what it did — a base visited twice is one book, so what the first visit took is
 * gone for the second. `elsewhere` is every other book known, off the route: a held good is not
 * sold on the route for less than one of them bids. Pure. */
export declare function plan(hold: Record<string, number>, free: number, stops: PlanStop[], elsewhere?: readonly Book[]): Plan;
/** One stop of a `tradeRun`: the base, and optionally what to take there: one item, or several
 * that the plan fills the hold from, unit by unit, whichever earns most. */
export interface RunStop {
    at: string;
    buy?: string | readonly string[];
    /** A cap on all of `buy` together; the plan sizes it otherwise. */
    quantity?: number;
    /** `'store'`: `buy` comes out of this base's store, at no cost, instead of off the market. */
    from?: 'store';
}
/** The call that runs `stops`, as a pilot pastes it. */
export declare const runCall: (stops: RunStop[]) => string;
/** What one stop of a run did. */
export interface Visit {
    at: string;
    /** The lib's `SellResponse` per row sold here. */
    sold: SellResponse[];
    /** Units of the stop's `buy` items taken aboard, all told, and the credits that cost: what left the wallet, tax included. */
    bought: number;
    spent: number;
    /** What fell short here, or why nothing was taken. */
    why?: string;
}
export interface Traded {
    /** One per stop reached, in order. */
    stops: Visit[];
    /** What was aboard when the run ended. After the last stop: what no stop bought, or what a base
     * off the route bids more for (named in the row's `why`). */
    unsold: Unsold[];
    /** Fuel units burned on the flights: the tank's measured drop across each `goTo`. */
    fuel: number;
    /** Sales, less what the buys took out of the wallet (tax included), less `fuel` at the
     * `fuel_price_all_in` of the first base the run was docked at — counted the way `Route.net`
     * counts it, so the two compare directly. */
    net: number;
}
/** Fly `stops` in order, and at each one sell and buy what the plan says, from the hold you have.
 * At each stop the live book is read and the rest of the route re-planned against it — the later
 * stops at their best known books — by the same rule `routes()` ranks with; so a full hold, an
 * empty one or a mixed one needs no other call. Each leg keeps its own rules (`buy` refuses under
 * `credit_reserve`, `goTo` refuses a POI while Tired). Never throws: a flight that does not arrive
 * is `partial` with the stops done so far, and `next` is the rest of the route. Re-running the
 * same call starts again at the first stop and re-plans from the hold you have. Trains trading and
 * navigation. */
export declare function tradeRun(opts: {
    stops: RunStop[];
}): Promise<Outcome<Traded>>;
/** `tradeRun` as an Effect, for `edge` and for converted callers; never in a barrel. A buy whose reply is lost is never
 * re-sent: the hold and the wallet are re-read against what they were before it, and the run is `partial`. */
export declare const tradeRunEffect: (opts: {
    stops: RunStop[];
}) => Effect.Effect<Outcome<Traded>, never, Game | import("../runtime.ts").Run>;
/** How far `routes()` looks unless told: `STOPS` stops, each leg at most `LEG_JUMPS` jumps, no cap
 * on the whole. A local cycle; a galaxy tour is the same call with larger numbers, up to `MAX_STOPS`. */
export declare const STOPS = 4, LEG_JUMPS = 3, MAX_STOPS = 10;
/** Jumps from one system to another over the map's links (`get_map` connections), breadth first;
 * null when the map does not connect them. */
export declare function hops(links: ReadonlyMap<string, readonly string[]>, from: string, to: string): number | null;
/** A route as `routes()` ranks it: the plan from the hold you have, with the trip priced. */
export interface Route extends Plan {
    /** Jumps from here through every stop, from the map; null when a stop could not be placed. */
    total_jumps: number | null;
    /** Fuel units: `total_jumps × fuel_per_jump`. Null when the trip is unpriced. */
    fuel: number | null;
    /** `0.5 ^ (sum of the stops' book ages / HALF_LIFE)`: 1 when every book is live. */
    confidence: number;
    /** What rows are ranked by: `max(confidence, 1/64) × net / max(1, total_jumps)`. 0 for an unpriced trip. */
    score: number;
    /** The call to paste. */
    next: string;
    /** What this row could not know: an unplaced stop, an unknown tax, a far stop's tax estimated at this base's rate. */
    why?: string;
    /** Present on a `routes({circuit})` row: the lap to hand a freighter. */
    circuit?: Circuit;
}
/** One item a circuit stop takes on: up to `qty` aboard, at asks of at most `max_price`. */
export interface CircuitBuy {
    item: string;
    qty: number;
    max_price: number;
}
/** A closed lap a freighter repeats: `routes({circuit:{hold}})` plans it, `assign` hands it over.
 * Each stop sells its `sell` items at bids of at least `min_price`, then buys each of its `buys`
 * up to its `qty` at asks of at most its `max_price`; the last stop is followed by the first. */
export interface Circuit {
    closed: true;
    /** The hold the lap was planned for, starting empty. */
    hold: number;
    /** Jumps round the whole lap, last stop back to the first included. */
    lap_jumps: number;
    /** The steady-state lap's revenue less cost, tax and fuel. */
    lap_net: number;
    stops: readonly {
        at: string;
        system_id: string;
        buys?: readonly CircuitBuy[];
        /** The one-item form a circuit had before `buys`: an entry or script written then still flies, read as `buys:[buy]`. */
        buy?: CircuitBuy;
        sell: readonly {
            item: string;
            min_price: number;
        }[];
    }[];
    /** The scope `routes()` planned it within, so `reassign` plans the next one alike. */
    scope?: Scope;
}
/** What a circuit stop takes on, whichever form it was written in. */
export declare const buysOf: (stop: Circuit["stops"][number]) => readonly CircuitBuy[];
/** How far `routes()` searches: stops per route or lap, jumps per leg, jumps all told. */
export interface Scope {
    maxStops?: number;
    maxLegJumps?: number;
    maxJumps?: number;
}
/** ponytail: ticks a ring rests after a freighter parked on it drained (no trade, or losing laps),
 * before `routes({circuit})` plans it again: an hour at ten seconds a tick. Unmeasured: tune it
 * once a drained ring's books are watched refilling live. */
export declare const REST_TICKS = 360;
/** Every route worth flying over what this pilot knows — the live book here, the faction ledger,
 * the remembered books — from the hold you have, ranked by trust-weighted net per jump. The search
 * picks only the bases, in order: at every stop the plan sells and fills the hold by the rule
 * `tradeRun` runs, so what ranks is what runs. `items` narrows what is taken on; goods aboard are
 * always weighed. `maxStops` (default `STOPS`, at most `MAX_STOPS`), `maxLegJumps` (default
 * `LEG_JUMPS`) and `maxJumps` (default none; round the lap for a circuit) set how far it looks: a
 * short cycle by default, a galaxy tour with larger numbers.
 * Reads only. Jumps come from `get_map` and each base's system, which the market memory keeps;
 * fuel per jump from one `find_route`. A stop that could not be placed is a row with a `why` and
 * the Outcome `partial`, never a throw. Undocked, every book is a remembered one, aged against `tickNow`.
 *
 * ponytail: goods in this base's store are not weighed; `tradeRun` takes them with `from:'store'`. */
export declare function routes(opts?: RouteOpts): Promise<Outcome<{
    routes: Route[];
    sources: string[];
}>>;
/** `routes` as an Effect, for `edge` and for converted callers; never in a barrel. */
export declare const routesEffect: (opts?: RouteOpts) => Effect.Effect<Outcome<Found>, never, Game | import("../runtime.ts").Run>;
export type RouteOpts = {
    items?: string[];
    circuit?: {
        hold: number;
    };
} & Scope;
type Found = {
    routes: Route[];
    sources: string[];
};
/** `routes()` itself, read through `seat`: the one planner, whether the pilot or a freighter's host asks. Sends through the `Game`
 * it runs under. */
export declare const searchEffect: (seat: Seat, opts?: RouteOpts) => Effect.Effect<Said<Found>, GameError | Stopped, Game>;
export {};
