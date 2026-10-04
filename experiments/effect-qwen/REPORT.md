# Can Qwen 3.8 write pilot scripts against an Effect-TS play library?

Model: `mlx-community--Qwen3.8-27B-4bit` on the local oMLX server, the kvothe profile's custom
provider. Sampling is the server default, as in the profile. With thinking on it sends
`thinking_budget: 4096`, which is what the profile sends. With thinking off it sends
`chat_template_kwargs.enable_thinking: false`. Measured 2026-09-28. 461 scored model requests in all.

## Short answer

Qwen can write competent Effect programs, but only when three things hold: whole-file recipes in
the skill doc, the recipes close to the task, and thinking on. With the plain README it passes 16%
of tasks in Effect-native form and 46% in async/await form. Across every doc version, mode and repair
setting, the **Promise facade** (async/await on the surface; typed tagged errors that the promise
rejects with; Effect inside) was the most reliable pilot surface.

Full pass means it typechecks, uses no casts, and behaves correctly in every scenario:

| | README only (v1) | + recipes and rules (v2) | + whole-file recipes (v3) | best, thinking on | after one repair round |
|---|---|---|---|---|---|
| Effect-native | 16% | 52% | 78% | 90% (v3) | 90% (v3) |
| Promise facade | 46% | 82% | — | 65% (v1) | 94% (v2) |
| Result facade | — | 66% | — | 80% (v2) | 90% (v2) |

Recommendation: keep Effect **inside** the library, where typed errors fix bugs like salvage's
swallowed `in_battle`. Give the pilot the Promise facade. Keep these out of the pilot's surface:
Either, `catchTag`/`catchTags` handlers, Schedule, Schema, Layer/`provide`/`run*`, written Effect
types, and recursive Effect helpers.

## Method

**Effect version.** Effect 3.22.2, pinned exactly in `package.json`: the v3 API (`Context.Tag`,
`Either`, `Effect.either`). The repo adopts Effect 4, where `Either` became `Result` and
`Context.Tag` became `Context.Service`. What carries over is the conclusion that the pilot should
get a Promise facade: the struggles below are with Effect's concepts (inspecting errors as values,
handler typing, schedules, written Effect types), which v4 renames but keeps.

**The stub library** (`lib/`). One in-memory world lives in `core.ts`, with a representative slice
of the play surface over it as Effects: `orient`, `scout`, `goTo`, `mine`, `sell`, `service`,
`prices`, `readMarket`, `salvage`, `hunt`, `disengage`, `missions`, `acceptMission`,
`completeMissions`, `note`. Each one is `Effect<A, E, Game>`, where `E` is a union of
`Data.TaggedError`s: `InBattle`, `NotDocked`, `HoldFull`, `NoWreck`, `UnknownPlace`, `NoFuel`,
`ServerBusy`, `NotAtBelt`, `NoBuyer`, `NothingHere`, `HullCritical`, `NoSlots`, `UnknownMission`,
`NothingCompletable`. `Game` is a `Context.Tag`, provided by a Layer built from a scenario world.
`Present` and `MarketBook` are Schemas; `MarketBook` decodes string prices with `NumberFromString`.
The Layer also installs a virtual `Clock`, so a `Schedule` or a sleep costs no wall time and is still
counted. The runner also virtualizes `setTimeout`. `salvage` fails with `InBattle` rather than
reporting "nothing that fits" — the motivating defect in `src/play/combat/salvage.ts`.

The pilot sees one of three shapes over the same Effects:

| variant | the pilot writes | errors |
|---|---|---|
| `effect` (`lib/effect.ts`) | `export default Effect.gen(function* () { … })`; the runtime provides `Game` | typed in `E`; `catchTag`, `either`, `retry`, `ensuring` |
| `promise` (`lib/promise.ts`) | `export default async function main()` | the promise rejects with the tagged error; `isError(e, 'Tag')` narrows it, `tagOf(e)` names it |
| `result` (`lib/result.ts`) | `export default async function main()` | the promise resolves to `{ok: true, value} \| {ok: false, error: E}`, with `E` typed per function; `unwrap(r)` |

`promise` and `result` run Effect inside and convert at the boundary, so the pilot never sees Effect.
`promise` also exports `sleep` and `decode(schema, raw)`; `decode` throws `BadData`.

