# Authoring TypeScript with Effect

How the TypeScript in this repo is written. Each section says what to do. Project history, baselines
and the migration plan live in [EFFECT-MIGRATION.md](EFFECT-MIGRATION.md) and its tracker, not here.

**Scope:** the TypeScript under `src/`. The Python side is out of scope. So is the pilot's own
program: the pilot writes against the Promise surface ([The pilot's surface](#the-pilots-surface)).

**Version:** `effect` 4, pinned exactly (no caret), bumped on purpose. Effect 4 is required because
only it can generate Schema source from a JSON Schema, which [Deriving types](#deriving-types)
depends on. It also has everything this repo needs in core (`Schema`, `Arbitrary`, `TestClock`,
`ManagedRuntime`), so don't add `@effect/platform` or `@effect/vitest`.

## Principles

These are in priority order.

1. **Ultra low maintenance.** Maintenance goes down through three things, in this order: code
   generation, type safety, and tests of behaviour. A type or test that a person has to keep in
   sync by hand costs maintenance and does not count toward any of the three.
2. **Derive types; don't author them.** Use the upstream type if one exists. If upstream has none,
   derive one from an upstream type or schema. Author a new type only when neither exists, and
   never write one that duplicates an existing type. Let the compiler prove behaviour: a type
   guarantee is a check that can't go stale.
3. **Type-safe from the data at rest to the code that uses it.** Bytes from the socket or a JSON
   file are decoded once, where they enter, against a generated schema. After that, every value
   has the type the compiler says it has. No seam depends on a person getting a cast right.
4. **Errors are values with names.** A failure shows up in the type (`Effect<A, E, R>`) and is
   handled by its tag. Nothing is swallowed, and nothing is made into a string before the edge.

## The ban list

| Banned | Instead |
|---|---|
| `x as T`, `<T>x` | A schema decode at the boundary, a type guard, `satisfies`, or an annotation |
| `x!` | Narrow it: `if (x === undefined)`, `Option`, `??` |
| `any` (written or implied) | `unknown`, then decode |
| `@ts-ignore`, `@ts-expect-error` | Fix the type. Allowed in `*.test.ts` only |
| `catch {}`, or `catch` that drops the error | A named error, handled by its tag ([Errors](#errors)) |
| A hand-written interface that duplicates a lib or schema type | `Pick`, `Omit`, indexed access, or `Schema.Type` |

`as const` stays. It narrows a type and is not a cast, and the assertion ban allows it.

- An assertion function that doesn't check (`asserts x is T` with an empty body), or an overload
  whose implementation returns a wider type than its signature, is a cast and is banned. The only
  sanctioned exception is a cast the frozen pilot surface forces, written as a plain `as` on a line
  marked `// cast: frozen surface (<type>)`; `scripts/debt.ts` reports those as `surface_cast`,
  apart from `cast`, so they stay visible without failing `--zero`. That cast makes a failure's
  `detail` an `{}` typed as the full `Detail`, so an internal caller checks an Outcome before
  reading its `detail`, through `reached()` in `runtime.ts`: `status` alone does not tell, since a
  stop is `partial` and an escaped refusal `refused`, both with `{}`.

**How it's enforced**, from least to most maintenance:

1. **tsconfig**, with no dependency added:
   ```json
   "erasableSyntaxOnly": true, "verbatimModuleSyntax": true,
   "exactOptionalPropertyTypes": true, "noUncheckedIndexedAccess": true
   ```
   `erasableSyntaxOnly` makes `tsc` refuse what Node's type stripping refuses (`enum`, parameter
   properties). `noUncheckedIndexedAccess` is what makes the `!` ban bearable.
2. **oxlint**, one binary with a small `.oxlintrc.json` and no plugins:
   `typescript/no-explicit-any`, `typescript/consistent-type-assertions` with `assertionStyle: "never"`,
   `typescript/no-non-null-assertion`, `typescript/ban-ts-comment`, and an override that turns all
   four off for `**/*.test.ts` and `src/test-support/**` (the tests' own debt is exempt, and
   `npm run lint` covers them). A grep check can't do this: it can't tell a cast from the word "as"
   in a string or an `import … as`.
3. **`@effect/language-service`**, as a tsconfig plugin for editors, and patched into `tsc` **as a
   CI step** (`effect-language-service patch`) so CI also reports **`floatingEffect`**: an Effect
   that is built but never run, which is the one bug Effect adds. Never patch in `prepare`: that
   would also patch the `tsc` a live profile's pilot gate runs.

## Deriving types

### What `@spacemolt/lib` ships

- **Only TypeScript types, with no runtime schemas.** The OpenAPI component types, and the typed
  facade `account.commands.<tool>.<action>(params)`. No zod, no JSON Schema, no validators.
- **Runtime metadata:** `ACTIONS` gives every command's params and its response type by name.
- **The spec itself is not in the npm package.** It is committed upstream as `openapi.json`
  (OpenAPI 3.1, so its schemas are JSON Schema 2020-12) at
  `github.com/SpaceMolt/spacemolt-lib/blob/v<version>/openapi.json`.
- **Error codes are untyped.** `SpacemoltError.code` is a `string`, and the spec enumerates none
  ([Error codes](#error-codes)).

### The ladder

Stop at the first rung that works.

1. **Use the lib type as it is:** `EnrichedWreck`, `V2Ship`, `LootedItem`. Call commands through the
   typed facade, `account.commands.spacemolt_salvage.loot({…})`, never the string seam
   `command('spacemolt_salvage/loot', {…}): Promise<unknown>`, which throws both types away and
   forces a cast.
2. **Derive from a lib type:** `Pick<V2CargoItem,'item_id'|'quantity'>`, `EnrichedWreck['cargo']`,
   `Parameters<Commands['spacemolt_salvage']['loot']>[0]`.
3. **Author a Schema** only for data the game doesn't define: `pilot.json`, `run.json` and journal
   lines. Derive the type from it (`typeof Pilot.Type`), so one source gives both the
   validator and the type. The pilot-facing `Outcome` is the exception: it is pilot surface, so it
   stays the interface it is today ([The pilot's surface](#the-pilots-surface)).
4. **Never** write an interface that repeats a shape rungs 1–3 already give you.

**Lib types are claims, the decode is the proof.** The facade's reply types are what the server
*should* send; nothing checks them at runtime. So a game reply is decoded exactly once, in the
`Game` layer, against the schema generated from the same spec (`Wire.*`). Everything downstream
uses the decoded type, and the drift check below proves it equal to the lib's. There is one type
for each shape, checked both ways.

**Two kinds of authored type are sanctioned**, because nothing upstream can give them: a service's
method signatures ([Services](#services-and-layers)), and the tagged error classes. What they
carry must still be lib or `Wire.*` types. A function's return shape built from those (an object of
lib rows and errors) is inferred, not declared as a named type.

### Generating the wire schemas

`scripts/gen-wire.ts` (a Node script, no build step):

1. Fetches `openapi.json` at the tag matching the `@spacemolt/lib` version pinned in `package.json`.
2. Rewrites `#/components/schemas/` to `#/$defs/`.
3. Runs `SchemaRepresentation.fromJsonSchemaDocument(…, {patterns: 'apply'})` over every component,
   then `toRepresentations` and `toCodeDocument`, and writes `src/wire.gen.ts`.
4. Writes one drift assertion per component the lib also exports, into `src/wire-drift.gen.ts`.

CI reruns it and fails on `git diff --exit-code`. Bumping the lib is then one command. Never edit
the output by hand. The generator handles these known cases:

- **Patterns.** `patterns` defaults to `"error"`, and three components reach a `patternProperties`
  (`RecoveredBattleSummary.side_factions`), so the default import throws. `'apply'` imports all of
  them and keeps the key check; `'ignore'` would close that record to no keys at all.
- **Contextual duplicates** are named `X_1`.
- **Suspended references** (`Schema.suspend((): Schema.Codec<X> => X)`) need an
  `export type X = typeof X.Type` beside the `export const`.
- **Open values.** The importer types every open value (`additionalProperties: true`, `{}`) as
  `Schema.Json`, and the lib types it `unknown`. `onEnter` can't fix that, because the importer turns
  every unknown into `Json` after it runs. Rewrite the representation between `toRepresentations`
  and `toCodeDocument` instead:

  ```ts
  const unjson = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(unjson);
    if (v === null || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return v;
    const o = v as {_tag?: unknown; representation?: {id?: unknown}; annotations?: object};
    if (o._tag === 'Declaration' && o.representation?.id === 'effect/schema/Json') {
      const {expected: _, ...annotations} = (o.annotations ?? {}) as Record<string, unknown>;
      return {_tag: 'Unknown', annotations, checks: []};
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unjson(x)]));
  };
  ```

  The casts here are the generator's own, not `src/` code.
- **Shadowed names.** The lib's `MapSystem` is its map-data type, not the component. Assert only the
  names whose public export has the same declared type as the one in the lib's
  `generated/openapi/types.gen.d.ts` (the TypeScript checker's `getDeclaredTypeOfSymbol`).
- **The lib's own bugs.** There are two, and each is handled the same way. The drift file asserts
  every component that reaches the bad field against the lib type with that field patched, through
  `Omit<…> & {…}`. It also asserts that the lib still has the bug, so when the lib is fixed that
  check fails and the patch comes out.
  - The lib types `side_factions` as `{[key: string]: never}`, because its generator drops
    `patternProperties`. The spec says `string`. This reaches `RecoveredBattleSummary`,
    `BattleLogEntry` and `GetBattleLogResponse`.
  - The lib types `NotificationOk.base` as `{[key: string]: unknown} | {[key: string]: unknown} |
    null`, because its generator reads the type array `["string","object","null"]` as two objects.
    The spec allows a `string`, and fleet_dock sends one. This reaches `NotificationPayload`,
    `GetNotificationsResponse` (through `McpNotification`) and `V2Response`.

**Drift check, with no cast.** The generated `Type` is deeply `readonly` and the lib's types are
mutable, so assert agreement in both directions after removing `readonly`. Don't use Effect's
`Types.DeepMutable`: it maps `unknown` to `{}`, so no open value could ever match.

```ts
import type {GetWrecksResponse} from '@spacemolt/lib';
import type * as Wire from './wire.gen.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type M<T> = unknown extends T ? T : {-readonly [K in keyof T]: M<T[K]>};
const _GetWrecksResponse: Same<M<typeof Wire.GetWrecksResponse.Type>, GetWrecksResponse> = true;
```

If the generated file and the lib disagree, this fails to compile. A lib-typed value goes wherever
the readonly one is expected, but not the reverse, so **take `readonly` (`Wire.*`) inputs**.

## Errors

Any failure the program could act on gets a tagged class. Command failures come in two kinds:

```ts
import {Data} from 'effect';

/** The server refused, definitively; nothing landed. `code` is the server's own. */
export class Rejected extends Data.TaggedError('Rejected')<{
  readonly action: string; readonly code: string; readonly message: string;
}> {}
/** The reply is gone, not the outcome. Re-observe; never re-send a mutation. */
export class ReplyLost extends Data.TaggedError('ReplyLost')<{readonly action: string; readonly cause: unknown}> {}
```

Classify **once**, in the `Game` layer, with `instanceof SpacemoltError` and `ConnectionClosedError`
(the lib's own classes) plus the set of uncertain codes, so no cast is needed. Code outside the
layer never sees a raw `SpacemoltError`. Use `Schema.TaggedError` in place of `Data.TaggedError`
only when the error has to be encoded, for example into the journal.

### Error codes

The code set is the one domain type this repo authors, and it grows only from evidence. The
journal records `code` on every failed `command` line. A code gets its own handling (a branch, a
narrower tag) once it has been observed there. Every other code stays `Rejected` with its raw
`code`, which is the fallback. Never guess a code from its message text.

### The salvage defect, before and after

Before: every refusal is swallowed, so `in_battle`, an empty wreck and a full hold all come out as
"nothing that fits":

```ts
try {await command('spacemolt_salvage/loot',{id:wreck.id,item_id:row.item_id,quantity});}
catch {left.push(row);continue;}
```

After: `lootWreck` handles the one error it can act on, keeps it as a value, and lets the other
go up with its type:

```ts
export class HoldFull extends Data.TaggedError('HoldFull')<{readonly free: number}> {}

export const lootWreck = Effect.fn('lootWreck')(function* (wreck: typeof Wire.EnrichedWreck.Type) {
  const game = yield* Game;
  const items: LootedItem[] = [];
  const left: {readonly row: typeof Wire.ShipCargoItem.Type; readonly reason: Rejected | HoldFull}[] = [];
  for (const row of wreck.cargo) {
    const hold = yield* game.hold;
    if (hold.free <= 0) { left.push({row, reason: new HoldFull({free: hold.free})}); continue; }
    const before = hold.held(row.item_id);
    const tried = yield* Effect.result(game.lootItem(wreck.id, row.item_id, Math.min(row.quantity, hold.free)));
    if (Result.isFailure(tried)) {
      if (tried.failure._tag === 'ReplyLost') return yield* Effect.fail(tried.failure);
      left.push({row, reason: tried.failure});
      continue;
    }
    const moved = (yield* game.hold).held(row.item_id) - before;
    if (moved > 0) items.push({item_id: row.item_id, quantity: moved});
  }
  return {items, left};
}); // Effect<{items, left}, ReplyLost, Game>
```

The reason stays a `Rejected` or `HoldFull` all the way to the `Outcome`, where `salvage()` writes
`left 5 ore: in_battle`. The journal carries the code.

Rules:

- **Handle by tag, and only the tags you can act on.** `catchTag` and `catchTags` remove the tag
  from `E`, so the compiler shows what is still unhandled. To keep an error as a value, use
  `Effect.result` and `Result.isFailure`, then re-fail the tags you don't handle.
- **Never catch everything** with `Effect.catch`, `catchCause`, `orElseSucceed` or `ignore` just to
  keep going. Defects (`die`) are bugs. Let them reach the edge.
- **Retry only reads.** A query can use
  `Effect.retry({times: 2, schedule: Schedule.exponential('1 second'), while: e => e._tag === 'ReplyLost'})`.
  A mutation never retries on `ReplyLost`; it re-observes instead.
- **Make it a string only at the edge.** `why` in an `Outcome` is built from the error's fields
  where the `Outcome` is built, never before.

## Services and layers

A service is a `Context.Service` class. A layer builds it. Program code asks for the service by
type and doesn't know where it came from.

```ts
export class Game extends Context.Service<Game, {
  readonly wrecks: Effect.Effect<typeof Wire.GetWrecksResponse.Type['wrecks'], Rejected | ReplyLost | Schema.SchemaError>;
  readonly lootItem: (wreck: string, item: string, quantity: number) => Effect.Effect<void, Rejected | ReplyLost>;
  readonly hold: Effect.Effect<{readonly free: number; readonly held: (item: string) => number}>;
}>()('Game') {}

const decodeWrecks = Schema.decodeUnknownEffect(Wire.GetWrecksResponse);

export const GameLive = (account: Account) => Layer.succeed(Game, {
  wrecks: Effect.tryPromise({
    try: () => account.commands.spacemolt_salvage.wrecks(),   // typed by the lib
    catch: classify('salvage/wrecks'),                         // unknown -> Rejected | ReplyLost
  }).pipe(Effect.flatMap(r => decodeWrecks(r.structuredContent)), Effect.map(r => r.wrecks)),
  // …
});
```

- **Keep one `Game` service for the connection.** Its methods take the domain's arguments and
  return decoded values. The journal line, reconnect-and-wait, and the Tired check wrap the facade
  call inside this layer, not in each caller.
- **Name a resource's lifetime.** A connection that has to close is
  `Layer.effect(Game, Effect.acquireRelease(connect, a => Effect.sync(() => a.close())))`.
  `Layer.effect` runs in the layer's scope, so it needs no separate `scoped` constructor.
- **Make services for what the program can't do without:** the connection, the journal, and the
  pilot record. Pure helpers stay plain functions.
- **Replace module singletons** (`let bound`, module-level counters) with a service whose layer the
  run builds.

## Boundaries

Decode once where data enters, and trust it afterwards.

| Enters at | Decode with |
|---|---|
| A game reply | Its `Wire.*` schema, inside the `Game` layer |
| `pilot.json`, `run.json`, `juncture.json` | An authored Schema via `Schema.fromJsonString(...)` |
| `gameplay.jsonl` lines read back | The same Schema that wrote them |
| Bridge stdin (JSON lines from `service.py`) | An authored request Schema, a union on `type` |

Inside the boundary, don't re-check `typeof x === 'string'`, don't use `?? 0` against a value the
schema already requires, and don't write `Number(ship?.cargo_capacity ?? 0)`. The decode already
proved it. Runtime checks on undecoded data are still needed until that data is decoded; delete
them then.

**The live server is looser than its spec.** It omits fields the spec marks required (`get_base`
does, as U12 found), so a full decode of a whole reply would refuse real data. Decode the fields
the code reads, picked from the `Wire.*` schema, never a parallel authored shape. A row is dropped
only when a field the code reads fails to decode, and a `step` line names it (observe, don't
gate). It sends `null` for empty collections (wreck `cargo`, F-U17), so a picked collection field
the code reads as none when absent reads `null` as empty too (`Schema.optionalKey(Schema.NullOr(…))`,
then `?? []`). Where the frozen pilot surface promises the full lib type for a reply the code only partly
reads, pass the raw body through on one line marked `// cast: frozen surface (<Type>)`: the lie is
the lib type's, and `debt.ts` counts it.

## The pilot's surface

The pilot is a smaller model writing `pilot/index.ts` against `src/play` and its READMEs. It
writes async/await reliably and Effect poorly, so **the pilot never sees Effect**. The surface is
today's helpers, unchanged and frozen: each returns `Promise<Outcome>` and never throws. Effect
lives behind them ([The Promise ↔ Effect edge](#the-promise--effect-edge)).

**Errors reach the pilot only as an `Outcome`'s `status` and `why`.** A tagged error is folded at
the edge: an escaped `Rejected` becomes `refused`, and `ReplyLost` or a defect stays `failed`. The
`why` is built from the error's fields, so it names the action and the code. The pilot branches on
`status` and reads `why`; there is nothing to catch, and no helper for inspecting an error.

These never appear in a README or an exported signature: `Either`/`Result`, `catchTag`/`catchTags`
handlers, `Schedule`, `Schema`, `Layer`/`provide`/`run*`, and written `Effect<…>` types. Any of them
there is a regression on the pilot's surface, even when it typechecks. The evidence is the Qwen
evaluation (`experiments/effect-qwen/REPORT.md`): those are the concepts the pilot model broke on,
and the Promise shape was the most reliable one at every level of doc support. The surface check
(`docs/effect-surface.txt`) and the pilot-surface sample in the migration runbook guard it.

## Testing

Test behaviour: given a world, check what the program did and said. Don't test which internal
functions it called.

- **A test layer is a world.** `Layer.succeed(Game, {...})` answers the way the server answers,
  refusals included. It is not a mock of internals: never spy on `lootItem` to count calls. The
  existing fake lib account sits underneath as `GameLive(fakeAccount)`, so tests run through the
  real classify-and-decode path.
- **Generate fixtures from the schema.** `Arbitrary.schema(Wire.EnrichedWreck)` yields valid wrecks
  of every shape the spec allows, so there is no hand-written fixture to keep current, and
  `Arbitrary.checkEffect` runs a property over them. Write a fixture by hand only to pin one
  specific case. (`Arbitrary` is marked unstable in Effect 4; the version pin covers that.)
- **Keep `node:test`.** `Effect.runPromise(program.pipe(Effect.provide(world)))` inside `test(...)`
  works under type stripping.
- **Time comes from `TestClock`** (`effect/testing/TestClock`): `TestClock.layer()` and
  `TestClock.adjust('1 hour')`. Never real sleeps.
- **Test the refusal, not only the success path:**

```ts
const inBattle = Layer.succeed(Game, {
  wrecks: Effect.succeed([]),
  lootItem: () => Effect.fail(new Rejected({action: 'salvage/loot', code: 'in_battle', message: 'in battle'})),
  hold: Effect.succeed({free: 10, held: () => 0}),
});
test('in battle, every row is left behind with the refusal attached', async () => {
  const result = await Effect.runPromise(Arbitrary.checkEffect(
    Arbitrary.schema(Wire.EnrichedWreck),
    wreck => lootWreck(wreck).pipe(
      Effect.map(out => out.left.length === wreck.cargo.length
        && out.left.every(l => l.reason._tag === 'Rejected' && l.reason.code === 'in_battle')),
      Effect.provide(inBattle)),
  ));
  assert.equal(Arbitrary.formatCheckFailure(result), undefined);
});
```

## The Promise ↔ Effect edge

Migrate one function at a time. Each function keeps its Promise signature until nothing
Promise-based calls it.

- **Going in:** `Effect.tryPromise({try, catch})`. `catch` has to return a tagged error, and
  `classify` is that function. Never use the one-argument form, which gives an `UnknownError`.
  It is written in two places only: `play/game.ts` for the game, and `journal-webhook.ts` for the
  journal's external webhook POST.
- **Going out:** one `ManagedRuntime` per binding (`bind()`), providing its `Game` and its `Run` (the
  run's own state, which an Effect asks for by type rather than reading a module variable): each
  freighter has its own account and binding, so each gets its own runtime. The Promise facade
  is `runtime.runPromiseExit(effect)`, mapping the `Exit` to an `Outcome` with a `status` and a
  `why`. A failure becomes `refused` or `failed` in the error's own words, and nothing is thrown.
- `job()` is that edge. `salvage()` keeps `Promise<Outcome<Salvaged>>` and runs an Effect inside.
- Don't call `runPromise` or `runSync` except at an edge. Calling them mid-Effect breaks the error
  channel and interruption.

## Erasable syntax

Node strips types; it doesn't compile them. Everything Effect needs is erasable:

| Idiom | Erasable |
|---|---|
| `class Game extends Context.Service<Game, {...}>()('Game') {}` | yes: generics are types, and `extends <call>` is plain JS |
| `class Rejected extends Data.TaggedError('Rejected')<{...}> {}` | yes |
| `class NoWreck extends Schema.TaggedError<NoWreck>()('NoWreck', {...}) {}` | yes |
| `class Order extends Schema.Class<Order>('Order')({...}) { get total() {...} }` | yes |
| `Effect.gen(function* () {...})`, `Effect.fn('name')(function* ...)` | yes: plain generators |
| `enum`, `namespace`, `constructor(private x)`, `import x = require()` | **no**. Use a union of string literals or `Schema.Literals`, a module, or a field |

`private` and `readonly` on fields are erasable; the parameter-property form is not. Keep `.ts` on
relative imports, and use `import type` for anything used only as a type (`verbatimModuleSyntax`
enforces it).

## What not to do

- Don't convert a pure function to Effect. `Effect` is for work that can fail, needs a service, or
  takes time.
- Don't write `Effect.runPromise` inside a service or a library function.
- Don't hand-edit `wire.gen.ts`, and don't write a `Schema.Struct` for a shape the spec already has.
- Don't widen an error to `Error` or `unknown` to make a signature compile. Name it.
- Don't add a Schema check that repeats a game rule the server enforces. Decode shape, not policy
  (*observe, don't gate*).
- Don't use `pipe` for code that reads as a sequence. Use `Effect.gen`/`Effect.fn` for sequences and
  `pipe` for one-step transforms.
- Don't let an Effect float. If it isn't yielded, returned, or run, it did nothing.

## Sources

- Effect v4: https://effect.website/blog/releases/effect/40-rc
- Effect language service (`patch`, `floatingEffect`): https://github.com/Effect-TS/language-service
- oxlint `consistent-type-assertions`: https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-type-assertions.html
- TypeScript `--erasableSyntaxOnly`: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html
- Node type stripping: https://nodejs.org/api/typescript.html
- SpaceMolt lib and its spec: https://github.com/SpaceMolt/spacemolt-lib
