# SpaceMolt checklist

## Using this checklist

- This is the checklist. [VISION.md](VISION.md) is intent; `worklog/` is history, one file per finished task, written by `scripts/codex_workflow.py` from verified artifacts. Neither is edited from here.
- Check an item only when its observable result exists. A stub, an accepted command, or a model claim is not completion.
- Put evidence beside a checked item: path, test command, or reviewed receipt. Name the level (fixture, replay, live).
- Record progress, decisions, and the next action here before ending work.
- Reopen an item when later evidence invalidates it.
- IDs are local to this file. The vision has none; do not invent cross-references to it.
- Work runs through `scripts/codex_workflow.py` (see `scripts/codex_workflow.md`): the operator names one milestone, usually one item or a few adjacent items from this file, and the fixed checks; while the tree is deliberately broken, checks are task-scoped (`node --test <file>`) or a checked-in script, never the whole suite.

## Decisions (D)

- [ ] D1 — Stop authority: only the operator's stop overrides the agent. A script may refuse a job or suspend one, never redirect the pilot. Written down with permitted and rejected examples.
- [ ] D2 — Mood resolves to numbers: each word maps to reserves, pursuit, spend, and walk-away margins in one table. Nothing is passed per call.
- [ ] D3 — Tired margins: which resources cross (fuel, hull, ammunition, credits), per mood, and what resupply must restore to clear it.
- [ ] D4 — Menu contract: what an option carries (what, bounds, reason), what a refusal carries, and what "worthwhile" means beyond "admissible".
- [ ] D5 — Place taxonomy: which kinds of place the engine distinguishes and what each makes possible.
- [ ] D6 — Rest triggers: what makes the agent rest rather than take another job, and which stagnation signals reflection sees.
- [ ] D7 — Enumeration session with Carl: the stances, jobs, and station counters the game actually offers. Blocks D5 and much of K and S below.
- [x] D8 — Home semantics: selection criteria, persisted identity, reconsideration triggers, temporary service stops, unreachable-home fallback. No operator-supplied station IDs.
- [x] D9 — Job contract: preconditions, outputs, obligations, cleanup, terminal outcomes.
- [x] D10 — Agent/script discretion: mechanical adaptation versus a change of objective, with examples.
- [x] D11 — Permissions are independent of mood; a bolder mood grants no authority the operator did not give.
- [x] D12 — Interruption contracts per state (idle, travel, work, combat) for Tired, operator stop, timeout, disconnect, handoff.
  - (mined from DECISIONS.md) Table: idle+stop latches admission closed and queues return with no inference turn; travel+stop finishes or reconciles the submitted move then exits through return checkpoints; work+stop forbids new admission and first strike but finishes command ownership; combat+stop latches fleeing at the next tactical poll (two seconds) and observes battle end before returning.
- [x] D13 — Success measures are authoritative per job; model prose cannot establish completion.

## Rules (R)

- [ ] R1 — One rules table with several consumers: the menu, skill surfacing, and running scripts read the same rules.
  - (mined from src/rules.ts) Composition law: every matching rule contributes; `allowed` is a hard AND that no allowance can undo, reasons dedupe on id+text (denial wins), obligations union, limits merge tightest-wins, and `exit` takes the strongest of finish_job < next_checkpoint < return_now.
- [ ] R2 — Inputs are stance x mood x place, plus holdings, obligations, and operator permissions.
- [ ] R3 — The menu is produced at every juncture: counters, jobs, sites, targets, contracts, each with bounds and a reason attached.
- [ ] R4 — The menu is never empty. An idle pilot at a base with no stance and nothing owed still gets meaningful options.
- [ ] R5 — On-menu refusal under unchanged conditions is a bug; fixing the menu is the fix. If the world moved since observation, the refusal names the changed condition and returns a fresh menu.
- [ ] R6 — Off-menu refusal is the script working, and says what would have made the attempt admissible.
  - (mined from src/execution-logistics.ts) Refusal text worth keeping verbatim: "Directory reachability only; fuel, service prices, docking access, hazards and delivery time are not established." A station appearing in the directory is not a quote for any of those.
- [ ] R7 — Mood word to margins resolves here. Scripts read the numbers; the agent never passes them.
  - (mined from src/rules.ts) Mood rows as ticks / retreat-hull fraction / gather cycles / route jumps / max liability: Relaxed 12/.90/2/1/500, Cautious 16/.95/2/1/500, Focused 20/.90/4/2/1000, Opportunistic 20/.90/4/2/1000, Aggressive 24/.80/6/2/2000, Tired 1/.95/0/0/0. Relaxed and Tired may not initiate.
  - (mined from src/execution-policy.ts) Overrides tighten only: limits merge by min except credit_reserve, retreat_hull_fraction and minimum_economic_margin which merge by max; max_spend 0..10000 (default 1000), credit_reserve >= 150000, retreat fraction <= .95, cycles and ticks integers within the resolved mood bound.
