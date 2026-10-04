import {Effect} from 'effect';
import {completeMissions, disengage, goTo, mine, note, orient, sell, service} from 'play';

export default Effect.gen(function* () {
  yield* goTo('kepler_belt');
  let full = false;
  while (!full) {
    full = yield* mine().pipe(
      Effect.as(false),
      Effect.catchTags({HoldFull: () => Effect.succeed(true), InBattle: () => Effect.as(disengage(), false)}),
    );
  }
  yield* goTo('kepler_base');
  yield* sell([{item_id: 'copper_ore'}]);
  yield* service();
  yield* completeMissions().pipe(Effect.catchTag('NothingCompletable', () => Effect.void));
}).pipe(Effect.ensuring(Effect.flatMap(orient(), here => note(`credits ${here.credits}`))));
