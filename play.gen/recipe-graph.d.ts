/** Ported from spacemolt-lib PR #53; to be replaced by the lib export once it ships.
 *
 * Recipe graph over the catalog: what produces an item, what consumes it, and
 * what you can craft with what you hold.
 *
 * For a full dependency trace (bill of materials, steps, raw totals,
 * alternates) query the server instead — `spacemolt_catalog` with
 * `{ type: 'recipes', id }` returns an `analysis: RecipeAnalysis` computed
 * server-side. Don't re-derive that locally here.
 *
 * Pure and deterministic given the recipe/item lists — no I/O, no Node
 * built-ins. Build it from a `Catalog` (`RecipeGraph.from`) or from bare arrays.
 */
import type { Catalog, CatalogRecipe, Item } from '@spacemolt/lib';
/** What the graph reads of a catalog item: its id and, for a raw one, how it is extracted. A `CatalogItem` is one. */
export type SourcedItem = Pick<Item, 'id' | 'extracted_by'>;
/** How much of a recipe's inputs a given inventory covers. */
export interface Coverage {
    recipe: CatalogRecipe;
    runs: number;
    /** 0..1 fraction of the required input quantity that is on hand. */
    covered: number;
    missing: {
        item_id: string;
        quantity: number;
        source: string;
    }[];
    complete: boolean;
}
export declare class RecipeGraph {
    private readonly byOutput;
    private readonly byId;
    private readonly byInput;
    private readonly itemsById;
    readonly recipes: readonly CatalogRecipe[];
    readonly items: readonly SourcedItem[];
    constructor(recipes: readonly CatalogRecipe[], items?: readonly SourcedItem[]);
    static from(catalog: Pick<Catalog, 'recipes'> & {
        items: readonly SourcedItem[];
    }): RecipeGraph;
    recipe(id: string): CatalogRecipe | undefined;
    /** Every recipe producing `itemId`, in catalog order. */
    recipesFor(itemId: string): CatalogRecipe[];
    /** Every recipe consuming `itemId`. */
    usesOf(itemId: string): CatalogRecipe[];
    /**
     * How an item enters the economy: the catalog's `extracted_by` verbatim
     * (`'mining'`, `'gas'`, ...) when the server publishes one, else `'crafted'`
     * if some recipe outputs it, else `'unknown'`. Passed through rather than
     * mapped to a local union so a new extraction method the server adds shows
     * up as itself instead of `'unknown'`.
     */
    source(itemId: string): string;
    /**
     * True when a player can hand-craft this recipe at the Station Workshop.
     *
     * Mirrors the server's own `handCraftable` rule
     * (`internal/game/facility_jobs_query.go`), which the catalog does not
     * publish — the `'Facility Only'` / `'Ship Passive'` category strings are
     * matched literally because `facility_only` alone is not sufficient there
     * either. Delete this in favour of the server's flag once `Recipe` carries
     * `hand_craftable`.
     */
    isCraftable(recipe: CatalogRecipe): boolean;
    /** How much of `recipe`'s inputs (for `runs` runs) the given inventory covers. */
    coverage(recipe: CatalogRecipe, have: ReadonlyMap<string, number> | Record<string, number>, runs?: number): Coverage;
    /**
     * Every recipe the inventory covers at least partly, best-first (most
     * covered, then fewest missing inputs). Facility-gated recipes are excluded
     * unless `includeFacilityOnly` is set; hidden and package-operation recipes
     * are always excluded.
     */
    craftableWith(have: ReadonlyMap<string, number> | Record<string, number>, opts?: {
        categories?: string[];
        includeFacilityOnly?: boolean;
    }): Coverage[];
}
