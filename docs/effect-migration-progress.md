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

The Flight row is `todo`, `handed-off` or `flown`. A Stops row is `open` or `answered`.

Debt is shown as cast/any/non-null/catch, from `node scripts/debt.ts <files>`.

## Baseline

Measured at `3811b4ae26` (`explore/effect-ts`) on 2026-09-28. The counts outside tests exclude
`*.test.ts` and `src/test-support/`.

| Measure | Outside tests | Including tests |
|---|---|---|
| Files | 71 | 121 |
| Casts (`as T`, `<T>x`; not `as const`) | 246 | 467 |
| `as unknown as` (a subset of the casts) | 9 | 67 |
| `any` | 42 | 108 |
| Non-null `!` | 184 | 687 |
| ts-comments | 0 | 0 |
| Catch clauses without an `// edge:` marker | 128 | 128 |
| `tsc` errors after the four P0.2 flags | 18 | 65 total (47 in tests) |
| Failed `command` journal lines (all profiles) | 1318 (413 name a code) | — |
| Pilot-gate latency (`readme-examples` test, best of 3) | _P0.3_ | — |
| Cold `check()`, one README example | _P0.3_ | — |
| Warm `check()`, one README example | _P0.3b_ | — |
| Qwen `play` variant full-pass rate (n=50) | _P0.8_ | — |

The counts come from these commands. Until P0.3 lands, run `scripts/debt.ts` from a scratch copy.

```
node scripts/debt.ts src                  # outside tests
node scripts/debt.ts --tests src          # including tests
node scripts/debt.ts --by-file src        # per file
tsc -p tsconfig.json --pretty false --erasableSyntaxOnly --verbatimModuleSyntax --exactOptionalPropertyTypes --noUncheckedIndexedAccess | grep -c 'error TS'
```

## Phase 0

| Step | Status | Commit | Notes |
|---|---|---|---|
| P0.1 | todo | | deps: effect (exact rc), oxlint, @effect/language-service |
| P0.2 | todo | | tsconfig flags + 65-error fallout |
| P0.3 | todo | | debt.ts, surface.ts, docs/effect-surface.txt, latency baseline |
| P0.3b | todo | | warm checker in the bridge, parity test, warm and cold latency |
| P0.4 | todo | | .oxlintrc.json + migration list |
| P0.5 | todo | | gen-wire + drift check |
| P0.6 | todo | | Game, classify, codes.ts, `code`/`lost` on command lines |
| P0.7 | todo | | jobEffect / edge / ManagedRuntime per bind |
| P0.8 | todo | | Qwen `play` variant + baseline |
| P0.9 | todo | | migration-check.sh + CI steps |

## Units

