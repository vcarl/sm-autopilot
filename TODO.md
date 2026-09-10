# SpaceMolt project completion checklist

This is the working checklist for [VISION.md](VISION.md), which preserves the planning discussion verbatim. D1–D10 and S1–S18 below refer to the same IDs in the vision. Update this checklist as work is completed; do not silently rewrite the preserved vision to describe implementation progress.

## Using this checklist

- Mark a condition complete only when its observable result exists. A stub, proposed design, successful tool submission, or model claim is not completion.
- Add an evidence reference beside each completed major item: implementation path, recorded decision, relevant test command/result, or reviewed live receipt. Distinguish unit tests, integration tests, replays, and live runs.
- Complete a parent checkbox only when its children are complete. Reopen a condition if later evidence invalidates it.
- Record concrete blockers and the next useful step beside unfinished items. A blocker is not a completed item.
- Read the repository and relevant area `AGENTS.md` before implementation. Reuse the library and existing workflows; these work items are behavior boundaries, not a mandate for eighteen new modules or a core-framework rewrite.
- Preserve existing work. The initial handoff contains uncommitted gameplay scripts and evidence; inspect the working tree before editing or committing.

## Starting point for a fresh session

The agreed starting vocabulary is seven stances (Combat, Hunt, Industry, Trade, Logistics, Explore, Salvage) and six moods (Relaxed, Cautious, Focused, Opportunistic, Aggressive, Tired). Mining belongs to Industry. Logistics includes passengers as well as freight. The agent chooses home; it is not a station ID the user must supply. Tired means return and resupply regardless of stance.

At handoff these systems were unimplemented. The first shared/Hunt slice is now integrated and tested offline; see the dated implementation record below. Existing live evidence remains historical. Parent milestones stay open where fallback, recovery, universal defense or live acceptance is incomplete.

| Existing foundation | Start reading here | Current boundary |
|---|---|---|
| Hermes runner and bridge | [runner.py](spacemolt/runner.py), [bridge.ts](spacemolt/src/bridge.ts), [policy.ts](spacemolt/src/policy.ts) | General/Industry/Combat modes and many tools; no full stance/mood system |
| Combat and preparation | [combat.ts](spacemolt/src/combat.ts), [combat-fit.ts](spacemolt/src/combat-fit.ts), [combat guide](spacemolt/COMBAT.md) | Working hunting sorties; servicing/recovery still incomplete as shared contracts |
| Generic threat assessment | [threat-assessment.ts](spacemolt/src/threat-assessment.ts), [combat-assessment.ts](spacemolt/src/combat-assessment.ts) | Generic encounter evaluator; reviewed wildlife intelligence covers the observed Phase-Lurker/loadout combination |
| Industry and gathering | [industry.ts](spacemolt/src/industry.ts), [mining-experiment.ts](spacemolt/src/mining-experiment.ts), [industry guide](spacemolt/INDUSTRY.md) | Existing bounded experiments and settlement; not yet consolidated under the new job policy |
| Locations and travel | [locations.ts](spacemolt/src/locations.ts), [survey.ts](spacemolt/src/survey.ts) | Reusable route and station discovery; no agent-selected persistent home workflow |
| Action uncertainty and receipts | [command-boundary.ts](spacemolt/src/command-boundary.ts), [execute.ts](spacemolt/src/execute.ts), [progression.ts](spacemolt/src/progression.ts) | Stops after uncertain actions and records measured changes; does not autonomously recover every job |
| Prior live evidence | [freight progress](spacemolt/evidence/PROGRESS.md), [combat proof](spacemolt/evidence/combat-proof.json), [training](spacemolt/evidence/combat-training.json), [assessment replay](spacemolt/evidence/threat-assessment.json) | Historical proofs, not current state or acceptance of the redesigned system |

At handoff, TypeScript typechecking, 47 Node tests, and five runner Python tests passed. The new threat assessment was tested with replay and a live read-only bridge call, not a new live fight. The preceding five fights used the earlier controller: two victories, three stalemates, and no hull loss. A laptop-sleep disconnect required manual reconciliation. Do not extrapolate those results to unattended recovery or other target classes.

Suggested order: resolve decisions and shared foundations first; then Hunt, Industry, and Logistics; then the remaining stances and final acceptance. Shared receipts, skill integration, and tests should be developed alongside their consumers rather than deferred until the end.

## Decisions — D1–D10

Record the resolution and its rationale beside each item or link a decision document. The selected vocabulary above is the starting agreement; remaining work is to define its contracts and edge cases.

Decisions are recorded in [DECISIONS.md](spacemolt/DECISIONS.md). D7 has a working numerical Hunt policy; opportunity-switching economics and other stance consumers remain deferred. Documented contracts below do not imply implementation of every stance.