**The prompt** (`docs/<variant>.<version>.md`) is a README in the style of `src/play/README.md`: a
worked example, a signature block, the data types, the error tags and the places. The system turn is
the doc. The user turn is the task plus "Write pilot/index.ts. Answer with the whole file in one ts
block."

- **v1**: the README alone. For `effect` it adds one `catchTag` example and a one-line list of
  useful Effect tools.
- **v2**: v1 plus *Recipes* (a fragment for each pattern) and *Shapes you will get wrong* (rules
  written against the v1 failures). For `promise` it also adds the `tagOf` helper. `result` was
  written at v2 directly.
- **v3** (`effect` only): the recipes become whole files that typecheck (`check-doc.ts` proves it).
  It adds a fixed two-line import header, spells out `Either.isLeft` and names what does not exist,
  and says "never write an Effect type".

**Tasks** (`tasks.ts`). The tasks were picked from what the kvothe journal shows going wrong:
`not docked` refusals, `in_battle` refusals, full holds, empty wrecks, missions that cannot be
completed and slots that are full. Each task runs against 1–4 scenarios, each with a behavioural
assertion. `reference/<variant>/` holds a passing solution for every task in every variant.
`reference/negative/` holds scripts that must fail, and they do.

| task | concept | scenarios |
|---|---|---|
| t1_sequence | fly, mine ×3, fly back, sell, service | plain |
| t2_catch_tag | `goTo`; on `InBattle`, disengage and retry once; note any other tag | in battle, plain, no fuel |
| t3_retry | retry only `ServerBusy`, exponential from 1 s, 5 retries | busy ×2, busy forever (6 attempts), in battle (1 attempt) |
| t4_until_full | mine until `HoldFull`, then sell the whole hold | empty hold, part-full hold |
| t5_salvage | `NoWreck` → note; `InBattle` → disengage and salvage again; `HoldFull` → sell, return, salvage again | each of the four |
| t6_finalizer | hunt ×2; `disengage` always runs last; failures still fail | plain, `HullCritical`, `NothingHere` |
| t7_parallel | `orient`/`prices`/`missions` at once, one note | plain |
| t8_schema | decode `readMarket()` with `MarketBook`, sell the held rows with `best_buy ≥ 10`; bad book → note | good, bad |
| t9_missions | accept every mission ≥ 100 until `NoSlots`; complete, tolerating `NothingCompletable`; return the count | plain, 2 slots, completable |
| t10_composed | t4 at kepler with ambush recovery, then sell, service, complete; credits noted last even on failure | plain, ambush, no fuel |

**Scoring** (`harness.ts`) applies three checks to each sample:

- **(a) Typecheck.** `tsc --noEmit` in strict mode against the stub, with a check file asserting
  that the default export is `Effect<unknown, unknown, Game>` (or `() => Promise<unknown>`).
- **(b) No casts.** No `as` casts (`as const` is allowed), no `any`, no non-null `x!`, and no
  `@ts-ignore` or `@ts-expect-error`. Comments, strings, template-literal text, import renames and
  local export lists (`export {main as default}`) are ignored. Regex literals are not: a `!` inside
  one counts as a non-null `x!`. No stored sample has one.

  **Re-scored after a cast-detector fix (2026-09-30).** The first detector caught `x!` only when a
  `.` followed it, did not look inside template literals' `${…}` or strip their text, and missed
  multi-line imports and suppressions in comments. `node harness.ts recheat` re-applied the fixed
  detector to every stored sample, with no model call and the typecheck and behaviour results kept
  as scored. Two samples moved from pass to fail, both v1 Promise with a missed `!`: t7_parallel #1
  (first try) and t1_sequence #4 (repair). v1 Promise went 48% → 46% first try and 54% → 50% after
  repair; no other cell changed.
- **(c) Behaviour.** Every scenario's assertion holds when the script runs under plain `node`. A
  script that fails the typecheck is still run, for the behaviour column.

**Full pass** means all three. **After one repair** sends a typecheck failure's diagnostics back
once, as `spacemolt_check` would for the pilot, and scores the second answer. Only typecheck failures
get a repair round.

**Sample counts.** Without thinking: 5 samples per task per variant, so 50 per cell. With thinking:
2 per task, so 20 per cell. The thinking runs are each over two minutes and the server is shared with
the live pilot, so they were trimmed.

