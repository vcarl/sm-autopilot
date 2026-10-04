import {MarketBook, decode, note, orient, readMarket, sell, unwrap} from 'play';

export default async function main() {
  const book = decode(MarketBook, unwrap(await readMarket()));
  if (!book.ok) { note('bad book'); return; }
  const here = unwrap(await orient());
  const worth = here.cargo.filter(r => book.value.rows.some(q => q.item_id === r.item_id && q.best_buy >= 10));
  if (worth.length) return unwrap(await sell(worth));
}
