import {Effect} from 'effect';
import {goTo, mine, sell, service} from 'play';

export default Effect.gen(function* () {
  yield* goTo('sol_belt');
  for (let i = 0; i < 3; i++) yield* mine();
  yield* goTo('sol_base');
  yield* sell([{item_id: 'iron_ore'}]);
  return yield* service();
});