**Records.** `results/*.jsonl` has one line per sample with every completion, its reasoning (when
thinking), the extracted file, the diagnostics and each scenario's result. `node summarize.ts`
regenerates every table below; `DETAIL=1` adds each failure. A snapshot is in `results/SUMMARY.txt`.

## Results

### Pass rates (first try)

| doc | mode | variant | n | tsc ok | no casts | behaviour | **full pass** | median latency | median completion tokens |
|---|---|---|---|---|---|---|---|---|---|
| v1 | no think | effect | 50 | 22% | 78% | 22% | **16%** | 10 s | 253 |
| v1 | no think | promise | 50 | 78% | 76% | 64% | **46%** | 9 s | 253 |
| v1 | think | effect | 20 | 55% | 85% | 70% | **50%** | 137 s | 4347 |
| v1 | think | promise | 20 | 95% | 75% | 90% | **65%** | 136 s | 4282 |
| v2 | no think | effect | 50 | 60% | 84% | 64% | **52%** | 7 s | 217 |
| v2 | no think | promise | 50 | 88% | 100% | 86% | **82%** | 8 s | 201 |
| v2 | no think | result | 50 | 70% | 100% | 72% | **66%** | 10 s | 248 |
| v2 | think | result | 20 | 85% | 95% | 95% | **80%** | 125 s | 3915 |
| v3 | no think | effect | 50 | 80% | 98% | 88% | **78%** | 8 s | 229 |
| v3 | think | effect | 20 | 90% | 100% | 95% | **90%** | 113 s | 3588 |

Prompts run about 1.4k tokens at v1 and 1.9–2.4k at v2/v3; the Effect docs are the longest.
Thinking usually uses the whole 4096-token budget: 19 of 20 v1 Effect samples did, and 8 of 20 at v3.
A thinking answer takes roughly 15× the wall time of a non-thinking one.

### After one repair round

| run | variant | n | first try | repairs that pass | full pass after repair | tsc ok after repair |
|---|---|---|---|---|---|---|
| v1 no think | effect | 50 | 16% | 6/39 | 28% | 46% |
| v1 no think | promise | 50 | 46% | 2/11 | 50% | 94% |
| v2 no think | promise | 50 | 82% | 6/6 | 94% | 100% |
| v2 no think | result | 50 | 66% | 12/15 | 90% | 98% |
| v3 no think | effect | 50 | 78% | 6/10 | 90% | 92% |

### By task (full passes out of samples)

| task | v1 effect | v1 promise | v1 think effect | v1 think promise | v2 effect | v2 promise | v2 result | v2 think result | v3 effect | v3 think effect |
|---|---|---|---|---|---|---|---|---|---|---|
| t1_sequence | 3/5 | 3/5 | 1/2 | 2/2 | 3/5 | 4/5 | 2/5 | 1/2 | 4/5 | 2/2 |
| t2_catch_tag | 1/5 | 0/5 | 1/2 | 0/2 | 3/5 | 4/5 | 5/5 | 2/2 | 5/5 | 2/2 |
| t3_retry | 0/5 | 4/5 | 1/2 | 2/2 | 4/5 | 5/5 | 3/5 | 2/2 | 4/5 | 2/2 |
| t4_until_full | 0/5 | 2/5 | 1/2 | 2/2 | 5/5 | 5/5 | 3/5 | 0/2 | 5/5 | 2/2 |
| t5_salvage | 0/5 | 1/5 | 0/2 | 1/2 | 2/5 | 5/5 | 4/5 | 1/2 | 0/5 | 1/2 |
| t6_finalizer | 2/5 | 4/5 | 2/2 | 2/2 | 4/5 | 5/5 | 4/5 | 2/2 | 5/5 | 2/2 |
| t7_parallel | 2/5 | 2/5 | 2/2 | 1/2 | 4/5 | 4/5 | 5/5 | 2/2 | 5/5 | 2/2 |
| t8_schema | 0/5 | 2/5 | 0/2 | 1/2 | 0/5 | 2/5 | 3/5 | 2/2 | 4/5 | 2/2 |
| t9_missions | 0/5 | 4/5 | 2/2 | 2/2 | 1/5 | 5/5 | 3/5 | 2/2 | 5/5 | 2/2 |
| t10_composed | 0/5 | 1/5 | 0/2 | 0/2 | 0/5 | 2/5 | 1/5 | 2/2 | 2/5 | 1/2 |