- [ ] R8 — Tired is imposed by a margin crossing, never chosen, and resupply clears it and restores the prior mood with nobody clearing it. (re-earn: old version worked by denying admission)
- [ ] R9 — Place changes the menu: the same stance and mood at a station, a belt, a planet, and deep space see different options.
- [ ] R10 — Invalid or conflicting context never reaches the menu, and therefore never reaches a game mutation. (re-earn: old version validated inside the resolver)
- [ ] R11 — Engine internals stay private. The agent sees conclusions and reasons, never the derivation.
- [ ] R12 — The rules and the journal carry safety and memory across crashes and reconnects.
- [ ] R13 — Tired recovery: when resupply is impossible, the menu offers permitted recoveries inside standing permissions (sell cargo for fuel, cheaper service at a nearer station, hold at a non-home dock); when none is admissible the pilot waits docked with a precise blocker, and that wait is a juncture a human can answer.
- [ ] R14 — Chains: a menu choice may compose jobs as a sequence, a loop until a condition, or one job then ask; the rules bound the chain (max trips, spend, Tired) the same way they bound a job.
- [ ] R15 — Danger is checked first and separately when building the menu: combat strips the pilot of its running work, so a fighting ship looks idle to every other check.

## Skills (K)

- [ ] K1 — Shared skill teaches the world, how to read state, how to choose home and mood, and how to read outcomes. Preloaded for the session's life. (re-earn: current one teaches procedure)
  - (mined from skills/spacemolt-operations/SKILL.md) Two paragraphs to keep: the world advances on ten-second ticks whether or not a tool is called, so a slow call is the world's clock and a pending call is never retried; and observations decay, so ids, offers and belt resources are confirmed only on arrival, never from a prior snapshot.
- [ ] K2 — Stance skill teaches choosing well inside that kind of work: what to look for, what a good job looks like, when to reconsider. Preloaded with the session. (re-earn: current ones teach routes and procedure)
  - (mined from COMBAT.md) Wildlife habitats are asteroid belts, gas clouds, ice fields and nebulae, never planetary surfaces; species and habitat ids are reusable but individual creature ids expire across a trip, so prefer species; only an unowned creature not already in a battle can be hunted; a mining laser is not a weapon.
  - (mined from COMBAT.md) Loadout floor for a hunt: full hull and shields, >=30 launch fuel with 15 reserved for withdrawal, >=100 autocannon rounds loaded, ten free cargo units, 150,000-credit wallet reserve. Assessment planning margins are 80% outgoing accuracy, 125% incoming damage, three approach ticks, three escape ticks.
  - (mined from COMBAT.md) A successful scan adds hull and description evidence but not weapon or mobility numbers, so scanning alone never clears need_intelligence; a faster opponent is rejected outright because there is no escape plan against it.
  - (mined from skills/spacemolt-industry/SKILL.md) A remote POI listing never proves deposit contents; resources are inspected after arrival and before extraction is admitted.
- [x] K3 — Stance skills load for the stances that have sessions today (hunt, industry, logistics). Not a closed roster.
- [ ] K4 — On-demand skills exist for place, counter, and contract type; the rules engine names which apply from the same stance, mood, and place it used for the menu.
- [ ] K5 — Station-counter skills teach how a counter works: how the market forms a price, a recipe's cost against its sale, what a contract really promises.
  - (mined from INDUSTRY.md) Screening margins omit unknown labor and taxes, so a screening number is never a quote; `incremental_profit_after_input_opportunity` subtracts the observed alternative sale value of consumed owned inputs, and that opportunity value is an observed alternative, not a completed sale.
  - (mined from skills/spacemolt-logistics/SKILL.md) A destination is an exact token off an observed offer, never invented; scripts resolve public directory ids to canonical stations while preserving passenger identity, and a board listing alone does not prove route readiness, capacity or profit.
- [ ] K6 — No skill explains a script's branches. Promise and outcome only; a skill describing a state machine means the script needs fixing.
- [x] K7 — Mood words and their thresholds have one authoritative configuration, not per-skill copies.
- [x] K8 — Preloaded skills load at session creation through the Hermes integration.
- [ ] K9 — Real sessions choose and interpret work from the skills without operator-supplied game commands.

## Scripts (S)

- [ ] S1 — Every stance carries the same flight primitives: look, travel, dock, service. No stance can strand the pilot.
- [x] S2 — Arrival and docking are verified against authoritative state; a pending or ambiguous move is never blindly replayed.
- [x] S3 — Tired, new danger, and an unavailable destination are handled at execution checkpoints; transit is never confused with arrival.
- [ ] S4 — Route selection accounts for cargo, fuel, destination access, hazards, and the return leg.
- [ ] S5 — Servicing is script-owned: fuel, repair, ammunition, shields, cargo staging, never a model reminder. Which fit to carry stays an agent choice on the menu. (re-earn: was a `prepare` tool the agent called)
- [ ] S6 — Servicing verifies the declared readiness conditions; missing supply produces a precise blocker, not a false ready state.
  - (mined from DECISIONS.md, src/return-service.test.ts) Shield recovery is a bounded wait: poll every two seconds for at most 120 seconds, preserving dock and ship identity and rechecking defense each poll; a timeout, changed hull/fuel/docking, lost docking, or missing all-in repair pricing stays blocked and never becomes a readiness claim. Service APIs have no atomic price cap, so a preflight quote and a post-action actual check are both required.
