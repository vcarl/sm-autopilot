import {Effect} from 'effect';
import {goTo, disengage, note} from 'play';

export default goTo('kepler_base').pipe(
  Effect.catchTag('InBattle', () => Effect.zipRight(disengage(), goTo('kepler_base'))),
  Effect.catchAll(e => note(`goTo failed: ${e._tag}`)),
);
