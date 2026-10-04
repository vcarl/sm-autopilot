# Effect migration progress

This file tracks the loop in [EFFECT-MIGRATION.md](EFFECT-MIGRATION.md). The loop updates it, and
each unit's commit carries its own row.

The status is always the second column. Step, unit and milestone rows take one of:

| Status | Meaning |
|---|---|
| `todo` | not started |
| `doing` | picked, not yet committed |
| `stuck` | the fable attempt is running |
| `deferred` | Qwen only: the model server was down. Retried at the next milestone; at M-final, or a second time, it opens a Stop |
| `done` | committed |

A flight row is `todo`, `flown` (every criterion passed) or `failed` (one missed; a Stop is open).
A Stops row is `open` or `answered`.

Debt is shown as cast/any/non-null/catch, from `node scripts/debt.ts <files>`.

## Baseline

Re-measured at `ca29bbeb48` (`effect/migration`, `@spacemolt/lib@15.1.0`, after P0.2) on 2026-10-01;
the 2026-09-28 figures at `3811b4ae26` (lib 14.2.0) are in brackets. The counts outside tests exclude
`*.test.ts` and `src/test-support/`.

| Measure | Outside tests | Including tests |
|---|---|---|
| Files | 71 [71] | 125 [121] |
| Casts (`as T`, `<T>x`; not `as const`) | 258 [246] | 527 [467] |
| `as unknown as` (a subset of the casts) | 9 [9] | 84 [67] |
| `any` | 42 [42] | 115 [108] |
| Non-null `!` | 189 [184] | 790 [687] (P0.2 added `!` in tests) |
| ts-comments | 0 [0] | 0 [0] |
| Catch clauses without an `// edge:` marker | 143 [128] | 143 [128] |
| `tsc` errors after the four P0.2 flags (at `f5243e3f91`, before the fix) | 19 [18] | 68 total, 49 in tests [65, 47] |
| Failed `command` journal lines (all profiles) | 1318 (413 name a code) [P0.6 re-reads] | — |
| Pilot-gate latency (`readme-examples` test, best of 3) | 2.01 s (2.01, 2.09, 2.10) | — |
| Cold `check()`, one README example (`tsc` child, as `run.ts` spawns it) | 0.63 s (best of 3: 641, 639, 633 ms) | — |
| Warm `check()`, one README example | 0.22 s at `9890e77d22` (P0.3b); 0.26 s at `ab9520b6f5` (best of 3, same runtime, pilot file changed). First check after boot 0.88 s, `tsc` child 0.82 s there: `effect`'s types now reach the pilot program through runtime.ts. Under the 0.945 s STOP line, not by much | — |
| Qwen `play` variant full-pass rate (n=50) | 60% (30/50) at `beff55981d`, `--thinking off`, after P0.7; 7 samples nudged; per task p1 5, p2 5, p3 3, p4 4, p5 3, p6 3, p7 0, p8 4, p9 0, p10 3 (`experiments/effect-qwen/results/P0.8.jsonl`) | — |

The counts come from these commands.

```
node scripts/debt.ts src                  # outside tests
node scripts/debt.ts --tests src          # including tests
node scripts/debt.ts --by-file src        # per file
tsc -p tsconfig.json --pretty false --erasableSyntaxOnly --verbatimModuleSyntax --exactOptionalPropertyTypes --noUncheckedIndexedAccess | grep -c 'error TS'
```

## Phase 0

