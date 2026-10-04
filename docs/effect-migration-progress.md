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
| U01 | done | normal-route, mood-policy, mining-inventory, rules-table | 396 | normal-route, rules-table | 0/3/4/0 | | | pure; debt 0/0/0/0 after; gates re-run by the controller. F-U02 prepped: testpilot-cv credentials, base worktree at `b983702818` (npm ci done), programs in `~/workspace/sm-playgrounds/programs/F-U02/`; pre-flight scout runs (base) are in testpilot-cv's current `gameplay.jsonl`, not flight data |
| U02 | done | play/runtime (command path), play/types | 567 | runtime, ask, fuel-cells, prose | 19/2/0/8 | 0/0/0/0 | `7f71b4813d` | `Game.command` owns the command path (count, ticker, reconnect-and-wait, re-issue, burnCells+watchMood); `command()` delegates via `viaGame` beside `edge` (the second run site, until U31) and rethrows the raw lib error kept as the tag's `cause`; refusal tags gain `cause`; `Stopped` gets `_tag`; `Binding.account`/`serve()` take the lib `Account`; no tags, no crossings; ponytail no-cast stand-ins `assume`, `orEmpty`, `said` overload where the frozen surface claims more than the data; `isProgress` drops malformed skill rows. Pilot check A/B vs HEAD on a loaded machine (best of 3): cold 1.232 vs 1.228 s, warm 0.466 vs 0.454 s — parity, but both over the 0.945/0.33 lines in absolute terms, so the absolute figure wants a quiet-machine re-measure at M-U02 |
| U03 | done | run-record, journal-lines | 387 | run-record, journal-lines | 9/16/0/8 | 0/0/0/0 | `9afd1ca6aa` | pure; Schemas `RunRecord`, `JournalLine` (`StructWithRest`, optional at/event for legacy lines); `Question` derived from `RunRecord`; journalRun listener catch kept as `// edge:`; consumer crossings `// bridge: U07` (reflect), `// bridge: U30` (run.test); verifier fix: a null `juncture_at` no longer fails the decode (which skipped the interrupted close) |
| U04 | done | combat-memory, sighting-memory | 425 | combat-memory, sighting-memory | 4/0/3/4 | 0/0/0/0 | `c5e58b6268` | pure; authored Schemas for `combat.json`/`sightings.json`, per-row decode (bad rows dropped, good kept); battle-push participant casts → record guard, frames not Wire-decoded (live server omits `your_zone`); fs catches `// edge:`; no tags, no crossings; `play.gen` d.ts declare non-exported Schema consts, surface unchanged |
| U05 | done | trade-intel, order-book, recipe-graph | 280 | all three | 1/0/0/1 | 0/0/0/0 | `305b09e193` | no tags; one crossing `// bridge: U15, U26` (Promise fileIntel runs the twin with GameLive({send}) — a run site outside edge, because freighters have no binding); a filing failure now names action+code or reply lost; defects no longer swallowed |
| U06 | done | play/places, play/boundary, play/policy, play/freighter/drained, play/prose, play/exploration/*, play/industry/facilities/* | 522 | gates, prose, exploration, facilities | 13/1/6/10 | 0/0/0/0 | `0ef2edcf52` (+ gen-play guard) | no tags; exploreNearby/facilities/buildFacility are jobEffect versions behind edge; replies decoded against Wire picked to the fields read; plugin json files get authored Schemas, file catches `// edge:`; a refused or lost survey, facilities read or build names action+code, statuses unchanged; gen-play-types no longer emits *.gen.d.ts and fails if a play declaration imports one; crossings U31 ×2 (admit), U17 (goTo), U18 (scout). Unflown: a live reply shape the fixtures don't cover could be rejected |
| U07 | done | controller-lock, credentials, storage (src), reflect | 251 | reflect | 10/4/7/7 | 0/0/0/0 | `5f465b1dea` | no tags; one crossing `// bridge: U18` (Promise reflectReport runs the twin over GameLive({send}), refreshing first so the outer layer adds no re-read on a lost reply); a GameError still names the read in `missing`, a defect now goes up; no ship → `ship` in `missing`; lock/fs catches marked `edge:`; viewStorage is Effect-only; rest.test.ts's world now refuses unserved actions |
| U08 | done | dock, play/counter | 77 | none direct | 1/0/2/1 | 0/0/0/0 | `4d7014849e` | no tags: `already_docked` is `Rejected` read by its code; `dockAtEffect` runs on `Game.command` with the account's own refresh; `DockBlocked` is a tagged error; Promise `dockAt` runs the twin with `GameLive({send})`, same raw errors; counter narrows get_system rows with `field`, `PoiRow` a Pick of `SystemPoi`; crossings `// bridge: U09`, `// bridge: U09, U11, U17`; dock's once-only re-send after a live re-check kept (idempotent) |
| U09 | done | reconcile, travel (src) | 350 | travel-*.test.ts (11) + travel-refusals | 8/3/28/5 | 0/0/0/0 | `72eb275354` | no tags; InBattle tag replaces refusedInBattle; travelTo/battleNow Promise wrappers run the twins over GameLive({send}); travel's own refusals stay thrown classes (ponytail) until U11/U17/U26; run.ts closeBattle reports a throwing battleNow (+1 catch, U30's); bridge-world "no active battle" now a SpacemoltError; a lost battle/status reply still clears the remembered battle (pre-existing, kept) |
| U10 | done | command-boundary, settle-cargo, mine | 282 | command-boundary ×2, gates | 4/0/0/4 | 0/0/0/0 | `81e4988b9e` | no tags; CommandBoundary deleted (Effect's error channel latches; tests ported to mine/settle over GameLive); Promise settleCargo deleted (test-only), no re-send after a lost reply; mine: other refusals stay in the error channel (F-U02 no_mining), no "mine failed:" prefix; a pending command is a lost reply before its code; crossing // bridge: U11 at mineToFull (gather-job mapping is a follow-up) |
| U11 | done | gather-job | 246 | gather-job | 3/0/0/3 | 0/0/0/0 | `e1d973b359`, `98c8e97def` | no code tags (local NotDocked); gatherJobEffect on Game, Promise gatherJob runs it under GameLive({send}); unconverted callees cross as SeamFailed so their throws keep today's blocked/failed step + reason; dock step calls dockAtEffect; deposit's lost-reply re-issue removed (never re-send a mutation); lost store-probe reply retried as a read (TestClock test); crossings U09 ×4, U10, U12, U19; the mine step's refusal mapping follows U10's mine.ts fix |
| U12 | done | servicing, play/service | 433 | service, fuel-cells | 6/2/13/7 | 0/0/0/0 | `b4dd0bb780` | no code tags (ServiceBlocked is a TaggedError; new ServiceUnsafe for the custody checks); counterEffect/hereEffect added to counter.ts; ServiceClock (dead) deleted; resupply stays Promise; lost refuel/repair/cell-buy replies never re-sent, the cell buy re-reads the hold; crossings U11/U17/U26 (serviceShip), U29/U30/U31 (serviceElsewhere), U17 (here), U13/U15/U16/U24 (counter); one frozen-surface cast (asBase: the live get_base omits spec fields) |
| U13 | done | play/storage | 147 | fuel-cells, runtime (indirect) + storage | 6/0/10/2 | 0/0/0/0 | `1fb09052cb`, `335614ead5`, `79b9e6fe25` | no tags; crossing `// bridge: U31` (attempt over play/counter's Promise counter(); DockBlocked from it mapped to the counter's refusal, not a defect); view reply decoded on the fields storage reads (base_id, item ids/qty/size) and passed through under one frozen-surface cast; a read field off spec is OffSpec → `failed` naming the action; a post-move off-spec re-read keeps the moved rows; short-row whys name `code: message`; a lost deposit/withdraw reply is never re-sent and is re-observed from the hold |
| U14 | done | play/hangar | 339 | hangar (20 world tests), runtime (indirect) | 23/0/0/2 | 0/0/0/0 | `45714930ef` | no tags; refit/shipsForSale/buyShip are jobEffect twins behind edge; decodes picked to the fields read, the frozen surface's full lib types passed raw (4 surface_cast); a reply or row that doesn't read is named in a step, never re-sent; catalogClass caches only Rejected "not found" (message match, no code evidence) and a definitive non-class answer; crossings U13 (withdraw), U31 (admit, acct().refresh), U15/U29 (moduleSpec/catalogClass Promise wrappers) |
| U15 | done | play/market | 300 | trading, fuel-cells, market | 8/0/1/4 | 0/0/0/0 | `df50e49a20`, `a6ca850a7e` | no tags; prices/sell/buy are jobEffect behind edge; bookEffect reads rows via servicing's listing, Promise book() kept (bridge U23/U24/U25); crossings U13 (withdraw), U14 (moduleSpec), U31 (admit); a lost sell reply re-reads once against a carried baseline, never re-sent; 3 frozen-surface casts; follow-up: a failed withdraw before a sell is reported, not a crash (`reached()` added to runtime) |
| U16 | done | play/missions | 262 | missions | 11/0/0/1 | 0/0/0/0 | `a7d1a13588` | no tags; jobEffect twins behind edge; board/active rows decoded on fields read, 5 frozen-surface casts; lost accept/abandon/complete never re-sent, a lost complete is `failed` (`partial` beside a turn-in); a withdraw that did not finish no longer says "withdrew"; crossings removed U16 (counter), added U17/U21 (active()), U31 (admit) |
| U17 | done | play/travel | 345 | runtime, travel-play-tired*, travel | 12/0/6/11 | 0/0/0/0 | `5050913777`, `2f0d8764f9`, `567f0872d8` | no code tags; goTo/route are jobEffect twins behind edge; refusals keep their code and end `refused`; a lost jump/travel reply is not re-sent by U17's code; an unconfirmed arrival (`ArrivalUnresolved`) or a pilot stop is a failure value, never a `defect` line; refuel on the way is serviceShipEffect, a failed refuel is said; Promise dockAt and here() deleted; 2 frozen-surface casts; crossings resolved: servicing, dock, counter, missions, rest, exploration, mining; added U21/U22 (route). Known re-sends kept (pre-existing, not U17's): dockAtEffect re-sends dock once after a lost reply when a live read shows it did not land; Game re-issues jump/travel/dock/undock once after a reconnect |
| U18 | done | play/orient, play/rest | 184 | orient, rest, reflect, menu (world) | 19/3/1/4 | 0/0/0/0 | `27e9ef5166` | no tags; orient/scout/reflection/rest are jobEffect twins behind edge; decodes picked to fields read, 9 frozen-surface casts; defects go up; Promise reflectReport deleted; scout's gather hint named resources `undefined` (a cast-hidden bug), fixed; crossings removed U18 ×3, added U17 (rest's goTo) |
| U19 | done | play/mining/* | 171 | mining | 2/0/0/1 | 0/0/0/0 | `ab5b767df2`, `9d133986e4` | no tags; gatherUntil is a jobEffect twin behind edge; Promise gatherJob deleted; store view decoded per row on item_id/quantity, a bad row named in a step; a sale that did not reach its detail settles nothing and is named in a step (via `reached()`); crossings removed U19, added U17 (route), U15 (sell), U31 (admit) |
| U20 | done | play/combat/salvage | 93 | combat | 1/0/0/2 | 0/0/0/0 | `736a65165e`, `7b60a196a9` | the motivating defect: a loot refusal is named with its code (`in_battle`), hold full, empty wreck (tow or scrap) and "nothing that fits" are told apart; a lost loot is never re-sent and ends `failed`; wreck rows decoded on the fields read, a missing cargo/modules key reads as none with a step line; one frozen-surface cast; crossings U21 (wrecksHere/lootWreck), U31 |
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
| M-U02 | done | U02 | 56% (28/50) | 50 | Passes (line 50%; P0.8 baseline 60%). At `78e1cfe62a`, `--thinking off`, 13 samples nudged; per task p1 4, p2 5, p3 1, p4 5, p5 5, p6 1, p7 0, p8 4, p9 0, p10 3 (`results/M-U02.jsonl`). Pilot-gate latency re-measured after the run, best of 3 (`uptime` load 2.3-2.4, other sessions live, so not idle): first `check()` after a fresh process 1.234 s (1.247, 1.239, 1.234), `tsc` child (`warm:false`) 1.254 s (1.261, 1.254, 1.263), warm `check()` 0.367 s (0.378, 0.370, 0.367 best-of-process; first warm 0.464-0.469). Over the 0.945/0.33 lines, as the loaded A/B at U02 showed. Cause, A/B against main (`b983702818`) at the same moment, load 1.5-1.8, best of 3, both through the warm service: main cold 0.925 s / warm 0.328 s, this branch cold 1.234 s / warm 0.365 s; `--extendedDiagnostics` 265 files / 87k lines of definitions on main, 425 / 313k here, 156 of them `effect`'s, reached through runtime.ts. Fixed by checking the pilot against the generated `play.gen/` declarations (`npm run gen:play`, `paths` in the pilot tsconfig): cold 0.623 s, warm 0.016 s, `tsc` child 0.624 s (main 0.970 s), errors identical. Effect's .d.ts still load (396 files), because runtime.d.ts imports it for `jobEffect`/`edge`, which no barrel exports: no pilot-surface leak, and dropping those two lines by hand measured cold 0.357 s |
| M-U17 | done | U17 | 54% (27/50) | 50 | Passes (line 50%; P0.8 baseline 60%). At `d8f4367b93`, `--thinking off`, 7 samples nudged; per task p1 4, p2 4, p3 3, p4 4, p5 5, p6 1, p7 0, p8 5, p9 0, p10 1 (`results/M-U17.jsonl`); the harness hit a 4 GB heap limit at sample 19 and was resumed with `NODE_OPTIONS=--max-old-space-size=12288`, same file. Pilot-gate latency, best of 3 (`uptime` load 4.1-4.4, other sessions live, so not idle): first `check()` after a fresh process 0.437 s (0.443, 0.437, 0.439), `tsc` child (`warm:false`) 0.426 s (0.439, 0.426, 0.427), warm `check()` on an edited file 0.013 s (0.018, 0.013, 0.014; an unchanged sha answers in 0.001 s). Under the 0.945/0.33 lines, and under the 0.623/0.016 s measured after the `play.gen/` fix at M-U02 |
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
| F-U02 | flown | U02 | `b983702818` | `b087106893` (code as `78e1cfe62a`) | TestPilot.cv | `programs/F-U02/`: `readme-1-gather.ts`, `readme-2-storage.ts`, `refusal-storage.ts` (`storage('no_such_base')`) | base `gameplay.2026-10-02T18-00-56Z.jsonl`; branch `gameplay.jsonl` (as of 2026-10-02 18:04Z; rotated at the next boot). Excluded: `gameplay.2026-10-02T17-57-20Z.jsonl` (pre-flight scouting), `gameplay.2026-10-02T18-01-52Z.jsonl` (first branch pass, stale `play` link) | `code` pass, 8/8 base, 8/8 branch (5 `not_in_battle`, `no_mining`, `not_docked`, `station_not_found`); `failed` pass, 3/6 → 1/6 (−33 points; `shipsForSale` and `storage` move to `refused`); `why` pass, the one failed `why` is `mine failed: mine failed: no_mining: …`; `refused` branch `refused`, why `storage: station_not_found — Station "no_such_base" not found…` (base `failed`, why the server's message with no code); `death` 0/0 → 0/0; `stderr` pass, `bridge.stderr.log` 0 bytes before and after; `ledger` n/a | Base also flew `reset-dock.ts` (`goTo('central_nexus')`) after its programs so the branch started docked where the base did; that run is excluded by `run_id`. The first branch pass ran the base's `play` through the playground's stale `node_modules/play` link (`pilotHome` keeps an existing link), so every run broke as unbound; the links were removed and the branch re-flown, and §6 now removes them before each serve. TestPilot.cv has no mining equipment, so the gather example only reaches the `no_mining` refusal; the gather job reports it `failed`, not `refused` (U11). The `why` doubles `mine failed:` on both versions. Spent 3 fuel, 0 credits; ship left undocked at `material_harvesters` |
| F-U17 | flown | U17 | `b983702818` | `d8f4367b93` | TestPilot.cv | `programs/F-U17/`, in order: `orient-scout.ts` (`orient`, `scout`), `readme-1-gather.ts`, `readme-mining.ts` (the mining README example), `salvage-none.ts` (`salvage()` at `material_harvesters`), `travel-roundtrip.ts` (`goTo('node_alpha')`, `salvage()` there, `goTo('central_nexus')`, `service()`), `readme-2-storage.ts`, `market-missions.ts` (`prices`, `missions`, `storage`), `refusal-storage.ts` (`storage('no_such_base')`) | base `gameplay.2026-10-03T04-07-48Z.jsonl`; branch `gameplay.2026-10-03T04-15-49Z.jsonl`. Excluded: `gameplay.2026-10-03T03-59-55Z.jsonl` (pre-flight: F-U02's branch pass), `gameplay.jsonl` as of 2026-10-03 04:19Z (`probe-wrecks.ts`, the post-flight probe in Notes) | `code` pass, 14/14 base, 14/14 branch (12 `not_in_battle`, `no_mining`, `station_not_found`); `failed` pass, 2/21 → 0/21 (−9.5 points; both gather calls and `storage` are `refused`); `why` pass, no failed call on the branch (base: `mine failed: mine failed: no_mining: …`, and the server's storage message with no code); `refused` pass, `storage` `refused`, why `spacemolt_storage/view: station_not_found — Station "no_such_base" not found…`, and the gather example `refused`, why `mine blocked: no_mining: No mining equipment installed` (base `failed` for both); `death` 0/0 → 0/0, `stranded` 0 → 0, `defect` 0 → 0; `stderr` pass, `bridge.stderr.log` 0 bytes before and after; `ledger` n/a | **A regression the criteria do not catch (U20, `salvage`):** at `material_harvesters` the base read 2 wrecks (`loot da50470d… nothing that fits`) and the branch dropped both: `{"event":"line","run_id":"f11611cf-5939-4b50-8f15-1934a425dd16","text":"  spacemolt_salvage/wrecks: wreck da50470d1f7214de1ef4d60df5372145 did not read, skipped","fn":"salvage"}` (and `662656061458…`), so `salvage` said `no wreck at material_harvesters`. The probe (`probe-wrecks.ts`, raw `scout().here.wrecks`, on the branch after the flight) shows the live rows carry `cargo: null` and `modules: []`; `Wreck` in `src/play/combat/salvage.ts` decodes `cargo` as `optionalKey(Array)`, which rejects `null`, so every such wreck is dropped, in `wrecksHereEffect` and so in `hunting.ts` too. No `reply off spec` line and no other `did not read` on either version. Nothing else differs: `goTo` one jump out and back, `prices` (6 of 7 quoted), `missions` (26 on the board) and `storage` read alike. Both versions start docked at `central_nexus`, so no reset run. Resources: start 23,602 cr, fuel 74/120, hull 55/55, hold 43/420 (5 `cargo_container`, 23 `coolant_fluid`); end 16,913 cr, fuel 120/120, hull 55/55, hold 69/420 (+21 `fuel_cell`, +1 `lithium_ore` and +2 `tungsten_ore` withdrawn from storage). Spent 6,689 cr: the base pass's `service()` filled the empty fuel-cell rack (21 at 300 cr, 6,457 cr) besides 204 cr of fuel; then 20 cr and 8 cr of fuel. Credits were 24,102 at F-U02's end and 23,602 at this flight's first `orient`, with no journal line between **Re-flight at `c52fd09bb1` (contains fix `4ed9c213ca`), TestPilot.cv, `programs/F-U17/salvage-refly.ts` (`goTo('material_harvesters')`, `salvage()`), run `67c21947-aae0-4942-963c-72dd2254daa9`, `gameplay.jsonl` (current file, lines 40 and 41 are the step lines):** the regression is gone. Both wrecks (`da50470d…`, `66265606…`) now read, each with the step line `no cargo listed, read as none`, and the Outcome is `looted 0 of 2 wreck(s) at material_harvesters: … empty (hull only)` per wreck. Criterion "no reply the base read is skipped on the branch": pass, 0 `did not read`, 0 `reply off spec`, 0 `defect` lines in the file; `bridge.stderr.log` 0 bytes. Resources: 1 fuel (119/120), 0 cr (16,913). Status stays `flown`. |
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
