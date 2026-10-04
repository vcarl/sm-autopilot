import {Effect, Schema} from 'effect';
import {MarketBook, note, orient, readMarket, sell} from 'play';

export default Effect.gen(function* () {
  const raw = yield* readMarket();
  const book = yield* Schema.decodeUnknown(MarketBook)(raw);
  const here = yield* orient();
  const worth = here.cargo.filter(r => book.rows.some(q => q.item_id === r.item_id && q.best_buy >= 10));
  if (worth.length) yield* sell(worth);
}).pipe(Effect.catchTag('ParseError', () => note('bad book')));
