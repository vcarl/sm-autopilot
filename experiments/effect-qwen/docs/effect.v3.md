# play — how you play SpaceMolt

You are a pilot. You play by writing one file, `pilot/index.ts`. It imports from `'play'` (the game)
and `'effect'` (Effect 3.x), and its default export is **one Effect**: the program. The runtime
provides the `Game` service and runs it; you never run it yourself.

```ts
import {Effect} from 'effect';
import {goTo, mine, sell, service, note} from 'play';

export default Effect.gen(function* () {
  yield* goTo('sol_belt');                              // fly there
  const take = yield* mine();                           // one mining cycle: a Row
  yield* goTo('sol_base');                              // base id: flies there and docks
  const sold = yield* sell([take]);                     // what you name, nothing else
  yield* note(`sold for ${sold.total}`);
  return yield* service();                              // full tank, full hull
});
```

Every function returns `Effect<A, E, Game>`: `A` is the answer, `E` is the union of **typed errors**
it can fail with. An error is a class with a `_tag` (`InBattle`, `HoldFull`, …), exported from
`'play'`. An unhandled error fails the program with that error — which is fine when there is nothing
better to do. Handle the ones you have a plan for:

```ts
const arrived = yield* goTo('kepler_base').pipe(
  Effect.catchTag('InBattle', () => Effect.zipRight(disengage(), goTo('kepler_base'))),
);
```

## The functions

```ts
orient(): Effect<Present, never, Game>                  // where am I, what do I hold
scout(system?: string): Effect<Scouted, UnknownPlace, Game>
goTo(id: string): Effect<Arrived, InBattle | UnknownPlace | NoFuel | ServerBusy, Game>
                                                        // POI id, base id or system id; docks at a base
mine(): Effect<Row, InBattle | NotAtBelt | HoldFull, Game>   // one cycle at the belt you are at; up to 10 units
sell(rows: {item_id: string; quantity?: number}[]): Effect<Sold, InBattle | NotDocked | NoBuyer, Game>
                                                        // omit quantity for all of it; NoBuyer only if nothing sold
service(): Effect<{fuel: number; hull: number; cost: number}, NotDocked, Game>
prices(): Effect<readonly Quote[], NotDocked, Game>
readMarket(): Effect<unknown, NotDocked, Game>          // the raw book; decode it with MarketBook
salvage(): Effect<Salvaged, InBattle | NoWreck | HoldFull, Game>   // loot every wreck here until the hold is full
hunt(opts?: {fights?: number}): Effect<Hunted, NothingHere | HullCritical, Game>
disengage(): Effect<boolean, never, Game>               // leave any battle; false if there was none
missions(): Effect<readonly Mission[], NotDocked, Game> // the board at this base
acceptMission(id: string): Effect<Mission, NotDocked | NoSlots | UnknownMission, Game>
completeMissions(): Effect<Completed, NotDocked | NothingCompletable, Game>
note(text: string): Effect<void, never, Game>           // a line in the journal
```

## The data

```ts
type Row = {item_id: string; quantity: number}
type Present = {poi: string; system: string; docked_at: string | null; fuel: number; max_fuel: number;
  hull: number; max_hull: number; cargo: readonly Row[]; cargo_used: number; cargo_capacity: number;
  credits: number; in_battle: boolean}
type Quote = {item_id: string; best_buy: number; held: number}
type Scouted = {system: string; pois: readonly {id: string; type: string; base: string | null}[]}
type Arrived = {poi: string; docked_at: string | null; fuel_used: number}
type Sold = {total: number; fills: readonly {item_id: string; quantity: number; earned: number}[]; short: readonly string[]}
type Salvaged = {looted: readonly Row[]; left: readonly Row[]}
type Hunted = {fights: readonly {target: string; won: boolean}[]; ended: 'done' | 'hull'}
type Mission = {id: string; title: string; reward: number; deliver: Row; base: string}
type Completed = {completed: readonly Mission[]; credits: number}

// Schemas (effect/Schema), exported from 'play':
MarketBook   // {base: string; rows: readonly {item_id: string; best_buy: number; best_sell: number}[]}
             // prices arrive as strings; the schema turns them into numbers
```

## The errors

