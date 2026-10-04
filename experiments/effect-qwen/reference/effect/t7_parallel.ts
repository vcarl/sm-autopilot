import {Effect} from 'effect';
import {missions, note, orient, prices} from 'play';

export default Effect.gen(function* () {
  const [here, quotes, board] = yield* Effect.all([orient(), prices(), missions()], {concurrency: 'unbounded'});
  const best = [...quotes].sort((a, b) => b.best_buy - a.best_buy)[0];
  yield* note(`credits ${here.credits}, best ${best?.item_id ?? 'none'}, missions ${board.length}`);
});