- [x] **D1 — Stance boundaries are documented.** Each of the seven stances has distinct entry criteria, supported jobs, exposed tools, and rules for handing work to another stance; mining is under Industry and passengers under Logistics.
- [x] **D2 — Mood semantics are documented.** All six moods map to explicit policy dimensions, including which dimensions remain unchanged; Tired has defined precedence over productive work.
- [x] **D3 — Transition authority is documented.** User instructions, agent choices, and script suspensions have an unambiguous precedence order, with examples of permitted and rejected transitions.
- [x] **D4 — Home semantics are documented.** Selection criteria, persisted identity, reconsideration triggers, temporary service stops, and unreachable-home fallbacks are distinct; choosing home does not require user-supplied IDs.
- [x] **D5 — Job contracts are defined.** Every job declares preconditions, outputs, obligations, cleanup responsibilities, and terminal outcomes such as completed, blocked, interrupted, or returned-to-base.
- [x] **D6 — Agent/script discretion is defined.** Mechanical adaptations scripts may make are distinguished from changes of objective requiring an agent decision; specific examples exist for each stance.
- [ ] **D7 — Initial numerical policy is specified.** Evidence requirements, reserves, pursuit, retries, diversion costs, and exit conditions have units, defaults, override bounds, and a rationale. Applicable consumers are identified.
- [x] **D8 — Initiation permissions are specified.** Permitted activities and target classes are independent of mood; changing to Aggressive cannot grant additional authority.
- [x] **D9 — Interruption contracts are specified.** Idle, traveling, working, and fighting states each define their response to Tired, stop, timeout, disconnection, and session handoff, including unfinished obligations.
- [x] **D10 — Success metrics are specified.** Each job has authoritative measures for its objective, costs, progression, output, and remaining liabilities; model prose cannot establish completion.

## Shared foundations — S1–S10

- [ ] **S1 — Execution-context and policy resolver is integrated.** Depends on D1–D3 and D5–D9.
  - [ ] A validated context carries stance, mood, objective, home, limits, permissions, obligations, intelligence, stop condition, return policy, job/checkpoint identity, and policy version.
  - [ ] Defaults and bounded overrides resolve through one implementation; invalid or conflicting inputs produce actionable errors before game mutations.
  - [ ] Executable policy covers initiative, evidence, reserves, pursuit, attention, and exit behavior. Tests demonstrate relevant behavioral differences rather than only checking enum names.
  - [x] Tired prevents admission of productive work across every stance, including calls made through an older session's still-visible tool schema.

- [ ] **S2 — Toolset resolution and session handoff work through Hermes.** Depends on S1.
  - [ ] Sessions expose `observe`, `assess`, `prepare`, and `travel`, plus only the stance/mood-appropriate job tools. Tired resolves to observation, return-to-base, and relevant skill access.
  - [x] Legacy primitive commands remain internal to scripts where needed; the model no longer receives the old sprawling catalog alongside the new interface.
  - [x] Normal transitions preserve the objective, home, obligations, and receipts in a controlled new session without mutating the old prompt prefix or toolset.
  - [x] Urgent execution controls reach active scripts independently of inference and prompt rebuilding; real-path integration tests exercise this distinction.

- [ ] **S3 — Unified observation and assessment are usable across stances.** Depends on S1 and D10.
  - [ ] `observe` provides current state, inventory, contacts, locations, obligations, and relevant history through a coherent interface, with freshness and source information where needed.
  - [ ] `assess` dispatches to threat, economic, route, capacity, and opportunity evaluation as appropriate and returns consistent decisions, reasons, evidence, and blockers.
  - [ ] Aggregate threat assessment distinguishes targets, plausible participants, and bystanders; insufficient intelligence is not converted into a favorable estimate.
  - [ ] Tests cover changed observations and expired or inapplicable intelligence; a model assertion cannot silently become trusted capability data.

- [ ] **S4 — Preparation and servicing guarantee a verified result.** Depends on S1, S3, and D5.
  - [ ] `prepare` composes existing fitting, ammunition, fuel, repair, shield recovery, and cargo staging capabilities without duplicating them.
  - [ ] Purchases and inventory changes respect resolved budgets, equipment permissions, existing assets, and obligations.
  - [ ] Success means the declared readiness conditions are verified; unavailable supplies or services produce a precise blocker rather than a false ready state.
  - [ ] Job cleanup uses this implementation so refueling and required servicing no longer rely on a subsequent model reminder.

- [ ] **S5 — Shared travel reaches and verifies its destination.** Depends on S1, S3, and D9.
  - [ ] Route selection and movement account for cargo, fuel, destination access, hazards, and return/fallback requirements.
  - [ ] Arrival and docking are verified against authoritative state; a pending or ambiguous movement is never blindly replayed.
  - [ ] Tired, new danger, and destination unavailability are handled at documented execution checkpoints without confusing transit with arrival.

