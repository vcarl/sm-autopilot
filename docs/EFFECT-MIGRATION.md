# Effect migration runbook

This runbook converts the player library (`src/play/` and what it imports from `src/`) to Effect,
one unit at a time, until it is done. It is written as the brief for a `/goal` loop. Everything here
applies [EFFECT.md](EFFECT.md), the decisions below, and [AGENTS.md](../AGENTS.md). If this file and EFFECT.md disagree, EFFECT.md wins and this file gets
corrected. Progress is tracked in [effect-migration-progress.md](effect-migration-progress.md).

**Decisions** (settled by the maintainer, 2026-09-28):
1. Effect 4, pinned exactly, adopted while it is still an RC; move to 4.0.0 when it ships.
2. The pilot-facing surface stays Promise-plus-`Outcome`; Effect is used only behind the pilot surface, never in the pilot's own program.
   The Qwen evaluation (`experiments/effect-qwen/REPORT.md`) backs this: the pilot model writes the
   Promise facade most reliably. It ran on Effect 3.22.2 (the v3 API); its finding is about Effect's
   concepts, which v4 keeps under new names, not about v3 specifically.
3. The spec comes from the GitHub tag matching the pinned `@spacemolt/lib` version.
4. Generate the whole spec; no list of roots to maintain.
5. The tsconfig flags go on repo-wide now; the lint rules go on per directory, through an override
   list that shrinks as directories migrate.
6. Dependencies: `effect` (runtime), `oxlint` and `@effect/language-service` (dev). The patched
   compiler runs in CI, as a CI step.

## 1. Goal and non-goals

**Goal.** Every file in scope follows EFFECT.md:
- no casts, no `any`, no `!`, no ts-comments, and no catch that drops an error;
- game failures are tagged errors, classified once in the `Game` layer;
- replies and files are decoded against generated or authored Schemas;
- refusal paths are covered by behaviour tests run against a test Layer.

The pilot sees the same API it sees today.

**Non-goals.**
- Changing the pilot-facing API shape: the names, the Promise signatures, `Outcome`, and the READMEs'
  examples. A unit that needs to change these stops and asks (§7).
- Changing gameplay behaviour, beyond making errors visible. A `why` or a journal line may now name
  a code. One `status` change is in scope: a `Rejected` that reaches the `job` edge becomes
  `refused` (the server said no, nothing landed), with a `why` that names the action and the code.
  `ReplyLost` and defects stay `failed`. Update the READMEs where they describe this, in the same
  commit as P0.7. The P0.8 baseline is measured after this change, so it covers it.
- Anything on the Python side (`*.py`, `plugin.yaml`, cron, the gate).
- Converting pure functions to Effect. A pure unit only gets the ban-list cleanup.
- Migrating the tests' own debt. Tests are exempt from the debt counts; a separate pass follows
  the migration, once fixtures come from the wire schemas.

## 2. Phase 0: the foundation, done once before the loop

Each step lands as its own commit. The controller dispatches each step and verifies it with the same
discipline as a unit (§4). A surprise in any step is a STOP (§7).

**Re-baseline first.** The numbers in this file and the tracker were measured at `3811b4ae26` against
`@spacemolt/lib@14.2.0`. `main` has since moved to `@spacemolt/lib@15.1.0`, and `db6d4527c3` already
journals `code` on failed `command` lines. Re-measure the tsconfig-flag error count in P0.2, and
the debt counts and per-unit sizes once P0.3 lands `scripts/debt.ts`, and update the tracker. Generate from the spec
at `v<installed lib version>`, not v14.2.0. In P0.6 keep the existing `code` field and add only
`lost: true`.