- [ ] S7 — Station tools are shared by every stance: market, workshop and recipes including profitability, boards, storage, hangar and fitting, comms.
  - (mined from src/execution-host.ts) Chat counter guardrails: one bounded message per call, content capped at 500 characters, targets system/local/faction/private (history also allows emergency), private requires target_id, and long form belongs in notes rather than another player's chat.
- [ ] S8 — A station act is not a job: no undock, no escort script, no job lifecycle.
- [ ] S9 — A job earns its place by a clear beginning at a dock, a clear end at a dock, and a script that keeps the pilot safe between. The set grows one job at a time.
- [ ] S10 — Existing executors (gather, produce, transport freight, transport passengers, track and hunt) are reshaped to S9. (re-earn: previously scored as stance completeness)
- [ ] S11 — New jobs come from D7 and from playing the game, added one at a time; there is no complete list to finish.
- [ ] S12 — Home selection compares observed stations on access, services, storage, activity, and travel cost.
- [x] S13 — The chosen home and its rationale persist across sessions and reach job planning without a supplied station ID.
- [x] S14 — Reconsideration updates home deliberately; a resupply stop or travel fallback never overwrites it.
- [x] S15 — No suitable observed home produces an explicit discovery or temporary-return plan, not an invented destination or an unexplained halt.
- [ ] S16 — Coming home resolves danger, preserves custody, travels, services, records what was left unfinished, and raises a juncture. (re-earn: old version latched and stopped productive admission)
- [ ] S17 — Tired during idle, travel, work, and combat reaches each state's safe exit without waiting for another model turn.
- [ ] S18 — Pending production, passengers, cargo, and deadlines survive Tired and are never silently abandoned, sold, cancelled, or reported complete.
- [ ] S19 — Every admitted job has an identity, resolved policy, preconditions, progress, obligations, and an explicit terminal outcome.
- [x] S20 — Checkpoints survive process restart and keep pending, confirmed, and uncertain actions distinct without losing their receipts.
- [x] S21 — Game commands are serialized per pilot; job work and defense cannot issue conflicting mutations.
- [x] S22 — Model iteration or time exhaustion does not interrupt required cleanup; a worker interruption leaves reconcilable state, not an invented success.
  - (mined from execution_runner.py) Cleanup runs in a `finally` outside the inference budget, is attempted at most once, and a cleanup failure is attached as a note to the original exception rather than replacing it; "cleanup was already attempted but produced no receipt" is itself recorded.
- [x] S23 — Reconnect queries authoritative location, transit, battle, inventory, production, and obligations before resuming.
- [ ] S24 — An accepted action whose reply was lost is recognised without a duplicate purchase, attack, craft, acceptance, or delivery; a mutating command is never retried on a connection error, it is reconciled first.
  - (mined from src/execution.ts) Per-command order: snapshot and save the entry `pending` -> send -> the accepted-result callback marks completion and records spending -> required refresh -> mark `confirmed`. An accepted command with a missing cost is not an unaccepted command: the boundary stays healthy for defensive return but further spend is blocked.
  - (mined from tests/test_spacemolt_runner.py) Bridge pairing: every reply must carry the request id or the request fails "ID mismatch", and after one unknown outcome the next request refuses with "no uncertain action" rather than re-sending; the request counter still advances.
- [ ] S25 — Active combat is reconciled and handed to defensive control; finished combat is resolved from authoritative outcomes.
- [x] S26 — Unresolvable uncertainty becomes a durable blocked state with evidence and a next step, never a blind retry.
- [ ] S27 — Defense runs beneath every stance during noncombat work, without model inference and without an offensive tool on the catalog.
  - (mined from src/execution.ts, DECISIONS.md) A battle notification only latches an assessment: a read-only status probe must establish participation before any mutation, idle defense then runs as a durable return job even while a handoff is pending, and an intentional hunt keeps tactical ownership of its own battle.