- [ ] **S6 — Agents choose and persist home.** Depends on D4, S3, and S5.
  - [ ] A broad objective prompts the agent to consider home and compare observed locations using access, services, storage, activity, and travel costs.
  - [x] The selected home and rationale persist across sessions for the pilot and are available to job planning without a user-supplied station ID.
  - [x] Reconsideration updates home deliberately; a temporary resupply stop or travel fallback does not overwrite it.
  - [x] No suitable observed home produces an explicit discovery or temporary-return plan, not an invented destination or an unexplained halt.

- [ ] **S7 — Return-and-resupply implements Tired across stances.** Depends on S4–S6, S8, and D9.
  - [ ] `return_to_base` stops productive admission, resolves immediate danger, selects home or a documented service fallback, travels, services, and stops.
  - [ ] Tired during idle, travel, work, and combat reaches each state's specified safe exit without waiting for another model turn.
  - [ ] Pending production, passengers, cargo contracts, and deadlines remain recorded and are not silently abandoned, sold, canceled, or reported complete.
  - [x] The terminal receipt verifies location and readiness or explicitly identifies the remaining service/return blocker; it does not automatically restart productive work.

- [ ] **S8 — Jobs have a shared durable lifecycle.** Depends on D5, D6, and D9; develop alongside S7 and S18.
  - [ ] Every admitted job has an identity, resolved policy, preconditions, execution progress, relevant obligations, and an explicit terminal outcome.
  - [x] Checkpoints survive process restart and distinguish pending, confirmed, and uncertain actions without losing the connection to their receipts.
  - [x] Game-command serialization prevents job work and defense from issuing conflicting mutations for the same pilot.
  - [x] Model iteration/time exhaustion does not interrupt required script cleanup; a worker/process interruption leaves enough state for reconciliation rather than an invented success.

- [ ] **S9 — Reconnect and reconciliation recover actual jobs.** Depends on S8 and S18.
  - [x] Reconnection queries authoritative location, transit, battle, inventory, production, and obligations as relevant before resuming work.
  - [ ] An accepted action whose response was lost is recognized without a duplicate purchase, attack, craft, transport acceptance, or delivery.
  - [ ] Active combat is reconciled and handed to defensive/tactical control; completed combat is resolved from authoritative outcomes.
  - [x] Unresolvable uncertainty produces a durable blocked state with evidence and a next step, rather than a blind retry or silent loss of the job.

- [ ] **S10 — Defense operates beneath every stance.** Depends on S1, S3, S8, and S9.
  - [ ] Actual attacks trigger scripted assessment and fight/escape handling during noncombat work without model inference or an exposed offensive tool.
  - [ ] Relaxed never initiates hostilities; Tired defense aims to reach a safe return path; neither bypasses permissions or resource limits.
  - [ ] Defensive control coordinates with the active job, preserving or checkpointing its obligations before resumption or return.
  - [x] Tests exercise danger during noncombat activity and verify that the job and defender do not race or duplicate commands. See the 2026-09-10 event-defense increment (offline).

## Stance jobs and repeated work — S11–S18

Each job must use the shared context, lifecycle, defense, receipts, and relevant travel/preparation components. Completing a historical workflow alone does not satisfy its new contract.

- [ ] **S11 — Combat and Hunt jobs implement their stance contracts.** Depends on S1–S10 and the Combat/Hunt skills.
  - [ ] `guard` and permission-gated `engage` support documented defensive/combat objectives; relaxed sessions cannot submit a first strike through either path.
  - [ ] `track` discovers assessable quarry from observations; `hunt` selects fresh targets, assesses the encounter, executes tactics, verifies results, handles loot, returns, and services.
  - [ ] Mood affects the relevant evidence, pursuit, resource, and exit policy without adding speculative target intelligence or changing authorization.
  - [ ] Combat and Hunt each have a representative real-Hermes job receipt under the new interface; training XP, escapes, victories, and costs are distinguished.

- [ ] **S12 — Industry includes gathering and complete production.** Depends on shared foundations and the Industry skill.
  - [ ] `gather` handles assessed resource collection, preserving starting assets and verifying yield, storage/sale policy, return, and servicing.
  - [ ] `produce` handles input sourcing/staging, quotes, craft submission, pending output, settlement, and explicit unsold inventory or remaining obligations.
  - [ ] Focused ignores unrelated opportunities; Opportunistic diversions include switching costs and pending work; Tired starts no new extraction or production.
  - [ ] Representative real-Hermes gathering and production jobs each finish with verified outputs, costs, servicing, and obligations under the new contract.

- [ ] **S13 — Trade executes bounded opportunities to a verified outcome.** Depends on shared foundations and the Trade skill.
  - [ ] `trade` assesses finite market depth, taxes, travel, inventory exposure, and opportunity cost before committing funds.
  - [ ] Execution verifies purchases, any transport, sales, partial fills, retained inventory, and cleanup without claiming inventory value as realized profit.
  - [ ] Mood-dependent switching and exposure are enforced; a representative real-Hermes trading job records its result and remaining exposure.