| Step | Work | Done when |
|---|---|---|
| P0.1 deps | `effect` pinned exactly to the current `4.0.0-rc.*` (EFFECT.md was checked against `4.0.0-rc.118`) in `dependencies`. `oxlint` and `@effect/language-service` pinned exactly in `devDependencies`. No carets. | `npm ci` is clean. `package-lock.json` is committed. |
| P0.2 tsconfig | Add `erasableSyntaxOnly`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` to `tsconfig.json`. Fix the fallout: **65 errors, 47 of them in tests** (measured at `3811b4ae26`). In non-test code, fix it by narrowing, never with `!` or a cast. In tests, `!` is acceptable. **Do not** touch the pilot gate's compiler options (`pilotHome` in `src/run.ts`): that config is pilot surface. | `npm run typecheck` is clean and `npm test` is green. |
| P0.3 measure | Add `scripts/debt.ts` (verbatim below) and `scripts/surface.ts` (spec below). Commit `docs/effect-surface.txt` as the surface baseline. Record the time `node --test src/play/readme-examples.test.ts` takes as the pilot-gate latency baseline (best of 3) in the tracker. Also record one cold `check()` of a README example on its own (a fresh `tsc` process, as `run.ts` spawns it today). Also extend the `test` script in `package.json` with `src/play/*/*/*.test.ts`, so a test added beside the depth-3 sources of U06 and U21 (`src/play/combat/bounties/`, `src/play/industry/facilities/`) runs; no such test exists yet. | Both scripts run. The tracker's baseline section is filled in. The `test` script contains the `src/play/*/*/*.test.ts` glob, `npm test` is green, and §6's test-coverage check passes. |
| P0.3b warm check | Replace the per-check `tsc` child process in `src/run.ts` with a warm checker in the bridge process, which is already long-lived: one `ts.createLanguageService` over the pilot home's tsconfig, `getScriptVersion` from file mtimes so a changed library file or plugin checkout invalidates itself, and diagnostics taken as `tsc --noEmit` takes them (options, global, syntactic and semantic, for every file in the program). The library's parsed and checked files stay in memory across checks, so only `pilot/index.ts` is re-checked. Keep the CLI path as the fallback for `play.py` and when the service throws. Journal `check_ms` and `warm: true/false` on each check. | A parity test runs every README example through both paths and gets the same errors. A warm check of an unchanged library is under the P0.3 baseline. |
| P0.4 lint | Add `.oxlintrc.json` with the four ban-list rules at `error` (EFFECT.md §The ban list). It has two overrides, **in this order**: (1) `**/*.test.ts` and `src/test-support/**` turn all four rules off; (2) **the migration list** turns all four rules off for every non-test `src/**/*.ts` path not yet migrated, as explicit file paths, one per line. Write each rule's severity as the string `"off"`, never `0` or `["off"]`. Units delete their lines. Run the defaults first: if oxlint's default `correctness` rules report ≤20 findings, fix them here. Otherwise set `"categories": {"correctness": "off"}` and note that in the tracker. Add `"lint": "oxlint --deny-warnings src"` to `package.json`. | `npm run lint` is clean. |
| P0.5 wire | Add `scripts/gen-wire.ts` (EFFECT.md §Generating the wire schemas). Start from `experiments/effect-wire/gen.ts`, the scratch generator that proved the drift check clean at v14.2.0 (683/683 imported, 615 assertions, 0 errors); it is not ban-clean, so the script is rewritten to the ban list, not copied. It takes the spec from the GitHub tag `v<@spacemolt/lib version>` and generates all of it into `src/wire.gen.ts`. Import with `{patterns: 'apply'}`. It also writes `src/wire-drift.gen.ts`: one `Same<M<typeof Wire.X.Type>, X>` assertion (EFFECT.md's `M`, not `Types.DeepMutable`) for **every** component whose name `@spacemolt/lib` exports as that component's generated type. There is no list of roots. Handle every known case in EFFECT.md §Generating the wire schemas: patterns, duplicates, suspended references, open values (`Schema.Json` → `Unknown`), shadowed names (`MapSystem`, `CatalogRecipe`), and the lib's two bugs (`side_factions`, `NotificationOk.base`). Measured at v15.1.0: 711/711 components import, 633 are asserted plus one guard for each lib bug, `tsc` is clean under P0.2's flags, and `wire.gen.ts` is 2,039,827 bytes. A disagreement at the installed version that is not one of the known cases is a STOP. Add `"gen:wire": "node scripts/gen-wire.ts"`. | `npm run gen:wire && git diff --exit-code -- src/wire.gen.ts src/wire-drift.gen.ts` passes, and `npm run typecheck` is clean. Adding `& {extra: 1}` to one assertion by hand fails the typecheck; revert that edit. |
| P0.6 Game | `src/play/game.ts` holds the `Game` service, the `GameLive(account)` layer, `classify` and the error classes. `src/play/codes.ts` holds the evidence-derived tag set (see "Error tags" below). `command()` keeps working unchanged. Both `command` journal lines gain `lost: true` on ReplyLost; `code` (the raw server code on failure) already exists (`db6d4527c3`) and stays as it is. Document these fields in the AGENTS.md Telemetry section in the same commit. | `npm test` is green. New tests exercise `GameLive(fakeAccount)` for each tag, a fallback code, and ReplyLost. |
| P0.7 edge | Add `jobEffect` and `edge` to `runtime.ts` (see "The Promise edge" below). Add a `ManagedRuntime` per `bind()`: freighters have their own binding, so each gets its own runtime. | Tests cover each Exit mapping (Success, Rejected, a specific tag, ReplyLost, `Stopped`, and a defect) through a test Layer. `docs/effect-surface.txt` is unchanged. |
| P0.8 Qwen | First port the harness to Effect 4: pin `experiments/effect-qwen/package.json` to the same exact `effect` version as P0.1 (it is on 3.22.2), move `lib/`, the docs and `reference/` to the v4 API (`Either` → `Result`, `Context.Tag` → `Context.Service`, …), and `node harness.ts reference` must pass. Then add a `play` variant to `experiments/effect-qwen/harness.ts` (spec in §5). Run `npm ci` in `experiments/effect-qwen` (the harness spawns its local `tsc`; a missing install would fail every sample). Measure the baseline on the pre-migration surface. | The baseline pass rate and n are in the tracker. If the local model server is down, write `deferred` in the tracker (and the date in Notes) and continue: it is retried at the next milestone. M-final deferred, or any Qwen check deferred twice (P0.8 included), opens a Stop (§7). |
| P0.9 gates | Add `scripts/migration-check.sh` (verbatim in §6). Extend the CI node job with these steps: `npm run lint`, the gen-wire diff, `node scripts/surface.ts --check`, and `npx effect-language-service patch && npm run typecheck`. Patching is a CI step and not a `prepare` script, because `prepare` would also patch the live profile's `tsc`, which the pilot gate runs. | CI is green on the branch (the owner pushes). Locally, every check in the script passes except the ones that only pass once the migration is done: the override-list check, `debt.ts --zero src`, the crossings check, and the tracker checks. |

### `scripts/debt.ts` (P0.3, verbatim)

This script produced the baseline numbers in the tracker. It is an AST count, because a grep can't
tell a cast from the word "as".

```ts
// node scripts/debt.ts [--tests] [--by-file] [--zero] [path ...]   default path: src
// AST counts of the docs/EFFECT.md ban list. --zero exits 1 unless every count is 0.
import ts from 'typescript';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const paths = args.filter(a => !a.startsWith('--'));
const expand = (p: string) => statSync(p).isDirectory() ? readdirSync(p, {recursive: true}).map(f => join(p, String(f))) : [p];
const files = (paths.length ? paths : ['src']).flatMap(expand)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.gen.ts') && (flag('--tests') || !(f.endsWith('.test.ts') || f.includes('test-support/'))));
const keys = ['cast', 'unknown_cast', 'any', 'non_null', 'ts_comment', 'catch'] as const;
const zero = () => Object.fromEntries(keys.map(k => [k, 0])) as Record<typeof keys[number], number>;
const total = zero();
for (const f of [...new Set(files)].sort()) {
  const text = readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
  const n = zero();
  const visit = (node: ts.Node): void => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
        && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(sf) === 'const')) {
      n.cast++;
      if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) n.unknown_cast++;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) n.any++;
    if (ts.isNonNullExpression(node)) n.non_null++;
    // A catch is debt unless its own line says why it is an edge: `catch (e) { // edge: <reason>`.
    if (ts.isCatchClause(node) && !/\/\/ edge:/.test(text.split('\n')[sf.getLineAndCharacterOfPosition(node.getStart(sf)).line] ?? '')) n.catch++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  n.ts_comment = (text.match(/@ts-(ignore|expect-error|nocheck)/g) ?? []).length;
  for (const k of keys) total[k] += n[k];
  if (flag('--by-file') && keys.some(k => n[k])) console.log(f, JSON.stringify(n));
}
console.log(JSON.stringify({files: files.length, ...total}));
if (flag('--zero') && keys.some(k => total[k])) process.exit(1);
```

`cast` counts `as T` and `<T>x`, excluding `as const`; `unknown_cast` is the subset that is
`as unknown as T`. `catch` counts every catch clause without an `// edge:` marker on its line. An
edge marker is legitimate only at a process or file edge, for example a lock file racing another
process. It is never legitimate around a game call: those are `Effect.catchTag`.