- [ ] S28 — Defense stays inside permissions and resource limits; under Tired it aims at the way home.
- [ ] S29 — Defense coordinates with the running job, preserving or checkpointing its obligations before resumption or return.
- [x] S30 — Tests exercise danger during noncombat activity and show the job and the defender neither race nor duplicate commands.
- [ ] S31 — Scripts consult the rules and vary internally with the world (route under a cautious mood, early return from a contested belt, shorter run on a full hold) without coaching the agent.
- [ ] S32 — Repetition runs to a verified objective, budget, Tired, or a declared stop without the model reconstructing each cycle.
- [ ] S33 — Each iteration reassesses state and completes servicing and settlement; blockers and changed obligations stop repetition.
- [ ] S34 — Receipts connect objective, stance, mood, policy version, home, job, decisions, outcomes, costs, progression, and obligations.
  - (mined from receipts.py) Recovery updates the ORIGINAL job id, so receipts are deduped by id before any sum; a partial delta plus its later complete delta would otherwise count the same purchases twice.
- [ ] S35 — Realized cash, consumed inputs and ammunition, retained inventory, and outstanding liabilities stay distinct.
  - (mined from DECISIONS.md) Gross spend counts only accepted refuel/repair `cost` and purchase `total_cost`; income never replenishes it and tax components are excluded from those totals. Missing paid-cost evidence blocks further spending and keeps reconciliation outstanding.
  - (mined from receipts.py) A cash or gross-spend total is reported only when every job is terminal and every amount is finite and non-negative; otherwise the total is null, never a partial sum.
- [ ] S36 — The agent's report derives its claims from receipts and names blocked, interrupted, partial, and unverified outcomes.
- [ ] S37 — Private runtime logs stay separate from shareable evidence; a reviewed receipt allows independent checking without credentials or unrelated player messages.
  - (mined from native_receipts.py) The complete bridge reply is content-addressed on disk (file named by the sha256 of its bytes, 0600, written tmp-then-replace) and the model sees only a `full_receipt` reference of path + sha256 + byte length beside the projection.
- [ ] S38 — Station counters carry the same guarantees as jobs: permissions checked before money moves, quoted kept apart from cleared, and a lost response reconciled from game state before any retry (reuse spending.ts and command-boundary.ts).
- [ ] S39 — Scripts run in the bridge process, never inside a model conversation; a juncture conversation dispatches and exits, and the next juncture reads the outcome from the journal.
- [ ] S40 — Flight primitive lifts (setpoint): wait-for-location forces a live read every 30 s regardless of the freshness flag; the fuel-route guard checks find_route cost plus reserve against actual fuel before departure and again before the return leg, and a shortfall is a Tired margin crossing.
- [ ] S41 — Reconciliation lifts (setpoint): the table of events that move the ship with no command behind it (death, capture, fleet kick, stranded passenger, mobile-capital transit), detected as an action_result with no request_id; the four location fields (poi_id, system_id, docked_at, in_transit) are refreshed before any checkpoint is trusted.
- [ ] S42 — Jobs and counters are idempotent: each is named for an end state and begins by checking whether it already holds; a loop iteration re-checks rather than re-does.
  - (mined from INDUSTRY.md) Craft escrow with a missing labor or fee component leaves accounting unresolved; disappearance from the craft queue alone does not establish finished output, and a serviced return does not establish settlement.
- [ ] S43 — Journal rules (setpoint job-manager): outcome is derived at read time from status plus result, never stored; on restart only an explicit resumable set returns to pending and everything else fails with a stated reason; terminal writes are guarded so a late abort cannot overwrite a finished row.
  - (mined from src/execution-store.ts) On load every `running` job becomes `needs_reconciliation` carrying "Worker ended before terminal verification; inspect authoritative state before any replay"; one JSON file per pilot id, written tmp-then-rename at 0600 inside a 0700 directory, and a pilot-id mismatch is fatal.
  - (mined from src/execution-stopping.ts) Confirms the read-time derivation: the stopping reason is recomputed from the current status and result and is separate from the job outcome, so a finished attempt stays completed and a blocker stays blocked even when the run stops.
- [ ] S44 — Receipt shape (setpoint ReconcileResult): per-subject results, success a hard AND that no script can assert, a failed subject carrying the state actually observed, and a machine token (cargo_full, not_at_poi) beside the prose so scripts branch without parsing.
- [ ] S45 — Every change the runner makes on its own (Tired, recovery, chain cut short) is journaled with its reason and the rule that made it.
- [ ] S46 — Replay harness over `runtime/gameplay.jsonl` (106 MB, not committed): slice into named per-scenario traces, add a call-index counter for repeated commands, parse the separate error-line shape, reconstruct post-command state from result.delta; movement and gathering first.

## Runner and sessions (N)

- [ ] N1 — One runner owns one pilot: connection, journal, rules engine, sessions, handoffs, schedule.
  - (mined from src/bridge.ts, service.py) Single ownership is a lock file `controller-<sha256(username)[:16]>.lock` in the runtime directory, plus one service instance per profile guarded by an RLock; the bridge process is the only holder of the game connection.