| Unit | Status | Files | Lines | Tests today | Debt before | Debt after | Commit | Notes |
|---|---|---|---|---|---|---|---|---|
| U01 | todo | normal-route, mood-policy, mining-inventory, rules-table | 396 | normal-route, rules-table | 0/3/4/0 | | | pure |
| U02 | todo | play/runtime (command path), play/types | 553 | runtime, ask, fuel-cells, prose | 18/2/0/8 | | | seam; Qwen milestone after |
| U03 | todo | run-record, journal-lines | 352 | run-record, journal-lines | 8/16/0/6 | | | pure; Schemas |
| U04 | todo | combat-memory, sighting-memory | 425 | combat-memory, sighting-memory | 4/0/3/4 | | | pure; Schemas |
| U05 | todo | trade-intel, order-book, recipe-graph | 280 | all three | 1/0/0/1 | | | |
| U06 | todo | play/places, play/boundary, play/policy, play/freighter/drained, play/prose, play/exploration/*, play/industry/facilities/* | 273 | gates, prose, exploration, facilities | 2/1/4/5 | | | pure |
| U07 | todo | controller-lock, credentials, storage (src), reflect | 251 | reflect | 10/4/7/7 | | | |
| U08 | todo | dock, play/counter | 76 | none direct | 1/0/2/1 | | | first Effect conversion |
| U09 | todo | reconcile, travel (src) | 350 | travel-*.test.ts (11) | 8/3/28/5 | | | |
| U10 | todo | command-boundary, settle-cargo, mine | 282 | command-boundary ×2, gates | 4/0/0/4 | | | |
| U11 | todo | gather-job | 245 | gather-job | 3/0/0/3 | | | |
| U12 | todo | servicing, play/service | 429 | service, fuel-cells | 6/2/13/6 | | | bridge → U15 |
| U13 | todo | play/storage | 147 | fuel-cells, runtime (indirect) | 6/0/10/2 | | | |
| U14 | todo | play/hangar | 339 | runtime (indirect) | 23/0/0/2 | | | |
| U15 | todo | play/market | 270 | trading, fuel-cells, market | 8/0/1/4 | | | |
| U16 | todo | play/missions | 262 | missions | 11/0/0/1 | | | |
| U17 | todo | play/travel | 340 | runtime, travel-play-tired*, travel | 13/0/6/11 | | | Qwen milestone after |
| U18 | todo | play/orient, play/rest | 184 | orient, rest | 19/3/1/4 | | | |
| U19 | todo | play/mining/* | 166 | mining | 3/0/0/1 | | | |
| U20 | todo | play/combat/salvage | 93 | combat | 1/0/0/2 | | | the motivating defect |
| U21 | todo | play/combat/hunting, play/combat/bounties/*, play/combat/index | 669 | combat | 8/0/3/6 | | | ≤3 commits |
| U22 | todo | play/hauling/* | 319 | hauling | 17/0/0/2 | | | |
| U23 | todo | play/industry/crafting, play/industry/index | 322 | crafting | 9/0/1/3 | | | |
| U24 | todo | play/trading/trading | 836 | trading | 11/0/38/7 | | | ≤3 commits |
| U25 | todo | play/trading/scout, play/trading/index | 140 | trading | 3/0/0/1 | | | |
| U26 | todo | play/freighter/index | 507 | freighter | 2/0/5/3 | | | ≤3 commits |
| U27 | todo | play/freighter/host | 532 | freighter | 6/0/4/14 | | | ≤3 commits |
| U28 | todo | play/fleet/* | 145 | freighter | 1/0/5/0 | | | |
| U29 | todo | play/menu | 649 | menu | 20/2/33/1 | | | ≤3 commits |
| U30 | todo | run | 295 | run, readme-examples, bridge | 3/1/7/8 | | | |
| U31 | todo | play/runtime (state → Run service), response-details, readiness | ~500 | all | 0/2/0/0 | | | Qwen milestone after |
| U32 | todo | alerts, heartbeat, journal-webhook | 305 | heartbeat, journal-webhook, push-journal | 4/1/0/2 | | | pure; bridge side (in scope) |
| U33 | todo | bridge | 501 | bridge, ask, push-journal, combat-memory | 13/2/9/4 | | | bridge side (in scope) |

The totals for the Debt before column are 246/42/184/128.

## Qwen milestones

Each milestone passes when it scores at least the P0.8 baseline minus 10 points (n=50). If it
misses, it gets one fresh run of 50. A `deferred` row names each unit it was deferred at in Notes.

| Milestone | Status | After unit | Pass rate | n | Notes |
|---|---|---|---|---|---|
| M-U02 | todo | U02 | | | |
| M-U17 | todo | U17 | | | |
| M-final | todo | U31 | | | |

## Flight

The owner does the flight. The loop stops at `handed-off`.

| Row | Status | Branch / sha | Window | Notes |
|---|---|---|---|---|
| Flight | todo | | 24 h or 20 ended runs, whichever is longer | checks in EFFECT-MIGRATION.md §6 |

## Stops

Each stop is a row: `| S<n> | open | <unit> | <question> | <owner answer> |`. The owner sets it to
`answered` and re-pastes the goal.

| Stop | Status | Unit | Question | Answer |
|---|---|---|---|---|