### Two secondary facts

- **An Effect script that typechecks is almost always right.** Behaviour passed in 39 of 40
  typecheck-clean v3 Effect samples, and 28 of 30 at v2. The Promise facade typechecks bad logic more
  often: 28 of 39 at v1, 41 of 44 at v2. The Effect error channel carries part of the logic, so tsc
  rejects more wrong programs. For Effect, the typecheck gate is where the work is. For Promise, it is
  the behaviour.
- **The motivating salvage case** (t5, the `in_battle` scenario handled correctly): at v1, Effect 0/5
  and Promise 2/5. At v2 and later, every variant handles it in 4 or 5 of 5 samples. When the error
  is typed and named in the doc, the model branches on it. None of the failing samples read the
  refusal as an empty wreck. The v1 Promise failures let `InBattle` escape (2) or sold undocked (1).

## Failure taxonomy

Each failing sample is tagged by what each checker error's line is doing (`summarize.ts`, `tags()`).
The ranking is by how often a concept broke a sample and how well it survived doc fixes.

### Effect-native: the concepts it struggles with

1. **Inspecting an error inside a generator (Either).** This was the most common v1 blocker, and it
   survived into v2.
   - `.pipe(Effect.either())`: the helper called with `()` (6 samples at v1).
   - Comparing the Either's own tag with an error tag: `if (res._tag === 'NoSlots')` and
     `res._tag === 'Success'`, where TS says `'"Left" | "Right"' and '"NoSlots"' have no overlap`
     (9 samples).
   - `Effect.isLeft`, `Data.isLeft`, `Option.isLeft` (7 samples, 4 of them in v2 after the recipe
     had shown `Either.isLeft`).
   - Forgetting `import {Either}`.

   The v3 whole-file recipe plus the fixed import header removed it: 0 cases at v3.

   ```ts
   const res = yield* acceptMission(m.id).pipe(Effect.either);
   if (res._tag === 'NoSlots') { break; }          // an Either is Left/Right, never NoSlots
   ```
2. **`catchTag`/`catchTags` handler typing.** Handlers return plain values (`Effect.zipRight(note(…),
   0)`), call `Effect.void(x)`, or return a union the next `catchTag` cannot accept (`No overload
   matches this call`). This is the largest residual category: 10 samples at v1, 7 at v2, and 6 of
   the 11 v3 failures.
3. **Recursive Effect helpers.** The model's natural solution to t5 is a recursive `salvageLoop`
   that calls itself from its `InBattle` and `HoldFull` handlers. The logic is right, but TS cannot
   infer the type (`TS7023 'salvageLoop' implicitly has return type 'any'`), and fixing it needs an
   explicit `Effect.Effect<A, E, Game>` annotation, which is the thing the model also gets wrong. This
   is why t5 fell to **0/5 at v3** while every other task rose. Async recursion has no such trap.

   ```ts
   const salvageLoop = () => salvage().pipe(
     Effect.catchTag('NoWreck', () => note('no wreck')),
     Effect.catchTag('InBattle', () => Effect.zipRight(disengage(), salvageLoop())),  // TS7023
     …
   ```
4. **Hallucinated or stale Effect API** (13 samples at v1). Seen across all runs:
   `Schedule.recurring` ×6, `Schedule.while` ×4, `Effect.isLeft` ×4, `Schedule.recursWhile` ×2,
   `Schedule.take`, `Schedule.whileInputIs`, `Effect.repeatUntil`, `Effect.repeatUntilError`,
   `Effect.retryable`, `Effect.recover`, `Schema.isSuccess`, `Duration.fromMillis`, `Data.getTag`,
   and `concurrency: 'unlimited'`. `Schedule` and `Effect` were also imported from `'play'`, and
   error classes lowercased (`holdFull`, `inBattle`, `marketBook`). The Schedule/retry-typing tag
   (10 samples at v1) is mostly this. Giving the one retry shape as a recipe fixed it: t3 went to 4/5.
