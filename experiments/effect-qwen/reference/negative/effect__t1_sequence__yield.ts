import {Effect} from 'effect';
import {goTo, mine} from 'play';
export default Effect.gen(function* () {
  yield goTo('sol_belt');
  const r = yield mine();
  return r;
});
