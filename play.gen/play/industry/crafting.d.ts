/** The bench at the base you are docked at — its workshop, or a facility there named by id:
 * recipes, quotes, stocking the store, crafts, the queue, and what a recipe tree comes to.
 *
 * Every call here uses the one convention the live game answered to: `source:'storage'`,
 * `deliver_to:'storage'`. The bench escrows the inputs out of THIS base's store and delivers
 * the output back into it, so the store — not the hold — is what has to be stocked, and the
 * store's own delta before and after is the only evidence the output arrived.
 */
import { fetchCatalogConditional, type Catalog, type CraftJobResponse, type CraftQuoteResponse, type ItemQuantity, type JobView, type Recipe, type RecipeInput } from '@spacemolt/lib';
import type { Outcome, Row } from '../types.ts';
/** The catalog recipe beside what it is worth here and what you already hold. */
export type Craftable = Recipe & {
    /** Value of outputs minus inputs at this base's live `best_buy`/`best_sell`, when quoted.
     * `null` when this base has no buyer for an output: unknown, not zero. `spreads()` says
     * which base does buy it. */
    margin?: number | null;
    /** Each input against what you hold here (hold + store). */
    have: (RecipeInput & {
        have: number;
    })[];
};
/** Where the recipe catalog comes from. The tests pass a fixture; nothing else calls it. */
export declare function useCatalog(load: () => Promise<Catalog>): void;
/** The catalog kept in `dir` beside its ETag, so a fresh process pays a ~0-byte 304 rather than
 * the multi-MB body when nothing changed, and a failed fetch falls back to the copy on disk.
 * One `fetch` line each time: status, ms, bytes stored, whether the disk copy answered. */
export declare function revalidated(dir: string | undefined, load?: typeof fetchCatalogConditional): Promise<Catalog>;
/** Where the quote says it runs and what it charges beyond the inputs. No fee at your own
 * facility and nothing at all at the workshop, so absent reads as 0. */
export interface Venue {
    venue: string;
    venue_type: string;
    facility_id?: string;
    labor: number;
    fee: number;
}
/** What can be made here, right now, out of what this base's store and the hold hold between
 * them: every catalog recipe whose inputs are all covered, each one dry-run for its real fee
 * and labour and priced against this base's book (one market read), sorted by margin in
 * credits. Reads only — nothing is escrowed, bought or queued.
 *
 * `search` filters on recipe id, name, category or output item. Capped at 20 quoted rows;
 * `did` says how many covered recipes were cut. Refused when there is no bench here, which is
 * itself the answer: the ore is in the wrong place. */
export declare function recipes(search?: string): Promise<Outcome<{
    recipes: Craftable[];
}>>;
/** An input the store is short of, with both sides of mine-or-buy. */
export interface Missing {
    item_id: string;
    need: number;
    have: number;
    /** What one costs on this market for the `need − have` you lack, the buy fee included;
     * `null` when this market does not sell it — mine it. */
    buy_each: number | null;
    /** This book's `best_buy`: what one of your own would fetch sold here instead of used;
     * `null` when nobody here buys it. */
    sell_each: number | null;
    /** How it enters the economy: `mining`, `gas`, …, `crafted`, or `unknown`. */
    source: string;
}
/** One recipe's full cost against what it is worth here. */
export type Quoted = CraftQuoteResponse & Venue & {
    /** `produces` is per run; this is per run × `runs`, what the whole order makes. */
    produces_total: ItemQuantity[];
    /** `produces_total` at this base's top buy level, or `null` when this base has no buyer
     * for one of them. */
    output_value: number | null;
    /** `output_value` less `credits_total`. Positive is worth crafting here; `null` means
     * unknown here, not zero — `spreads()` says which base buys the output. */
    margin: number | null;
    /** Inputs this base's store is short of, each priced to buy and to sell here. */
    missing: Missing[];
};
/** A dry-run quote for one recipe at this base's workshop, or wherever `at` names: the venue,
 * the escrow (inputs, labour, fee), `credits_total`, `est_completion_tick`,
 * `have_inputs`/`have_credits`/`have_capacity`, plus what the whole order fetches here and
 * the inputs the store is short of, each priced to buy and to sell. Nothing is committed.
 * `next` names the buy or the mining that would close the gap. */