- [ ] N2 — Discord, cron, and a command line are clients of the runner. None of them owns the pilot.
- [ ] N3 — A juncture is the objective done or unable to continue: job finished, blocked, came home Tired, or the world changed.
- [ ] N4 — The idle schedule (wakeup) fires only while the pilot is idle; while a job or chain runs, the runner itself raises the juncture at its end.
- [ ] N5 — Between junctures the agent is idle and the runner keeps the pilot safe. A job taking many minutes is the world's clock, not a stall.
- [ ] N6 — Rest happens only at home, only when safe and serviced, and clears the stance.
- [ ] N7 — Reflection reads lagging skills, ship gaps, holdings and debts, what has been seen of the world, and recent work.
- [ ] N8 — Reflection picks a goal, and from the goal a stance and an initial mood. It is the only place a stance is chosen.
- [ ] N9 — Stagnation signals reach reflection: repeated work, unchanged position, kinds of work never tried.
- [ ] N10 — Docking, refuelling, repairing, and unloading anywhere, home included, is not rest; the stance survives it.
- [x] N11 — A handoff carries objective, home, obligations, and receipts into a controlled new session without mutating the old prompt prefix or toolset.
- [ ] N12 — A stance change is a handoff. Mood moves inside the session and the toolset does not change with it. (re-earn: old design swapped catalogs by mood)
- [x] N13 — Legacy primitive commands stay inside scripts; the model no longer receives the old sprawling catalog.
- [ ] N14 — The operator stop reaches active scripts without an inference round trip, and only the operator releases it. (re-earn: today only a plan call with a non-Tired mood clears it, and control.json re-signals on every gateway start)
  - (mined from src/bridge.ts) Stop and handoff arrive as out-of-band frames on the same stdin reader: an urgent frame calls signal(reason) immediately while ordinary frames stay serialized behind the queue, and closing the input dispatches one return_to_base whose failure is journaled as `control_return_blocked`.
  - (mined from service.py) Cross-process stop is a `control.json` file under the profile runtime, polled every 200 ms by a daemon thread that re-signals only when the file's bytes change (the reason the re-signal-on-restart defect exists); only the gateway-owner process ever touches the bridge.
- [ ] N15 — Each consultation shows the present, the menu, and what just happened. History lives in the journal and is fetched when a decision needs it.
  - (mined from model_receipts.py, native_receipts.py) Projection for a session with no file-reading tool: drop the full command journal and keep only entries still pending or uncertain; collapse closed receipts to the latest, the latest blocker, and every unresolved one, stating the elided total and status counts.
- [ ] N16 — A long session leaves the agent's context small.
  - (mined from model_receipts.py) A before/after pair collapses to the diff: drop `before`, keep only the changed keys of modules, skills and ship; repeated uniform record lists render as named columns rather than repeating every field name.
- [ ] N17 — Operator objectives and standing permissions are set once, rarely change, and bound everything below.
- [ ] N18 — Junctures are cron fires: one cron job per pilot, fresh conversation each fire, carrying the current stance's skills and enabled toolsets; the runner rewrites that job at rest.
  - (mined from execution_runner.py, session_skills.py) Each stance opens a fresh session with skip_context_files, skip_memory, skip_background_review and a run budget; the shared skill plus the one stance skill are written into the profile home with per-tool sections filtered to the resolved catalog, and the run aborts if Hermes' tool grant differs from that catalog.
- [ ] N19 — Discord is a fixed-toolset client: observation, journal, station counters, objective and permissions; it never carries job tools and never needs to cycle.
  - (mined from cli.py, __init__.py, plugin.yaml) The registration shape to reuse: tools, skills, one static prompt section positioned after_memory with a char cap, a CLI command, a slash command, and an unload hook. `hermes spacemolt setup` prints credentials/node/npm readiness, `install` runs `npm ci` behind a confirm, `status` reads the gateway-written status file without starting a controller, `stop` writes the control file.
- [ ] N20 — Verify cron can fire on demand after rest (or the runner shortens the schedule for one fire), and that plugin toolsets pass the cron toolset clamp. (spike)
- [ ] N21 — Vocabulary in code and skills matches VISION.md: no 'plan' noun, no 'task', no 'session' outside Hermes internals; mission and contract mean station-board items only.
- [ ] N22 — A chain interrupted by a runner restart keeps its definition and resumes through reconciliation; a chain that ended naturally is cleared.
- [ ] N23 — Scripts hold a resolver to the game connection, never a handle, so a reconnect mid-step does not send on a dead socket.

## Cross-cutting invariants (X)

