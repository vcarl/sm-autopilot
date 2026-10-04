import {MarketBook, decode, isError, note, orient, readMarket, sell} from 'play';

export default async function main() {
  const raw = await readMarket();
  let book;
  try { book = decode(MarketBook, raw); }
  catch (e) { if (isError(e, 'BadData')) { note('bad book'); return; } throw e; }
  const here = await orient();
  const worth = here.cargo.filter(r => book.rows.some(q => q.item_id === r.item_id && q.best_buy >= 10));
  if (worth.length) return sell(worth);
}
