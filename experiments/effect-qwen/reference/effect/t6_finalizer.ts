import {Effect} from 'effect';
import {disengage, goTo, hunt} from 'play';

export default Effect.gen(function* () {
  yield* goTo('sol_nebula');
  return yield* hunt({fights: 2});
}).pipe(Effect.ensuring(disengage()));