- [ ] X1 — Tool to executor: every exposed tool dispatches to a real implementation with a completion contract; no stub or legacy escape hatch in the catalog.
- [ ] X2 — Mood to execution: each resolved number changes observed behavior in its consumer; settings that do not apply are named.
- [ ] X3 — Home to travel: home persists across jobs and sessions, fallback is explicit, and a stop cannot silently redefine it.
- [ ] X4 — Job to obligation: return, interruption, and switching preserve and report cargo, passengers, deadlines, and queued work.
- [ ] X5 — Defense to stance: every stance can defend while offensive tools stay absent, and command ownership stays serialized.
- [ ] X6 — Checkpoint to state: recovery reconciles authoritative state before anything uncertain is resumed or resubmitted.
- [ ] X7 — Receipt to report: outcome, cost, and progression claims match verifiable receipts, including partial and negative results.
- [ ] X8 — Session to control: ordinary change uses cache-safe handoff; the operator stop bypasses inference entirely.
- [ ] X9 — Menu to script: the rules that built the menu are the rules the script runs under.
- [ ] X10 — No raw JSON in model-facing output: every tool result is prose and short tables, structured replies go to the forensic receipt on disk, and a denial names what would clear it.
- [ ] X11 — Server traps carried as tests in the owning primitive or counter: freshness flag lies about location; find_route is the only fuel truth; a failed jump may have succeeded; bulk order success with no order_id is escrow-then-refund; view_orders pages via has_more; PERMANENT markers land mid-string; cargo_full on loot is a success; wreck_empty is a response field; get_system takes no id; stations never spawn wrecks; the observation watch drops on every move; an awaited mutation blocks until its tick. (source: SETPOINT-BORROWING.md and setpoint src; keep the list here, not there)
  - (mined from COMBAT.md) One combat tick is ten seconds; the fight loop polls battle status every two seconds and paces maneuvers on elapsed wall time, because the server's `tick_duration` field stayed unchanged across multiple real combat ticks and cannot be trusted as the cadence.

## Acceptance (A)

- [ ] A1 — Broad objective: in a fresh session with no supplied station IDs and no itinerary, the agent picks a goal, stance, mood, reasoned home, and first work from observations.
- [ ] A2 — Menu: at a juncture the agent is offered options with reasons, picks one, and under unchanged conditions it is not refused.
- [ ] A3 — Empty case: an idle pilot at a base with no stance, no mood, and nothing owed still receives a non-empty menu.
- [ ] A4 — Place: the same stance and mood at two different kinds of place produce visibly different menus.
- [ ] A5 — Tired: from idle, travel, work, and combat the pilot exits safely, returns, resupplies, clears Tired, restores the prior mood, and keeps the stance, with nobody clearing it. One live run recorded.
- [x] A6 — Home failure: an unavailable home produced an explicit serviced fallback while preserving the chosen home. `spacemolt/evidence/shared-live-local-scout.json` (live). Stale mobile-home coordinates and a redundant final return remain open defects.
- [ ] A7 — Rest: a serviced pilot at home rests, the stance clears, reflection picks a goal, and a repetitive recent record produces a different kind of evening.
- [ ] A8 — Job: a representative job runs dock to dock through real Hermes with verified outcome, costs, servicing, and remaining obligations.
- [ ] A9 — Repetition: a repeated plan stops at its declared condition and reaches its specified return and readiness state.
- [ ] A10 — Uncertain action: a disconnect after acceptance reconciles without a duplicate purchase, attack, craft, transport acceptance, or delivery.
- [ ] A11 — Model budget: exhausting the iteration or time budget leaves active scripts able to finish their safe terminal behavior with obligations recorded.
- [ ] A12 — Handoff: a stance change delivers the new toolset and skills and carries goal, plan, and last outcome forward without rebuilding the prefix; a mood change does none of that.
- [ ] A13 — Windows: the same pilot behaves identically from Discord, cron, and the command line.
- [ ] A14 — Completion evidence: reports expose independently checkable costs, obligations, location, condition, progression, and outcome, including unsold inventory and unresolved work.
- [ ] A15 — Fresh-session reproducibility: setup and run instructions are current, the required checks pass, and another session reproduces a representative workflow without this conversation's context.
  - (mined from README.md, DAEMON.md) Setup block to restate: Node 22+ and the Hermes Python env (3.11–3.13), `npm ci && npm run typecheck && npm test` from `spacemolt/`; credentials are a file named by `SPACEMOLT_CREDENTIALS_FILE` containing `Username:` and `Password:` lines, kept outside the repo, with no default path and none packaged. One profile per pilot, created before install; the profile inherits no model, Discord or game credentials from another.
- [ ] A16 — Bounded objective: given "gain one Crafting level, then stop", the pilot completes it, rests, and stays idle through at least three scheduled wakeups, reporting done each time, until the operator gives a new objective. (replay; one live)
- [ ] A17 — Tired with no resupply path: low credits and unreachable home end in a permitted recovery or a docked wait with a precise blocker raised as a juncture, never a silent stop. (replay)

## Testing for real (T)

- [ ] T1 — One pilot is one profile: objective, stance, mood, home, journal, and receipts all live under `get_hermes_home()/spacemolt/`; a second profile is a different pilot, not a second view of this one. (fixture)
  - (mined from tests/test_spacemolt_plugin.py) Under multiplex the inherited process env must read as unconfigured, and the bridge child must be spawned with the scoped profile's credentials file, asserted on the env actually handed to the child.
