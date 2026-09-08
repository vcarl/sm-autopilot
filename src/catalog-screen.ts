import { evaluateLoop, quoteDepth } from './economics.ts';
import { recipePrerequisites } from './recipe-prerequisites.ts';

type Row = Record<string, any>;
export interface CatalogScreenInput {
  recipes: readonly Row[];
  station: string;
  market: Row;
  storage: Row | readonly Row[];
  cargo: readonly Row[];
  facilities: Row;
  skills: Row;
}

/** Evaluate the complete local catalog before any presentation/quote limit. */
export function screenCatalog({ recipes, station, market, storage, cargo, facilities, skills }: CatalogScreenInput) {
  const stock: readonly Row[] = Array.isArray(storage) ? storage : (storage as Row).items ?? [];
  const available = new Map<string, number>();
  for (const item of [...stock, ...cargo]) available.set(item.item_id, (available.get(item.item_id) ?? 0) + item.quantity);
  const books = new Map<string, Row>((market.items ?? []).map((item: Row) => [item.item_id, item]));
  // The public flag controls access to somebody else's venue, not one's own.
  const owned = [...facilities.player_facilities ?? [], ...facilities.faction_facilities ?? []]
    .map(venue => ({ ...venue, production: { ...venue.production, public: true } }));
  const external = [...facilities.station_facilities ?? [], ...facilities.public_facilities ?? []]
    .filter(venue => venue.production?.public !== false && venue.public !== false);
  const venues = [...owned, ...external];
  const eligibleRecipes = recipes.filter(recipe => !recipe.hidden && !recipe.package_operation && recipe.outputs?.length);
  const candidates: Row[] = [], exploration_candidates: Row[] = [];
  for (const recipe of eligibleRecipes) {
    const prerequisites = recipePrerequisites(recipe, venues, skills);
    const venue = venues.find(venue => venue.recipe_id === recipe.id);
    for (const source of ['buy', 'inventory'] as const) {
      const row = evaluateLoop({ id: `${station}/${recipe.id}/${source}`, recipe: {id:recipe.id, inputs:recipe.inputs, outputs:recipe.outputs}, batches: 1,
        inputs: recipe.inputs.map((item: Row) => ({item_id:item.item_id, source, asks:books.get(item.item_id)?.sell_orders ?? [],
          rawSaleBids:books.get(item.item_id)?.buy_orders ?? [], availableQuantity:available.get(item.item_id) ?? 0})),
        outputMarkets: recipe.outputs.map((item: Row) => ({item_id:item.item_id, bids:books.get(item.item_id)?.buy_orders ?? []})),
        costs: {travelCredits:0, laborCredits:undefined, taxCredits:undefined, otherCredits:0, travelSeconds:0,
          craftSeconds:Math.max(1, Math.ceil(recipe.crafting_time ?? 0))*10, otherSeconds:30, rawSaleCredits:0},
        blockers:prerequisites.blockers });
      row.unknowns.push(...prerequisites.unknowns);
      const shared = {...row, recipe_id:recipe.id, source, venue:venue?.name ?? (recipe.facility_only ? 'Unobserved facility' : 'Workshop')};
      if (!row.blockers.length) candidates.push({...shared, gross_margin:row.saleCredits - (source === 'inventory' ? row.rawSaleCredits ?? 0 : row.purchaseCredits)});
      else if (source === 'inventory') {
        const rawQuotes = row.inputs.map(input => ({book:books.get(input.item_id), fill:quoteDepth(books.get(input.item_id)?.buy_orders ?? [], input.quantity, 'sell')}));
        const known = rawQuotes.every(quote => quote.book && quote.fill.complete);
        const benchmark = known ? rawQuotes.reduce((sum,quote) => sum + quote.fill.credits, 0) : null;
        const outputComplete = row.outputs.every(output => output.sale?.complete);
        exploration_candidates.push({...shared, source:'mine_or_buy',
          inputs_needed:row.inputs.map(input => ({item_id:input.item_id, quantity:Math.max(0,input.quantity-(available.get(input.item_id) ?? 0))})).filter(input => input.quantity > 0),
          raw_sale_benchmark:benchmark, potential_conversion_margin:benchmark === null || !outputComplete ? null : row.saleCredits-benchmark,
          output_sale_credits:row.saleCredits, output_demand_complete:outputComplete,
          benchmark_note:!outputComplete ? 'Observed output demand is insufficient; another market or future demand must be established.' : known
            ? 'Output proceeds minus finite-depth raw sale opportunity, before labor, tax and acquisition/travel costs.'
            : 'Raw-sale benchmark unavailable at full depth; missing inputs are not valued as free.'});
      }
    }
  }
  candidates.sort((a,b) => b.gross_margin-a.gross_margin || a.id.localeCompare(b.id));
  exploration_candidates.sort((a,b) => (b.potential_conversion_margin ?? -Infinity)-(a.potential_conversion_margin ?? -Infinity) || b.output_sale_credits-a.output_sale_credits || a.id.localeCompare(b.id));
  return {candidates, exploration_candidates, evaluated_recipe_count:eligibleRecipes.length};
}
