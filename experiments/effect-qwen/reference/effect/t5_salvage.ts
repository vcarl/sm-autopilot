import {Effect} from 'effect';
import {disengage, goTo, note, orient, salvage, sell} from 'play';

const sellHold = Effect.gen(function* () {
  yield* goTo('sol_base');
  const here = yield* orient();
  yield* sell(here.cargo.map(r => ({item_id: r.item_id})));
  yield* goTo('sol_debris');
});

export default salvage().pipe(
  Effect.catchTags({
    NoWreck: () => note('no wreck'),
    InBattle: () => Effect.zipRight(disengage(), salvage()),
    HoldFull: () => Effect.zipRight(sellHold, salvage()),
  }),
);