- [ ] **S14 — Logistics supports freight and passengers.** Depends on shared foundations and the Logistics skill.
  - [ ] `transport` evaluates both cargo contracts and passenger jobs with appropriate capacity, admission, route, deadline, and budget checks based on current game contracts.
  - [ ] Acceptance, loading/boarding, travel, unloading/disembarkation, and delivery/payment are verified; incomplete obligations remain visible across interruption and restart.
  - [ ] Tired and route changes preserve passengers/cargo and report deadlines and unresolved commitments instead of silently abandoning them.
  - [ ] Separate real-Hermes freight and passenger jobs complete under the new interface with verified delivery, costs, return/service outcome, and final obligations.

- [ ] **S15 — Explore produces useful, persisted discoveries.** Depends on shared foundations and the Explore skill.
  - [ ] `survey` accepts a discovery objective, selects reachable observations, records coverage, and distinguishes observed facts from untested opportunity hypotheses.
  - [ ] Policy bounds detours, repeated observations, and travel; new information can support home selection without automatically changing home.
  - [ ] A representative real-Hermes survey returns or stops according to its contract and records discoveries, coverage, travel cost, and final state.

- [ ] **S16 — Salvage is an independent complete job.** Depends on shared foundations and the Salvage skill.
  - [ ] `salvage` assesses wreck suitability, permitted recovery, nearby threats, cargo capacity, and costs without requiring a preceding hunt.
  - [ ] Recovery verifies item provenance and quantities, handles changing availability, and returns/services without booking unsold recovery as cash profit.
  - [ ] A representative real-Hermes salvage job records the recovery, final cargo, costs, and terminal condition.

- [ ] **S17 — Repetition is bounded by executable stopping conditions.** Depends on S8, S18, and at least one completed stance executor.
  - [ ] A plan can repeat work until a verified objective, budget, Tired signal, or explicit stopping condition is reached without asking the model to reconstruct every mechanical cycle.
  - [ ] Each iteration reassesses relevant state and completes required servicing/settlement; blockers and changed obligations prevent inappropriate repetition.
  - [ ] Reaching a skill, delivery, production, or discovery threshold ends the loop from authoritative receipts; an inconclusive outcome is not counted as success.
  - [ ] A repeated real-Hermes plan stops at its declared condition and reaches its specified return/readiness state.

- [ ] **S18 — Receipts explain results across all stances.** Depends on D10; build with S8 and each executor.
  - [ ] Receipts connect objective, stance, mood, policy version, home, job ID, decisions, action outcomes, costs, progression, and obligations.
  - [ ] Realized cash, consumed inputs/ammunition, retained inventory, and outstanding fuel/repair/settlement liabilities remain distinct.
  - [ ] The agent's completion report derives claims from receipts and identifies blocked, interrupted, partial, or unverified outcomes.
  - [ ] Private runtime logs remain separate from reviewed shareable evidence; a reviewed receipt permits independent checking without exposing credentials or unrelated player messages.

## Skills and agent use — K0–K8

Every stance skill must cover the seven common sections in VISION.md: selection, observations, assessment, tool contracts, mood effects, outcomes/interruptions, and reconsidering home/stance/objective. Skill authoring is future implementation work; use the applicable skill instructions when creating them.

- [x] **K0 — Shared SpaceMolt operations skill is installed and loadable.** It explains the common tools, authoritative state, choosing home, transitions, obligations, receipts, and Tired; its procedure agrees with executable policy.
- [ ] **K1 — Combat skill is installed and loadable.** It teaches guard versus engage, defensive objectives, threat assessment, and escalation/withdrawal interpretation.
- [x] **K2 — Hunt skill is installed and loadable.** It teaches tracking, intelligence limits, quarry selection, training/harvesting goals, and escaped-target outcomes.
- [ ] **K3 — Industry skill is installed and loadable.** It treats gathering and production together, including mine-versus-buy decisions, input allocation, pending work, and settlement.
- [ ] **K4 — Trade skill is installed and loadable.** It teaches opportunity comparison, market depth, inventory exposure, switching costs, and realized accounting.
- [ ] **K5 — Logistics skill is installed and loadable.** It covers both freight and passengers, capacity/admission, routes, deadlines, and verified delivery.
- [ ] **K6 — Explore skill is installed and loadable.** It teaches discovery objectives, coverage, information value, and observations relevant to home selection.
- [ ] **K7 — Salvage skill is installed and loadable.** It teaches suitability, recovery limits, threats, capacity, and aftermath.
- [ ] **K8 — Skills influence the real agent path correctly.**
  - [x] The shared and selected stance skills load at session creation through the chosen Hermes integration; optional references use native skill reading where exposed.
  - [x] No session receives guidance to call unavailable tools; mood-dependent guidance matches the actual resolved catalog and policy.
  - [x] Mood definitions and executable thresholds have one authoritative configuration rather than forty-two independently maintained skill variants.
  - [ ] Real Hermes sessions select and interpret jobs using the skills without operator-supplied individual game commands; scripts still enforce critical steps when the model omits them.

