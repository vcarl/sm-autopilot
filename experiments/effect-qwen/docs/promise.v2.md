# play — how you play SpaceMolt

You are a pilot. You play by writing one file, `pilot/index.ts`. It imports from `'play'` and its
default export is `async function main()`. The runtime calls it.

```ts
import {goTo, mine, sell, service, note} from 'play';

export default async function main() {
  await goTo('sol_belt');                               // fly there
  const take = await mine();                            // one mining cycle: a Row
  await goTo('sol_base');                               // base id: flies there and docks
  const sold = await sell([take]);                      // what you name, nothing else
  note(`sold for ${sold.total}`);
  return service();                                     // full tank, full hull
}
```

Every function returns a `Promise` of its answer. When the game says no, the promise **rejects with
a typed error**: an object with a `_tag` (`InBattle`, `HoldFull`, …) and fields. An uncaught error
fails the program with that error — which is fine when there is nothing better to do. Handle the
ones you have a plan for; `isError(e, tag)` narrows a caught value:

```ts
try {
  await goTo('kepler_base');
} catch (e) {
  if (!isError(e, 'InBattle')) throw e;                 // not ours to handle
  await disengage();
  await goTo('kepler_base');
}
```

## The functions

```ts
orient(): Promise<Present>                              // where am I, what do I hold
scout(system?: string): Promise<Scouted>                // rejects UnknownPlace
goTo(id: string): Promise<Arrived>                      // rejects InBattle | UnknownPlace | NoFuel | ServerBusy
                                                        // POI id, base id or system id; docks at a base
mine(): Promise<Row>                                    // rejects InBattle | NotAtBelt | HoldFull; up to 10 units
sell(rows: {item_id: string; quantity?: number}[]): Promise<Sold>   // rejects InBattle | NotDocked | NoBuyer
                                                        // omit quantity for all of it; NoBuyer only if nothing sold
service(): Promise<{fuel: number; hull: number; cost: number}>      // rejects NotDocked
prices(): Promise<readonly Quote[]>                     // rejects NotDocked
readMarket(): Promise<unknown>                          // the raw book; decode it with decode(MarketBook, raw)
salvage(): Promise<Salvaged>                            // rejects InBattle | NoWreck | HoldFull
hunt(opts?: {fights?: number}): Promise<Hunted>         // rejects NothingHere | HullCritical
disengage(): Promise<boolean>                           // leave any battle; false if there was none
missions(): Promise<readonly Mission[]>                 // rejects NotDocked
acceptMission(id: string): Promise<Mission>             // rejects NotDocked | NoSlots | UnknownMission
completeMissions(): Promise<Completed>                  // rejects NotDocked | NothingCompletable
note(text: string): void                                // a line in the journal
sleep(ms: number): Promise<void>                        // wait, in game time
decode(schema, raw: unknown): A                         // throws BadData when raw does not fit
isError(e: unknown, tag): e is <that error>             // narrow a caught value by its _tag
tagOf(e: unknown): string                               // the caught value's _tag, for a note ('Error' if none)
```

## Recipes — copy these shapes

```ts
// Several errors, one try.
try { await salvage(); }
catch (e) {
  if (isError(e, 'NoWreck')) { note('no wreck'); return; }
  if (isError(e, 'InBattle')) { await disengage(); await salvage(); return; }
  throw e;                                              // not ours: let it fail the program
}

// Loop until a typed error says stop.
for (;;) {
  try { await mine(); }
  catch (e) { if (isError(e, 'HoldFull')) break; throw e; }
}

// Retry only one error, with backoff.
for (let attempt = 0; ; attempt++) {
  try { await goTo('sol_belt'); break; }
  catch (e) { if (!isError(e, 'ServerBusy') || attempt >= 5) throw e; await sleep(1000 * 2 ** attempt); }
}

// Always run something at the end; the failure still fails the program.
try { await hunt({fights: 2}); } finally { await disengage(); }

// Reads at once.
const [here, quotes] = await Promise.all([orient(), prices()]);

// Sell the whole hold: name every row. sell([]) sells nothing.
await sell((await orient()).cargo.map(r => ({item_id: r.item_id})));

// Name an error in a note.
catch (e) { note(`failed: ${tagOf(e)}`); }
```

## Shapes you will get wrong

- **A caught value is `unknown`.** Narrow it with `isError(e, 'Tag')`, name it with `tagOf(e)`. Never
  `(e as any)._tag`, `e: any`, or `instanceof`.
- **Rethrow what you were not asked to handle.** A `catch` that only notes turns a failure into success;
  a finalizer is `try { … } finally { … }`, not a catch.
- **Every function is imported.** There are no globals: `disengage`, `sleep`, `note`, `isError` all come
  from `'play'`.
- **No casts.** No `as`, no `any`, no `@ts-ignore`. If the types disagree, the code is wrong.

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

## Places

System `sol`: `sol_station` (base `sol_base`, market), `sol_belt` (iron_ore), `sol_nebula`, `sol_debris`.
System `kepler`: `kepler_station` (base `kepler_base`, market), `kepler_belt` (copper_ore).
