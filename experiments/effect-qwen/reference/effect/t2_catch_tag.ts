import {Effect} from 'effect';
import {goTo, disengage, note} from 'play';

export default goTo('kepler_base').pipe(
  Effect.catchTag('InBattle', () => Effect.andThen(disengage(), goTo('kepler_base'))),
  Effect.catch(e => note(`goTo failed: ${e._tag}`)),
);