## Cross-system invariants — X1–X9

- [ ] **X1 — Skill ↔ catalog:** Real skill/tool resolution agrees for supported stance/mood combinations; no dangling tool instructions are delivered.
- [ ] **X2 — Tool ↔ executor:** Every exposed tool dispatches to a concrete implementation with a completion contract; no stub or legacy escape hatch remains in the model catalog.
- [ ] **X3 — Mood ↔ execution:** Each relevant resolved setting changes observed behavior in its consumer; non-applicable settings are explicitly identified.
- [ ] **X4 — Home ↔ travel:** Home persists across jobs/sessions, fallback is explicit, and temporary stops cannot silently redefine home.
- [ ] **X5 — Job ↔ obligation:** Return, interruption, and switching preserve and report cargo/passengers, deadlines, and queued work.
- [ ] **X6 — Defense ↔ stance:** Every stance can defend while offensive tools are absent; command ownership remains serialized.
- [ ] **X7 — Checkpoint ↔ state:** Recovery reconciles authoritative state before any uncertain action can be resumed or resubmitted.
- [ ] **X8 — Receipt ↔ report:** Outcome, cost, and progression claims match verifiable receipts, including partial and negative results.
- [ ] **X9 — Session ↔ control:** Ordinary changes use cache-safe handoff while urgent signals affect active execution without an inference round trip.

## Final acceptance — A1–A16

These are project-level demonstrations under the new interface, not substitutes for per-system validation. Policy resolution should cover the supported combinations; forty-two separate live runs are not required. Targeted failure/interruption tests may use controlled fixtures, but record the validation level accurately and use real imports/dispatch paths where required.

- [ ] **A1 — Broad objective:** In a fresh session without supplied station IDs or a command-by-command itinerary, the agent selects stance, mood, a reasoned home, and a work location from observations.
- [ ] **A2 — Combat:** A representative guarding/engagement job completes through real Hermes and produces a verified terminal receipt.
- [ ] **A3 — Hunt:** A representative hunting job completes through real Hermes, including assessment, outcome verification, return, and servicing.
- [ ] **A4 — Industry:** Both gathering and production complete through real Hermes, with verified yield/output, settlement, servicing, and obligations.
- [ ] **A5 — Trade:** A representative trading job completes through real Hermes with independently verifiable financial and inventory results.
- [ ] **A6 — Logistics:** Both freight and passenger jobs complete through real Hermes with verified delivery and final obligations.
- [ ] **A7 — Explore:** A representative discovery job completes through real Hermes with useful observations and verified final state.
- [ ] **A8 — Salvage:** A representative independent recovery job completes through real Hermes with verified recovered items and cleanup.
- [ ] **A9 — Mood behavior:** Relaxed combat does not shoot first but defends; Focused industry ignores unrelated opportunities; Aggressive hunt increases initiative without bypassing assessment. Cautious and Opportunistic have behavioral evidence for their distinct margins and switching rules.
- [ ] **A10 — Tired:** Tests from idle, travel, productive work, and combat show no new productive admissions and the documented safe exit, return, resupply, and stop. A representative real-Hermes Tired return is recorded.
- [ ] **A11 — Home failure:** Unavailable or unreachable home produces an explicit fallback and verified return outcome without silently losing the agent's home choice.
- [ ] **A12 — Uncertain action:** Disconnect scenarios after acceptance demonstrate reconciliation without duplicated purchases, attacks, crafts, transport obligations, or deliveries.
- [ ] **A13 — Model budget:** Exhausting the model's iteration/time budget leaves active scripts able to complete their defined safe terminal behavior; obligations remain recorded.
- [ ] **A14 — Handoff:** Stance and mood transitions preserve the objective and state, deliver the correct new catalog/skills, and do not rebuild the historical prompt prefix.
- [ ] **A15 — Completion evidence:** Final reports expose independently checkable costs, obligations, location, condition, progression, and outcome, including unsold inventory and unresolved work.
- [ ] **A16 — Fresh-session reproducibility:** Setup and run instructions are current, required checks pass, and another session can reproduce representative workflows without relying on this conversation's hidden context.

## Real-inference receipt fidelity — 2026-09-10

- A real local-model/AIAgent run through the offline Node execution fixture chose
  home with a rationale, handed off, tracked, completed one fixture Hunt, and returned
  serviced. This is genuine inference and dispatch evidence, not live gameplay.
  `spacemolt/evidence/shared-model-fixture.json` preserves reviewed findings.
- The run exposed two gaps: model prose treated projected hull damage/ticks as measured
  results, and repeated command snapshots spilled the Hunt tool response to a file
  whose required `read_file` tool was deliberately absent from the session catalog.
- `spacemolt/receipts.py` now constructs public reports from recorded job receipts,
  deduplicating recovered IDs and excluding model narrative/assessment estimates.
  Endpoint hull is explicitly an observation, not inferred damage taken. Raw narrative
  remains `model_report` in the private checkpoint; `verified-report.json` is the
  authoritative public report artifact. Cash aggregation is labeled for recorded jobs,
  not total session profit or unrecorded asynchronous activity.