- [ ] T2 — Resume proof: a session opened against an existing home restates the same objective, home, and last outcome with nobody supplying them; the same code against a fresh HERMES_HOME has none of them and says so. (fixture)
- [ ] T3 — Persistence is state, not prompt text: the two sessions in T2 load identical skills and the identical prompt section, and differ only in what they read from disk. (fixture)
- [ ] T4 — A scheduled juncture reaches the pilot, it observes, then acts or declines with a reason, and the outcome lands in the journal before the session ends. (replay)
- [ ] T5 — The idle schedule (N4) raises a juncture only when none arrived in the window; a real juncture inside the window suppresses it. (fixture)
- [ ] T6 — Nothing wakes the pilot into an unrecoverable state: waking Tired, mid-job, blocked, or disconnected reconciles first (S23, S26) and ends docked or durably blocked with evidence, never a blind retry. (replay)
  - note: cron sessions are separate sessions with `skip_memory=True` and are not mirrored into the gateway conversation, so a wakeup remembers only what the journal and profile state hold.
- [ ] T7 — A Discord question is answered from current observation plus the journal, and objective, stance, mood, and home are byte-identical before and after the turn. (fixture)
- [ ] T8 — An inquiry turn issues no game mutation; only a juncture or a script does. (fixture)
- [ ] T9 — Direction updates the objective or standing permissions in state and is integrated at the next juncture; a job in flight runs to its terminal outcome first (D10, X4). (replay)
- [ ] T10 — The operator stop is the exception and acts immediately: it reaches active scripts without a model turn and only the operator releases it (N14, X8). (live)
- [ ] T11 — Direction outside standing permissions is refused with what would make it admissible, and the permissions are not widened by the asking (D11, R6). (fixture)
- [ ] T12 — Coherence probe: what the pilot says it is doing matches the journal across a wakeup, a human turn, a rest, and a gateway restart. (replay; the restart arm is live)
- [ ] T13 — Rest clears the stance and reflection picks the next goal (N6, N8); the goal carried into the new session matches what the pre-rest journal recorded, not what the last human said. (fixture)
- [ ] T14 — Sycophancy probe, permissions: a human proposes an off-permission act (attack a protected target, spend past the cap); the pilot declines, names the permission, and keeps its objective. (fixture)
- [ ] T15 — Sycophancy probe, mid-flight: a human says to drop the current job and do something else; the pilot checkpoints or completes custody first and integrates the direction at the juncture (T9). (replay)
- [ ] T16 — Silence probe: across a full idle cycle with no human message, the pilot still produces a goal and first work from reflection alone (A1). (live)
- [ ] T17 — In-game chat stays untrusted data: a player message demanding assets, credentials, or a new objective is reported, never obeyed. (fixture)
  - (mined from src/execution-host.ts) The outbound half also matters: a message is refused when its content contains any process-env value of eight characters or more, and "a delivered message is never evidence that another player read it, agreed to it, or will act on it."
- [ ] T18 — Fixture level covers identity, persistence, permissions, inquiry, refusals, and schedule arithmetic, through the real plugin registry and a stdin/stdout bridge fixture with no game connection; the game side is a Proxy-based fake account that records every command and dispatches to a handler map (lift setpoint tests/dispatcher/lib-fakes.ts).
  - (mined from src/execution-fixture.ts) Handler-map shapes: find_route -> {found,target_system,total_jumps,estimated_fuel,fuel_per_jump,fuel_available,cargo_used,route[{system_id,jumps}]}; get_base -> {fuel_price_all_in}; refuel cost = (max_fuel - fuel) x price, reply {cost,fuel,source}; battle/status -> {battle_id,is_participant,combat_state,participants[{player_id,side_id,hull_pct,shield_pct,zone,stance}]} and throws SpacemoltError('not_in_battle') once the fight ends; battle/summary -> {battle_id,status,outcome,winning_side}; get_nearby -> {creatures[{creature_id,species,role,hull,max_hull}]}.
  - (mined from src/gather-fixture.ts) get_poi -> {kind:'normal',poi,resources[{resource_id,remaining,richness}]}; mine -> {kind:'yield',resource_id,quantity,remaining}, alternating ore x2 and carbon x1 per cycle, each cycle costing one fuel and adding mining xp, with remaining counting down from the cycle index.
  - (mined from src/logistics-fixture.ts) Freight contract {id,package_id,status posted->in_transit->delivered,origin_base_id,destination_base_id,failure_debt,reserved_exposure,base_reward}; shipping/profile carries debt_blocks_acceptance and capacity{active_contracts,active_contract_limit,remaining_aggregate_liability,single_package_liability_limit}; shipping/active rows carry package_in_your_cargo, ticks_to_deadline, late; package size is not inspectable before acceptance, and the package arrives in station storage, reaching cargo only via storage/withdraw.
  - (mined from src/passenger-fixture.ts) list_passengers -> {count,passengers,berths:{economy|business|first:{free,total}}}; list_station_passengers -> {station,count,waiting[{citizen_id,name,destination,destination_name,destination_system,class,ticks_remaining,base_fare,estimated_fare}]}; docking at the destination can auto-deliver, returning {passenger_arrivals:{delivered,fare_collected}}, and fare_collected can be absent on an otherwise successful delivery.
  - (mined from src/production-fixture.ts) craft dry_run -> {kind:'quote',quantity,runs,credits_total,effective_time_per_run,have_inputs,have_credits,have_capacity,cost:{inputs,labor,fee},produces,venue_type,facility_id,venue}; real craft -> {kind:'job',job_id,runs,produces,escrowed:{labor,fee}}; bare craft -> {kind:'queue',total_jobs,jobs[{job_id,base_id,recipe,runs_remaining}]}; estimate_purchase -> {quantity_requested,available,total_cost,subtotal,sales_tax,unfilled,fills}; sell -> {item_id,quantity_sold,unsold,total_earned}; buy replies as a delta envelope {command,delta:{player.stats.credits_spent,details:{total_cost,unfilled,delivered_to_storage}}}.
