/** The recipe catalog, read without a bench: what makes an item, what an item goes into, and the whole tree a craft
 * takes down to what is mined or bought. Reads the public catalog and what this pilot remembers (`world.db`'s books and
 * stores) and sends no game command, so each works undocked, with no workshop, and in a query.
 *
 * Both print what they found as text, the way a player's crafting tool lays it out; the rows stay in `detail` for a
 * program. Live 2026-10-06 (kvothe): with only `recipes()`, which lists what hold + this store already cover, the pilot
 * gathered at random and then checked what it could make. */
import type { Recipe } from '@spacemolt/lib';
import { Effect } from 'effect';
import { type CheapAsk } from '../market.ts';
import type { Outcome } from '../types.ts';
export interface Browsed {
    /** Every matching recipe, in catalog order; only the first 20 are printed. */
    recipes: Recipe[];
    total: number;
}
export interface CatalogFilter {
    /** Matches a recipe's id, name, category or an output item, ignoring case. */
    search?: string;
    /** A category, as the catalog names it (`Refining`, `Components`, …), ignoring case. */
    category?: string;
    /** Recipes whose outputs include this item id. */
    makes?: string;
    /** Recipes whose inputs include this item id. */
    uses?: string;
}
/** The catalog's recipes, filtered: `makes` an item, `uses` an item, in a `category`, or matching `search`; the filters
 * combine. Prints the first 20 as text; `did` says how many matched and how to narrow. Reads only the catalog. */
export declare const catalogEffect: (filter?: CatalogFilter) => Effect.Effect<Outcome<Browsed>, never, import("../game.ts").Game | import("../runtime.ts").Run>;
export declare function catalog(filter?: CatalogFilter): Promise<Outcome<Browsed>>;
/** One item in a traced tree. */
export interface TraceNode {
    item_id: string;
    /** Units this branch takes. */
    need: number;
    /** An intermediate: units already held (hold + every store) taken against `need`. A leaf: all you hold of it. */
    have: number;
    /** How the item enters the economy: the catalog's `extracted_by` (`mining`, `gas`, …), `crafted`, or `unknown`. */
    source: string;
    /** The recipe that makes it here, its runs, and whether it needs a facility. Absent on a leaf. */
    recipe?: string;
    runs?: number;
    facility_only?: boolean;
    /** A crafted item left as a leaf because it is made from itself further up this branch. */
    cycle?: true;
    /** A leaf's cheapest remembered ask for `need`, at any base, with its age in ticks. */
    ask?: CheapAsk;
    inputs: TraceNode[];
}
/** What one craft comes to, from the catalog and what you remember. */
export interface Traced {
    /** The recipes to run, in the order to run them (deepest first), each with its runs. */
    steps: {
        recipe: string;
        runs: number;
        facility_only: boolean;
    }[];
    /** The raw items at the bottom, all of each the tree consumes, beside what the hold and every store hold of it
     * (`aboard`, `stored` by base, as last seen) and the cheapest ask remembered for it, when one is. */
    leaves: {
        item_id: string;
        need: number;
        have: number;
        source: string;
        aboard: number;
        stored: {
            base_id: string;
            quantity: number;
        }[];
        ask: CheapAsk | null;
    }[];
    tree: TraceNode | null;
    /** Each other recipe for an item in the tree, one level: what it takes instead. */
    alternates: {
        item_id: string;
        recipe: string;
        facility_only: boolean;
        inputs: {
            item_id: string;
            quantity: number;
        }[];
        makes: number;
    }[];
    /** Runs × each recipe's `crafting_time`: base ticks, before the workshop's skill factor or a facility's throughput. */
    crafting_ticks: number;
}
/** The tree `quantity` of an item takes — named by item id, recipe id, or a unique part of either — down to what is
 * mined, harvested or bought, net of what the hold and every store already hold of each intermediate. Each item's
 * route prefers recipes whose leaves are gathered over bought over only crafted, hand-craftable over facility-only,
 * and, when remembered asks price every leaf of both, the cheaper; the others are listed one level deep. Prints the
 * tree as text. Reads only: the catalog, the hold, and `world.db`. */
export declare const traceEffect: (itemOrRecipe: string, quantity?: number) => Effect.Effect<Outcome<Traced>, never, import("../game.ts").Game | import("../runtime.ts").Run>;
export declare function trace(itemOrRecipe: string, quantity?: number): Promise<Outcome<Traced>>;