- Model responses omit repetitive mechanical command journals while retaining complete
  outcomes, assessments, obligations, and unresolved command identities. Full journals
  remain executor-owned and persisted; the model catalog is not expanded with file tools.

Validation after fixes: 14 Python tests pass through the required runner. A fresh
real-model/offline-game run completed two Hermes sessions, agent-selected home,
scouting, exactly one fixture Hunt, and verified return. The public report agrees
with checkpoint and stdout; it contains no projected damage/ticks or raw model
narrative. No spillover files or unavailable `read_file` calls occurred. The reviewed
before/after evidence is in `shared-model-fixture.json`. Unreconciled/running jobs
produce an unknown aggregate cash delta rather than treating stale balances as final.

Live acceptance still requires approval and evidence. Full S18/X8 across all stance
consumers remains open; this closes the concrete reporting defects found in real inference.

## Real-path preflight and exception cleanup — 2026-09-10

- Real local omlx model discovery and Hermes imports pass. Real AIAgent inference
  called the harmless balance fixture exactly once and reported its actual value.
  A single authenticated read-only bridge verified full hull/shields/fuel and no
  freight, passengers or queued production. Frontier Station is currently at
  `horizon/mobile_capital`, illustrating why the earlier location is not authoritative.
  Reviewed evidence: `spacemolt/evidence/shared-preflight.json`. No new fight occurred.
- Preflight review found that inference, setup or checkpoint-write exceptions bypassed
  final return. `execution_runner.py` now attempts deterministic cleanup after configured
  failures, records `exception-receipt.json`, and preserves the original exception if
  cleanup/persistence also fails. It stops/joins the control monitor and does not repeat
  completed cleanup when its receipt write fails.
- Required Python runner tests: 12 pass, including real Python-to-Node travel followed
  by planner/checkpoint failure, cleanup transport failure and receipt-write failure.
  Typecheck and the existing 59 Node tests pass. These failure scenarios are offline.
- The prepared one-Hunt live acceptance launch was rejected by automatic approval
  review: it requires explicit user authorization for the movement, expenditure and
  possible loss involved. A permission question is pending. The gameplay process did
  not start. A3/live acceptance stays open; implementation can continue independently.

## Event-driven defense increment — 2026-09-10

- `src/defense-events.ts` uses the pinned Account notification API, filtering own
  participation/damage/join events. Callbacks only latch danger; startup and the
  library's post-refresh reconnect hook also request authoritative assessment.
  Repeated notifications coalesce onto the bridge's existing command lane.
- `BridgeQueue` serializes input, control return and idle defense; a failed task
  does not prevent later recovery/stop work. Shutdown removes listeners before
  draining. No offensive tool or prompt change is needed for defensive execution.
- `Execution` verifies participation before idle response, then owns defense under a
  durable return job. Active jobs consume danger before subsequent noncombat commands
  and at travel/service checkpoints. Actual unexpected combat suspends productive
  work and uses the existing forced-retreat controller, preserving obligations.
  Normal Hunt battle notifications leave its tactical controller in ownership.
- Pending session handoffs cannot block urgent return. Stale operations after defense
  are discarded. If defense interrupts return itself, one bounded replan recomputes
  current route/service inputs and records `return_reassessments`; it does not replay
  the preceding accepted movement. Repeated disruption remains an explicit blocker.
- Offline evidence: `defense-events.test.ts` drives the real library socket parser/
  event emitter through the shared queue into actual Execution and durable service
  receipts. `defensive-execution.test.ts` covers all-stance idle defense during a
  pending handoff, Relaxed no-first-strike, pending movement serialization, service
  waits, own-Hunt ownership, lost defensive response recovery and interrupted return.
  Independent IC review reproduced two defects (handoff gating and return interruption);
  both now have fixes and passing regressions.
- Validation: typecheck, 59 Node tests and eight Python runner tests pass. No new
  live connection, live attack or live reconnect acceptance is claimed.

Remaining S10 scope: exercise new live defense, integrate subsequent stance consumers'
work/wait checkpoints, and verify broader defensive objectives. Notifications cannot
preempt an unresolved tick-deferred command: the library must finish it or reconciliation
must establish its outcome before another mutation. Existing service waits check at
most two seconds apart; arbitrary future waits must explicitly participate.

## Obligation verification increment — 2026-09-10

- Shared `src/obligations.ts` now supplies normal observations and recovery, retaining
  authoritative freight roles/custody, passenger destinations/deadlines and production
  queue metadata. Missing lists cannot establish absence of commitments.
- Hunt/track admission blocks passengers and carried freight until a transport plan
  exists. Freight in a non-carrier role without custody and background production
  do not alone block hunting. Return remains available and preserves those obligations.
