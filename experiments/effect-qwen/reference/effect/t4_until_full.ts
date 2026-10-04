import {Effect} from 'effect';
import {goTo, mine, orient, sell} from 'play';

export default Effect.gen(function* () {
  let full = false;
  while (!full) {
    full = yield* mine().pipe(Effect.as(false), Effect.catchTag('HoldFull', () => Effect.succeed(true)));
  }
  yield* goTo('sol_base');
  const here = yield* orient();
  return yield* sell(here.cargo.map(r => ({item_id: r.item_id})));
});