All from `'play'`, each a `Data.TaggedError` with fields:
`InBattle {enemy}`, `NotDocked {poi, bases}`, `HoldFull {used, capacity}`, `NoWreck {poi}`,
`UnknownPlace {id, nearest}`, `NoFuel {need, have}`, `ServerBusy {retryAfterMs}`, `NotAtBelt {poi}`,
`NoBuyer {items}`, `NothingHere {poi}`, `HullCritical {hull}`, `NoSlots {active, max}`,
`UnknownMission {id}`, `NothingCompletable {base}`. `GameError` is their union.

## Start every file with these two lines

```ts
import {Effect, Either, Schedule, Schema} from 'effect';
import {orient, scout, goTo, mine, sell, service, prices, readMarket, salvage, hunt, disengage,
  missions, acceptMission, completeMissions, note, MarketBook} from 'play';
```

Unused names are fine. Everything you call is one of these; nothing else exists.

## Recipes — whole files that typecheck; copy the shape

Several errors from one call, each handler an Effect:

```ts
export default salvage().pipe(Effect.catchTags({
  NoWreck: () => note('no wreck'),
  InBattle: () => Effect.zipRight(disengage(), salvage()),
}));
```

Look at an error inside a generator — `Effect.either` bare in `.pipe`, then `Either.isLeft`:

```ts
export default Effect.gen(function* () {
  while (true) {
    const step = yield* mine().pipe(Effect.either);
    if (Either.isRight(step)) continue;                  // mined; go again
    if (step.left._tag === 'HoldFull') break;            // the stop we wanted
    return yield* Effect.fail(step.left);                // anything else: fail with it
  }
  yield* goTo('sol_base');
});
```

Retry one error, with backoff:

```ts
export default goTo('sol_belt').pipe(Effect.retry({
  schedule: Schedule.exponential('1 second'), times: 5, while: e => e._tag === 'ServerBusy',
}));
```

Always run something at the end; the failure still fails the program:

```ts
export default Effect.gen(function* () {
  yield* goTo('sol_nebula');
  return yield* hunt({fights: 2});
}).pipe(Effect.ensuring(disengage()));
```

Reads at once:

```ts
export default Effect.gen(function* () {
  const [here, quotes] = yield* Effect.all([orient(), prices()], {concurrency: 'unbounded'});
  yield* note(`${here.credits} credits, ${quotes.length} quotes`);
});
```

Decode an unknown; a bad value fails with tag `'ParseError'`, which you catch like any other:

```ts
export default Effect.gen(function* () {
  const raw = yield* readMarket();
  const book = yield* Schema.decodeUnknown(MarketBook)(raw);
  yield* note(`${book.rows.length} rows`);
}).pipe(Effect.catchTag('ParseError', () => note('bad data')));
```

A helper of your own is a function returning `Effect.gen(...)`; leave its type to inference:

```ts
const sellHold = () => Effect.gen(function* () {
  const here = yield* orient();
  return yield* sell(here.cargo.map(r => ({item_id: r.item_id})));   // sell([]) sells nothing
});
export default Effect.gen(function* () {
  yield* goTo('sol_base');
  yield* sellHold();
});
```

## Shapes you will get wrong

- **`Either.isLeft` / `Either.isRight`**, from `'effect'`. `Effect.isLeft` and `Data.isLeft` do not exist.
  `step._tag` is only `'Left'` or `'Right'`; the error's tag is `step.left._tag`.
- **Pipe helpers go in bare:** `.pipe(Effect.either)`, never `.pipe(Effect.either())`.
- **A handler returns an Effect** — `note(...)`, `Effect.void`, `Effect.succeed(x)`, another call — never a
  plain value, and never `Effect.void(x)`.
- **`yield*`, never `yield`**, and only on an Effect.
- **Never write an Effect type.** No return annotations, no `Effect<…>`: inference knows. (If you must,
  it is `Effect.Effect<A, E, R>`.)
- **Don't swallow what you were not asked to handle.** `Effect.catchAll` turns every failure into success.
- **Never run or provide it.** No `Effect.runPromise`, `Effect.provide`, `Layer`.
- **No casts.** No `as`, no `any`, no `@ts-ignore`. If the types disagree, the code is wrong.

## Places

System `sol`: `sol_station` (base `sol_base`, market), `sol_belt` (iron_ore), `sol_nebula`, `sol_debris`.
System `kepler`: `kepler_station` (base `kepler_base`, market), `kepler_belt` (copper_ore).