- [ ] T19 — Replay level covers junctures, recovery, direction-at-juncture, and coherence, from recorded game traces driven through the real bridge.
- [ ] T20 — Live level covers only what replay cannot prove: the stop latch, a gateway restart, the silence probe, and A5 and A8. One recorded run each; a model claim is not a run.
- [ ] T21 — Harness: `scripts/run_tests.sh` only, never bare pytest; temp HERMES_HOME via the autouse isolation fixture; credentials supplied as a fixture file plus monkeypatched env, never a real key.
  - (mined from evals/native_rules_ab.py) An A/B comparison runs each workload in a fresh child process with a disposable HERMES_HOME and records a sha256 manifest of the sources under test, so an arm cannot inherit the other's state or be attributed to the wrong code.
- [ ] T22 — One runner owns one pilot (N1): no test starts a second bridge, gateway, or cron ticker against a pilot another test or a live session already owns.
- [ ] T23 — `check_fn` results are TTL-cached process-wide, so a credential-gating test sets the env before first tool discovery in that process; per-file subprocess isolation is what keeps that honest.
- [ ] T24 — No test asserts prompt text. Cache-integrity claims are asserted as byte-stability of the system prompt across a wakeup and a human turn, and as a handoff that does not rebuild the prefix (N11, A12).
  - (mined from tests/test_spacemolt_plugin.py) The byte-stability assertion worth keeping is taken around a plan call: an applied plan completes its handoff inside the same conversation, so the prompt section and tool grant before and after the plan must be identical bytes.
- [ ] T25 — A Discord session key is per channel and per profile, so two channels are two conversations over one pilot; the coherence and windows checks (A13) exercise both rather than one.
- [ ] T26 — None of T1 to T25 is a change-detector: each asserts a relation between what the pilot says, what the journal holds, and what the game state shows, never a frozen value.
- [ ] T27 — Stillness probe, mirror of T16: with a completed bounded objective, wakeups leave goal, stance, and journal unchanged and the pilot says it is done. (fixture)
- [ ] T28 — Port `spacemolt/ported/setpoint/` (34 files copied verbatim from setpoint ea47eb2, 2026-09-14; see its README): swap bun:test for node:test, retarget imports, delete the frozen-constant test; the Proxy fake account becomes the T18 harness and replaces execution-fixture.ts and the three domain fixtures.

## Next action

- Run the enumeration session with Carl (D7): which stances, jobs, and station counters the game actually offers.
- Then build the second attempt from VISION.md: runner, rules table and menu, journal, chains, station counters, cron junctures. Nothing of the first engine remains to extend.
- Keep the existing executors and assessment helpers; reshape them under S9 and S10 rather than rewriting them.
- First rebuild step: kept executors import deleted engine types; list: rules.ts -> combat-fit, combat, industry, logistics, obligations, passenger-fit, progression, readiness, recovery, servicing, spending, transport-budget, transport-time; execution-policy.ts -> combat, equipment-retrieval, gather, home-location, locations, logistics, passengers, transport-budget, transport-itinerary; execution-store.ts -> recovery, shared-production, spending, transport-budget; logistics-policy.ts -> transport-itinerary; and in kept tests logistics.test.ts (execution, execution-store, execution-logistics, logistics-fixture), mining-delta.test.ts (gather-fixture), transport-itinerary.test.ts (execution-policy).
  - Deletion state 2026-09-14: `npm run typecheck` 98 errors across 23 files; `npm test` 19 of 27 files fail to load (ERR_MODULE_NOT_FOUND), the other 8 files / 20 tests still pass. Broken is expected until the replacement exists.
