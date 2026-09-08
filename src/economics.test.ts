import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLoop, quoteDepth, rankLoops, type LoopCandidate } from './economics.ts';

const base: LoopCandidate = {
  id: 'refine', recipe: { id: 'smelt', inputs: [{ item_id: 'ore', quantity: 3 }], outputs: [{ item_id: 'metal', quantity: 2 }] },
  target: { item_id: 'metal', quantity: 3 },
  inputs: [{ item_id: 'ore', source: 'buy', asks: [{ price_each: 2, quantity: 3 }, { price_each: 4, quantity: 3 }], rawSaleBids: [{ price_each: 6, quantity: 6 }] }],
  outputMarkets: [{ item_id: 'metal', bids: [{ price_each: 8, quantity: 4 }] }],
  costs: { travelCredits: 2, laborCredits: 1, taxCredits: 1, otherCredits: 0, travelSeconds: 20, craftSeconds: 10, otherSeconds: 0, rawSaleCredits: 2 },
};

test('consumes finite depth, excludes own orders, rounds complete batches and flags partial liquidation', () => {
  const levels = [{ price_each: 5, quantity: 3 }, { price_each: 2, quantity: 4, my_quantity: 1 }];
  const buy = quoteDepth(levels, 5, 'buy');
  const sell = quoteDepth(levels, 8, 'sell');
  assert.equal(buy.credits, 3 * 2 + 2 * 5);
  assert.equal(sell.filled, 6); assert.equal(sell.unfilled, 2);
  assert.deepEqual(levels[0], { price_each: 5, quantity: 3 });
  const full = evaluateLoop(base);
  assert.equal(full.batches, 2); assert.equal(full.outputs[0].quantity, 4);
  assert.equal(full.purchaseCredits, 3 * 2 + 3 * 4);
  assert.equal(full.expectedProfit, 4 * 8 - full.purchaseCredits - 4);
  const thin = evaluateLoop({ ...base, id: 'thin', outputMarkets: [{ item_id: 'metal', bids: [{ price_each: 100, quantity: 1 }] }] });
  assert.equal(thin.outputs[0].sale?.filled, 1); assert.equal(thin.feasible, false);
  assert.equal(rankLoops([thin, full], 'profit')[0].id, full.id);
  const missing = evaluateLoop({ ...base, costs: { ...base.costs, taxCredits: undefined } });
  assert.equal(missing.expectedProfit, null); assert.ok(missing.unknowns.includes('estimate: taxCredits'));
});

test('separates mined cash earnings from processing opportunity, and ranks time explicitly', () => {
  const bought = evaluateLoop(base);
  const mined = evaluateLoop({ ...base, id: 'mined', inputs: [{ ...base.inputs[0], source: 'mine', measuredUnitCost: 1, secondsPerUnit: 5, availableQuantity: 6 }] });
  assert.equal(mined.expectedProfit! - bought.expectedProfit!, bought.purchaseCredits - 6);
  assert.equal(mined.processingAdvantage, bought.processingAdvantage);
  assert.ok(mined.expectedProfit! > 0); assert.ok(mined.processingAdvantage! < 0);
  assert.equal(mined.seconds, bought.seconds! + 6 * 5);
  const faster = { ...mined, id: 'faster', seconds: 1, profitPerSecond: mined.expectedProfit };
  assert.equal(rankLoops([mined, faster])[0].id, 'faster');
  const depleted = evaluateLoop({ ...base, inputs: [{ ...base.inputs[0], source: 'mine', availableQuantity: 0 }] });
  assert.equal(depleted.feasible, false); assert.equal(depleted.expectedProfit, null);
  assert.ok(depleted.blockers.some(x => x.includes('insufficient mine')));
  const raw = evaluateLoop({ ...base, recipe: undefined, target: { item_id: 'ore', quantity: 2 }, outputMarkets: [{ item_id: 'ore', bids: [{ price_each: 5, quantity: 2 }] }] });
  assert.equal(raw.outputs[0].sale?.credits, 10); assert.equal(raw.processingAdvantage, null);
});
