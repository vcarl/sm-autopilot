import {Effect} from 'effect';
import {goTo} from 'play';
export default Effect.runPromise(goTo('sol_belt') as any);
