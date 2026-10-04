import {Effect} from 'effect';
import {acceptMission, completeMissions, missions, note} from 'play';

export default Effect.gen(function* () {
  const board = yield* missions();
  let accepted = 0;
  for (const m of board.filter(m => m.reward >= 100)) {
    const ok = yield* acceptMission(m.id).pipe(Effect.as(true), Effect.catchTag('NoSlots', () => Effect.succeed(false)));
    if (!ok) break;
    accepted++;
  }
  yield* completeMissions().pipe(Effect.catchTag('NothingCompletable', () => note('nothing completable')));
  return accepted;
});