5. **Writing Effect types.** `function run(): Effect<void, never, Game>` fails with `Cannot use
   namespace 'Effect' as a type`, and `Game` is usually not imported either. Relatedly, it builds a
   helper as an Effect *value* and then calls it (`yield* acceptAll()`: `This expression is not
   callable`). "Never write an Effect type" cut this but did not remove it.
6. **Casts to silence the checker** (11 samples at v1): `undefined as unknown as {completed: …}`,
   `null as never`, `e as GameError`, `row as Row | void`. The "No casts" rule brought this to 1/50
   at v3.
7. **Schema** (4 samples at v1). `Schema.decodeUnknown` itself was used correctly once shown. What
   failed was the code around it: a `catchTag('ParseError', …)` that returns `void`, making the
   decoded value `void | Book`, then `.rows` on that union. The v3 recipe (catch at the outer
   `.pipe`) got t8 to 4/5.

**Concepts that were *not* a problem:**

- `yield` vs `yield*`: 1 of 50 at v1, and none after.
- Running or providing the effect itself: 1 of 50 at v1. `Layer` never appeared.
- `Effect.all`: t7 passed 5/5 at v2–v3.
- `Effect.ensuring`: t6 passed 4–5 of 5 once shown.
- Mixing `async`/`await` into generators: never.

### Promise facade

- **Casting the caught value** (11 samples at v1, plus one non-null `quotes[0]!`), as in `${(e as any)._tag}`. This happened because
  there was no typed way to name an unknown error. Adding `tagOf(e)` and a rule took it to 0 at v2.
- **A catch that only notes**, which turns a failure into success. This broke the t6 and t10
  finalizer scenarios in 4 samples at v1 and 2 at v2.
- **Data-shape misreads, the same in every variant**: `sell([])` read as "sell everything", `for
  (const r of take)` where `mine()` returns one `Row`, and a dynamic `await import('play')` to get a
  function it forgot to import.
- **Missing imports**: 5 samples at v1 and at v2. This is the main residual error, and one repair round
  fixes it (100% typecheck after repair at v2).

### Result facade

Its residual errors are all about the wrapper:

- `done.completed` instead of `done.value.completed`.
- `.value` read before narrowing on `.ok`.
- `unwrap(goTo(…))` without `await`.

Together these are the 10 samples tagged "fails where it should recover" at v2. The static error
union helped branching (t2 5/5), but the extra layer on every call cost 16 points against Promise on
the first try. It repairs well: 90% after one round.

## Prompt iteration: what fixed what