### `scripts/surface.ts` (P0.3, spec)

The script is about 80 lines of TypeScript compiler API, loaded with the repo `tsconfig.json`.

- **Default mode.** Walk `checker.getExportsOfModule` for `src/play/index.ts` and every folder
  barrel (`src/play/*/index.ts`, `src/play/*/*/index.ts`). For each export, print a line:
  `<barrel> <kind> <name>: <type>`, where the type comes from `typeToString(…, NoTruncation)`.
  Then print every named type that is declared under `src/` and reachable from those signatures or
  from type exports, member by member (`<Type>.<prop>?: <type>`), recursing until the set is closed.
  Sort the output and write it to `docs/effect-surface.txt`.
- **`--check` mode.** Regenerate the output in memory and diff it against the committed file.
  Exit 1 and print the diff if they differ.
- **`--internal <files…>` mode.** For every exported value in those files whose type is an
  `Effect`, print `name: E`. Exit 1 if any `E` prints as `unknown`, `any`, `Error`,
  `UnknownError`, or anything containing `Cause`.

A leaked Effect twin, a new `readonly`, or a changed `Outcome` field all show up as a diff. That diff
is the surface check.

### Error tags (P0.6): derived from evidence, not guessed

Error codes are untyped upstream (`SpacemoltError.code: string`, and the spec lists none). The tag
set is built from what has actually been observed:

1. **Evidence.** `scripts/observed-codes.ts` reads
   `~/.hermes/profiles/*/spacemolt/runtime/gameplay*.jsonl` (read-only). For each `event:"command"`
   line with `ok:false`, it tallies the `code` field when the line has one, and otherwise the
   `^([a-z_]+): ` prefix of `summary`. It adds the codes that `src/` branches on (grep for `code===`
   and the `Set([...])` code lists in `src/mine.ts`) and the codes that
   `src/test-support/bridge-world.ts` raises. It prints `code count source`. At `3811b4ae26` there
   are 1318 failed command lines. Only 413 of them carry a code prefix (`not_in_faction` 308,
   `mission_not_found` 7, `cargo_full` 6, `in_battle` 6, `skill_required` 4,
   `mission_incomplete` 3, …). The remaining 905 are prose, such as "No active battle…" and
   "Target system not found". The journal line carries `code` (since `db6d4527c3`), so the evidence
   improves as the pilot flies.
2. **Tag rule.** A code gets its own `Data.TaggedError` only if it appears in the evidence **and**
   some caller branches on it. Today that is `in_battle` → `InBattle`, `cargo_full`/`hold_full` → `HoldFull`, and the depletion set in `mine.ts` →
   `Depleted`. Every other definitive refusal is the fallback, **`Rejected {action, code, message}`**,
   which carries the raw code. Ambiguous outcomes (`command-boundary.ts`'s `uncertainCodes`, a
   pending command, or `ConnectionClosedError`) are **`ReplyLost {action, cause}`**.
3. **Growth.** When a unit needs to branch on a new code, it adds the tag in `codes.ts` with the
   evidence count in a comment, in the same commit. It never adds a tag for a code that has no
   evidence.
4. `classify` is the only place that reads `SpacemoltError`. It uses `instanceof`, with no cast.

### The Promise edge (P0.7)

`job(fn, args, body)` keeps its exact signature and behaviour, and two functions are added next to it:

- `jobEffect<D, R>(fn, args, body: Effect<Said<D>, GameError, R>): Effect<Outcome<D>, never, R>`
  does the same bookkeeping as `job`: the `▶` line, the opening and closing reads, `finish`, and
  the `calls` push. It folds failures into the Outcome: `Stopped` → `partial`, `Rejected` →
  `refused` (§1), and any other error → `failed`. The `why` is built from the error's fields, for
  example `salvage/loot: in_battle — cannot perform this action while in combat`, or
  `reply lost on travel/jump; state re-read`. Composition stays as it is today: a library function
  calls another one's Effect twin and gets an Outcome back.
- `edge(effect)` runs the effect through the binding's `ManagedRuntime` and returns a `Promise`.
  A defect becomes a `failed` Outcome, and its stack goes to a `defect` journal line. `edge` is
  the only place that calls `run*`.

Each pilot function then takes this form:

```ts
export const salvageEffect = (…) => jobEffect('salvage', args, Effect.gen(function* () { … })); // not in any barrel
export const salvage = (…): Promise<Outcome<Salvaged>> => edge(salvageEffect(…));             // barrel export, unchanged
```

- **Effect twins** are named `<name>Effect` and are never exported from a barrel. When a folder
  barrel uses `export *` over a module that has twins, the unit switches that barrel to named
  exports. The surface check catches a leaked twin.
- **Calling an unconverted function.** A converted function reaches an unconverted Promise function
  only through `Effect.tryPromise({try, catch: classify})`. Each such crossing gets a `// bridge: U<nn>`
  comment naming the unit that will remove it. Converting that unit removes the crossing. At the end
  of the project, `tryPromise` appears only in `game.ts`, and in `journal-webhook.ts` for the webhook POST.

## 3. Units

The units are in dependency order, bottom-up. Pure leaves come first. The runtime's command path
(U02) comes next, so every later unit converts against the `Game` layer. After that come the helpers
in `src/` that the play modules call, then the play core, the careers, the multi-account code
(freighter, fleet, menu, run), the runtime's module state, and finally the bridge. A few modules
import each other in a cycle (servicing↔market, travel↔market↔missions, runtime↔service).
Inside a cycle, convert in the listed order and use the `// bridge:` rule.

Units marked **P** are pure: ban-list cleanup, plus a Schema decode where they read a file. There
is no Effect conversion.

"Lines" counts non-test lines. "Debt" is cast/any/non-null/catch, from `scripts/debt.ts` at
`3811b4ae26`. A unit of 500 or more lines may land as up to 3 commits. Its override-list lines go in
its last commit.