- Every normally finalized job now records fresh `obligations_after` and an explicit
  `obligation_verification`; admission evidence remains immutable. Recovery refreshes
  these after cleanup too. Observation failure cannot yield verified success, and
  uncertain mutations prohibit further normal commands until reconciliation. Empty
  final queues do not imply delivered or settled output.
- Offline behavioral tests cover admission, changing deadlines/queues during servicing,
  persisted receipts, malformed observations and failed final observation. Known
  malformed obligation data still permits defensive return/service (including recovery);
  the terminal receipt remains blocked/unverified. An independent IC review found
  and reproduced this distinction, plus queue-count and freight-custody validation gaps. Typecheck,
  55 Node tests and eight Python tests through the required runner pass. No live play.

Repair pricing investigation: pinned `GetBaseResponse` has a nested station-owner
`repair_price_per_hull` override and empire policy has `repair_cost_per_hull`, but
neither establishes all-in repair tax/default/discount/rounding semantics. `repair`
has no quote or maximum-charge parameter; `RepairResponse.cost` is post-action only.
The neighboring library provides no additional pricing helper. Retain the precise
unquoted-repair blocker pending an authoritative quote/cap contract; do not invent a
price from these inputs. This was a delegated local read-only investigation, not a
live quote or repair test.

Remaining: obligation-aware delivery routing and resource allocation, settlement
verification, authoritative repair pricing and universal idle/wait defense. This
increment strengthens S7/S8/S18 and X5 but does not close their all-stance conditions.

## Interrupted-job reconciliation increment — 2026-09-10

- `src/recovery.ts`, `execution.ts`, `execution-store.ts`, `execute.ts`: preserve a
  received response before refresh and journal the pre-action snapshot. Reconcile
  the existing job against fresh authenticated state; never replay the pending command.
  Accepted responses, verified destinations and actual quarry participation justify
  cleanup, while missing battle/transaction evidence remains a durable blocker.
- Actual combat gets forced defensive control, including when another unresolved
  effect must remain blocked. Recorded battle IDs select exact terminal summaries.
  The tactical controller now retains an already-observed battle ID, so a battle
  ending between reconciliation and the first control poll does not become a bogus
  "hunt accepted but no battle observed" failure.
- `execution_runner.py`, `bridge.ts`: run reconciliation before inference and after
  uncertain job results, using the existing library reconnect/re-auth path. Recovery
  returns/services under the interrupted job's policy, reports interrupted instead
  of productive success, and keeps stop latched for a later explicit new run.
- Offline evidence: `recovery.test.ts` proves retained refuel acceptance without a
  second purchase, verified movement without repeated outward travel, active Hunt
  recovery/escape, the battle-end race and durable ambiguity. The parameterized real
  Hermes registry/Python subprocess/Node dispatch integration now exercises a lost
  accepted hunt response through automatic runner recovery as well as normal success.
- Validation: TypeScript typecheck, 53 Node tests and eight Python tests through the
  required runner pass. No new live game connection or live disconnect test performed.

Remaining S9 scope: raw lost economic responses need stronger acceptance/provenance
proof; ongoing transit, replaced ships and missing battle history remain explicit
blockers. General productive resumption is not implemented. Repair-price verification,
obligations-aware routing and universal defense during noncombat waits remain next.

## Return and servicing increment — 2026-09-10

- `src/servicing.ts` is the common service consumer for preparation, travel and Hunt
  cleanup, reusing `ensureReadiness`. It waits for authoritative shield recovery at
  two-second intervals for at most 120 seconds, checking dock/ship identity and
  defense. Changed fuel/hull or incomplete state is a blocker. Repair quotes remain
  unresolved; no estimated all-in repair price is invented.
- `src/execution.ts` now chooses one explicit temporary return fallback after a known
  home-route or docking rejection. It prefers the current verified dock, otherwise an
  observed refuel station using the existing route and reserve checks. A missing home
  can also return temporarily, including Tired sessions in every stance. This never
  overwrites home or relaxes policy. Unknown command outcomes and inconsistent arrival
  state still prohibit further movement.
- Return attempts record the temporary destination and reason before fallback travel.
  An already-failed return does not silently retry its whole cleanup sequence. Existing
  obligations and cargo are preserved; fallback cannot declare their delivery complete.
- Evidence: `src/return-service.test.ts` exercises real execution dispatch with offline
  accounts: denied home, home-less Tired returns, uncertainty, shield recovery/timeout,
  changed docking and unquoted repair. Typecheck and 51 Node tests pass. All seven Python runner regression tests pass through
  `scripts/run_tests.sh tests/test_spacemolt_runner.py` with the Hermes environment. No new live connection or gameplay used.

Next: verify repair pricing from an authoritative API path; add obligations-aware
return routing/admission and interrupted-job reconciliation. Fallback service failure
currently stays blocked rather than trying additional stations. Shared parent and live
acceptance milestones remain open.

## Intent checkpoint — 2026-09-10