| change | concept it targeted | effect |
|---|---|---|
| v2: a recipe per pattern (retry, loop until an error, ensuring, all, decode, catchTags) | Schedule API, loop control, finalizers, hallucinated APIs | Effect 16 → 52%. t3 0→4/5, t4 0→5/5, t6 2→4/5. Promise 46 → 82% |
| v2: "Shapes you will get wrong" (pipe helpers bare, Either is Left/Right, PascalCase errors from `play`, no casts, don't swallow) | Either misuse, `()` arity, casts | casts fell (Effect no-cast 78→84%, Promise 76→100%). Either misuse fell only 9→6: rules without whole examples half-work |
| v2: `tagOf(e)` in the Promise facade | casting caught errors | Promise casts 12→0 |
| v2 side effect: recipe fragments | — | **recipe bleed**: fragments pasted in without their imports (`Cannot find name 'Schedule'`/`'disengage'`, even in t1) |
| v3: whole-file recipes that typecheck, plus a fixed import header | recipe bleed, missing `Either` import, `Effect.isLeft` | Effect 52 → 78%; Either misuse 6→0, missing imports 6→0, casts 8→1 |
| v3: "never write an Effect type"; helpers as `() => Effect.gen(…)` | namespace-as-type, value-vs-function | reduced; the remaining cases are recursive helpers, which need the annotation (t5 0/5) |
| thinking on (4096 budget) | everything | v1 Effect 16→50%, v1 Promise 46→65%, v3 Effect 78→90%, v2 Result 66→80%, at ~15× the latency |
| one repair round with the tsc diagnostics | whatever the checker names | Promise and Result close almost all typecheck failures (94–98% tsc ok). Effect v1 repairs poorly (6/39; still 46% tsc ok). Effect v3 repairs well (6/10) |

The next fix for the Effect doc, not measured: forbid recursive helpers ("loop with `Effect.either`
instead of calling yourself") and show a `catchTags` whose handlers all return the same type. That
would likely recover t5.

## Recommendation

**Keep Effect inside the play library, and give the pilot the Promise facade.**

1. **The Promise facade is the most robust shape at every level of support.** Without doc help it
   is 3× the Effect-native rate (46% vs 16%). With recipes it is 82% vs 52%. After one repair round,
   which `spacemolt_check` already gives the pilot, it reaches 94%. It is the least sensitive to the
   doc being close to the task. Effect's 78–90% needs whole-file recipes shaped like the task, or
   thinking at about two minutes a juncture. A task no recipe covers falls back toward the v1 column,
   and the failures that remained at v3 are in open-ended composition (recursion, handler typing).
   That is where novel pilot programs live.
2. **The typed errors still pay off where the bug lives.** Salvage swallowing `in_battle` is a
   library bug, and an Effect error channel in the library makes it structurally hard to write. At
   the pilot boundary, the tagged error survives as the promise's rejection. With the tag named in the
   README, the model branched on it correctly (t5 `in_battle` handled in 5/5 at v2).
3. **The pilot surface should be:**
   - `async`/`await`.
   - Every function rejects with one of a documented set of tagged errors.
   - `isError(e, 'Tag')` and `tagOf(e)` to inspect a caught error.
   - `sleep` for backoff loops.
   - `decode(schema, raw)` that throws `BadData`, instead of Schema.
   - `try`/`finally` for anything that must always run.

   Document each function's possible tags beside its signature, as the facade doc does.
4. **Result is a reasonable second choice**, and a small version of it is worth considering: typed
   error unions give static exhaustiveness. But making *every* call return a Result cost 16 points on
   the first try. Today's `Outcome` has the same always-resolve shape, and the same "forgot to check"
   failure. A possible hybrid is Result only for the two or three branch-heavy calls (`salvage`,
   `mine`, `acceptMission`) and rejection everywhere else. That hybrid is not measured here.

**What to keep out of the pilot's surface, if Effect ever reaches it:**

- Either and `Effect.either` (the top v1 blocker).
- `catchTag`/`catchTags` handlers (the top residual).
- Schedule: expose a retry loop or helper instead.
- Schema: expose `decode` instead.
- `Layer`, `provide`, `run*`, `Context`.
- Written `Effect.Effect<…>` types.
- Recursive Effect helpers.

`Effect.gen` with `yield*`, `Effect.all` and `Effect.ensuring` were the parts the model handled
reliably.

## Caveats

- **The recipes are close to the tasks.** The v2/v3 recipes show a loop until `HoldFull`, a
  `ServerBusy` retry and an `ensuring`. They measure whether the model can apply a shape it was shown,
  which is how the real README works. Off-recipe performance is better predicted by the v1 column.
- **One shot, plus one repair round.** Each sample is a single file in a single turn, apart from that
  one repair round. The real pilot also sees run output and tries again at the next juncture.
- **Noise.** With 50 samples per cell, differences under about 15 points are within noise. The
  thinking cells have 20 samples each; there is no v2 Promise thinking run and no v3 Promise doc.
- **What the fake world tests.** The world is small and deterministic. It tests control flow and
  error handling, not game judgement.
- **Hand-edited docs.** The doc edits between versions were made by hand, aimed at failures seen in
  the previous version, so they carry some bias toward the observed samples.

## Files

- `lib/core.ts`: the world, the `Game` service, the errors, the Schemas and the Effect surface.
  `lib/effect.ts`, `lib/promise.ts` and `lib/result.ts` are the three pilot surfaces.
- `docs/*.md`: every prompt version.
- `tasks.ts`: the tasks and assertions.
- `runner.ts`: runs one script against one scenario.
- `harness.ts`: the `run`, `repair`, `rescore`, `reference` and `probe` commands.
- `summarize.ts`: the tables and tags.
- `check-doc.ts`: typechecks a doc's recipes.
- `reference/`: known-good scripts per variant and known-bad scripts that must fail; `node harness.ts
  reference` checks both.
- `results/*.jsonl`: every raw completion and score. `results/*.log` are the run logs, and
  `results/SUMMARY.txt` is the summarizer's output. `work/` (gitignored) holds the scored files as
  written.
