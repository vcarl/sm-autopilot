import {note, prices, sell} from 'play';

export default async function main() {
  const market = await prices();
  if (market.status !== 'done') { note('bad book'); return market; }
  const worth = market.detail.quotes.filter(q => q.held > 0 && q.best_buy >= 10).map(q => ({item_id: q.item_id}));
  if (!worth.length) { note('nothing to sell'); return market; }
  return sell(worth);
}
