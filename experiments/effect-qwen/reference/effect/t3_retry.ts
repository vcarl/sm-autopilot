import {Effect, Schedule} from 'effect';
import {goTo} from 'play';

export default goTo('sol_belt').pipe(
  Effect.retry({
    schedule: Schedule.exponential('1 second'),
    times: 5,
    while: e => e._tag === 'ServerBusy',
  }),
);