| Unit | Files | Lines | Tests today | Debt | Notes |
|---|---|---|---|---|---|
| U01 P | normal-route, mood-policy, mining-inventory, rules-table | 396 | normal-route, rules-table | 0/3/4/0 | |
| U02 | play/runtime (the command path: `command`, `sent`, `reconnected`, `admit`, `ask`, `burnCells`), play/types | 553 | runtime, ask, fuel-cells, prose | 18/2/0/8 | `command()` delegates to `Game`. The module singletons stay until U31. `Outcome` stays an interface (surface). |
| U03 P | run-record, journal-lines | 352 | run-record, journal-lines | 8/16/0/6 | Authored Schemas for `run.json` and journal lines (EFFECT.md, the ladder's rung 3). |
| U04 P | combat-memory, sighting-memory | 425 | combat-memory, sighting-memory | 4/0/3/4 | Schemas for `combat.json` and `sightings.json`. |
| U05 | trade-intel, order-book, recipe-graph | 280 | all three | 1/0/0/1 | trade-intel sends a command. |
| U06 P | play/places, play/boundary, play/policy, play/freighter/drained, play/prose, play/exploration/*, play/industry/facilities/* | 273 | gates, prose, exploration, facilities | 2/1/4/5 | Schema for `places.json`. |
| U07 | controller-lock, credentials, storage (src), reflect | 251 | reflect | 10/4/7/7 | The lock's race catch may keep an `edge:` marker. |
| U08 | dock, play/counter | 76 | none direct | 1/0/2/1 | The first real Effect conversion; it sets the pattern. `already_docked` stays `Rejected`, read by its code (never observed, so no tag). |
| U09 | reconcile, travel (src) | 350 | 11 `travel-*.test.ts` | 8/3/28/5 | `InBattle` replaces `refusedInBattle`. |
| U10 | command-boundary, settle-cargo, mine | 282 | command-boundary ×2, gates | 4/0/0/4 | `CommandBoundary` becomes Effect semantics: after a send, `ReplyLost` is fatal. Port its two tests. `HoldFull` and `Depleted`. |
| U11 | gather-job | 245 | gather-job | 3/0/0/3 | |
| U12 | servicing, play/service | 429 | service, fuel-cells | 6/2/13/6 | Cycle with market: bridge to U15. |
| U13 | play/storage | 147 | fuel-cells, runtime (indirect) | 6/0/10/2 | |
| U14 | play/hangar | 339 | runtime (indirect) | 23/0/0/2 | The most casts in play. Write behaviour tests. |
| U15 | play/market | 270 | trading, fuel-cells, market | 8/0/1/4 | |
| U16 | play/missions | 262 | missions | 11/0/0/1 | |
| U17 | play/travel | 340 | runtime, `travel-play-tired*`, travel | 13/0/6/11 | |
| U18 | play/orient, play/rest | 184 | orient, rest | 19/3/1/4 | |
| U19 | play/mining/* | 166 | mining (thin) | 3/0/0/1 | |
| U20 | play/combat/salvage | 93 | combat | 1/0/0/2 | The motivating defect (EFFECT.md §Errors): the refusal is named. |
| U21 | play/combat/hunting, play/combat/bounties/*, play/combat/index | 669 | combat | 8/0/3/6 | ≤3 commits. |
| U22 | play/hauling/* | 319 | hauling | 17/0/0/2 | |
| U23 | play/industry/crafting, play/industry/index | 322 | crafting | 9/0/1/3 | |
| U24 | play/trading/trading | 836 | trading | 11/0/38/7 | ≤3 commits. The most `!`. |
| U25 | play/trading/scout, play/trading/index | 140 | trading | 3/0/0/1 | |
| U26 | play/freighter/index | 507 | freighter | 2/0/5/3 | ≤3 commits. |
| U27 | play/freighter/host | 532 | freighter | 6/0/4/14 | ≤3 commits. The most catches. It has its own account, so it gets its own runtime. |
| U28 | play/fleet/* | 145 | freighter | 1/0/5/0 | |
| U29 | play/menu | 649 | menu | 20/2/33/1 | ≤3 commits. |
| U30 | run | 295 | run, readme-examples, bridge | 3/1/7/8 | |
| U31 | play/runtime (module state → a `Run` service; delete the string `command()` seam), response-details, readiness | ~500 | everything | 0/2/0/0 + structural | Deletes `details()` once nothing calls it. |
| U32 P | alerts, heartbeat, journal-webhook | 305 | heartbeat, journal-webhook, push-journal | 4/1/0/2 | Bridge side (in scope). |
| U33 | bridge | 501 | bridge, ask, push-journal, combat-memory | 13/2/9/4 | A request Schema for stdin (EFFECT.md §Boundaries). Bridge side (in scope). |

That is 33 units. Every non-test file in `src/` belongs to exactly one unit, except `src/play/index.ts`
(the barrel, which is left alone), `src/test-support/*`, and the generated files. `play/runtime.ts`
belongs to both U02 and U31.

## 4. The per-unit loop

The loop runs in a controller session. The controller **does not write unit code**. It picks,
dispatches, runs the gates itself, commits, and records.

| Step | Who | Model |
|---|---|---|
| Pick | controller | (session model: opus) |
| Convert | conversion subagent | **sonnet** |
| Gate | controller runs the §5 commands itself | — |
| Review | verification subagent, read-only | **opus** |
| Fix round | the same conversion subagent (SendMessage) | sonnet |
| Stuck | one fresh attempt, from the current tree | **fable** (only here) |
| Commit + record | controller | — |

1. **Pick.** If a flight row is `todo` and due (§6, Flights), fly it: that is this iteration.
   Otherwise take the first unit row in the tracker whose status is `todo` and whose predecessors
   are `done`. Set it to `doing` in the working tree; it is committed with the unit.
2. **Record the "before" numbers.** Run `node scripts/debt.ts <unit files>` and
   `git rev-parse HEAD`. Keep them for the brief and the commit.
3. **Convert.** Dispatch the conversion subagent with the brief below.
4. **Gate.** Run every §5 command yourself. **Don't trust the subagent's report.** If a gate is
   red, send the output back once (a fix round). If it is still red, or the subagent says it is
   blocked, run the **stuck** step (fable, one attempt). If that is still red, STOP.
5. **Review.** Dispatch the verification subagent with the verifier brief. It returns `PASS` or
   `FAIL` with findings, as `file:line` plus the rule broken. On `FAIL`, run one fix round, then
   re-gate and re-review. **A second `FAIL` is a STOP.**
6. **Commit.** Stage exactly these paths: the unit's files, its tests, the lines removed from
   `.oxlintrc.json`, `codes.ts` if a tag was added, and the tracker. Use Conventional Commits:
   - `refactor(<scope>): convert <unit> to Effect` when nothing the pilot or a journal reader sees
     changes;
   - `fix(<scope>): …` when a `why` or a journal line now names an error, with a body saying what
     now shows.

   The scope is the subsystem: `play`, `bridge`, `juncture`, and so on. The body gives the debt
   before → after and names any `// bridge:` crossings added or removed.
7. **Record.** In the tracker row, set the status to `done`, and fill in the after-debt (`0/0/0/0`),
   the commit sha, and one line of notes: tags added, crossings, anything odd.

   If a unit touched a README, or its surface diff was approved, add a Qwen run to the milestones
   table (§5, check 9). The milestone runs after U02, U17 and U31 are always required. So are
   the flights after U02, U17 and U33 (§6).

### Conversion brief (paste it, filling in the `<…>` fields)

> You are converting unit `<Uxx>` of the Effect migration in `<worktree path>`, on branch
> `<branch>`. Read `docs/EFFECT.md` (all of it), `docs/EFFECT-MIGRATION.md` §2 ("Error tags" and
> "The Promise edge") and §5, `AGENTS.md`, and the unit's files: `<files>`. Its tests are `<tests>`.
> The debt before is `<numbers>`.
>
> Done means every §5 check passes for this unit. Delete the unit's lines from the migration list in
> `.oxlintrc.json`. Add behaviour tests for every refusal or failure path, using a test Layer: a
> world that answers the way the server answers, via `GameLive(fakeAccount)` or `Layer.succeed(Game,
> …)`. Don't mock or spy on internals. Keep every function the pilot reaches with the same name and
> Promise signature: `node scripts/surface.ts --check` must pass. Pure code stays plain functions.
>
> If you need to change the public surface, a README, or an `Outcome` status, or you need a tag for a
> code with no evidence, **stop and report**. Don't work around it.
>
> Report: files changed; debt after; each gate's result (you ran them); tags added; `// bridge:`
> crossings; anything you were unsure of.
>
> **Hard stops** (verbatim, §8): <paste §8>. Don't commit. Leave your changes in the working tree;
> the controller reviews and commits them.

### Verifier brief

> Read-only. Review the working-tree diff of unit `<Uxx>` (`git diff -- <paths>`) in `<worktree
> path>` against `docs/EFFECT.md` and `docs/EFFECT-MIGRATION.md` §2 and §5. For each of these, cite
> `file:line`:
> 1. Is any error swallowed, widened, or made into a string before the Outcome edge?
> 2. Does any `catchTag` handle a tag it can't act on?
> 3. Is a mutation retried on `ReplyLost`?
> 4. Does any `// edge:` catch surround a game call?
> 5. Did behaviour change beyond naming errors? Compare old and new control flow for each exported
>    function.
> 6. Does every new test fail if the refusal handling is removed? Check at least one by reverting
>    the handler in a scratch copy, not in the tree.
> 7. Is there a type that duplicates a lib or wire type?
> 8. Is `run*` called anywhere except `edge`?
>
> Answer `PASS` or `FAIL` with numbered findings. Don't edit files. **Hard stops**: <paste §8>.

## 5. Per-unit definition of done

`U` is the unit's non-test files; `T` is its test files. Every check is a command, and the
controller runs each one itself.

| # | Check | Command | Passes when |
|---|---|---|---|
| 1 | Typecheck, including the Effect diagnostics | `npm run typecheck && npx effect-language-service patch && npm run typecheck` | Both runs exit 0. |
| 2 | Lint, with the unit out of the override list | `! grep -nF -e '<each U path>' .oxlintrc.json && npm run lint` | Exit 0. |
| 3 | Zero debt in the unit | `node scripts/debt.ts --zero U` | Exit 0: no cast, `any`, `!`, ts-comment, or unmarked catch. |
| 4 | Error channels typed | `node scripts/surface.ts --internal U` | Exit 0. |
| 5 | Refusal tests exist and use worlds | the check-5 block below the table | There is at least one match, and no mocks. This is skipped for **P** units. The verifier's item 6 checks that the tests are meaningful. |
| 6 | Everything green, including the README examples | `npm test` | Exit 0. |
| 7 | Public surface unchanged | `node scripts/surface.ts --check` | Exit 0. A non-empty diff is a STOP (§7). |
| 8 | Wire untouched and in sync | `npm run gen:wire && git diff --exit-code -- src/wire.gen.ts src/wire-drift.gen.ts` | Exit 0. |
| 9 | Pilot-surface regression, sampled | `node experiments/effect-qwen/harness.ts run --doc play --variants play --samples 5 --thinking off --out <Uxx>` (10 tasks × 5 = 50 samples) | Run it only when the unit touched a README, when an approved surface diff landed, and at the U02, U17 and U31 milestones. It passes when the full-pass rate is ≥ the P0.8 baseline − 10 points. If it misses, run a fresh 50 with `--out <Uxx>-retry` (the harness resumes a run by its `--out` name, so reusing `<Uxx>` would skip every sample). The check passes if the mean over the two files, `results/<Uxx>.jsonl` and `results/<Uxx>-retry.jsonl`, is ≥ baseline − 10; otherwise STOP. If the server is down, write `deferred` in the milestones table, note the unit in Notes, and continue: it is retried at the next milestone. M-final deferred, or any Qwen check deferred twice (P0.8 included), opens a Stop (§7). |

Check 5, as a command (the pipes are ERE alternation):

```bash
grep -lE 'Rejected|ReplyLost|InBattle|HoldFull|Depleted|new SpacemoltError\(' T \
  && ! grep -nE 'mock\.(fn|method)|spyOn' T
```

**The `play` harness variant (P0.8).**
- **Prompt:** the system turn is `src/play/README.md` plus one career README. The ten tasks mirror
  t1–t10 in `experiments/effect-qwen/tasks.ts`, rewritten against the real exports (`goTo`,
  `gatherUntil`, `sell`, `service`, `salvage`, `hunt`, `acceptMission`, `completeMissions`, …).
- **Scoring:** a full pass is two things together. The script must pass `check()` from
  `src/run.ts` (the pilot's own gate: tsc, the import boundary, and the policy) in a temporary
  runtime, as `readme-examples.test.ts` does it. It must also pass the harness's existing cast ban.
- **No behaviour column:** behaviour is covered by the test suite, and the surface is frozen.

Why −10 points: at n = 50 and p ≈ 0.8, one standard error is about 5.7 points. Missing by 10 points
twice in a row is not noise.

## 6. Whole-project definition of done

**The `/goal` condition** (paste it as it is):

```
/goal Execute docs/EFFECT-MIGRATION.md from where docs/effect-migration-progress.md says it stands, one unit or flight per iteration, until EITHER `bash scripts/migration-check.sh` exits 0 (it requires the F-final flight row to be `flown`), OR docs/effect-migration-progress.md's Stops table contains a row whose status is `open`. Before Phase 0 is done, scripts/migration-check.sh does not exist, and that counts as not met.
```

**The checklist behind it.** This is `scripts/migration-check.sh`, written verbatim in P0.9:

```bash
#!/usr/bin/env bash
# The whole-project definition of done for the Effect migration. Exit 0 = done, F-final flown.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
T=docs/effect-migration-progress.md
npm run typecheck
npx effect-language-service patch >/dev/null && npm run typecheck      # floatingEffect
npm test                                                               # includes readme-examples
shopt -s nullglob                                                      # every *.test.ts must be one the test script runs
picked=$(printf '%s\n' $(node -p 'require("./package.json").scripts.test.replace(/^node --test /,"")') | sort)
[ "$(find src -name '*.test.ts' | sort)" = "$picked" ] || { echo 'test files the test script does not run'; exit 1; }
npm run lint
node -e 'const off=v=>["off","allow",0].includes(Array.isArray(v)?v[0]:v);
  const o=JSON.parse(require("fs").readFileSync(".oxlintrc.json","utf8")).overrides??[];
  const left=o.filter(x=>off(x.rules?.["typescript/consistent-type-assertions"])).flatMap(x=>x.files).filter(f=>!/test/.test(f));
  if(left.length){console.error("migration override list not empty:",left);process.exit(1)}'
npm run gen:wire && git diff --exit-code -- src/wire.gen.ts src/wire-drift.gen.ts
npm run gen:play && [ -z "$(git status --porcelain -- play.gen)" ]             # the pilot's declarations, new files too
node scripts/surface.ts --check
node scripts/debt.ts --zero src                                        # outside tests and *.gen.ts
# game.ts for the game; journal-webhook.ts for the external webhook POST, the one boundary that isn't the game
if grep -rn 'tryPromise' src --include='*.ts' | grep -v -e '^src/play/game.ts:' -e '^src/journal-webhook.ts:' -e '\.test\.ts:'; then echo 'tryPromise outside Game'; exit 1; fi
if grep -rn '// bridge: U' src; then echo 'unconverted crossings remain'; exit 1; fi
if grep -E '^\| (P0\.[0-9]+[a-z]?|U[0-9]{2}|M-[A-Za-z0-9]+|F-[A-Za-z0-9]+) \|' "$T" | grep -vE '^\| ([^F|][^|]* \| done|F-[A-Za-z0-9]+ \| flown) \|'; then echo 'tracker rows not done'; exit 1; fi
grep -qE '^\| M-final \| done \|' "$T"                                  # the rows exist at all
grep -qE '^\| F-final \| flown \|' "$T"
```

In words, the project is done when:
- the migration override list is empty;
- every Phase 0, unit and Qwen milestone row is exactly `done` (a `deferred` milestone has not
  run yet, so it fails);
- every flight row (`F-U02`, `F-U17`, `F-final`) is exactly `flown` (a `todo` or `failed` flight fails);
- every gate is green;
- the debt counts are zero outside tests and generated code (baseline: the tracker's baseline section, which P0.3 re-measures);
- `tryPromise` appears only in `game.ts` and `journal-webhook.ts` (the webhook POST), and no crossings remain;
- the final Qwen milestone passed;
- the final flight passed every criterion below.

The loop is done when this script exits 0, or when a Stop is open. The owner's only gate after
that is merge and release.

The pilot-gate latency (`readme-examples` time) is recorded at M-final next to the P0.3 baseline.
It is gated at P0.6 and every milestone: a warm check over 1.5× the P0.3b warm figure, or a cold
check (the first after a bridge boot) over 1.5× the P0.3 cold figure, is a STOP.

### Flights: the loop flies

A **flight** runs one fixed set of programs against the live game through `play.py` (the shell
driver for the bridge, no Hermes, no cron), first on the base version and then on the branch, and
compares the two versions' journals. It is defined by what is flown, not by how long it takes.
There are three, each a tracker row: `F-U02` (due once U02 is `done`), `F-U17` (once U17 is
`done`) and `F-final` (once U33 and M-final are `done`). A due flight is the next iteration (§4,
Pick). The loop never flies through Hermes: no profile, no gateway, no cron job.

**Pilots.** Two test accounts. **TestPilot.cv is the default**: every flight flies on it.
**Chrisjen Avasarala** is for late-game careers only, the ones TestPilot.cv can't exercise (a
second ship to switch to, freighters, crafting skills). Her resources can't be replaced, so she
flies only the programs of a late-game career converted since the last flight, and only when
TestPilot.cv can't run them; the Notes say why. Before her first program, run a read-only program
(`orient()`, `ships()`, `storage()`) and record her start state in the tracker's Chrisjen ledger:
credits, cargo, storage, and ships. After her last program, run it again. Her credits, every cargo
and storage item, and every ship must be at least what she started with. If they aren't, the loop
plays her back up (sell, mine, buy back) in the same flight. If it can't, that is a STOP.

**Playgrounds.** One per pilot, outside the repo, kept across flights: `~/workspace/sm-playgrounds/testpilot-cv/`
and `~/workspace/sm-playgrounds/chrisjen/`. `play.py serve <playground>` keeps `pilot.json` there
(the bridge writes it; no record is fine) and the journal, programs and `bridge.stderr.log` under
its `runtime/`. Its socket is `/tmp/smp-<playground basename>.sock`, so the basenames must differ;
both can serve at once. Each playground also holds `credentials`, a single-account file.
`~/workspace/sm-autopilot/test-credentials` holds both accounts as two `Username:`/`Password:`
blocks separated by `---`, and `src/credentials.ts` takes the first match, so the loop splits it
once (bash, the loop's shell):

```bash
for p in 'TestPilot.cv:testpilot-cv' 'Chrisjen Avasarala:chrisjen'; do
  dir=~/workspace/sm-playgrounds/${p##*:}; mkdir -p "$dir"
  (umask 077; python3 -c 'import sys; b=[x.strip() for x in open(sys.argv[1]).read().split("\n---\n") if f"Username: {sys.argv[2]}\n" in x+"\n"]; assert len(b)==1, "want exactly one block"; open(sys.argv[3],"w").write(b[0]+"\n")' \
    ~/workspace/sm-autopilot/test-credentials "${p%%:*}" "$dir/credentials")
done
```

A credentials file is never printed, never copied into the repo, and never committed. Check one
with `grep -c '^Username: '`, never `cat`.

**The two versions.** The base is `git merge-base main HEAD`, so the comparison measures only the
branch. The branch is `HEAD`. `play.py` runs the bridge of the checkout it lives in, and
`code_sha` is that checkout's `git rev-parse HEAD`, so the base flies from a detached worktree
outside the repo:

```bash
base=$(git merge-base main HEAD)
git worktree add --detach ~/workspace/sm-playgrounds/base "$base"   # or, if it exists: git -C ~/workspace/sm-playgrounds/base switch --detach "$base"
npm --prefix ~/workspace/sm-playgrounds/base ci
```

The branch flies from this worktree. After F-final, `git worktree remove ~/workspace/sm-playgrounds/base`.

**The programs.** One set per flight, kept in `~/workspace/sm-playgrounds/programs/<F-row>/` and
flown unchanged on both versions:
- the fenced `ts` examples of `src/play/README.md` that act in game (#1 gather, sell, service; #2
  storage and the shipyard). #3 is the `ask` example and its ids are placeholders, so it is skipped;
- the examples (`src/play/<career>/README.md`, the same blocks `readme-examples.test.ts` gates) of
  every career whose unit is `done` by then: exploration (U06), mining (U19), combat (U20, U21),
  hauling (U22), industry (U23), trading (U24, U25), fleet (U26 to U28, Chrisjen);
- one refusal program: a call that the library sends and the server refuses. Prefer a function
  converted by then. At F-final, use `salvage()` at a POI with no wreck (U20, the motivating
  defect). A candidate qualifies only if the base journal shows a `command` line with `ok:false`
  inside that call; if it doesn't, pick another.

An example's place ids may be swapped for ids from the pilot's own `orient()`/`scout()` when they
don't exist where it flies. The swapped file is the one both versions fly.

**Flying one version** (bash; `<checkout>` is the base worktree, then this one):

```bash
pg=~/workspace/sm-playgrounds/testpilot-cv
ls "$pg"/runtime/gameplay*.jsonl            # before the flight: the files that existed already
SPACEMOLT_CREDENTIALS_FILE="$pg/credentials" python3 <checkout>/play.py serve "$pg"   # run in the background; it blocks
SPACEMOLT_PLAYGROUND="$pg" python3 <checkout>/play.py run ~/workspace/sm-playgrounds/programs/<F-row>/<program>.ts
```

Run each program to its end before the next. Then stop the daemon with SIGTERM (`kill <pid>`),
wait for it and its `node src/bridge.ts` child to exit (the bridge ends when its stdin closes), and
start the other version. Each `serve` points the playground's `node_modules/play` and
`node_modules/@spacemolt` links at its own checkout (`pilotHome`, `src/run.ts`). A base that
predates that fix keeps whatever link it finds, so the base pass imports the branch's `play`,
which that bridge never bound, and every run breaks with "the play runtime is not bound" (F-U02's
first branch pass): while the base lacks it, `rm` the two links before the base's `serve`. Find that bridge by its cwd, which is `<checkout>`: it is the daemon's
child (`pgrep -P <pid>`), and `lsof -a -p <bridge pid> -d cwd -Fn` names the checkout. Never find
it with `pgrep -f src/bridge.ts`: that also matches a live Hermes pilot's bridge, which a flight
never touches. Each `serve` boots a bridge, and each boot rotates `gameplay.jsonl`, so
each version's lines land in their own files.

**Comparing.** For each pilot, the flight's journal files are the ones new since the flight began,
plus the current `gameplay.jsonl`, less one: the flight's first boot rotates the pre-flight
`gameplay.jsonl` (scouting, an earlier flight) to a new `gameplay.<stamp>.jsonl`, and that file's
lines predate the flight, so it is excluded. Assign each to a version by `code_sha` on its `run started`
lines: `jq -r 'select(.event=="run" and .phase=="started") | .code_sha' <file> | sort -u`. The
branch passes when:
- every `command` line with `ok:false` has a `code`, or `lost:true`: 100%;
- the share of `failed` among `run` `ended` `calls[].status` is no more than 5 points above the
  base's;
- a `failed` call's `why` names an action and a code, or "reply lost". It never says only
  "`<fn>` broke";
- the refusal program's call is `refused`, and its `why` names the action and the code (from
  F-U17 on; at F-U02 nothing that refuses is converted yet, so record the status it shows);
- there is no `death` or `stranded` beyond the base's count;
- no reply the base read is skipped on the branch: every `did not read` / `reply off spec` step
  line on the branch is matched by the same read failing on the base (F-U17: a wreck with
  `cargo: null` was skipped on the branch, read on the base);
- what the branch's bridge wrote to `runtime/bridge.stderr.log` has no `FiberFailure`, `Defect`,
  or unhandled rejection. `play.py` appends to that one file and never rotates it, so note its
  size (`wc -c`) before the branch's `serve` and read from there (`tail -c +<size+1>`);
- for Chrisjen, the ledger's after row is at least the start row.

The two passes share the playground, so the base leaves state the branch starts from: what it
withdrew, and what it cached (`routes()`/`spreads()` place at most 5 bases a call through
`find_route`, and the placements persist). A program that ends differently on the branch is
re-flown on the base after the branch; if the base now ends as the branch did, it is state, not a
regression (F-final: `routes` `partial` on the base, `done` on the branch, `done` on the re-flown
base).

**Recording.** In the flight's tracker row: the base and branch shas, the pilot(s), the program
files, the journal file names per version, and each criterion's result. All pass → `flown`. Any
miss → `failed`, and a Stop row naming the criterion and the lines that broke it.

## 7. Kickoff, tracking, resume, stops

**Kickoff (the owner, in fish).** The work happens in the worktree
`~/workspace/sm-autopilot/.claude/worktrees/determinate-checking`, on branch `effect/migration`,
which is already created from `explore/effect-ts`.

1. `cd ~/workspace/sm-autopilot/.claude/worktrees/determinate-checking; npm ci`
2. `claude --model opus`, then paste the `/goal` line from §6.

The loop creates the playgrounds and their credentials files itself, at the first flight (§6). To
start one by hand, for example to look at a pilot between flights, run each in its own terminal
from the worktree (it blocks), and stop it with ctrl-C:

```
env SPACEMOLT_CREDENTIALS_FILE=$HOME/workspace/sm-playgrounds/testpilot-cv/credentials python3 play.py serve $HOME/workspace/sm-playgrounds/testpilot-cv
env SPACEMOLT_CREDENTIALS_FILE=$HOME/workspace/sm-playgrounds/chrisjen/credentials python3 play.py serve $HOME/workspace/sm-playgrounds/chrisjen
env SPACEMOLT_PLAYGROUND=$HOME/workspace/sm-playgrounds/testpilot-cv python3 play.py status
```

The bridge holds a controller lock in the playground's `runtime/`, so a playground can't serve
twice at once: one started by hand must be stopped before the loop flies.

**Tracking.** The tracker is [effect-migration-progress.md](effect-migration-progress.md): one row
per Phase 0 step, per unit, per Qwen milestone, and per flight, plus a Stops table. Its row
status is the second column. Step, unit and milestone rows take one of these values:

| Status | Meaning |
|---|---|
| `todo` | not started |
| `doing` | picked, not yet committed |
| `stuck` | the fable attempt is running |
| `deferred` | Qwen only: the model server was down. Retried at the next milestone; at M-final, or a second time, it opens a Stop |
| `done` | committed |

A flight row (`F-U02`, `F-U17`, `F-final`) is `todo` (not flown yet), `flown` (every §6 criterion passed) or `failed` (one missed; a Stop is open). A Stops row is `open` or `answered`.

Every unit commit carries its own tracker row, so `git log` and the tracker never disagree.

**Resume.** Paste the same `/goal`. The controller reads the tracker. For a `doing` row:
1. Run `git status` and `git diff`. **Never discard.** Unattributed changes may be someone else's
   live work.
2. If the diff covers only the allowed paths, run the gates on it and continue from the review step.
   The allowed paths are the unit's files and their tests, the tracker, `.oxlintrc.json`,
   `src/play/codes.ts`, and `docs/effect-surface.txt` only if the tracker records an approved
   surface change for this unit.
3. If the diff touches any other path, record a Stop and don't act on them.

A flight left half done resumes from its start, with the same programs; the files its first try wrote are named in Notes and not counted. If a `play.py serve` is still running on a playground (`pgrep -fl 'play.py serve'`), SIGTERM it only if the flight row's Notes record that the loop started that pid; otherwise STOP. A `stuck` row resumes at the stuck step. A `deferred` Qwen row is retried at the next milestone. M-final has no next milestone, so M-final deferred, or any Qwen check deferred twice (P0.8 included), opens a Stop; otherwise the loop could neither finish nor stop.

**Stop and ask.** Add a row `| S<n> | open | <unit> | <question> | |` to the Stops table, commit the
tracker, and end the turn. That meets the goal condition. The owner answers in the row, sets it to
`answered`, and re-pastes the goal. Stop when:
- a taste question could redirect the work: an `Outcome` status mapping, a README wording, or
  whether a Schema should reject data the game sends;
- a unit fails verification twice, or is still red after the stuck step;
- a public-surface change is needed (check 7 would be non-empty);
- a tag is needed for a code with no evidence;
- a Phase 0 step surprises: the codegen breaks on the spec at the pinned tag, the drift check fails
  on a real mismatch, oxlint lacks a rule, the language service won't patch, or the pilot-gate
  latency passes 1.5× (§6);
- a Qwen milestone fails twice;
- a flight misses a §6 criterion, or Chrisjen can't be played back up to her start state;
- the model server is down at M-final, or for the second time at any Qwen check (P0.8 or a milestone);
- the working tree contains changes the loop didn't make.

## 8. Hard stops (paste verbatim into every dispatch)

```
HARD STOPS: these apply to every loop agent, with no exceptions.
- Never merge to main.
- Never push, merge, deploy, or tag. The owner's gate is merge and release.
- Never bump versions (package.json version, CalVer, tags, version numbers in commit messages).
- Never discard uncommitted work: no `git reset --hard`, `git checkout .`, `git restore`, `git stash` without a unique tag.
- Append-only commits on the migration branch: no rebase, reset, or amend. Other agents commit here concurrently.
- Stage only files you changed, by explicit path. Never `git add -A`, `git add -u`, or a directory.
- No broad-glob deletes. List first, then delete by exact path.
- No `kill -9`. SIGTERM, wait, and escalate only to survivors.
- Never touch ~/.hermes, a profile, or a gateway. The only reads allowed are P0.6's journal evidence scan and the Qwen harness's API-key lookup. Never write there, and never restart a gateway. Flights go through play.py only.
- Never print, copy into the repo, or commit a credentials file. The per-pilot files live under ~/workspace/sm-playgrounds/<pilot>/credentials, mode 600.
- TestPilot.cv is the default pilot. Chrisjen Avasarala flies only late-game careers TestPilot.cv can't exercise; record her start state first, and leave her credits, cargo, storage and ships at least where they started. If that can't be done, STOP.
- When a flight ends, stop every `play.py serve` daemon it started with SIGTERM, and wait for it and its bridge to exit.
- Conventional Commits per AGENTS.md: type(scope): summary, with a body that says why; scope = subsystem (play, bridge, juncture, service, skills).
- Subagents don't commit. The controller commits.
```

## 9. Risks and open questions for the owner

**Risks.**
- **Pilot-gate latency.** The pilot's `check()` typechecks the library sources it imports, and
  `wire.gen.ts` is about 1.5 MB (1,509,109 bytes at v14.2.0). The warm checker (P0.3b) pays that once per bridge process instead
  of on every check. If the cold check still passes 1.5×, keep `wire.gen.ts` out of the files the
  pilot's program reaches (decode in `game.ts`; the pilot only sees lib types).
- **Effect 4 is an RC.** An rc bump mid-loop is a separate commit at a unit boundary, never inside
  a unit.
- **The evidence for error codes is thin** until P0.6's `code` field has flown for a while: 905 of
  1318 failed commands name no code. So most failures start as `Rejected`, and that is by design.

**Settled** (by the maintainer, 2026-09-29): an escaped `Rejected` becomes `refused` (§1); the
bridge side, U32–U33, is in scope; the tests' own debt stays exempt and gets its own pass
afterwards; pilot-gate latency is held under 1.5× by a warm checker in the bridge (P0.3b, §6).
