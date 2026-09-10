# Hermes SpaceMolt

This local Hermes fork runs the real `AIAgent` loop against omlx and a persistent
`@spacemolt/lib` WebSocket connection. The model chooses plans and complete jobs; scripts handle mechanical
execution, urgent controls, return, servicing and verified receipts. The first new
execution interface supports Hunt and bounded local Industry gathering. Production
and other stance jobs remain tracked in root TODO.md. The new shared interface has
offline integration evidence; the live results below use the historical workflows.

The integration is contained in this directory. Hermes core files are unchanged.
The fork starts from commit `b3399c139624a0081d70397741a5b45f60fbe1f4` of the
neighboring `hermes-agent` checkout, on branch `spacemolt-local-agent`.

## Live proof

Manual play earned **51,117 net credits**. The actual local Hermes agent then
completed six freight deliveries over two sessions for **19,697 net credits**
after fuel, unlocking licensed carrier status. That freight trial ended at
**201,380 credits**; this is a historical result, not the current live balance.
Both sessions finished fully fueled, undamaged, with original cargo preserved
and no active freight obligations. See [verified results](evidence/PROGRESS.md),
[manual receipts](evidence/manual-proof.json), and
[autonomous receipts](evidence/autonomous-proof.json).

The model occasionally misstates arithmetic in its prose reports. Use the
runner's independently measured wallet deltas and carrier records for accounting.

## Setup

Use Node 22+ and the Hermes Python environment (Python 3.11–3.13). From this directory:

```sh
npm ci
npm run typecheck
npm test
../../hermes-agent/.venv/bin/python runner.py --probe-model
../../hermes-agent/.venv/bin/python runner.py --smoke-model
```

The local default model is `mlx-community--Qwen3.6-35B-A3B-4bit`. The runner reads omlx's
host, port, and API key from `~/.omlx/settings.json` and verifies the requested
model through `/v1/models`. Keys are never put into prompts or checked-in config.

By default the bridge reads `Username: ` and `Password: ` from the existing
`/Users/vcarl/workspace/testbench/roci-testing/players/kvothe/me/credentials.txt`.
Set `SPACEMOLT_CREDENTIALS_FILE` to use another credential file.

## Play

Check for an existing controller before opening a live connection. The bridge now
holds an exclusive per-login lock under `runtime/controller-*.lock`; a crash leaves
it for inspection rather than silently stealing control. It cannot detect unrelated
clients outside this checkout. Do not delete a stale lock before verifying ownership.

From the repository root, use a fresh runtime for the new interface:

```sh
../hermes-agent/.venv/bin/python spacemolt/runner.py \
  --allow-wildlife --runtime spacemolt/runtime/jobs \
  --iterations 30 --seconds-per-cycle 1800 \
  --objective 'Choose a sensible home, assess nearby wildlife training opportunities, complete one hunt if supported by evidence, and return serviced. Report verified outcomes and blockers.'
```

The agent chooses stance/mood unless supplied with `--stance` or `--mood`, and
chooses home through observed stations and a reasoned plan. Default initial policy
is Hunt/Cautious; a mood choice never grants initiation. `--combat` is shorthand
for authorizing the new Hunt path. It no longer exposes the primitive catalog.
The session receives common job tools, Hunt tools when eligible, and native
`skill_view`; shared and selected stance skills preload at session creation. Tool names use
`job__observe`, `job__plan`, `job__track`, `job__hunt`, etc. Plan archives the old
conversation and starts a fresh session without editing its historical prefix.

Use `--stance Industry` for bounded local gathering. The agent observes nearby
asteroid-belt candidates, chooses home and a site, then uses `job__gather` for a
policy-limited visit, extraction, and serviced return. Resources are verified on
arrival; remote POI listings do not prove deposits or safety. Gather retains new
materials and preserves starting cargo. Its receipt distinguishes measured yield
and XP from cash spent on servicing. Production and sales are not yet exposed by
this shared Industry interface; `--industry` still selects the legacy workflows.

To request Tired during a live run, create `stop.json` in that run's runtime:

```sh
printf '{}\n' > spacemolt/runtime/jobs/stop.json
```

The runner notices the file within 250 ms and sends a control frame independently
of the outstanding job request. The bridge latches stop immediately, queues return
if idle, and tactical control reacts on its next poll (normally within two seconds).
Already submitted travel must finish/reconcile before movement can change. Stop
files are deliberately persistent. A final return runs outside the model budget.
Tired also interrupts active model inference; script return and reconciliation still
retain ownership of any already-submitted game command.