Confirmed: initiating agents may choose `--stance` and `--mood` locks. Those choices
remain fairly static for the execution session/operating period. Normal policy
reconsideration occurs in a later session; urgent Tired control remains immediate.
This confirms the existing lock semantics rather than requiring human selection.

## First shared/Hunt implementation record — 2026-09-09

Implemented paths:

- `spacemolt/src/execution-policy.ts`: validated vocabulary, host permission, user locks,
  numerical Hunt bounds and tighter call overrides. `execution.ts` enforces admission,
  including stale tools after stop. Context stores plan/home/limits; observations,
  obligations, intelligence and action identity are captured in each job's evidence.
  S1's full cross-stance context contract remains open.
- `execution.ts`, `execution-store.ts`: one Hunt consumer composes existing combat,
  fitting, assessment, readiness, route validation and command boundary. Jobs journal
  pending/confirmed/uncertain commands, retain partial fight results when servicing
  fails, verify return/fuel, and persist pilot home separately from sessions.
- `bridge-input.ts`, `bridge.ts`, `controller-lock.ts`: normal dispatch remains serial;
  urgent controls are read while a job runs, latch admission and queue return. Login
  locks prevent a second bridge in this checkout; stale locks require inspection.
- `execution_runner.py`, `session_skills.py`, `runner.py`: small per-session catalogs,
  native read-only skill access, shared/Hunt preloads, archived session handoffs and
  post-budget return. `stop.json` is an independent urgent control path. `--new-run`
  clears a prior stop only after reconciled docked readiness. `--industry` remains
  an explicit historical path outside the new execution contract.
- `spacemolt/skills/`: shared and Hunt skills are packaged and installed into the
  dedicated temporary/profile Hermes home, with unavailable tool sections removed
  before the session starts. Other stance skills are deliberately not scaffolded.

Validation level: offline unit/integration fixtures, including real Hermes AIAgent
construction, native skill_view, model tool dispatch, Python subprocess transport,
Node execution and the existing Hunt/tactical controller. The integration planner
is scripted; no new model inference, recorded-data replay or live gameplay claim.
Existing Node tests and earlier live evidence are preserved.

Remaining work, in dependency order:

1. Strengthen home/service completion: verified repair pricing and obligations-aware
   return admission. Bounded shield waiting and temporary fallback were added on
   2026-09-10; see the increment above.
2. Extend interrupted-job reconciliation beyond the evidenced Hunt/movement and
   retained-response cases added on 2026-09-10. Raw lost economic responses and missing
   battle history still need authoritative provenance; productive resumption remains
   separate from return/cleanup.
3. Validate the new event-driven idle defense and existing travel/service wait
   integration with live evidence, then apply checkpoints to subsequent stance consumers.
4. Complete S1 context breadth, S3 assessment domains, remaining S4–S10 conditions,
   then validate one new live Hermes Hunt with a reviewed receipt before claiming S11/A3.
5. Add Industry and Logistics consumers and their skills following existing TODO
   dependencies. Opportunity switching and repetition wait for complete consumers.

No S1–S18 parent or A1–A16 live acceptance condition is claimed complete by this slice.

## Validation and completion record

Follow the repository's required test workflow. Existing useful checks from the repository root are:

```sh
(cd spacemolt && npm run typecheck && npm test)
scripts/run_tests.sh tests/test_spacemolt_runner.py
git diff --check
```

If the test runner needs an environment selector, the handoff used `HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python` with `scripts/run_tests.sh`; verify the local environment rather than assuming that path elsewhere. Add the relevant new test files to validation as implementation grows. Do not replace behavioral tests with source-text assertions or hardcoded catalog-count snapshots.

| Completed item IDs | Implementation / decision | Validation and evidence | Remaining limits | Date |
|---|---|---|---|---|
| D1–D6, D8–D10; K0/K2; selected foundation conditions | [Decision contracts](spacemolt/DECISIONS.md), implementation record above | Typecheck; 49 Node tests; 7 Python tests through required runner; both skill validators | Offline fixtures with scripted planner; no new live acceptance; recovery/fallback/universal defense pending | 2026-09-09 |
| S6/S7 selected conditions; lock intent confirmed | `servicing.ts`, bounded return fallback, `return-service.test.ts` | Typecheck; 51 Node tests; 7 Python runner tests; diff check | Offline fixtures only; repair pricing, obligations-aware routing and reconnect reconciliation pending | 2026-09-10 |
| S9 selected conditions | `recovery.ts`, accepted-response checkpoints, automatic runner reconciliation | Typecheck; 53 Node tests; eight Python tests including lost-Hunt integration | Offline evidence; raw economic uncertainty, missing battle history and ongoing transit remain blocked | 2026-09-10 |

The project is complete when the decisions are resolved, the required skills and systems satisfy their conditions, cross-system invariants hold, and the acceptance demonstrations have evidence. A smaller milestone may be reported as complete without implying that the entire project is done.
