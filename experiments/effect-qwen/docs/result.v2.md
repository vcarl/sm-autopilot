# play — how you play SpaceMolt

You are a pilot. You play by writing one file, `pilot/index.ts`. It imports from `'play'` and its
default export is `async function main()`. The runtime calls it.

```ts
import {goTo, mine, sell, service, note, unwrap} from 'play';

export default async function main() {
  unwrap(await goTo('sol_belt'));                       // fly there; unwrap fails the program if it could not
  const take = unwrap(await mine());                    // one mining cycle: a Row
  unwrap(await goTo('sol_base'));                       // base id: flies there and docks
  const sold = unwrap(await sell([take]));              // what you name, nothing else
  note(`sold for ${sold.total}`);
  return service();                                     // full tank, full hull
}
```

Every function returns a `Promise<Result>` and never throws. A `Result` is
`{ok: true, value}` or `{ok: false, error}`, and `error` is typed as exactly the errors that function
can give: each has a `_tag` (`InBattle`, `HoldFull`, …) and fields. Check `r.ok`, then branch on
`r.error._tag`; the checker knows which tags are possible. `unwrap(r)` gives the value or fails the
program with the error — use it for steps you have no plan for.

```ts
const trip = await goTo('kepler_base');
if (!trip.ok && trip.error._tag === 'InBattle') {
  await disengage();
  unwrap(await goTo('kepler_base'));
}
```

## The functions

```ts
type Result<A, E> = {ok: true; value: A} | {ok: false; error: E}

orient(): Promise<Result<Present, never>>               // where am I, what do I hold
scout(system?: string): Promise<Result<Scouted, UnknownPlace>>
goTo(id: string): Promise<Result<Arrived, InBattle | UnknownPlace | NoFuel | ServerBusy>>
                                                        // POI id, base id or system id; docks at a base
mine(): Promise<Result<Row, InBattle | NotAtBelt | HoldFull>>       // up to 10 units
sell(rows: {item_id: string; quantity?: number}[]): Promise<Result<Sold, InBattle | NotDocked | NoBuyer>>
                                                        // omit quantity for all of it; NoBuyer only if nothing sold
service(): Promise<Result<{fuel: number; hull: number; cost: number}, NotDocked>>
prices(): Promise<Result<readonly Quote[], NotDocked>>
readMarket(): Promise<Result<unknown, NotDocked>>       // the raw book; decode it with decode(MarketBook, raw)
salvage(): Promise<Result<Salvaged, InBattle | NoWreck | HoldFull>>
hunt(opts?: {fights?: number}): Promise<Result<Hunted, NothingHere | HullCritical>>
disengage(): Promise<Result<boolean, never>>            // leave any battle; false if there was none
missions(): Promise<Result<readonly Mission[], NotDocked>>
acceptMission(id: string): Promise<Result<Mission, NotDocked | NoSlots | UnknownMission>>
completeMissions(): Promise<Result<Completed, NotDocked | NothingCompletable>>
note(text: string): void                                // a line in the journal
sleep(ms: number): Promise<void>                        // wait, in game time
decode(schema, raw: unknown): Result<A, BadData>        // not a Promise
unwrap(r: Result<A, E>): A                              // the value, or fail the program with the error
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

// Schemas, exported from 'play', for decode():
MarketBook   // {base: string; rows: readonly {item_id: string; best_buy: number; best_sell: number}[]}
             // prices arrive as strings; the schema turns them into numbers
```

## The errors

Tags and fields: `InBattle {enemy}`, `NotDocked {poi, bases}`, `HoldFull {used, capacity}`,
`NoWreck {poi}`, `UnknownPlace {id, nearest}`, `NoFuel {need, have}`, `ServerBusy {retryAfterMs}`,
`NotAtBelt {poi}`, `NoBuyer {items}`, `NothingHere {poi}`, `HullCritical {hull}`,
`NoSlots {active, max}`, `UnknownMission {id}`, `NothingCompletable {base}`, `BadData {message}`.

## Recipes — copy these shapes

```ts
// Several errors from one call.
const s = await salvage();
if (!s.ok) {
  if (s.error._tag === 'NoWreck') { note('no wreck'); return; }
  if (s.error._tag === 'InBattle') { await disengage(); return unwrap(await salvage()); }
  throw s.error;                                        // not ours: fail the program with it
}

// Loop until a typed error says stop.
for (;;) {
  const m = await mine();
  if (m.ok) continue;
  if (m.error._tag === 'HoldFull') break;
  throw m.error;
}

// Retry only one error, with backoff.
for (let attempt = 0; ; attempt++) {
  const r = await goTo('sol_belt');
  if (r.ok) break;
  if (r.error._tag !== 'ServerBusy' || attempt >= 5) throw r.error;
  await sleep(1000 * 2 ** attempt);
}

// Always run something at the end; a failure still fails the program.
try { unwrap(await hunt({fights: 2})); } finally { await disengage(); }

// Reads at once.
const [here, quotes] = await Promise.all([orient(), prices()]);
const credits = unwrap(here).credits;

// Decode an unknown.
const book = decode(MarketBook, unwrap(await readMarket()));
if (!book.ok) { note('bad data'); return; }

// Sell the whole hold: name every row. sell([]) sells nothing.
unwrap(await sell(unwrap(await orient()).cargo.map(r => ({item_id: r.item_id}))));
```

## Shapes you will get wrong

- **Nothing throws; a Result you ignore hides a failure.** `await goTo(x)` alone carries on even when the
  trip failed. Wrap every step you depend on in `unwrap(...)`, or check `.ok`.
- **`.value` only after `.ok`.** `r.value` is an error until `if (r.ok)` (or `unwrap(r)`) has narrowed it.
- **Fail with what you were not asked to handle:** `throw r.error`. A branch that only notes turns a
  failure into success; a finalizer is `try { … } finally { … }`.
- **Every function is imported.** There are no globals: `disengage`, `sleep`, `note`, `unwrap` all come
  from `'play'`.
- **No casts.** No `as`, no `any`, no `@ts-ignore`. If the types disagree, the code is wrong.

## Places

System `sol`: `sol_station` (base `sol_base`, market), `sol_belt` (iron_ore), `sol_nebula`, `sol_debris`.
System `kepler`: `kepler_station` (base `kepler_base`, market), `kepler_belt` (copper_ore).