The `one_job` operating allowance permits one optional Hunt scout and one hunting
attempt, or one Industry gathering attempt. An admitted blocker or a scout without
an eligible quarry ends the run. Script receipts carry `stopping_reason`, which ends
the model loop without changing the historical prompt or tool catalog. Handoffs and
reconnects retain the allowance; only a verified explicit `--new-run` resets it.

Use `--resume` only with an existing checkpoint and unchanged session/model/grant.
Saved wildlife permission and stance/mood locks persist without repeating their flags.
Repeating matching stance/mood values does not add new locks; expanding permission
requires a fresh runtime. After a completed stop,
start a fresh runtime with `--new-run`; clearing the prior stop requires a reconciled,
docked, fully serviced ship. Home persists per pilot across runtimes. A job interrupted
by worker death or uncertain response blocks productive admission. The runner now
reconciles it before inference and after uncertain job results, using the library
connection recovery. Saved responses, verified arrival and observed battle participation
can justify defensive control and return/service without replay. Recovery ends the
productive attempt and leaves stop latched. Missing acceptance evidence (including a
hunt whose battle was never observed) stays blocked. Read `recovery-receipt.json` for
startup recovery, `return-receipt.json` for end-of-session recovery, and the full pilot
journal before starting another operating period. If inference or runner persistence
fails after configuration, `exception-receipt.json` records the original error and
the attempted return/reconciliation. Cleanup failure does not hide that original error.

Use `verified-report.json` for recorded outcomes, cash changes, final condition and
obligations. The runner builds this report from script receipts, excluding model prose
and assessment estimates. The private checkpoint retains `model_report` for review.
Observed endpoint hull is not a measurement of damage taken during a fight. Model
responses keep outcomes and unresolved commands but omit repeated mechanical journal
snapshots; the full journal remains on disk for executor recovery.

Hunt sorties refuse onboard passengers and carrier freight until those commitments
are resolved. Return preserves them; it does not deliver or cancel them. Receipts
keep admission `obligations`, fresh terminal `obligations_after`, and an explicit
`obligation_verification`. Missing terminal observations block success. A production
job disappearing from the queue does not itself prove that output was settled.

Private full command checkpoints and home live under `runtime/pilots/`. These are
separate from per-conversation history. Public station discovery does not establish
access. Unreachable home, missing fuel quotes, damaged hull without verified repair
pricing, or shields that fail to recover within a bounded two-minute wait produce
explicit blockers. A known home-route/docking rejection permits one temporary service
fallback (current verified dock first, otherwise an observed refuel station), preserving
home. Uncertain movement never triggers fallback. Own-battle notifications wake
scripted defense through the shared command queue, including while Hermes is idle.
Existing work checks danger at travel/service and command boundaries. Unexpected
combat suspends productive work and returns; interrupted return gets one fresh
route/service assessment. Pending commands must settle or reconcile before defense
can issue a mutation. Future stance-specific waits still need integration.

The explicit `--industry` flag retains the historical industry runner and its
[existing guide](INDUSTRY.md); it has not yet been migrated to these contracts.
Historical freight receipts remain evidence of the earlier primitive runner, not
new Logistics acceptance. [Combat internals](COMBAT.md) and [decision contracts](DECISIONS.md)
explain the reused controller and current limits.

Validation: `npm run typecheck && npm test` from this directory, and the root
`scripts/run_tests.sh tests/test_spacemolt_runner.py` with the Hermes Python environment.
The new tests use real Hermes registration/dispatch and Node execution against offline
fixtures; they do not establish new live inference or combat performance.

## Design

- `src/bridge.ts`: persistent authenticated library connection, a curated game
  command catalog, JSON-lines requests, and gameplay receipts.
- `runner.py`: real Hermes registration and tool dispatch, local model discovery,
  bounded sessions, isolated Hermes home, and resumable conversation evidence.
- `config.example.yaml`: isolated Hermes settings for the game sessions.

The new model catalog contains only implemented common and Hunt jobs. Legacy
primitives remain internal to scripts. Messaging and transfers remain excluded.
Execution decisions and unfinished milestones are recorded in root TODO.md.

Current game contracts come from the installed library's `COMMANDS.md` and generated
`ACTIONS` catalog. Public references: [library](https://github.com/SpaceMolt/spacemolt-lib),
[markets](https://spacemolt.com/docs/markets), and
[client protocol](https://spacemolt.com/docs/guides/client-dev).
