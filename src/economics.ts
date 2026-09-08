/** Pure estimates. Order books are observations, never promises of future fills. */
export interface PriceLevel { price_each: number; quantity: number; my_quantity?: number }
export interface DepthQuote {
  requested: number; filled: number; unfilled: number; credits: number;
  averagePrice: number | null; complete: boolean;
}
function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
  return value;
}
export function quoteDepth(levels: readonly PriceLevel[], quantity: number, side: 'buy' | 'sell'): DepthQuote {
  nonnegative(quantity, 'quantity');
  const sorted = levels.map(level => ({
    price: nonnegative(level.price_each, 'price_each'),
    quantity: Math.max(0, nonnegative(level.quantity, 'quantity') - nonnegative(level.my_quantity ?? 0, 'my_quantity')),
  })).sort((a, b) => side === 'buy' ? a.price - b.price : b.price - a.price);
  let remaining = quantity, credits = 0;
  for (const level of sorted) {
    const filled = Math.min(remaining, level.quantity);
    credits += filled * level.price;
    remaining -= filled;
    if (!remaining) break;
  }
  const filled = quantity - remaining;
  return { requested: quantity, filled, unfilled: remaining, credits,
    averagePrice: filled ? credits / filled : null, complete: remaining === 0 };
}
export interface ItemQuantity { item_id: string; quantity: number }
export interface EconomicRecipe { id: string; inputs: ItemQuantity[]; outputs: ItemQuantity[] }
export interface InputSource {
  item_id: string;
  source: 'buy' | 'mine' | 'inventory';
  asks?: PriceLevel[];
  /** Bids at the alternative raw-material sale location. Empty means observed no demand. */
  rawSaleBids?: PriceLevel[];
  /** Mining fuel/repair/consumables cost, measured per recovered unit; not sunk equipment cost. */
  measuredUnitCost?: number;
  secondsPerUnit?: number;
  availableQuantity?: number;
}
export interface LoopCosts {
  travelCredits?: number; laborCredits?: number; taxCredits?: number; otherCredits?: number;
  travelSeconds?: number; craftSeconds?: number; otherSeconds?: number;
  /** Extra cost of taking the raw-sale alternative (zero only if established). */
  rawSaleCredits?: number;
}
export interface LoopCandidate {
  id: string;
  recipe?: EconomicRecipe;
  /** Desired output; whole recipe batches round up. Without recipe this is a raw sale loop. */
  target?: ItemQuantity;
  batches?: number;
  inputs: InputSource[];
  outputMarkets: { item_id: string; bids?: PriceLevel[] }[];
  costs: LoopCosts;
  /** Skill/facility/cargo/reachability checks supplied by the caller. */
  blockers?: string[];
}
export interface LoopEvaluation {
  id: string; batches: number;
  inputs: (ItemQuantity & { source?: InputSource['source']; purchase?: DepthQuote })[];
  outputs: (ItemQuantity & { sale?: DepthQuote })[];
  blockers: string[]; unknowns: string[]; feasible: boolean;
  purchaseCredits: number; miningCredits: number; saleCredits: number;
  /** Full loop cash delta, including measured extraction cost. Null if estimates are missing. */
  expectedProfit: number | null;
  seconds: number | null; profitPerSecond: number | null;
  /** Finite-depth gross value of every recipe input sold raw (unsold units valued at zero). */
  rawSaleCredits: number | null;
  /** Craft sale proceeds minus raw proceeds and incremental craft/route costs; input acquisition cancels. */
  processingAdvantage: number | null;
  costs: LoopCosts;
}
function sumItems(items: ItemQuantity[], multiplier: number): ItemQuantity[] {
  const totals = new Map<string, number>();
  for (const item of items) totals.set(item.item_id, (totals.get(item.item_id) ?? 0) + nonnegative(item.quantity, 'recipe quantity') * multiplier);
  return [...totals].map(([item_id, quantity]) => ({ item_id, quantity }));
}
export function evaluateLoop(candidate: LoopCandidate): LoopEvaluation {
  let batches = candidate.batches ?? 1;
  if (candidate.target && candidate.recipe) {
    const output = candidate.recipe.outputs.filter(x => x.item_id === candidate.target!.item_id).reduce((n, x) => n + x.quantity, 0);
    if (!(output > 0)) throw new Error('Target is not a positive recipe output');
    batches = Math.ceil(nonnegative(candidate.target.quantity, 'target quantity') / output);
  }
  if (!Number.isInteger(batches) || batches < 1) throw new Error('batches must be a positive integer');
  if (!candidate.recipe && !candidate.target) throw new Error('A raw loop requires a target');
  const requirements = sumItems(candidate.recipe?.inputs ?? [candidate.target!], candidate.recipe ? batches : 1);
  const products = sumItems(candidate.recipe?.outputs ?? [candidate.target!], candidate.recipe ? batches : 1);
  const blockers = [...(candidate.blockers ?? [])], unknowns: string[] = [];
  let purchaseCredits = 0, miningCredits = 0, miningSeconds = 0, rawValue = 0, rawKnown = true;
  const inputs = requirements.map(item => {
    const source = candidate.inputs.find(x => x.item_id === item.item_id);
    if (!source) { rawKnown = false; unknowns.push(`input source: ${item.item_id}`); return item; }
    let purchase: DepthQuote | undefined;
    if (source.source === 'buy') {
      if (!source.asks) unknowns.push(`buy depth: ${item.item_id}`);
      else {
        purchase = quoteDepth(source.asks, item.quantity, 'buy'); purchaseCredits += purchase.credits;
        if (!purchase.complete) blockers.push(`insufficient supply: ${item.item_id} (${purchase.unfilled} missing)`);
      }
    } else {
      if (source.availableQuantity === undefined) unknowns.push(`available ${source.source} quantity: ${item.item_id}`);
      else if (nonnegative(source.availableQuantity, 'availableQuantity') < item.quantity) blockers.push(`insufficient ${source.source} quantity: ${item.item_id}`);
      if (source.source === 'mine') {
        if (source.measuredUnitCost === undefined) unknowns.push(`measured mining cost: ${item.item_id}`);
        else miningCredits += nonnegative(source.measuredUnitCost, 'measuredUnitCost') * item.quantity;
        if (source.secondsPerUnit === undefined) unknowns.push(`measured mining time: ${item.item_id}`);
        else miningSeconds += nonnegative(source.secondsPerUnit, 'secondsPerUnit') * item.quantity;
      }
    }
    if (!source.rawSaleBids) rawKnown = false;
    else rawValue += quoteDepth(source.rawSaleBids, item.quantity, 'sell').credits;
    return { ...item, source: source.source, ...(purchase ? { purchase } : {}) };
  });
  let saleCredits = 0;
  const outputs = products.map(item => {
    const market = candidate.outputMarkets.find(x => x.item_id === item.item_id);
    if (!market?.bids) { unknowns.push(`sale depth: ${item.item_id}`); return item; }
    const sale = quoteDepth(market.bids, item.quantity, 'sell'); saleCredits += sale.credits;
    if (!sale.complete) blockers.push(`insufficient demand: ${item.item_id} (${sale.unfilled} unsold)`);
    return { ...item, sale };
  });
  const costKeys = ['travelCredits', 'laborCredits', 'taxCredits', 'otherCredits'] as const;
  const timeKeys = ['travelSeconds', 'craftSeconds', 'otherSeconds'] as const;
  const sumCosts = (keys: readonly (keyof LoopCosts)[]) => keys.reduce((total, key) => {
    const value = candidate.costs[key];
    if (value === undefined) { unknowns.push(`estimate: ${key}`); return total; }
    return total + nonnegative(value, key);
  }, 0);
  const overhead = sumCosts(costKeys), time = sumCosts(timeKeys) + miningSeconds;
  const timeUnknown = unknowns.some(x => x.includes('time:') || timeKeys.some(key => x === `estimate: ${key}`));
  const financialUnknown = unknowns.some(x => !x.includes('time:') && !timeKeys.some(key => x === `estimate: ${key}`));
  const expectedProfit = financialUnknown ? null : saleCredits - purchaseCredits - miningCredits - overhead;
  const seconds = timeUnknown ? null : time;
  const rawSaleCredits = rawKnown ? rawValue : null;
  const processingAdvantage = candidate.recipe && rawKnown && !financialUnknown && candidate.costs.rawSaleCredits !== undefined
    ? saleCredits - rawValue - overhead + nonnegative(candidate.costs.rawSaleCredits, 'rawSaleCredits') : null;
  return { id: candidate.id, batches, inputs, outputs, blockers, unknowns, feasible: !blockers.length && !unknowns.length,
    purchaseCredits, miningCredits, saleCredits, expectedProfit, seconds,
    profitPerSecond: expectedProfit !== null && seconds !== null && seconds > 0 ? expectedProfit / seconds : null,
    rawSaleCredits, processingAdvantage, costs: { ...candidate.costs } };
}
export function rankLoops(evaluations: LoopEvaluation[], by: 'profit' | 'profitPerSecond' = 'profitPerSecond'): LoopEvaluation[] {
  const score = (row: LoopEvaluation) => (by === 'profit' ? row.expectedProfit : row.profitPerSecond) ?? -Infinity;
  return [...evaluations].sort((a, b) => Number(b.feasible) - Number(a.feasible) || score(b) - score(a) || a.id.localeCompare(b.id));
}