| Step | Status | Commit | Notes |
|---|---|---|---|
| P0.1 | done | `f5243e3f91` | effect 4.0.0 (shipped 2026-10-01, so decision 1 skips the rc), oxlint 1.86.0, @effect/language-service 0.87.3 |
| P0.2 | done | `ca29bbeb48` | 68 errors at lib 15.1.0 (19 outside tests); one exported type widened: freighter `Report.why?: string\|undefined` |
| P0.3 | done | `7f20151aa4` | debt.ts, surface.ts (693 lines), test glob; baselines above |
| P0.3b | done | `9890e77d22` | language service per pilot tsconfig; parity test over every README example plus a broken file; `check` journal line. `readme-examples` now 4.6–5.1 s (was 2.01): 16 runtimes, each its own program, checked one after another |
| P0.4 | done | `91257f0fd1` | 70 files on the migration list (not the barrel `src/play/index.ts`); default correctness found 29 (>20), so `categories.correctness` is off. The commit also carries P0.5's `gen:wire` script line |
| P0.5 | done | `b4fcfc2730` | 711/711 import, 633 assertions plus 2 lib-bug guards (S1's `NotificationOk.base` added), 2,039,827 bytes; deterministic; the `& {extra: 1}` edit fails typecheck |
| P0.6 | done | `4fb9a27b6f` | evidence (kvothe only): 2701 failed lines, 1257 coded. Tags `InBattle` 6, `HoldFull` (cargo_full) 10, `Depleted` 7; no `AlreadyDocked` (never observed). `lost` added in `journalCommand` |
| P0.7 | done | `ab9520b6f5` | all four refusal tags fold to `refused` (they split `Rejected` by code); the Promise `job` classifies a raw SpacemoltError too; freighters never `bind()`, so no runtime there yet (U26/U27). Surface unchanged |
| P0.8 | done | `8ada192e29`, `beff55981d` | harness on effect 4.0.0; play variant; baseline 60% (n=50), so a milestone passes at ≥ 50%. A first run was discarded: 18/34 samples were tool calls with no file, fixed by `beff55981d` |
| P0.9 | done | `5073362ed1` | CI not run (no push): every added CI step passes locally (lint, gen-wire diff, `surface.ts --check`, patched typecheck); the script's other checks pass except the expected override list (70 files), `debt.ts --zero src`, and the tracker rows. The crossings check passes (no crossings yet). The patched `tsc` takes ~2 min. `edge.test.ts` silences `globalErrorInEffectFailure` on its one `Effect.fail(new Stopped())` until U02 gives the stop an Effect form |

## Units

| Unit | Status | Files | Lines | Tests today | Debt before | Debt after | Commit | Notes |
|---|---|---|---|---|---|---|---|---|
| U01 | todo | normal-route, mood-policy, mining-inventory, rules-table | 396 | normal-route, rules-table | 0/3/4/0 | | | pure |
| U02 | todo | play/runtime (command path), play/types | 567 | runtime, ask, fuel-cells, prose | 20/2/0/8 | | | seam; Qwen milestone after |
| U03 | todo | run-record, journal-lines | 387 | run-record, journal-lines | 9/16/0/8 | | | pure; Schemas |
| U04 | todo | combat-memory, sighting-memory | 425 | combat-memory, sighting-memory | 4/0/3/4 | | | pure; Schemas |
| U05 | todo | trade-intel, order-book, recipe-graph | 280 | all three | 1/0/0/1 | | | |
| U06 | todo | play/places, play/boundary, play/policy, play/freighter/drained, play/prose, play/exploration/*, play/industry/facilities/* | 522 | gates, prose, exploration, facilities | 13/1/6/10 | | | pure |
| U07 | todo | controller-lock, credentials, storage (src), reflect | 251 | reflect | 10/4/7/7 | | | |
| U08 | todo | dock, play/counter | 77 | none direct | 1/0/2/1 | | | first Effect conversion |
| U09 | todo | reconcile, travel (src) | 350 | travel-*.test.ts (11) | 8/3/28/5 | | | |
| U10 | todo | command-boundary, settle-cargo, mine | 282 | command-boundary ×2, gates | 4/0/0/4 | | | |
| U11 | todo | gather-job | 246 | gather-job | 3/0/0/3 | | | |
| U12 | todo | servicing, play/service | 433 | service, fuel-cells | 6/2/13/7 | | | bridge → U15 |
| U13 | todo | play/storage | 147 | fuel-cells, runtime (indirect) | 6/0/10/2 | | | |
| U14 | todo | play/hangar | 339 | runtime (indirect) | 23/0/0/2 | | | |
| U15 | todo | play/market | 300 | trading, fuel-cells, market | 8/0/1/4 | | | |
| U16 | todo | play/missions | 262 | missions | 11/0/0/1 | | | |
| U17 | todo | play/travel | 345 | runtime, travel-play-tired*, travel | 12/0/6/11 | | | Qwen milestone after |
| U18 | todo | play/orient, play/rest | 184 | orient, rest | 19/3/1/4 | | | |
| U19 | todo | play/mining/* | 171 | mining | 2/0/0/1 | | | |
| U20 | todo | play/combat/salvage | 93 | combat | 1/0/0/2 | | | the motivating defect |
| U21 | todo | play/combat/hunting, play/combat/bounties/*, play/combat/index | 676 | combat | 9/0/3/7 | | | ≤3 commits |
| U22 | todo | play/hauling/* | 323 | hauling | 17/0/0/2 | | | |
| U23 | todo | play/industry/crafting, play/industry/index | 600 | crafting | 10/0/4/9 | | | |
| U24 | todo | play/trading/trading | 836 | trading | 11/0/38/7 | | | ≤3 commits |
| U25 | todo | play/trading/scout, play/trading/index | 137 | trading | 2/0/0/1 | | | |
| U26 | todo | play/freighter/index | 507 | freighter | 2/0/5/3 | | | ≤3 commits |
| U27 | todo | play/freighter/host | 534 | freighter | 6/0/4/14 | | | ≤3 commits |
| U28 | todo | play/fleet/* | 145 | freighter | 1/0/5/0 | | | |
| U29 | todo | play/menu | 743 | menu | 19/2/33/1 | | | ≤3 commits |
| U30 | todo | run | 308 | run, readme-examples, bridge | 3/1/7/8 | | | |
| U31 | todo | play/runtime (state → Run service), response-details, readiness | ~575 (runtime.ts, also in U02) + 7 | all | 0/2/0/0 | | | Qwen milestone after |
| U32 | todo | alerts, heartbeat, journal-webhook | 305 | heartbeat, journal-webhook, push-journal | 4/1/0/2 | | | pure; bridge side (in scope) |
| U33 | todo | bridge | 512 | bridge, ask, push-journal, combat-memory | 13/2/9/4 | | | bridge side (in scope) |

The totals for the Debt before column are 258/42/189/143 (re-measured at `ca29bbeb48`, lib 15.1.0; Lines is `wc -l` of the non-test files).

## Qwen milestones

Each milestone passes when it scores at least the P0.8 baseline minus 10 points (n=50). If it
misses, it gets one fresh run of 50. A `deferred` row names each unit it was deferred at in Notes.

| Milestone | Status | After unit | Pass rate | n | Notes |
|---|---|---|---|---|---|
| M-U02 | todo | U02 | | | |
| M-U17 | todo | U17 | | | |
| M-final | todo | U31 | | | |

## Flights

The loop flies each one through `play.py` (EFFECT-MIGRATION.md §6, Flights): the same programs on
the base (the merge-base with `main`) and then the branch, on TestPilot.cv, and on Chrisjen
Avasarala only for a late-game career TestPilot.cv can't exercise. Programs are files under
`~/workspace/sm-playgrounds/programs/<row>/`; journals are file names under the pilot's
`runtime/`, per version (selected by `code_sha`). Criteria: `code` = every `ok:false` command has
`code` or `lost:true`; `failed` = the branch's failed share minus the base's, in points (≤ 5);
`why` = every failed `why` names action + code or "reply lost"; `refused` = the refusal program's
status and `why`; `death` = deaths and strandings, base → branch; `stderr` = no `FiberFailure`,
`Defect` or unhandled rejection; `ledger` = Chrisjen ended at or above her start (or n/a).

| Flight | Status | After unit | Base sha | Branch sha | Pilot | Programs | Journals | Criteria | Notes |
|---|---|---|---|---|---|---|---|---|---|
| F-U02 | todo | U02 | | | | | | | |
| F-U17 | todo | U17 | | | | | | | |
| F-final | todo | U33, M-final | | | | | | | |

### Chrisjen ledger

One row before her first program of a flight, one after her last. `after` must be at least
`before` in every column, or the loop plays her back up; if it can't, that is a Stop.

| Flight | When | Credits | Cargo | Storage | Ships | Journal line |
|---|---|---|---|---|---|---|

## Stops

Each stop is a row: `| S<n> | open | <unit> | <question> | <owner answer> |`. The owner sets it to
`answered` and re-pastes the goal.

| Stop | Status | Unit | Question | Answer |
|---|---|---|---|---|
| S1 | answered | P0.5 | At lib 15.1.0 the drift check fails on a sixth case, not one of the five documented: `Notification_ok.base` is `{"type":["string","object","null"]}` in the spec (a string for fleet_dock), but the lib types it `{[k:string]:unknown} \| {[k:string]:unknown} \| null`, dropping `string`. It breaks the `GetNotificationsResponse`, `NotificationPayload` and `V2Response` assertions. Proposed: patch it like `side_factions` (`Omit<NotificationOk,'base'> & {base?: string \| {[k:string]:unknown} \| null}`, carried up to those three, plus a guard that fails when the lib is fixed) and add it to EFFECT.md's known cases. Approve, or say otherwise? | Approved (controller, 2026-10-01): patch `Notification_ok.base` the `side_factions` way, carried to the three, with a guard that fails once the lib is fixed; add it to EFFECT.md's known cases and P0.5. |