export declare function quote(recipeId: string, quantity?: number, opts?: {
    at?: 'workshop' | string;
}): Promise<Outcome<Quoted>>;
export interface Supplied {
    /** Moved from the hold into this base's store, measured from the hold. */
    stowed: Row[];
    /** Bought into this base's store, as each buy reported it. */
    bought: Row[];
    /** Inputs the store is still short of after all that, read from the store. */
    short: {
        item_id: string;
        have: number;
        need: number;
        source: string;
    }[];
    /** Credits the buys actually cost, wallet before vs after (fee-inclusive; `total_cost` alone
     * is the pre-tax subtotal). */
    spent: number;
}
/** This base's store holds every input `quantity` of a recipe escrows — at the workshop or
 * wherever `at` names, since that decides the inputs.
 *
 * Reads the dry run and the store; an input already stocked is left alone, so a stocked store
 * is `done` with nothing sent. The rest is stowed from the hold first, then bought into the
 * store at this market. The whole bill is estimated (buy fee included) before anything moves:
 * over `maxSpend`, it is refused with nothing stowed or bought. An input this market does not
 * sell comes back in `short` with its `source`, and the status is `partial`. Each buy keeps
 * `credits − permissions.credit_reserve`. */
export declare function supply(recipeId: string, quantity?: number, opts?: {
    at?: 'workshop' | string;
    maxSpend?: number;
}): Promise<Outcome<Supplied>>;
export interface Crafted extends Venue {
    /** The commit, or the queue row this run re-entered on. */
    job: CraftJobResponse | JobView;
    /** What landed in the store, measured from `storage/view` before and after. */
    made: Row[];
}
/** Quote, stock the store, commit the escrow, wait out the queue, confirm the outputs landed
 * in this base's store. `at` is where it runs: `'workshop'`, a facility id from
 * `facilities().here`, or omitted for the server's choice.
 *
 * Preconditions, all before anything is committed: docked at a base with a workshop (or at
 * the named facility's base); the inputs in this base's store, with anything the hold carries
 * stowed into it by name first; the escrow inside `credits − permissions.credit_reserve`.
 * Refused, naming the shortfall, when any of them does not hold.
 *
 * A job already queued here for this recipe and this many runs IS this job: the run re-enters
 * at the wait and escrows nothing twice, so a re-run after a restart is safe. The wait streams
 * a line at least every 90 seconds and gives up after 10 minutes with `partial` and the job.
 * Tired mid-wait keeps waiting — the ship is docked — but `craft` will not start while Tired.
 *
 * At the workshop it trains crafting, and engineering for components and modules; a facility
 * trains nothing. */
export declare function craft(recipeId: string, quantity?: number, opts?: {
    at?: 'workshop' | string;
}): Promise<Outcome<Crafted>>;
/** A queued job as `jobs()` reports it. */
export interface Queued {
    job_id: string;
    /** The recipe's display name, as the queue names it. */
    recipe: string;
    base_id?: string;
    venue_type?: string;
    /** `queued` or `active`; a finished job leaves the queue rather than changing status. */
    status: string;
    runs_done: number;
    runs_total: number;
    /** A workshop job at a base the ship is not docked at: it does not advance until you dock
     * there again. Facility jobs run while you fly. */
    paused: boolean;
}
/** Every job this pilot has queued, at every base, and which of them are paused because the
 * ship is not docked there. Works undocked. Reads only. */
export declare function jobs(): Promise<Outcome<{
    jobs: Queued[];
}>>;
/** What one recipe tree comes to, from the catalog. */
export interface Materials {
    /** The recipes to run, in the order to run them (deepest first), each with its runs. */
    steps: {
        recipe: string;
        runs: number;
        facility_only: boolean;
    }[];
    /** The raw items at the bottom, all of each the tree consumes, beside what the hold and this
     * base's store hold of it. */
    leaves: {
        item_id: string;
        need: number;
        have: number;
        source: string;
    }[];
}
/** Everything `quantity` of `itemId` takes, down to raw leaves, net of what the hold and — when
 * docked — this base's store already hold of each intermediate. From the catalog: reads only,
 * works undocked, needs no bench. `failed` when the catalog cannot be read. */
export declare function materials(itemId: string, quantity: number): Promise<Outcome<Materials>>;
