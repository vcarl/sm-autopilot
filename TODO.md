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
| Locations and travel | [locations.ts](spacemolt/src/locations.ts), [normal-route.ts](spacemolt/src/normal-route.ts), [survey.ts](spacemolt/src/survey.ts) | Reusable route and station discovery; no agent-selected persistent home workflow |
| Action uncertainty and receipts | [command-boundary.ts](spacemolt/src/command-boundary.ts), [execute.ts](spacemolt/src/execute.ts), [progression.ts](spacemolt/src/progression.ts) | Stops after uncertain actions and records measured changes; does not autonomously recover every job |
| Prior live evidence | [freight progress](spacemolt/evidence/PROGRESS.md), [combat proof](spacemolt/evidence/combat-proof.json), [training](spacemolt/evidence/combat-training.json), [assessment replay](spacemolt/evidence/threat-assessment.json) | Historical proofs, not current state or acceptance of the redesigned system |

At handoff, TypeScript typechecking, 47 Node tests, and five runner Python tests passed. The new threat assessment was tested with replay and a live read-only bridge call, not a new live fight. The preceding five fights used the earlier controller: two victories, three stalemates, and no hull loss. A laptop-sleep disconnect required manual reconciliation. Do not extrapolate those results to unattended recovery or other target classes.

Suggested order: resolve decisions and shared foundations first; then Hunt, Industry, and Logistics; then the remaining stances and final acceptance. Shared receipts, skill integration, and tests should be developed alongside their consumers rather than deferred until the end.

## Decisions — D1–D10

Session scope confirmed 2026-09-13: complete the S5 travel borrowing milestone from
[SETPOINT-BORROWING.md](SETPOINT-BORROWING.md) first. Rules, repetition, additional
stances and drones remain subsequent work. The proof of concept is complete only
after Hermes demonstrates the specified tasks still work and a report compares two
Hermes runs before/after the rules engine. Carl selected Industry and Logistics on
Kvothe using its configured model. Use the same bounded task instructions, model,
permissions and limits for both comparison runs; record the code/model identities,
authoritative starting conditions and any changing game conditions. Compare verified
productive outcomes, return/service, retained assets and obligations, blockers,
tool/model usage and elapsed time. A fixture pass or an accepted command is not a
completed live task. S5 validation alone does not satisfy this later comparison;
the initial live diagnostic did not complete either workload; final paired runs remain pending.

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
  - [x] Arrival and docking are verified against authoritative state; a pending or ambiguous movement is never blindly replayed. Shared travel borrowing evidence below (2026-09-13; offline).
  - [x] Tired, new danger, and destination unavailability are handled at documented execution checkpoints without confusing transit with arrival. Shared travel plus existing bounded return/fallback tests pass; live acceptance remains separate.

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
  - [x] `gather` handles assessed resource collection, preserving starting assets and verifying yield, storage/sale policy, return, and servicing. Local retained-output consumer: `gather.ts`, `gather.test.ts`, real Hermes dispatch tests and [offline real-model receipt](spacemolt/evidence/shared-industry-model-fixture.json). Live acceptance and cross-system collection remain open.
  - [x] `produce` handles input sourcing/staging, quotes, craft submission, pending output, settlement, and explicit unsold inventory or remaining obligations. Local single-run consumer at chosen home: `execution.ts`, `industry.ts`, `shared-production.test.ts`, `production-custody.test.ts`, and real Hermes registry/ExecutionHost integration in `tests/test_spacemolt_production.py`. Live production acceptance remains open.
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
- [x] **K3 — Industry skill is installed and loadable.** It treats gathering and production together, including mine-versus-buy decisions, input allocation, pending work, and settlement.
- [ ] **K4 — Trade skill is installed and loadable.** It teaches opportunity comparison, market depth, inventory exposure, switching costs, and realized accounting.
- [x] **K5 — Logistics skill is installed and loadable.** It covers both freight and passengers, capacity/admission, routes, deadlines, and verified delivery.
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
- [x] **A11 — Home failure:** Unavailable home produced an explicit serviced fallback while preserving the chosen home. Live evidence: `spacemolt/evidence/shared-live-local-scout.json`. Stale mobile-home coordinates and redundant final return remain follow-up defects; no full Hunt acceptance is claimed.
- [ ] **A12 — Uncertain action:** Disconnect scenarios after acceptance demonstrate reconciliation without duplicated purchases, attacks, crafts, transport obligations, or deliveries.
- [ ] **A13 — Model budget:** Exhausting the model's iteration/time budget leaves active scripts able to complete their defined safe terminal behavior; obligations remain recorded.
- [ ] **A14 — Handoff:** Stance and mood transitions preserve the objective and state, deliver the correct new catalog/skills, and do not rebuild the historical prompt prefix.
- [ ] **A15 — Completion evidence:** Final reports expose independently checkable costs, obligations, location, condition, progression, and outcome, including unsold inventory and unresolved work.
- [ ] **A16 — Fresh-session reproducibility:** Setup and run instructions are current, required checks pass, and another session can reproduce representative workflows without relying on this conversation's hidden context.

## Rules-engine proof of concept — active, 2026-09-13

The active goal now continues beyond S5: a proof-of-concept rules engine must
entirely replace the prior policy/admission implementation, and the real Hermes
Industry/Logistics tasks must be verified before and after it. The previous goal
turn made progress by completing S5; the current turn is implementing the full
policy replacement, auditing all consumers, and preparing the comparison driver.
Do not treat S5 or green isolated rules tests as completion of this goal.

The complete pre-engine SpaceMolt source (including verified S5 changes) is frozen
at `/var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/spacemolt-rules-before-8hwhdo_g/spacemolt`.
Its sibling `source-manifest.json` hashes the captured files; every hash was checked
unchanged and the baseline passed typecheck. The candidate is the current workspace.
Use the same configured Kvothe oMLX model, instructions, permissions and limits for
both arms, each comprising Industry then Logistics with independent bounded jobs.
Record source hashes, canonical starting/terminal state, verified job receipts,
gross costs, retained assets/custody, model/tool usage and elapsed time. Produce a
comparison report after both actual Hermes runs, not a scripted-planner substitute.

The existing Kvothe gateway was gracefully paused for the comparison and ownership
checks found no competing gateway, bridge or controller lock. Restore its existing
installation when live tests finish; no candidate installation or deployment is authorized.
The configured local oMLX model is available. An actual baseline diagnostic is preserved
at `/tmp/spacemolt-rules-ab/before`: Altais/frontier_station has no local gathering
candidates, and Hermes stopped before targeted freight assessment or transport. Neither
workload completed. Pilot remained docked and fully serviced, credits 193637, cargo 21/120,
with no productive mutation or new custody from that trial. Nearby observed stations
will be checked as mechanical test setup, separately from model acceptance.

The native comparison driver now supplies bounded normal follow-up turns for premature
prose, and immediately honors native plan handoffs in fresh sessions. Freeze this same
protocol for both final arms and preserve the diagnostic. Rules review is completing
prospective fitting, service and production admission migration before final validation.
S5 is committed as `b72215ac34`. Rules audit passed all requested policy families;
final typecheck and 132 Node tests passed, Python resume retained strict context/cache
identity (10/10), and the other 13 Python files passed in the preceding full check.
The comparison harness and runner pass 15 tests. Rules and denial propagation are
ready for a local checkpoint commit; live acceptance is still incomplete.

The next baseline diagnostic at `/tmp/spacemolt-rules-ab-final/before` ended both
workloads blocked. Industry requires replacing a fitted economy cabin with the carried
mining laser; no asset was discarded. Logistics accepted contract
`71e521e6f4ddf08629c97c6589581830`, job `84b2aa11-8556-4cdf-8440-1bf57791987a`,
package `b87c597c1aad42dd71fb3d6d65d63340`, then correctly blocked because its
100-unit package exceeds 99 free cargo. It remains in personal storage at Unknown Edge
Waystation. Its 20-tick job allowance has expired, so do not reset it or replay acceptance.
Root is preparing explicit origin return/settlement, preserving the original diagnostic.
Both diagnostic processes exited; gateway remains paused. Before a successful paired
run, establish the same verified fit/capacity and resolve all freight custody. Version identifiers stay fixed under Carl's restriction;
source hashes and rule IDs identify executable semantics. Exact next action: establish
a viable observed start, run the frozen baseline with the final protocol, finish and
validate the rules candidate, repeat both actual Hermes workloads and write the report.
Keep the goal active until full replacement and the agreed real-agent evidence are proven.

## Shared travel borrowing milestone — 2026-09-13

Completed the first bounded milestone selected from SETPOINT-BORROWING.md. New
`spacemolt/src/travel.ts` owns movement for Execution, Hunt and station surveys.
It verifies exact system/POI arrival and docking, forces an Account.refresh live
read at least every 30 seconds while polling, and bounds arrival waiting at 600
seconds. Unrelated fresh cargo/hull pushes cannot postpone that read. Only a narrow
set of definitive server rejections permits one replan; timeouts, connection loss
and pending commands never replay movement. Unresolved accepted arrival leaves a
durable needs_reconciliation job.

Each leg, including return, uses current find_route fuel and cargo evidence plus
the caller's reserve. State is revalidated before departure. Tank capacity, original
gross spending and wallet reserve remain hard bounds. Docked refuel attempts a full
tank under the installed library/server contract, so Execution authorizes the full
live station quote, not an invented partial price. Survey retains no fuel purchases,
its per-leg two-jump cap and total allocation; Hunt retains its existing reserves.
Home fallback stays bounded, explicit and separate from remembered home. Future
return projections and local fuel allowances remain estimates; the API cannot quote
an arbitrary remote origin. Broader hazard/access planning keeps the S5 parent open.

Tired waits for accepted transit to settle, then stops further productive movement.
Defense still probes battle at stable departure/arrival boundaries, including when
an event was missed; during polling it responds to events without repeatedly querying
battle status. Defense relocation invalidates the old route and uses the existing
bounded defensive return reassessment. Transport deadline and custody callbacks,
command journaling and cleanup budget ownership remain on the actual caller path.

Two behavioral tests in `execution-arrival.test.ts` and `travel.test.ts` exercise
delayed arrival with unrelated fresh state, Tired, defense relocation, unresolved
arrival, actual Execution refill spending, unaffordable refill, asymmetric return
fuel, tank capacity and bounded rejection versus uncertainty. The arrival assertion
was copied into an isolated archive of baseline `d08ce3a880`; the actual old
Execution failed it with blocked / POI arrival not verified while still in transit.
That same assertion passes after the change. Evidence: `/tmp/s5-baseline-red.log`.

Required baseline Python validation also exposed an existing guidance regression:
the standalone runner filtered old job__ headings after bundled skills changed to
native spacemolt_* names, dropping every tool section. `session_skills.py` now adapts
native names to the standalone runner's actual immutable catalog while preserving
bundled native guidance and installed resume content. The real skill_view/temp-home
runner test covers the repaired filtering, translation and resume behavior.

Final validation: `cd spacemolt && npm run typecheck && npm test` passed all 130
Node tests; the required `scripts/run_tests.sh` with the documented HERMES_PYTHON
passed 57 tests across all 13 SpaceMolt Python/skill test files. Logs are
`/tmp/spacemolt-s5-node-final.log` and `/tmp/spacemolt-s5-python-final.log`.
`git diff --check` passed. These are fixture/process integration results, not live
Hermes or game acceptance. No bridge, gateway, model session or game controller was
started; pilot state and obligations remain historical and need fresh observation.
No active runtime handles were created.

The verified S5 patch was committed as `b72215ac34`. Milestone files: `TODO.md`,
`spacemolt/session_skills.py`, `tests/test_spacemolt_runner.py`, and
`spacemolt/src/{travel.ts,travel.test.ts,execution-arrival.test.ts,execution.ts,
combat.ts,survey.ts,execution-fixture.ts,combat.test.ts,survey.test.ts,
home-location.test.ts}`. Pre-existing changes to `CLAUDE.md`, `.claude/` and
`SETPOINT-BORROWING.md` were preserved. VISION and versions are unchanged.

Exact next action: review the completed S5 borrowing patch. Before changing rules,
capture the agreed pre-engine Hermes Industry/Logistics run on Kvothe after checking
single-controller ownership and authoritative pilot state. Implement the rules
milestone, repeat the same bounded workload and produce the comparison report.
Neither that report nor proof-of-concept acceptance is claimed by this milestone.

## Executable stopping and live receipt compaction — 2026-09-10

The live repeated-scout failure is fixed at the script/runner boundary. `execution-stopping.ts` and the pilot store enforce one
optional Hunt scout and one principal Hunt/gather attempt, with persistent admission
across handoff/reconnect and verified host-only reset. Terminal `stopping_reason` is
separate from completed/blocked outcome. The runner interrupts on this reason and
urgent Tired, while deterministic cleanup retains pending-command ownership.

Stopping validation: typecheck and 63 Node tests pass; all 25 SpaceMolt Python tests
pass through the required test runner, including idle inference interruption and
terminal gather interruption through actual Hermes and Node. The real bridge and
offline tests now share `ExecutionHost` dispatch, including verified host reset.
Independent review found no allowance bypass; a monitor reference race was fixed
before final validation.
Real local-model validation also passed through actual `ExecutionHost` dispatch:
home choice, assessment, one gather, immediate inference interruption, then verified
cleanup. There was no third model completion after the assess/gather tool turns;
the public report was built with no final model narrative. Reviewed offline evidence:
`spacemolt/evidence/shared-stopping-model-fixture.json`.
This closes the current single-attempt gap, not S17's general objective-driven repetition.

`model_receipts.py` now keeps large planning results inline using shared evidence,
named-column tables and mission overrides. Historical duplicate snapshots are
omitted; current state, every candidate assessment/scan, obligations, unresolved
accepted responses and observed skill/loadout/ship changes remain. Raw durable
journals are unchanged. Five recorded live responses shrink from 49K–262K to
10,531–37,967 characters, below the actual 39,321-character Hermes threshold at
65,536-token context. Real registry/storage/turn-budget checks and all 26 Python
tests pass. This bounds the tested receipts, not arbitrary future payloads.

A real local-model reading check initially misread scan success as engagement
clearance despite retaining all `need_intelligence` assessments. Derived recorded
decision counts and engage IDs now make the distinction explicit. A repeat with
concise JSON output correctly reported all 12 candidates needing intelligence,
zero engagement clearances and the −18 cash delta, with no spilled output. This
is a reading check over saved live evidence, not new gameplay or proof of general
model planning competence; scripts independently enforce fresh assessment. Both
attempts are recorded in `spacemolt/evidence/shared-receipt-compaction.json`.

Next: enforce gross spending independently of income before another economic job.

## Gross spending enforcement — 2026-09-10

The per-job limit remains the contract in `DECISIONS.md`: preparation and cleanup
share one allocation, independently of wallet income. Accepted command costs must
be counted once; refuel `cost` already includes tax. Missing cost evidence must not
authorize another purchase. Net `cash_delta` remains a separate observed outcome.

Independent review also reproduced a cleanup ownership bypass without income:
gather spends its 12-credit budget preparing, blocks on 9-credit cleanup, then the
runner's automatic separate return receives a fresh budget and spends the 9.
`spending.ts` now derives costs once from durable accepted commands and carries the
original allocation across return chains through `budget_owner_id`. Readiness and
fitting use the same authoritative cost fields; their local quote checks no longer
use net wallet loss. Safe movement and defense remain available. Unpriced costs
keep reconciliation outstanding without replaying the accepted action.

Each receipt exposes its own `spending` and aggregate `budget_spending`; the public
report sums only distinct jobs' own costs, separately from cash change. Historical
receipts without cost evidence remain unknown. Policy version is `one-job-gross-1`.
Validation: typecheck and 65 Node tests; 27 Python tests through the required runner.
The real Python bridge/Node dispatch/final-cleanup/report regression records gross12,
net+88 after income100, retained ore2, and blocked cleanup with only one refuel.
Recovery tests verify accepted cost counted once after refresh failure, missing cost
blocking subsequent service/new-run, and tax not double-counted. Offline only.

Limitation: exhausted cleanup can leave an under-serviced stopped ship. The existing
new-run readiness gate correctly refuses to erase that liability; an explicit host
budget reauthorization workflow remains future work. Independent review reproduced
the original boundary defect, but the reviewing IC hit a usage limit before final
patch review; final implementation review and validation were completed locally.

## Shared freight and passenger jobs — 2026-09-11

S14 now has concrete single-destination workers: `logistics.ts` for one personal
freight contract and `passengers.ts` for one passenger destination. `Execution`
provides the small Logistics assessment/transport catalog, shared service, serialized
commands, journaled docking replies, cleanup, one-job stopping and budget ownership.
`logistics-policy.ts` enforces the route/liability allocations below; an actual
route test distinguishes Cautious from Focused without broadening authorization.

Freight verifies contract/contractor identity, contingent liability, inspected or
postaccept storage package size, cargo/storage custody, delivery and payout. Unknown
preaccept size remains an explicit commitment risk, not a fabricated number. A clean
interruption can continue the same accepted contract without a second acceptance or
withdrawal. Passengers preserve exact boarded identities, berth capacity and observed
deadlines, consume dock-triggered delivery receipts before unloading, verify fares
and retain unrelated cargo/passengers. Expired observed deadlines stop further
productive execution; no guaranteed travel-time estimate is invented.

A later operating run can use `resume_job_id` for verified unfinished transport;
uncertain effects/accounting remain needs-reconciliation even after generic cleanup.
Resume retains the original gross spending owner and applies current route/reserve
constraints. Public reports expose transport receipts separately from net wallet
changes. The Logistics skill loads through native skill_view and filters correctly
for Tired. K3 and K5 packaging/skill-content conditions are now checked with real
native loading tests; they do not imply live stance acceptance.

Offline evidence: worker behavioral tests, `shared-logistics.test.ts`, and actual
Hermes registry → Python subprocess → ExecutionHost tests for both delivery types
under temporary HERMES_HOME. Freight fixture reports payout80, grossfuel6 and
netwallet174 with unrelated income100; passenger fixture reports fare7/gross6 and
net101 with unrelated income100. Tired continuation submits one acceptance/boarding,
keeps custody, and returns serviced after delivery. Failure tests cover missing
payment, unknown acceptance, failed pickup, missing/expired passenger deadlines,
missing arrival evidence and repeated-action prevention. Independent IC review
found and fixed the expired-deadline gap; no remaining concrete integration blocker
was found. Typecheck, 84 Node tests, and 36 Python tests pass.

No new live Logistics or local-model Logistics run was performed. S14/A6 remain open
for representative live freight and passenger jobs, broader transport recovery,
capacity acquisition and stronger deadline feasibility evidence. This slice uses
existing equipment and observed station identities with at most two normal jumps.

## Corrected live economic planning and next Logistics slice — 2026-09-11

A fresh real Hermes/oMLX Industry run after `1a8c92b813` performed one bounded
local economic assessment, then chose return/stop without guessing recipe IDs.
Discovery established no profitable candidate at Frontier Station: its observed
shortlist had input costs above output demand before additional fees. Raw assessment
is preserved. This is a local bounded result, not proof that production is globally
unprofitable. Final Deep Range/Frontier Station,197,773 credits, full105 hull/35
shields/120 fuel, unchanged cargo, gross0/net0, no craft or sale. Exit0; controller
lock released. Evidence: `spacemolt/evidence/shared-live-production-blocker.json`.
A4 still needs actual live production; the current market is an observed blocker.

Next meaningful implementation is S14 Logistics. Independent pinned-library audit
found singular passenger load/unload commands and dock-triggered passenger delivery,
plus inspectable freight package size. Freight and passenger executors are now being
implemented separately with shared checkpoints, journaled travel/docking evidence,
identity/custody checks and explicit monetary receipts. No Logistics tool is exposed
until its shared integration works. Existing route parsing supports at most two normal
jumps; reuse it. Proposed initial Logistics route bounds: Relaxed/Cautious1 jump,
Focused/Opportunistic/Aggressive2, Tired0. Freight failure-liability allocations are
separate from gross spending:500/500/1000/1000/2000/0 credits respectively, also subject
to carrier profile eligibility and existing exposure. These values still need concrete
consumer coverage before D7/S14 completion. Passenger deadlines are observed after
boarding; neither a route estimate nor an optimistic model claim guarantees punctuality.

## Live production planning diagnostic — 2026-09-11

Real Hermes/oMLX ran the shared Industry interface against the MMO after controller
checks. It repeatedly assessed guessed recipe IDs, received an error referring to
unavailable legacy tools, and triggered context compression without submitting
production. An operator Tired signal stopped the run; final verified state remained
Frontier Station/Deep Range, 197,773 credits, full105 hull/35 shields/120 fuel,
unchanged cargo, gross0/net0, no queued production. Exit0 and lock released.
Evidence: `spacemolt/evidence/shared-live-production-planning.json`.

This does not prove that no profitable opportunity exists. Earlier discovery payloads
were lost from the compressed conversation, so their exact blockers cannot be
reconstructed. The runner now preserves raw observe/assess responses, request
arguments and session IDs under the private runtime `observations/` directory before
model compaction. A real Hermes dispatch test verifies this persistence.

Shared economic assessment now rejects unknown recipe IDs with the requested ID,
the available assessment action, and actual bounded discovery candidates/blockers.
Discovery explicitly distinguishes candidates available from no profitable candidate
established; it never directs Hermes to absent recipes/screen tools. Unknown IDs
are not sent as craft quotes. Typecheck, 78 Node tests and 32 Python tests pass.
The corrected planning path still needs another live attempt; A4 remains open.

## Shared production job and custody verification — 2026-09-11

Industry now exposes economic assessment and `produce` through the shared session
catalog. New work uses one recipe run at the chosen home, input inventory or purchases,
existing production economics, shared gross budget/reserve, and return/service without
mining fitting. A queued/partial result remains blocked with its experiment visible.
An explicit later operating run can settle that experiment without purchasing or
crafting again; its costs and cleanup stay linked to the original budget owner.
Unknown accounting/acceptance remains unresolved even after generic recovery.

The existing settlement code had two independently reproduced custody defects:
an accepted withdrawal without matching inventory could sell starting cargo, and
an accepted sale with no cargo removal could falsely complete. Withdrawals now require
matching storage/cargo deltas; sales protect starting cargo and require a matching
canonical decrease. Ambiguous accepted effects retain their receipt and prevent replay.
Tests also cover vanished output before resumed sale, partial fills, queued work,
Tired during bounded waits, and missing monetary evidence.

Native skill loading follows the actual catalog, including removing productive tool
sections for Tired. A real Hermes registry → Python bridge → ExecutionHost test
chooses home, quotes, produces, settles, stops inference, and verifies the final
report under temporary HERMES_HOME. Its planner and game are fixtures, not live
inference/gameplay. Production report amounts are labeled cumulative per experiment;
job-level gross spending is independently counted once.

Local oMLX/Hermes validation used a broad production objective without station or
recipe IDs. The first attempt ended with intent prose and confused storage with cargo;
the second hit an unnecessary home prerequisite on read-only economic assessment.
Discovery now retains input locations, the skill explains storage and execution,
and economic assessment can inform home selection. The third attempt chose home,
used owned inputs, crafted once, sold two output units, and stopped on the receipt.
Gross3, sales40, net production37 (35 after input opportunity), wallet+237 including
unrelated fixture income200. All three attempts are preserved in
`spacemolt/evidence/shared-production-model-fixture.json`. This is real inference
with an offline game, not live production acceptance. Validation: typecheck,
77 Node tests and 32 Python tests through the required runner.
S12/A4 live acceptance, multi-station production, general recovery and opportunity
switching remain open. No new MMO connection was started for this increment.

## Production accounting and settlement integration — 2026-09-11

S12 production integration is in progress. The existing Industry executor now accepts
shared durable experiment storage and execution checkpoints, including waits of at
most two seconds. Accepted mutation identity is saved before accounting validation;
interrupted settlement retains queued work or partial output instead of replaying it.

Production accounting uses accepted `buy.total_cost`, craft `escrowed.labor` plus
`escrowed.fee`, and direct-sale `total_earned`. Quotes and queue reads are free;
wallet changes remain separate cash observations. The pinned library does not define
omitted escrow components as zero, so incomplete escrow evidence blocks further paid
work. Queue contents cannot reconstruct a missing enqueue charge. Sales keep
`auto_list:false` to avoid creating untracked listings.

Offline checks cover durable callbacks, interrupted waits/withdrawals, enqueue costs
with unrelated income, and missing escrow without duplicate production. Shared
spending journals count retained accepted craft responses once across recovery.
Production reporting preserves partial custody/accounting evidence and excludes
quoted profit. These changes alone do not complete the shared `produce` tool or S12;
tool dispatch, settlement continuation, skills, and real-Hermes acceptance are being
integrated next. Validation: typecheck, 72 Node tests, and 31 Python tests through
the required runner pass. No new live game controller was started for this increment.

## Live gathering recovery and startup receipt race — 2026-09-11

After `163d1e4317`, a fresh real Hermes Industry run completed both requested
extraction cycles: platinum ore1 and carbon ore3, measured in correlated mine
deltas and retained. The connection closed during docking. Automatic reconciliation
could not reauthenticate within30 seconds; an explicit same-checkpoint process
resume then verified docking without replay, refueled, and returned serviced.
Exactly two mines and one dock were submitted. Final Frontier Station/Deep Range:
197,773 credits, full105 hull/35 shields/120 fuel; gross cost6. The productive job
remains `interrupted`, with verified yield and later cleanup. Neither uninterrupted
Industry acceptance nor autonomous process-level recovery is claimed. Evidence:
`spacemolt/evidence/shared-live-gather-recovery.json`.

Idle recovery completed before the runner's explicit reconcile call. That call
returned only `no_unfinished_job`, losing the updated receipt; the runner restarted
inference and its final report used the old job status and zero spending. The fix
returns the stopped run's authoritative receipts and stopping reason even when
reconciliation is already complete. Startup imports them before reporting, skips
inference, and still verifies final cleanup. The prior live report is preserved.
An actual Python bridge/Node execution regression reproduces recovery-before-startup
and asserts no agent construction, no repeated service purchase, and correct gross
and net costs. Tired resume tests now require the same inference-free cleanup.

The mine-delta adapter also honors the pinned library's documented omitted-section
semantics: absent ship/location sections mean unchanged, while conflicting supplied
identities remain invalid. The executor still verifies identity before/after mining.
Validation: typecheck, 69 Node tests and 30 Python tests through the required runner.

Fixed-runner live recheck after `3d461df536`: resumed the same stopped checkpoint,
verified final cleanup, published the corrected gross6/net−6 and recovered job
status, then exited0 and released its lock. No model inference, new extraction,
movement or spending occurred. Original reports are archived before the recheck.
The reviewed live evidence above includes both the defect and this verification.

Next practical milestone: complete S12 production/settlement using the existing
Industry executor and ledger, then Logistics. Keep the remaining general recovery
and all-stance acceptance conditions open; do not repeat gathering merely to erase
the useful interrupted-job evidence or call production complete from mined cargo.

## Live gathering receipt correction — 2026-09-11

Real Hermes/oMLX Industry/Focused retained the chosen Frontier Station home, assessed
a local belt in Deep Range, and submitted one mine. The actual response omitted
`delta.details` but supplied a correlated `command: mine`, tick and canonical state
delta showing three carbon ore. The detailed-yield-only verifier blocked its second
cycle. It returned to the mobile home's current location, serviced, stopped, and
performed no extra movement/spending in final cleanup. Cost6; full ship condition;
starting cargo plus carbon ore3 retained; runner exited0 and released its lock.
Evidence and a reduced recorded-command replay fixture:
`spacemolt/evidence/shared-live-gather-delta.json`. This validates the mobile-home
correction live; it is not a completed two-cycle gathering acceptance.

`mining-inventory.ts` now measures either detailed pilot yield or retained site-resource
gains in the accepted mine state delta. Command/tick, ship/site identity, observed
resource IDs and current custody must corroborate the delta; a refresh alone cannot
establish yield. Detailed filtered/drone results never fall through to this path.
`yield_measurements` exposes the source and the delta path's attribution limit:
simultaneous gains of the same resource cannot be separated. Other cargo gains remain
unattributed. Raw journals and the recorded blocked run are not rewritten.

Validation: recorded-command replay, typecheck, 69 Node tests and 29 Python tests.
The real Hermes registry/Node gathering integration now exercises both response
forms. No successful new live two-cycle run is claimed yet; production remains open.

## Mobile-home and final-cleanup correction — 2026-09-11

`home-location.ts` resolves the chosen base ID using current authenticated docking
or the station directory. The session home and cached context stay unchanged;
`home_location` observations and `return_plan` receipts carry current coordinates
and their source. Missing bounded-directory entries retain a labeled remembered
waypoint. Return and Industry assessment/admission share this resolution.

Final return now reuses the latest temporary fallback within the same budget owner
when fresh state confirms the same ship remains docked there. It still services
current fuel/hull/shields and observes obligations; it neither repeats the failed
home route nor grants new spending. Explicit new-run boundaries discard fallback
reuse. Public reports include the return plan and provenance.

Offline validation: typecheck, 67 Node tests and 29 Python tests through the required
runner. New contracts cover relocated home at dock/away, Industry gathering under a
relocated home, immutable session context, restart/fallback reuse, fresh service
needs, unquoted hull damage and new-run retry. Real Python bridge → Node dispatch →
runner final cleanup checks prove no additional movement or spending after either
successful mobile-home or fallback cleanup. Policy: `one-job-gross-home-1`.
No new live run has validated this correction yet. The previous live receipt below
remains evidence of the original defects, not acceptance of this patch.

## Second live shared Hunt attempt — 2026-09-10

After commit `42dd9fa919`, fresh process and lock checks found no controller. Real
Hermes launched with Hunt/Aggressive locks and wildlife permission in
`spacemolt/runtime/shared-live-hunt-local-20260910-02`, one local scout then at most
one assessed hunt. Fresh state places Frontier Station (`mobile_capital`) in
Deep Range, while the persisted home coordinates still say Horizon. This is a
mobile-home location case requiring follow-up: preserve the chosen base identity
while reconciling its authoritative current location, rather than silently choosing
a different home. The run exited 0 and released its controller lock. Final verified
state: Deep Range Outpost, 197,785 credits, hull105/105, shields35/35, fuel120/120,
starting cargo unchanged. Gross spending42 equals net cash−42; scout/fallback cost27
and the redundant final return cost15. Both draw from the original 1,000-credit
job allowance. No hunt was submitted. Reviewed evidence:
`spacemolt/evidence/shared-live-local-scout.json`.

Observed follow-up: scouting found 12 `need_intelligence` candidates and no eligible
quarry. After verified fallback service, it stopped inference after one oMLX call;
the live tool response stayed inline at 20,618 characters. Automatic final return
then repeated the stale home route, despite already serviced fallback arrival.
Next fix must resolve mobile-home coordinates by identity and reuse/reverify a
completed safe cleanup without restarting a known-failed home attempt. Preserve
fresh condition/obligation checks, defense, and the existing budget owner.

## Wind-down handoff — live run, 2026-09-10

Resumed at the user's request. The next slice implements the first two follow-ups
below: a durable `one_job` allowance and faithful compact live-data responses.
Routine MMO gameplay risks remain explicitly authorized; process/state checks still
precede any new controller. Implementation and offline validation come first.

User authorized normal MMO risks (movement, spending, ship/cargo loss), then requested
shutdown before laptop sleep. Industry milestone committed as `a14d1fc922` (61 Node
tests/typecheck, 24 Python tests, real-model offline gathering). The live runner exited
normally with code 0; its bridge closed and controller lock was released. No controller
should be restarted without a fresh process check and authoritative game observation.

Reviewed live evidence: `spacemolt/evidence/shared-live-scout.json`; private runtime:
`spacemolt/runtime/shared-live-hunt-20260910`. Hermes chose Frontier Station in Horizon
as home, scouted First Step, hit the two-jump limit for Last Light, then started another
scout toward Deep Range despite the requested stopping rule. External
Tired stopped after the submitted movement and returned serviced. Final credits 197827
(30 spent), hull 105/105, shields 35/35, fuel 120/120, original cargo preserved. No hunt
command or fight occurred. A3/full Hunt acceptance remains open; this is live evidence
for home choice, scouting, servicing and Tired during travel only.

Next priorities from this live run, before another acceptance attempt:

1. Enforce `stop_condition: one_job` across tool calls and session handoffs. It is
   currently metadata only. Bound the concrete Hunt flow to one optional scouting
   sortie then one hunt; stop on an admitted blocker/no eligible quarry/finished hunt.
   Persist the operating-run allowance across reconnect/handoff; only explicit verified
   host new-run resets it. Preserve actual job outcome while recording a stopping reason;
   interrupt Hermes when the script has stopped, then run deterministic cleanup.
2. Compact actual live receipts, not only fixture journals. Live track results were
   94K/50K/70K characters and observe reached 262K, mostly duplicate state/receipt history.
   At 65536-token model context the tool-result threshold is 39321 chars, so outcomes
   spilled to files unavailable to the small grant. Preserve every candidate's scan,
   assessment decision/unknowns and verified outcomes while removing duplicate snapshots.
   Replay private spillover `call_65644292.txt` (track) and `call_efde2a82.txt` (observe)
   through actual Hermes result handling; prove no inaccessible-output marker remains.
3. Fix gross spending separately from net wallet change before more economic consumers.
   Offline reproduction: max_spend12, initial refuel12, async income100, cleanup refuel9
   currently completes at gross21. Use authoritative journaled total costs, never add
   refuel tax twice, and block further spend if cost evidence is missing. Recovery must
   not double-count accepted commands. Net cash_delta stays separate.

All ICs are finished; no code edits for these follow-ups have started. The user is
pausing work, not abandoning the full TODO goal.

## Resume grant preservation — 2026-09-10

- Resume now preserves the saved wildlife permission when its original CLI grant is
  omitted. Repeating the same stance/mood flags asserts those choices without adding
  new locks to a previously unlocked session. Existing locks remain unchanged, including
  the original mood lock while Tired is active. Bridge host configuration now reuses
  `resolveHostContext`, which validates those lock identities against the current policy.
- An attempted permission expansion is rejected before execution configuration;
  `--resume` without a checkpoint no longer silently starts a fresh session. Normal
  new-session authorization behavior is unchanged.
- `tests/test_spacemolt_resume.py` exercises real Hermes construction/tool resolution,
  native skill setup, Python-to-Node dispatch and policy resolution against a temporary
  Hermes home, with both permission and lock states. It verifies session/history/grant
  retention, Tired override persistence and pre-configuration rejection. Combined
  Python checks: 20 tests pass; typecheck and 59 Node tests pass.
  No live gameplay is used or authorized by these tests.

## Industry gathering integration — 2026-09-10

The delegated Industry audit selected a local bounded `gather` consumer under shared
Execution, retaining gathered inventory without implicit sales. Implementation reuses
mining readiness and canonical inventory accounting; shared Execution owns home return,
servicing, uncertainty and defensive control. The legacy experiment is not wrapped:
its separate ledger, origin return, caller-supplied service quotes and missing stop
checkpoints conflict with the shared contract.

- The Industry session now includes local candidate observation, assessment, mining
  preparation and a policy-bounded gathering executor. Asteroid-belt listings permit
  a verification visit; only arrival observations establish resource contents.
- The gathering skill loads through native Hermes skill reading and follows the
  actual session catalog, including Tired filtering. It explicitly scopes production
  and sales as unfinished. K3 remains open for the complete Industry planning skill.
- Python receipt reporting retains verified gathering output and progression through
  partial cleanup wrappers. It distinguishes successful return from interrupted work
  and does not convert retained materials or model prose into realized earnings.
- Independent review reproduced two verification gaps before acceptance: a ship
  replacement after the last mine and a filtered mine with unrelated cargo gains.
  The executor now checks ship identity after extraction and final return, and matches
  pilot extraction receipts to canonical cargo changes. Unattributed gains are separate.
  Follow-up review also reproduced stale retention after recovery; recovery now rechecks
  known gathered inventory after cleanup and blocks missing cargo without replaying mining
  or attributing uncertain yield. The independent reviewer confirmed all three fixes.

Validation: real Hermes imports, native skill loading and Python-to-Node
dispatch against temporary homes and offline game fixtures, including Tired after
an accepted extraction. All 24 SpaceMolt Python tests pass through the required runner.
Typecheck and 61 Node tests pass. A real local-model run chose home, handed off,
assessed a site, gathered two cycles and returned serviced: 2 ore + 1 carbon retained,
10 measured mining XP and 12 credits spent. Its public report agrees with the receipts;
reviewed evidence is `spacemolt/evidence/shared-industry-model-fixture.json`.
No live gameplay is claimed by this evidence. Production, cross-system gathering and settlement remain
later S12 scope; A4 remains open.

Shared spending follow-up found during this slice: `Execution.remainingSpend()` uses
net wallet loss. An unrelated asynchronous credit reward can mask prior expenditures;
this is not yet a proof of cumulative gross spending limits. Before extending economic
consumers, record authoritative per-command costs (including taxes) and test concurrent
income against the job allocation. Current gathering has no sales or production income.

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

Live acceptance still requires new evidence; gameplay-risk authorization was provided
later on 2026-09-10. Full S18/X8 across all stance
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
  review because movement, expenditure and possible loss required explicit authorization.
  That launch did not start. The user has now explicitly authorized those normal MMO
  risks (2026-09-10); live acceptance can proceed after controller checks. A3 stays open
  until a new live receipt establishes the result.

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

## Live Logistics admission correction — 2026-09-11

The first real Hermes/oMLX Logistics run made two inference calls, assessed freight
and passengers, and attempted transport. It accepted no contract: admission incorrectly
compared reserved exposure with the mood failure-debt allocation. The observed local
candidate had 500 failure debt and 13,230 reserved exposure; Focused allows 1,000 debt
and the carrier profile allowed 50,000 single / 100,000 remaining aggregate exposure.
The run stopped serviced with zero spending and cash delta. See
[evidence](spacemolt/evidence/shared-live-logistics-admission.json). This is a live
blocked-job result, not successful freight acceptance or delivery.

`logistics.ts` now caps failure debt separately from the existing carrier exposure
capacity checks, in both admission and continuation. Policy version is
`one-destination-2`. Admission errors retain the specific assessment blockers.
Behavioral coverage reproduces the old false rejection, completes delivery with
exposure above the debt cap, and still rejects carrier-capacity overflow and excessive
debt without accepting. Typecheck and all 84 Node tests pass; the required Python
runner passes 15 tests across runner and Logistics integration. A corrected live run
is still needed; S14/A6 remain open.

## Freight board readiness after live planning — 2026-09-11

The corrected debt-policy live run still completed no delivery: Hermes selected a
higher-paying contract to unobserved Ramen's Rest directly from the board, skipping
targeted assessment. The script rejected it before acceptance, then stopped serviced
with zero spending. [Recorded live result](spacemolt/evidence/shared-live-logistics-planning.json).
The board now distinguishes server eligibility from local readiness: missing observed
stations, wrong origin, server rejection and excessive failure debt are explicit
blockers; remaining candidates require targeted assessment. Same-system observations
are explicit, and stored contract hop counts are labeled potentially stale for mobile
stations. Behavioral coverage verifies an eligible contract becomes locally blocked
when its destination is absent, without hiding that listing. Typecheck and 84 Node
tests pass. Another live attempt is needed; S14/A6 remain open.

## First complete shared live freight job — 2026-09-11

Real Hermes through local oMLX selected the Frontier Station → Deep Range Outpost
contract from a broad objective containing no station or contract IDs. The shared
executor assessed current eligibility and route, accepted once, verified a sealed
100-unit package in cargo, delivered once, and verified the terminal contract and
207-credit payout. It returned to remembered Frontier Station, resolved at its
current Deep Range position, and refueled for 6 credits: net wallet change +201.
Final credits 197,974; full hull, shields and fuel; original cargo retained; no live
freight, passengers or production queue. Existing distress missions remain reported.
[Live receipts and action trace](spacemolt/evidence/shared-live-freight.json).

This proves the freight half of A6 through the real Hermes path and shared cleanup.
A6/S14 stay open for passenger completion and remaining recovery/feasibility work.
The model still called transport directly after board comparison; the script itself
performed targeted admission assessment. No combat or disconnect occurred. Process
exited successfully; no controller remains active from this run.

## Passenger preparation consumer — 2026-09-11

Logistics now exposes economy berth assessment through `job__assess` with
`kind: passenger_fit` and execution through `job__prepare` with `kind: passengers`.
The bounded worker inspects the named economy cabin, verifies skills and fitting
capacity, prefers owned cargo/storage, otherwise requires fresh complete purchase
quotes, and uses the shared command journal and gross spending checks. It can replace
only an observed Mining Laser I when utility slots are full, preserving the laser in
cargo. Actual module identity, cargo consumption and canonical berth capacity prove
completion. A nominal accepted installation without its effect cannot complete.
Omitted berth data on an empty no-accommodation ship is handled according to the pinned
API, while malformed supplied capacity remains blocked.

The host can supply `--max-spend` in 0..10,000 credits for shared execution; default
1,000 remains unchanged. Changing the saved allocation on resume is rejected before
configuration. This makes the existing host policy usable for cabin capital costs
without granting the model a budget-raising tool. Fresh live quotes, not catalog
values, determine whether fitting is possible. Preparation receipts report verified
berths and actual spend independently of subsequent delivery fares.

Validation: typecheck and 86 Node tests; 27 Python tests through the required runner
(runner, resume, Logistics real imports/dispatch, native skill loading). Node shared
execution covers buy/storage/cargo sourcing, preservation, readonly quotation, blocked
replacement and ineffective installation. Python uses temporary HERMES_HOME and
actual ExecutionHost configuration, including default/zero/larger host allocations
and resume invariants. This is offline integration evidence. No live cabin purchase
or passenger delivery has yet occurred; S14/A6 remain open. Next: live oMLX planning
with an explicit fitting allocation, fresh cabin availability/quote and observed
passenger destinations.

## Wind-down checkpoint — 2026-09-11

The live passenger objective through local Hermes/oMLX assessed economy cabin
availability at Frontier Station, then independently traveled to Deep Range Outpost
and reassessed. Both authoritative purchase estimates reported zero available and
one unfilled; no cabin was bought, installed, or passenger boarded. Hermes selected
return; the user then requested wind-down. Tired reached the active execution path,
which finished return and refueling before the process exited 0. Total fuel spending
6, cash change −6; final credits197,968, docked Frontier Station in Deep Range,
hull105/105, shields35/35, fuel120/120, original cargo retained. No freight,
passengers or production queue. [Live evidence](spacemolt/evidence/shared-live-passenger-preparation.json).

No live controller should be resumed from this terminal run; check processes and
locks again before another connection. The next useful work is finding cabin supply
and resolving observed passenger destination tokens against public directory IDs.
The delegated destination mapping was partial at wind-down; it is now integrated,
tested and ready to commit as described below. No live cabin fitting or passenger
delivery has yet occurred.

## Completed passenger destination mapping — 2026-09-11

`locations.ts` resolves at most six exact observed passenger destination tokens
against public directory ID, base ID or POI ID before the usual shortlist truncation.
Names and opaque-ID shapes are not identity evidence. Missing, ambiguous, wrecked
and outside-route-limit matches remain explicit blockers; input bounds are checked
before public requests. Resolved stations enter the executor's observed routing
set without changing home or the session catalog.

Assessment, transport admission and interrupted-job resume now use the mapping.
Receipts preserve both the server passenger destination and canonical base ID:
passenger identity checks use the former; boarding commands and travel/docking use
the latter, as required by the pinned load-passenger API. Resume cannot
change the recorded canonical destination. Existing route/fuel/mood checks still
run before boarding. No additional tools or mid-session prompt changes were added.

Validation: typecheck and all 88 Node tests pass, including exact/ambiguous/wrecked/
distant identity matching, shared alias delivery, Tired/resume without duplicate
boarding, and unresolved admission without boarding. Required Python runner: 27 tests
across runner, Logistics, resume and native skill integration. These are offline
behavioral/integration tests, not live destination acceptance. No controller was
started for this task. Next session: fresh cabin supply and passenger observations;
live passenger completion remains open under S14/A6.

## Passenger quote verification — 2026-09-11

Cabin preparation previously reported an unavailable purchase as `estimated_spend:0`
and accepted contradictory quote totals. Unknown source/quote costs now remain
`null`; filled quantities and prices must reconcile with the supplied subtotal,
and subtotal plus supplied tax must equal the total before either initial admission
or the final purchase. No tax rate or rounding estimate is invented. Owned stock
still has zero acquisition spending. Two behavioral regressions were proven failing
against the original implementation and passing with the fix.

Validation: `npm run typecheck && npm test` passes all 90 Node tests.
The required Python runner with the specified `HERMES_PYTHON` passes 27 tests across
runner, Logistics, resume and native Logistics skill loading. These are offline
fixtures/integration, not a live cabin purchase. The Codex skill quick-validator
rejects Hermes-specific frontmatter (`author`, `platforms`, `version`); the actual
Hermes native-load/catalog tests pass, and required Hermes metadata is preserved.

Checkpoint: this milestone changes `passenger-fit.ts`, `passenger-fit.test.ts` and
this record. Supplier-discovery implementation and README/Logistics guidance remain
separate uncommitted work. No controller was launched; process inspection found no
matching SpaceMolt controller and no controller lock was present. Last verified
pilot state remains the historical passenger wind-down receipt above (197,968
credits, serviced at Frontier Station/Deep Range, no freight/passengers/production;
distress missions retained), not a fresh game observation. Next: integrate bounded
faction trade-intel supplier leads, validate real Hermes dispatch, then attempt live
passenger preparation/delivery if fresh supply permits. Existing-berth readiness is
under separate shared-path review; S14/A6 remain open.

## Pending-command rejection correction — 2026-09-11

Independent review reproduced a shared command-boundary bypass: a nominal known
game rejection carrying `pendingCommand:buy` allowed a following operation to start.
`command-boundary.ts` now treats that marker as unresolved regardless of the rejection
code. The existing uncertain-send invariant uses the real pinned `SpacemoltError`
and proves the next send is blocked; the regression failed before the one-line fix.
Both targeted boundary tests pass, including recovery from an ordinary unflagged
known rejection. This is offline command-boundary evidence, not a live disconnect.

## Existing passenger berth readiness — 2026-09-11

The shared prepare path could report `completed/ready` for an installed cabin despite
excess CPU/power, missing cargo capacity or malformed cargo/module custody. Passenger
preparation now validates canonical capacity and custody before its existing-berth
shortcut and during fitting. A valid installed cabin still needs no purchase,
catalog or storage discovery. The shared regression was proven failing before the
fix; six targeted preparation tests pass. The passenger integration fixture now
supplies realistic canonical fitting fields and an installed cabin rather than only
a synthetic berth response. Shared Logistics Node integration and both required
Python Logistics tests pass. Generic servicing's broader capacity-validation gap
remains outside this passenger consumer fix; all-stance S4 is still open.

## Cabin supplier discovery integration — 2026-09-11

Quote-verification milestone committed locally as `babe13c48a` (no push).
The pinned 14.2.0 API has no global stock search or remote `estimate_purchase`:
`view_market` and purchase estimates are local. The concrete remote source is
item-filtered faction trade intelligence, requiring the faction's Commerce Terminal
capability. Its reports are historical leads, not fresh stock or all-in quotes.

The next increment uses that source only after observed local cabin supply is
unavailable, matches exact current public station identities within the Logistics
route limit, and retains the report tick, unknown current stock/cost, rejected
matches and explicit unavailable-intel result. It uses the existing passenger-fit
assessment and shared travel, preserving home and session prompt/catalog. No faction
mutations or remote purchase primitive are added. README and Logistics guidance
explain the observation limits. Independent review reproduced that normal travel
refresh erased supplier stations outside the shortlist. Supplier identities now
survive that refresh and resolve freshly before actual travel, including relocated
stations; missing/out-of-policy destinations remain blocked without outward movement.

Stable-tree validation: typecheck and all 94 Node tests pass, plus all 41 SpaceMolt
Python tests in 11 files through the required runner and specified Hermes Python.
The new Python test exercises actual AIAgent registration, native Logistics guidance,
BridgeClient and ExecutionHost dispatch with temporary HERMES_HOME; historical
supplier evidence survives while assets, home, context and catalog remain unchanged.
This is scripted offline integration, not real model inference or live supply.
The readiness and pending-command fixes are committed as `038741790d`; discovery
is ready for its own local milestone commit. The real local oMLX model probe and
Hermes imports pass. Next: recheck controllers/locks, start a fresh bounded real-Hermes
passenger objective with a 10,000-credit host preparation allocation, and verify
the resulting supply/capacity/delivery or precise blocker plus serviced stop.

## Live passenger supply checkpoint — 2026-09-11

Supplier discovery is committed locally as `eaaf50fe1d`, following `babe13c48a`
(quote integrity/unknown costs) and `038741790d` (passenger readiness and pending
command uncertainty). No commits were pushed. VISION.md remains unchanged.

Real Hermes through local oMLX ran the broad passenger objective with Logistics /
Focused locks and a 10,000-credit host allocation. It assessed current passengers,
assessed cabin fitting, and chose return/stop in three recorded model tool-call turns. The live
quote had zero cabins available and one unfilled; estimated preparation spending
correctly remained unknown. The actual faction-intel query returned `not_in_faction`.
The three observed destination identities resolved against the directory but were
outside the two-jump route allowance. No purchase, installation, boarding, outward
travel or delivery occurred. This establishes live blocker handling and safe stop,
not passenger acceptance or a globally unavailable cabin market.

Runtime: `spacemolt/runtime/shared-live-passengers-20260911-02`; process handle
`21109` exited 0. Fresh process inspection found no runner/bridge; controller lock
released. Saved checkpoint and final return/report are terminal; do not resume this
run as productive work. Final authenticated receipt at 2026-09-11T07:09:45Z:
Frontier Station / Deep Range, 197,968 credits, hull105/105, shields35/35,
fuel120/120, unchanged cargo (rounds1, carapace1, phase pearls2, carbon ore6,
platinum ore1). Gross spending0, net cash0. No freight, onboard passengers or queued
production; three active distress missions remain recorded and unresolved.
Reviewed evidence: `spacemolt/evidence/shared-live-passenger-supply.json`.

Checks actually run on the final implementation: `npm run typecheck && npm test`
(94 Node tests); the required Python runner with the specified `HERMES_PYTHON`
(41 tests across all 11 SpaceMolt Python/native-skill files); `git diff --check`;
real oMLX model discovery and Hermes imports. Fixture failures during development
were corrected and all final checks pass. No source edits occurred during live play.

Remaining work / exact next action: close the independently reproduced generic
servicing capacity/custody-validation gap in S4 through shared readiness and return
tests, then continue the TODO dependencies. Passenger preparation now validates
these inputs, but generic service/return still needs the same invariant. For S14/A6,
the pilot needs cabin supply and a reachable passenger offer: use a bounded
non-faction acquisition/discovery workflow with fresh local quotes or future actual
stock; do not rerun the same blocked intel query as if it might establish supply,
join a faction implicitly, or relax route/cost limits. Successful live passenger
delivery, the other unfinished stance consumers and the full acceptance grid remain
open. This record and its evidence form the final checkpoint commit; source
milestones and skill/README changes are committed with no unfinished source edits.

## Shared readiness and service lifecycle verification — 2026-09-11

Closed the concrete S4 validation gap left by the live passenger checkpoint.
`readiness.ts` now supplies canonical capacity/custody validation reused by shared
servicing and passenger fitting. Missing, malformed or exceeded resource fields,
invalid inventory/module identities, nonnumeric mining capability and invalid
safety-option types cannot establish readiness. The mining refit pins ship/dock,
preserves original assets and removed scanner through all later steps, and verifies
the exact newly installed laser plus consumption of one owned cargo unit.

Independent review reproduced additional failures in the real service functions:
a shield wait could finish ready after crew incapacitation or wallet depletion;
an internal refresh could change ship/dock before spending; and a changed fuel
deficit could exceed the allocation before post-purchase rejection. `servicing.ts`
now checks captured identity and retained assets before/after commands, revalidates
current readiness after waits, and rejects changed fuel quote inputs before refuel.
Return movement remains available when readiness metadata is incomplete: a shared
test reaches home dock but correctly reports servicing blocked without purchase.
Defense ownership, session prompts/catalogs and remembered home are unchanged.

Evidence: new/extended behavioral regressions were proven failing against unfixed
code, then passed with the implementation. The real Hermes registry → Python
BridgeClient → ExecutionHost regression in `tests/test_spacemolt_readiness.py`
uses temporary HERMES_HOME: invalid capacity/cargo blocks preparation and terminal
serviced status despite planner prose claiming ready; valid state succeeds. The
shared and historical mining fixtures now contain complete canonical ship/module
data and consistent cargo effects rather than weakening production validation.

Checks run: `npm run typecheck && npm test` passes all 97 Node tests; the required
Python runner with `HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python`
passes all 44 tests across 12 SpaceMolt files. Final targeted return tests also pass,
including return with missing capacity and the quote-drift rejection. A recorded-data
replay of the actual authenticated snapshot at
`shared-live-passengers-20260911-02/observations/4ee642a8317347798008342b775e0d02.json`
passes the stricter readiness checks. This is fixture/integration and recorded-data
evidence; no new model inference, game connection or live servicing is claimed.
Independent review confirmed the original lifecycle and quote-drift reproductions
are fixed. README records the new completion conditions; VISION is unchanged.

Checkpoint: baseline commit `8f111a3c83`; this milestone includes readiness/service,
passenger validator reuse, their tests/fixtures, README and this TODO record. All
changes are local and will be committed together; no push. No controller was started
in this increment. Last tracked live handle `21109` exited 0; its runtime and terminal
checkpoint remain `spacemolt/runtime/shared-live-passengers-20260911-02`. Last verified
pilot state is still the 07:09:45Z receipt above: serviced at Frontier Station / Deep
Range, 197,968 credits, unchanged cargo, no freight/passengers/production and three
unresolved distress missions. Treat it as historical until a new authenticated query.

Remaining: all-stance S4 and acceptance remain open, including authoritative repair
pricing and future consumers. Exact next action is to assess a non-faction cabin
acquisition path using existing Industry production/retained-output mechanics and
actual recipe prerequisites, before implementing or launching another passenger
attempt. No same-state faction-intel retry, invented supply, expanded route bounds
or implicit faction membership is justified by the previous live blocker.

## Own-use cabin production audit — 2026-09-11

Shared readiness milestone committed locally as `a68731ae9b`; no source edits remain.
A bounded read-only audit found `build_economy_passenger_cabin` in `spacemolt/runtime/catalog-cache.json`, catalog
version `0.599.5`, fetched 2026-09-11T05:36:32.636Z: four titanium alloy, six flex
polymer and two life-support units produce one cabin, with `crafting_time:90`.
These are historical catalog facts, not current material availability or a quote.
The catalog/pinned recipe schema omit required skills/facilities; historical crafting2
and engineering0 prove neither eligibility nor rejection. Inspected historical
cargo/storage contained none of those inputs or the cabin; no prior cabin dry-run
was found.

The existing producer's admission requires sale depth and positive economic margin,
and settlement withdraws/sells all output (`industry.ts`). Retaining a cabin therefore
needs an explicit persisted own-use disposition on the existing Industry job, with
unchanged input/craft quotation, allocation and custody checks, no output-demand
requirement, verified retained output, and spending reported without invented sale
earnings. Then a normal session handoff to Logistics can use its existing owned
storage/cargo cabin fitting path. This extends complete production rather than adding
a cabin-only executor or silently changing disposition during settlement.

Exact next prerequisite observation: a fresh read-only craft dry-run for this recipe
at the authenticated current station. Its actual skill/facility/material/cost result
must guide whether to implement or launch the retained-output acquisition path.
No live call or new controller occurred during this audit; the terminal live checkpoint
and outstanding missions remain those recorded above. S12/S14 and A4/A6 remain open.

## Retained production implementation — 2026-09-11

Baseline local commit `ed4285ad39` records the cabin audit. A fresh authenticated
read-only prerequisite probe now confirms the station workshop quotes the cabin:
four titanium alloy, six flex polymer and two life-support units, one cabin, zero
craft fee, about 84 ticks while docked. Titanium and life-support purchase quotes
have no supply; polymer six costs 470 including tax. Missing acquisition costs
remain unknown, not zero. No purchase, craft, fitting or movement occurred. Evidence:
`spacemolt/evidence/cabin-craft-prerequisite.json`; private runtime
`spacemolt/runtime/cabin-craft-prerequisite-20260911`, bridge PID2250 exited0. The
initial sandbox network attempt failed before WebSocket open and exited before the
successful authorized retry. This is a script prerequisite observation, not Hermes
inference or completed production. Last verified pilot remains docked at Frontier
Station / Deep Range / mobile_capital, 197,968 credits, full fuel120, hull105,
shield35, unchanged cargo/modules; the three historical distress missions remain
unresolved. Remembered home identity is unchanged.

Implementation in progress extends the existing Industry executor with persisted
`sell` (default) or `retain` disposition. Retain requires complete current input and
craft costs and verified personal-storage output, with no invented sale earnings or
profit. Shared assessment will discover actual recipe IDs using an output-name/ID
search, then quote them; later Logistics fitting still requires normal session
handoff. Pending workshop work must resume the original experiment without another
craft. Review reproduced an existing input/output overlap ambiguity: unchanged or
refunded original stock could masquerade as produced output. Such recipes require
an explicit blocker until job-specific completion attribution exists.

Prerequisite evidence committed locally as `0307abbd2f`. Retained production is now
integrated through the shared tool catalog, worker, persisted settlement, native
Industry skill and verified reports. Default selling is preserved. Retained outcomes
have zero sale earnings, actual spending/cash delta, null economic profit, personal
storage location and an explicit observation basis. Own-use quotes/outcomes do not
become trading recommendations or economic losses in strategy funding; wallet
headroom still constrains spending. Contradictory queue counts and input/output
overlap cannot prove completion. Explicit authoritative zero workshop cost is
accepted without inventing absent fee components. Pending resumption retains the
original allocation and cannot craft twice or change purpose.

Final validation run: `npm run typecheck && npm test` passes101 Node tests. Required
Python runner with the specified HERMES_PYTHON passes46 tests across all12 SpaceMolt
files, including actual Hermes imports/registry/BridgeClient/ExecutionHost and native
skill loading in temporary HERMES_HOME. Retained custody, queued resume and economic
strategy regressions failed before their fixes. Diff check passes; VISION unchanged.
These are fixtures/integration checks, not live retained-production acceptance.

First real Hermes/oMLX offline production attempt reached retained discovery/quote
but confused a quote comparison key with an experiment ID, then stopped without
crafting or spending. This prompted explicit quote-only guidance and valid new-job
parameters, plus skill guidance. Its runtime
`spacemolt/runtime/shared-retained-production-model-ye8170sd`, tool handle26601,
exited0; a fresh model-fixture retry is tracked separately. Retained production is an
optional capability, not a requirement to obtain a cabin. The user explicitly
clarified that Codex itself may play Kvothe to discover needs and alternatives.

Direct Codex exploration is active at runtime
`spacemolt/runtime/codex-exploration-20260911`, tool handle45882, bridge PID3593.
No competing game controller was present before login. Kvothe visited Deep Range
Outpost from Frontier Station and found no cabin sellers, differing equipment stock,
a struggling station and construction short2850 lead shielding. Five current
unresolved distress missions are now observed. Accepted return freight
`cace55e0d6f6b93a802a8bdf3c45b367` for549 credits, package
`ef3295a02b890c7814ec47ac4d13cb6e`, verified withdrawal from station storage into
cargo (100volume;111/120 used), and is returning to Frontier Station. This is direct
Codex gameplay, not Hermes live acceptance. Exact immediate action: follow existing
handle45882 travel to mobile_capital, dock, deliver once, verify payout and emptied
obligation, resupply with current quote, then close and save final checkpoint.
S12/S14 and A4/A6 remain open; live retained production is not demonstrated.

## Direct Kvothe exploration and retained-model evidence — 2026-09-11

Implementation milestone committed locally as `586ecd4500`; prerequisite observation
is `0307abbd2f`. The implementation commit includes all source, skill, report and
behavioral regression changes listed above. Nothing was pushed; VISION is verbatim.

Actual Hermes/oMLX retry completed an offline retained job at
`spacemolt/runtime/shared-retained-production-model-ihdkiiia`; tool handle51985
exited0. It selected home, searched an output name, quoted observed recipe `refine`,
consumed owned ore2, crafted once, and retained metal2 in personal storage. Gross
cost3, earnings0, production cash delta-3; wallet+97 included unrelated fixture
income100 and is not production profit. Original cargo survived, queue is empty and
final readiness is full. Hermes initially included a comparison ID as experiment_id,
then corrected the rejected request; guidance improved recovery but has not eliminated
this planning mistake. Both failed and successful attempts are preserved in
`spacemolt/evidence/shared-retained-production-model-fixture.json`. This proves real
inference through the offline game fixture, not a live retained-production job.

Direct Codex gameplay completed a distinct live exploration and return freight job.
At Deep Range Outpost, observed equipment asks differ materially from Frontier:
cargo expander II2154 versus4988, armor plate I1222 versus1679, damage control4977
versus10459. These are acquisition observations, not arbitrage profits; output buyer
depth was not established. No cabin sellers were quoted there either. Station
condition is struggling (66 percent infrastructure satisfaction); construction of an
enriched uranium extraction unit awaits2850 lead shielding. These support broader
needs/supplier reconnaissance instead of treating crafting a cabin as mandatory.

Return freight `cace55e0d6f6b93a802a8bdf3c45b367` was delivered intact at Frontier
Station, with authoritative carrier payout549, cargo package removed, active freight
empty and zero debt/liability. Fuel fell120→118 over the round trip, and current
station all-in quote3/unit was verified against refuel receipt6 (market4+tax2).
Net wallet gain543; final credits198511. Original cargo/modules unchanged, hull105/105,
shield35/35, fuel120/120, cargo11/120, docked Frontier Station / Deep Range /
mobile_capital. No passengers or production queue remain. Five distress missions
remain unresolved, including the earlier three and newly observed
`7e90e5674cdef9743cf85984c776e640` and `b440eef2ecb1d76c0abd0f31074fa979` in Starfall.
Remembered home was never changed by the temporary Outpost visit.

Private runtime `spacemolt/runtime/codex-exploration-20260911` stores requests001–033,
ready state and terminal.json. Direct-controller tool handle45882 and bridge PID3593
both exited0 after final authoritative observations. Process review afterward found
no game controller. No active runtime requires continuation. This is Codex gameplay,
not Hermes playing; its market/freight evidence is separate from model acceptance.

Tests actually run after final worker changes: typecheck plus101 Node tests; required
Python runner with specified HERMES_PYTHON passes46 tests in12 SpaceMolt files. The
returned quote next_action is also exercised by the targeted4 shared-production
tests. Git diff check passes. No further source edits followed those checks.

Exact next action: implement a complete bounded requisition trip through existing
`prepare`, following S3/S4/S5 dependencies. Hermes chooses an observed item/shortfall
and up to three candidate stations; scripts verify routes and local supply, acquire
only the authorized shortfall under one purchase/travel/service allocation, verify
custody, return/service and record dated coverage and retained goods. Reuse locations,
shared travel/defense/journal/recovery/servicing and existing purchase accounting.
Do not expose legacy surveyMarkets unchanged: it lacks shared cleanup/recovery and
leaves unpriced fuel liability. Precise unavailable supply is not global absence;
construction needs do not prove paying demand. This supports both Logistics equipment
and Industry inputs without mandatory crafting or superficial Explore support.
Broader purchasing opportunities (including First Step and other reachable markets)
remain unobserved. Live retained-production and passenger acceptance, extended
workshop settlement and full-vision stance work remain open. Any next live connection
must check controller ownership and query fresh state.

Shareable direct-game evidence: `spacemolt/evidence/codex-market-exploration.json`.
Final evidence/TODO checkpoint will be committed separately from implementation;
no other uncommitted source work remains.

## Passenger-test setup steering — 2026-09-11

User clarified that Codex may directly control Kvothe generally to unblock skills or
scripts; Hermes inference is required for acceptance, not development setup. The
return-freight detour did not unblock passengers. General requisition implementation
is paused (neither IC edited files); current priority is directly obtaining usable
passenger capacity and positioning for a bounded Hermes passenger demonstration.

Active direct controller: `spacemolt/runtime/codex-passenger-setup-20260911`, tool
handle10611, bridge PID4440. Login and fresh state confirm198511 credits and full
serviced Cobble at Frontier Station before departure. Read-only remote listings had
no First Step ships under10000, and no technically_legal at Starfall/voidGate.
A fresh route to First Step Memorial Station is Deep Range→Horizon→First Step,
two jumps quoted4 fuel. Root undocked and submitted jump to Horizon; follow existing
handle10611 and record authoritative arrival before another movement. Do not open a
competing controller or treat an observation timeout as terminal.

Alternate capability found in pinned catalog/API: T1 cogito/technically_legal each
have one inherent economy berth, nebula_tender two, loose_change four. These are
capability leads, not owned/available ships. NPC shipyards expose commission_quote
and credits-only commission_ship, but can wait for materials; submission is not an
owned usable ship. list_ships/switch_ship and canonical berth query are required to
verify that alternative. No ship commission or purchase has been made. First Step
local cabin market remains unobserved. No new code tests were needed/run in this
setup increment; prior101Node/46Python milestone remains the last source validation.

Passenger setup continuation: prior handle10611/bridge4440 exited0 after docking and
refueling at First Step (fuel5 cost15; credits198496). The private diagnostic bridge
adds pinned fleet/commission queries for direct Codex use without changing repository
policy or a Hermes session. Current runtime
`spacemolt/runtime/codex-passenger-fleet-20260911`, handle8726, bridge PID4659.
Fleet query confirms only the active Cobble. First Step quotes technically_legal
credits-only80377 and loose_change68780, both above the configured spend and150000
reserve. No commission was submitted. Cabin market quote has no sellers; a life-support
quote initially offered2 for3847 but a fresh quote later showed0. Codex mistakenly
submitted the buy after that fresh unavailable quote; server rejected it with no
credit/item change or standing order. One mistyped storage action was policy-rejected
before game dispatch. These are operator errors, not script acceptance evidence.

Verified withdrawal of4 owned titanium alloy from First Step storage into cargo
(15/120 used, original cargo preserved). Current direct operation is a quoted one-jump
trip First Step→Void Gate (fuel quote2) to inspect another cabin/material market;
jump submitted and existing handle8726 must be followed to authoritative arrival.
No passenger capability is installed and no production/ship commission is pending.
General requisition implementation remains paused; setup is unfinished.

## Passenger prerequisite checkpoint — 2026-09-11, 07:59Z

Evidence: `spacemolt/evidence/codex-passenger-setup.json`; private resume state:
`spacemolt/runtime/codex-passenger-fleet-20260911/resume-checkpoint.json`.
Known controller PIDs are absent and no controller lock remains.

Direct setup has not yet produced passenger capability. First Step and Void Gate
both explicitly quote no cabin sellers; Void Gate also has no life-support sellers
or waiting passengers. First Step's previously available two life-support units were
no longer available at the fresh quote. No cabin/material purchase succeeded. NPC
credits-only hull quotes80377/68780 exceed the10000 spend ceiling and150000 reserve;
Cogito/Nebula Tender commissioning is rejected at this non-home-empire yard. Remote
Starfall and Unknown Edge listings under10000 are empty; Ramen's Rest lists only a
Prayer hull, not established passenger capacity. No commission or standing order was
created. These are local dated supply limits, not proof of global unavailability.

Final direct-controller observations: credits198487 (198511 start minus24 fuel
purchases), fuel120/120, hull105/105, shield35/35, cargo15/120. Original cargo and fit
preserved; additional titanium_alloy4 was withdrawn from owned First Step storage,
which retains1. Docked at Void Gate Outpost / void_gate. Remembered home remains
Frontier Station; this temporary service stop did not select a new home. This is
three jumps from the last home region, so do not start a shared two-jump return on
assumption; direct repositioning or a verified multi-leg plan is needed first.
Passenger count0, crafting queue empty, active freight empty, ship commissions empty.
Four missions now appear active: fff0b7ce092ff4f0d31ebd19977b803f,
2a23e470f63feb5b23c1be98a5bcf466,7e90e5674cdef9743cf85984c776e640,
b440eef2ecb1d76c0abd0f31074fa979. The prior Void Gate distress mission is no longer
active; its disposition is not proven by that absence, and no completion credit is
claimed. Completed-mission query was saved for inspection.

Both private controllers are terminal: codex-passenger-setup-20260911 handle10611 /
PID4440 exited0; codex-passenger-fleet-20260911 handle8726 / PID4659 exited0. Followed
actual process handles through every travel, dock and service; no uncertain mutation
was retried and no controller was restarted based on timeout. The fleet launcher
only extends the private diagnostic command set, not repository policy or Hermes's
session catalog. Current source remains the verified f813df1428 baseline. Only TODO
and new sanitized passenger-setup evidence are being committed in this increment;
no tests run because no production/test code changed. JSON/evidence checks and git
diff check are the validation here; prior101Node/46Python results remain historical.

Exact next action: continue direct passenger prerequisite work from the verified
Void Gate dock, checking ownership before reconnect. Starfall is an observed adjacent
market not yet inspected locally for cabins; quote its actual route before travel.
Do not repeat the vanished First Step supply without new evidence, buy a hull beyond
limits, or claim a cabin has been acquired. If buying remains unavailable, compare a
fully quoted materials route before extending any crafting chain. Two life-support
units plus one cabin need titanium4, polymer18, boards6, steel4 and water6 when the
life-support units themselves must be produced; only titanium4 is staged. No such
chain is admitted yet. Once capacity is actually installed and canonical berths
verified, position for a bounded real-Hermes passenger job. General shopping-trip
implementation stays paused per user steering; full VISION and passenger acceptance
remain unfinished.

## Passenger materials and purchase-tax fix — 2026-09-11

Baseline commit is `d3d589c8a0`. Direct Codex setup (not Hermes acceptance) reached
Starfall Salvage Station from Void Gate and bought two life_support_unit after a
fresh fully filled quote: subtotal3819, tax19, actual debit3838. Verified both units
in cargo. Refueling three units cost9 including tax3. Evidence and replay inputs:
`spacemolt/evidence/codex-passenger-starfall.json`. No economy cabin sellers were
quoted; a business cabin ask30000 exceeds the configured10000 allocation and was
not purchased. No wrecks or waiting passengers were observed locally.

This exposed a production accounting bug: accepted buy `details.total_cost` excludes
tax. `execute.ts` now captures the canonical lifetime credits_spent counter before
submission and in the accepted response, durably before refresh can fail. The shared
spending parser conservatively charges that observed interval, preserving the raw
subtotal. Concurrent income cannot conceal spending; unrelated interval debits also
consume the allocation. Missing, decreasing or inconsistent counters remain unknown
costs and block further spending. Historical receipts lacking this evidence are not
silently assigned a tax estimate. Regression tests were reproduced red before the
fix; taxed fixtures now exercise actual sendAndRefresh and shared durable recovery.

Validation actually run: from spacemolt, `npm run typecheck && npm test` passed104
Node tests. `HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python
scripts/run_tests.sh tests/test_spacemolt*.py tests/skills/test_spacemolt_industry_skill.py
tests/skills/test_spacemolt_logistics_skill.py` passed46 tests across12 files, including
real Hermes imports/registry/BridgeClient/ExecutionHost in temporary HERMES_HOME.
Recorded live data replay through sendAndRefresh and commandSpend confirms3838 gross
spend while preserving3819 subtotal in both accepted callback and returned receipt.
These are fixtures, integration checks and a recorded-data replay, not a new Hermes
live job. Diff check passes; VISION remains verbatim.

Terminal direct runtime: `spacemolt/runtime/codex-passenger-starfall-20260911`, tool
handle11027 and bridge PID5019 exited0; terminal.json records exit and subsequent
process inspection confirms PID absent. No controller is active. Last authoritative
state: docked starfall_salvage_station / starfall, credits194640, fuel120/120,
hull105/105, shield35/35, cargo19/120. Original cargo and modules preserved; staged
materials are titanium_alloy4 and life_support_unit2. No passengers, freight or craft
queue remain, and no ship commission was submitted. Only Unknown Edge distress
mission `2a23e470f63feb5b23c1be98a5bcf466` remains in the active listing; absent Starfall
missions are not claimed completed or paid. Remembered home remains Frontier Station,
last observed in Deep Range / mobile_capital; temporary servicing did not change it.

Files in this verified milestone: TODO.md, spacemolt/README.md, execute.ts and its new
behavioral test, spending.ts/test, execution-fixture.ts, production-fixture.ts,
industry.test.ts, passenger-fit.test.ts, new shared-buy-spending.test.ts,
tests/test_spacemolt_production.py and sanitized Starfall evidence. Commit this set
locally as `Account for purchase tax using accepted spending counters`; no push.
No unrelated uncommitted work was present. The commit containing this record closes
the accounting bug, not passenger setup or the full vision.

Exact next action: check controller ownership, reconnect and query fresh state, then
quote a route toward Frontier's previously observed polymer supply. The staged cabin
recipe now needs only flex_polymer6 plus an available workshop; re-quote local supply,
all-in costs and craft prerequisites before buying or queuing. Crafting is a fallback,
not mandatory: a currently available affordable cabin remains a valid alternative.
Starfall is three jumps from the last home region, so use a verified multi-leg route,
not an assumed shared two-jump return. A queued cabin takes about84 docked ticks;
verify completion/output custody before fitting and preserve the removed mining laser.
Canonical berths must exist before a bounded real-Hermes passenger demonstration.
General requisition implementation remains paused; live retained production,
passenger acceptance and full-vision integration remain open.

## Materials staged and live workshop receipt mismatch — 2026-09-11

Purchase-tax fix committed as `7506d0f973`. Direct Codex setup returned Starfall →
The Telescope → Horizon → Deep Range → Frontier Station, with fresh route/arrival
verification. Bought flex_polymer6 for470 (subtotal468 +tax2); the patched bridge
captured canonical spending37568→38038. Deposited titanium_alloy4, life_support_unit2
and flex_polymer6 into personal Frontier storage, verifying cargo/storage deltas and
preserving original cargo/modules. Fresh cheap quote selected workshop, explicit
credits_total0, have_inputs true, ~84 docked ticks. Refuel7 cost21. One operator
request used invalid amount instead of quantity; server rejected it without effects.
Evidence: `spacemolt/evidence/codex-passenger-polymer.json`. Direct runtime
`spacemolt/runtime/codex-passenger-polymer-20260911`, handle34813/PID6014 exited0,
PID absent and lock cleared before Hermes launch. Final credits194149, fuel120,
hull105, shield35, cargo11, docked frontier_station/mobile_capital/deep_range.
No queued craft, freight or passengers existed at that direct checkpoint. Three
active distress missions were observed (Unknown Edge twice, Zosma); no completion
or payouts claimed. This closed material staging, not passenger capability.

Real Hermes/oMLX then ran shared Industry at
`spacemolt/runtime/shared-live-cabin-retain-20260911-01`, handle31474 exited1 and
bridge PID6290 absent/lock cleared. It corrected an initial output_search lacking
retain disposition, discovered/quoted the cabin, and queued exactly one retained
workshop craft. Shared job6d12fa84-4702-469d-a2de-78b74c625134,
experiment63fb6218-3bd3-440c-b5cf-30fec213c792,
server jobc711344461b35498e31c07b6442fd4a9. Accepted escrow includes inputs but omits
labor/fee; existing parser refused to invent zero and suspended needs_reconciliation.
Cleanup verified docked/full readiness without movement. No completed production or
passenger acceptance is claimed. Remembered Frontier home identity was preserved;
its historical system cache is Horizon, while authenticated current dock resolves
Deep Range correctly.

Read-only direct reconciliation observation:
`spacemolt/runtime/codex-cabin-reconciliation-20260911`, handle93926/PID6594 exited0.
Fresh get_status shows lifetime credits_spent38059, identical to pre-craft accepted
refuel receipt codex-passenger-polymer-20260911/017.json, with the same pilot identity.
Thus the observed interval had zero debit; the quote alone is not actual-cost proof.
Queue still contains the original job, progress20.4%, eta67ticks; materials are consumed
and no cabin yet in storage. No new craft or paid command was submitted. Latest
credits194149 and full readiness at Frontier; latest status lists four distress
missions, to retain by exact IDs in the eventual final checkpoint. No controller is
currently active, but the dock-dependent workshop job remains an obligation.

Development in progress: extend accepted craft spending evidence with a durable
before counter and authoritative post-refresh counter; preserve unknowns on refresh
failure and conservatively count unrelated debits. Reconcile the exact accepted craft
into the persisted experiment once, clearing its pending marker only with proven
accounting/job identity, then resume existing settlement without another craft.
The old live receipt lacks the baseline, so a backed-up private checkpoint evidence
restoration from the recorded pre-craft receipt will be explicitly classified manual.
No new code validation has run yet in this increment; prior104Node/46Python results
remain the baseline. Commit material evidence/TODO separately while source fixes are
unfinished. Exact next action: finish and verify that fix, reconcile this original
job, then let real Hermes select its persisted experiment and verify retained cabin
custody. Fit and canonical berths/passenger demonstration remain unfinished.

## Workshop spending and accepted-craft recovery fix — 2026-09-11

Material staging evidence committed as `74e5f742f3`. The live workshop mismatch is
fixed without treating omitted fees or a quote as actual spending. sendAndRefresh
persists accepted craft with its before counter, then enriches the same action with
an authoritative counter after refresh. Missing/decreasing counters remain unknown;
explicit escrow costs remain supported. Reconciliation completes before-only evidence
from a fresh canonical counter, includes unrelated interval debits conservatively,
and resolves the exact saved craft/job identity into its experiment once. It clears
only that accounted pending marker and leaves output settlement unfinished.

Verified regressions were red on prior implementation. `npm run typecheck && npm test`
passes106 Node tests. Required Python runner with specified HERMES_PYTHON and all
SpaceMolt/native-skill test files passes46 tests across12 files. Coverage includes
actual Hermes imports/registry/BridgeClient/ExecutionHost, refresh loss, preserved
acceptance, repeated reconciliation without duplicate cost/craft, original allocation,
and retained output custody. README documents the accounting contract. VISION unchanged.

For the already accepted historical job, root backed up the private pilot checkpoint
at codex-cabin-reconciliation-20260911/pilot-before-evidence-restoration.json and restored
only its missing before-counter evidence from the recorded accepted refuel receipt.
Same-pilot baseline38059 and later authoritative38059 were verified. The action records
source paths, reason and pre-edit SHA256 in operator_evidence_restoration. This is
manual historical evidence restoration, not proof of autonomous old-receipt migration.
No job ID, production status, stop latch or cost was manually rewritten.

An attempted fresh --new-run at shared-live-cabin-retain-20260911-02 correctly rejected
the unreconciled state before productive dispatch, exiting1. The ordinary recovery
run at shared-live-cabin-retain-20260911-recovery, handle32997 exited0, then used actual
script recovery: original shared job becomes interrupted, gross spending0, production
pending with the same job ID and no pending_action/accounting_unverified marker.
Final return receipt verifies docked serviced Frontier state. All involved controller
locks cleared before the next connection. No cabin custody is claimed yet.

Active real Hermes/oMLX resume attempt:
`spacemolt/runtime/shared-live-cabin-retain-20260911-03`, handle52520. It must observe
and select the saved experiment, never enqueue a replacement. Follow this process
handle through completion; no competing connection. The accepted workshop obligation
remains c711344461b35498e31c07b6442fd4a9; last direct queue observation was eta67ticks,
20.4percent progress, materials consumed and no cabin yet. Last verified credits194149,
full fuel120/hull105/shield35, original cargo11, Frontier dock; remembered home preserved.

Source milestone files: execute.ts/test, spending.ts, recovery.ts,
shared-production.ts/test, README and this TODO. Commit locally after evidence/diff
review as `Reconcile workshop spending from authoritative counter intervals`. No push.
Exact next action: follow active Hermes handle52520, verify it selects the original
experiment and script-owned pending/completed settlement; after terminal controller
exit, obtain canonical cabin storage custody and fit/berth proof before passenger
acceptance. Full vision remains open. Workshop completion is not implied by this fix.

## Live retained cabin completed — 2026-09-11, 08:40Z

Workshop accounting/recovery fix committed as `f0f4def658`; materials evidence is
`74e5f742f3`. Real Hermes/oMLX sessions03,04,05 each selected the original persisted
experiment63fb6218-3bd3-440c-b5cf-30fec213c792. Scripts polled and settled the same
server jobc711344461b35498e31c07b6442fd4a9, with no new craft, purchase or sale.
Session05 verified queue absence AND economy_passenger_cabin1 above starting personal
storage at Frontier Station. Original cargo/storage assets were preserved. Production
spent0, earned0, crafting XP145→160. Purchased setup inputs cost4308 separately
(life support3838 +polymer470); those capital inputs are not free or sale earnings.

This is real-model live retained production and later model-selected settlement,
with the explicitly documented manual historical counter-baseline repair between
acceptance and recovery. It is not proof that the old receipt recovered unaided.
Evidence: `spacemolt/evidence/shared-live-cabin-workshop-recovery.json`; full private
runs shared-live-cabin-retain-20260911-01/recovery/03/04/05. Node106/Python46 validations
from f0f4def658 remain current; no production code changed after those checks.

All production controllers are terminal:03 handle52520/PID6907 exited0;
04 handle67118/PID7099 exited0;05 handle36359/PID7247 exited0. Each actual process
exit and released lock was checked before another connection. Final authoritative
state: credits194149, fuel120/120, hull105/105, shield35/35, cargo11/120, original
modules intact, docked frontier_station/mobile_capital/deep_range. Cabin1 remains in
personal storage, not fitted. Queue empty, no passengers or freight. Three active
Unknown Edge distress missions remain:2a23e470f63feb5b23c1be98a5bcf466,
5d71554aad53fcbbd6551bc2dadab278,f854b7a203c7c7089f144c4521a8cf9b. Other mission
disappearance is not proof of completion. Remembered Frontier home identity remains
unchanged. User asked whether connected; fresh process and lock inspection confirmed
no controller at that point.

Next acceptance was launched after another ownership check:
`spacemolt/runtime/shared-live-passengers-cabin-20260911-01`, handle54408, real Hermes
via local oMLX, Logistics/Focused, max_spend100. Objective fits the owned cabin with
mining-laser custody preserved, verifies berths, then assesses and performs one
supported passenger destination under shared return policy. No equipment purchase,
crafting, asset sale or freight is authorized by this run's objective. Follow this
handle; do not reconnect in parallel. Exact next action: inspect actual fit/assessment
receipts and continue this process to verified delivery or precise blocker plus
serviced terminal state. Passenger acceptance, complete Logistics integration and
full VISION remain open. Commit this completed retained-output evidence locally;
only evidence/TODO edits exist beyond f0f4def658, and nothing is pushed.

## Owned cabin fitting completed — 2026-09-11

Real Hermes Logistics run shared-live-passengers-cabin-20260911-01 completed fitting:
withdrew cabin1 from personal Frontier storage, removed only mining_laser_i and
verified it in cargo, installed economy_passenger_cabin, and verified12 free/total
economy berths. Other modules and original cargo preserved; cost0. Fresh passenger
assessment at Frontier had no destination filter and no waiting passengers, so no
transport was attempted. Scripts returned/serviced and stopped. Handle54408 exited0,
bridge PID7617 absent and lock released. Credits194149, fuel120/hull105/shield35,
cargo21/120 including preserved laser, Frontier dock. No passengers/freight/queue.

A direct read-only confirmation at codex-passenger-boarding-20260911 verified12
berths and a current zero-jump route to Deep Range Outpost. No movement or paid
command was sent; handle51349/PID7730 exited0. Shared Logistics already supports
travel to that station while preserving remembered home, so the next Hermes run can
exercise integrated travel and passenger discovery instead of requiring direct
positioning. Evidence will be recorded in shared-live-passenger-fit.json.

Retained production evidence now includes terminal03/04/05 and completed cabin
custody, rather than only a pending checkpoint. No production code changed since
f0f4def658's106Node/46Python verification; this increment validates actual live effects
and JSON/diff consistency. Commit TODO plus completed workshop evidence now. Exact
next action: fresh Logistics run to inspect the observed Outpost, deliver one feasible
passenger destination if offered, then return/service at remembered Frontier. Recheck
controller ownership first. Passenger acceptance remains open, not blocked globally
by Frontier's local empty board. Nothing is pushed; VISION remains verbatim.

## Passenger discovery scope correction — 2026-09-11

Completed workshop evidence committed as `15db97fc41`; completed real-Hermes fitting
and12-berth custody proof as `80775a2b1b`. Fresh shared Logistics Outpost run01 at
shared-live-passengers-outpost-20260911-01 traveled to Deep Range Outpost, serviced,
then returned to Frontier without assessing the station board. The actual model
mistook obligations.passengers count0 (aboard) for zero waiting offers. Its statement
that Outpost had no passengers is unsupported; no station-board observation occurred.
Shared travel and home-preserving return worked, spending3 each for6 total, final
credits194143/full120/105/35/cargo21. Handle97161/PID7812 exited0, PID absent, no lock.
No passenger boarded or delivered, and original cargo/modules/laser remained intact.

Fix: obligations retain their server count/passengers/berths fields and explicitly
label onboard_ship scope with station_offers not_observed. This is shared data
semantics, not a Logistics tool advertised in other stances. Logistics skill now
teaches a fresh job__assess after each boarding-station arrival; empty onboard lists
cannot establish an empty board. No Hermes-core capability added, and no live
session prompt or catalog changed. Behavioral regression demonstrates empty onboard
custody alongside a real waiting offer discovered only by assessment; failed on prior
code. Typecheck +107Node tests and required Python runner46 tests across12files pass,
including real Hermes imports/registry/BridgeClient/ExecutionHost/native skill loading.

Fresh real-Hermes retry is active at
spacemolt/runtime/shared-live-passengers-outpost-20260911-02, handle6801, Logistics/
Focused, max_spend100, unchanged discovery/transport/return objective. Prior controller
exit and empty lock set verified before launch. Follow the handle and verify actual
station assessment, selected transport or precise blockers, final custody/fare and
return. Do not repeat the unsupported empty-board claim or start another controller.
Files in this fix are obligations.ts/test, native Logistics SKILL.md and this TODO;
new sanitized discovery evidence is being prepared separately. Commit the verified
observation/skill correction locally; model-retry acceptance remains unproven until
its recorded behavior exists. VISION unchanged; no push. Passenger delivery and full
vision remain open.

## Live passenger discovery correction verified — 2026-09-11

Observation/skill fix committed as `ab0effc90b`. Fresh real Hermes/oMLX retry02
actually called passenger assessment at Frontier and again after Outpost arrival.
Frontier now offered an economy passenger to Grand Exchange Station; the destination
was outside the two-jump policy. Outpost offered a passenger whose destination was
also outside that policy and whose class lacked a free berth. These are dated local
offers with explicit feasibility blockers, not an empty station or global absence.
Hermes correctly used actual offers rather than onboard counts. Scripts verified
travel, service, home-preserving return and terminal obligations. No passenger was
boarded/delivered; passenger acceptance remains open. Evidence:
`spacemolt/evidence/shared-live-passenger-discovery.json` includes the failed01 and
corrected02 behavior, excluding private model reasoning.

Runtime shared-live-passengers-outpost-20260911-02 handle6801 exited0; bridge PID8141
is absent and no controller lock remains. No live runtime needs polling. Last
verified Kvothe: credits194137, fuel120/120, hull105/105, shield35/35, cargo21/120,
docked frontier_station/mobile_capital/deep_range. Cabin installed with12 free economy
berths; displaced mining laser remains cargo, other modules and original cargo intact.
No passengers, freight or craft queue. Six active distress missions remain:
2a23e470f63feb5b23c1be98a5bcf466,5d71554aad53fcbbd6551bc2dadab278,
f854b7a203c7c7089f144c4521a8cf9b (Unknown Edge),
5c9bc23fa56b3cd0774b57ba60e7eff5 (Altais),
84329d25261cee50f7909cb7c94d43d2 (Void Gate),
7174b196617c87cc44ecf45242914bb8 (Starfall). No mission payouts claimed.
Each Outpost run spent6 for servicing (3 outbound destination,3 home), separate from
cabin capital and zero transport earnings. Remembered Frontier home is preserved.

Tests actually run for the last source change: typecheck +107Node tests;
HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python via
scripts/run_tests.sh passed46 tests across12 SpaceMolt/native-skill files. Fixtures
prove onboard/waiting separation and real Hermes imports/dispatch/skill loading;
retry02 proves corrected real-model live assessment. No source changes followed
validation. Remaining uncommitted files are this TODO and sanitized discovery
comparison evidence, to commit locally as the completed discovery correction proof.
VISION unchanged and nothing pushed.

Exact next development job follows D7/S5/S14: inspect and complete transport itinerary
admission before broadening route limits. The current1/2-jump mood cap is deliberate
initial policy, not a library restriction. Current passenger admission checks outbound
route and fuel reserve, but does not establish an outbound-plus-home-return service
budget, route hazard evidence, or a travel-time feasibility check against actual
post-boarding deadlines. Do not simply raise the cap to admit Grand Exchange. Build
and test a complete bounded itinerary/return-cost contract using existing locations,
travel, service, spending and recovery; maintain unknown costs as unknown. A fresh
read-only route quote can determine actual current distance for this offer, without
boarding or speculative travel. Audit also found survey.ts routeSteps independently
rejects routes above2 jumps, and locations.ts directory expansion caps at5. Separate
route validation from caller allocations before widening Logistics, preserving the
survey's explicit existing cap. Pinned find_route accepts only destination (no from
origin) and reports fuel/jumps but no duration; future-origin return routes and ETA
must remain qualified estimates/unknowns unless grounded in actual map/timing data. Passenger live delivery, universal route/defense
integration, general requisition (still paused) and full VISION remain unfinished.

## Route validation separated from survey allocation — 2026-09-11

Baseline checkpoint commit `5af166a899` records the live passenger-discovery correction.
Development only this increment; Kvothe remains disconnected. Extracted routeSteps
from survey.ts into normal-route.ts with a required caller maxJumps allocation. All
five existing consumers explicitly retain2; no route policy or live admission was
widened. Normal path endpoints, count/index consistency, wormhole exclusion and fuel
field validity remain checked. Survey retains its own cap rather than imposing it
implicitly on all consumers. The separate mining-experiment local validator has a
different existing contract and remains unchanged.

Typecheck +109Node tests pass, including new caller-allocation and malformed-route
invariants. Required Python runner with specified HERMES_PYTHON passes46 tests across
12 SpaceMolt/native-skill files. Real imports/registry/BridgeClient/ExecutionHost paths
remain covered; this is fixture/integration validation, not a live longer route.
Source milestone files: normal-route.ts/test, import/call updates in survey.ts,
execution.ts, execution-logistics.ts, logistics.ts and combat.ts, plus this TODO.
Commit locally as `Separate normal route validation from caller jump allocations`.
VISION unchanged; no push. No unrelated uncommitted work exists.

Mechanics audit found no pinned formula for local-travel fuel/duration or passenger
mass effects. find_route estimates exclude local travel; recorded same-Cobble trips
showed jump2 and local1, but those observations are not universal upper bounds.
Forward routes also do not prove reverse edges. Preserve explicit uncertainty and
post-loading revalidation; do not invent a guaranteed ETA or global max fuel burn.

Next concrete integration closes a preboarding return-reachability gap: an admitted
outbound route can fit2 jumps while its destination lies more than2 jumps from home,
which the actual cleanup executor cannot traverse. Resolve the remembered home from
the destination using the existing fresh directed-map/directory provider before
accepting or boarding, repeat after loading to catch mobile-home changes, and retain
that scoped evidence. This is reachability only, not complete fuel/service/deadline
admission. Broader itinerary economics, timing and longer-route policy remain open.
Last verified pilot and outstanding missions remain the194137-credit serviced
Frontier checkpoint above; no controller or new game observation this increment.

## Transport return reachability admission — 2026-09-11

Route extraction committed as `b5bdf5b049`. Development only: no new Kvothe
connection or real-model run this increment. New transport checks resolve delivery
station and remembered home together from the delivery system using a refreshed
public directed map and station directory. New freight acceptance and passenger
boarding require a canonical unchanged destination and home within the cleanup
executor's existing two-jump allocation; checks repeat after loading. Missing,
wrecked, ambiguous or moved destinations block for reassessment. Evidence persists
in transport_return_checks, including blocked observations and its explicit limits.
Remembered home identity is preserved when its observed waypoint moves.

The pinned client otherwise caches map edges indefinitely. Internal refresh_map
forces refresh at admission while preserving ordinary discovery caching. Its
behavior test was proven red against HEAD's old provider in an isolated temporary
copy, then green with this fix; asymmetric map edges cannot establish reverse
reachability. Real Hermes imports/registry/BridgeClient/ExecutionHost tests in a
temporary HERMES_HOME cover reachable and blocked freight/passenger jobs, including
no acceptance/boarding when home is unreachable. These are fixtures, not Hermes
playing or completed live transport.

Already-arrived, legitimately admitted resumes may settle existing custody before
return servicing despite blocked return evidence. Startup readiness and urgent
stop gates remain in force. Freight follows the same rule: an authenticated dock at the contract base
supersedes historical destination coordinates, and delivery precedes any movement
or refueling. Its test verifies one acceptance and package removal after a station
moves with the ship docked. Integration is ready for local commit after validation.

Validation actually run: npm run typecheck and npm test passed112 Node tests;
HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python with
scripts/run_tests.sh passed48 tests across12 SpaceMolt/native-skill files.
Logs: /tmp/spacemolt-return-reachability-node.log and
/tmp/spacemolt-return-reachability-python.log. git diff --check passed.
Uncommitted milestone files: TODO.md, spacemolt/README.md, execution-logistics.ts,
execution-store.ts, execution.ts, locations.ts, new locations-refresh.test.ts,
logistics.ts/test, passenger-destinations.test.ts, shared-logistics.test.ts, and
tests/test_spacemolt_logistics.py. VISION remains unchanged; no push.

No active live runtime introduced. Last verified terminal runtime remains
spacemolt/runtime/shared-live-passengers-outpost-20260911-02: handle6801 exited0,
bridge PID8141 absent, locks absent at that checkpoint. Historical pilot: docked
Frontier Station (frontier_station/mobile_capital/deep_range), credits194137,
fuel120/120 hull105/105 shield35/35, cargo21/120, economy cabin12 free berths,
preserved mining laser in cargo, no passengers/freight/crafting queue. Six distress
missions listed above remain outstanding; no mission payouts verified. Query fresh
authoritative state after checking controllers before any future live operation.

Commit this bounded milestone as `Verify transport return reachability before custody`.
All listed milestone files belong to that commit; no unrelated work is present.
Next action: implement the broader itinerary fuel/service
spending and deadline admission contract before considering longer Logistics
routes. Reachability is not a fuel, cost, docking-access, hazard or arrival-time
promise; passenger live delivery, S5/S14 integration and full VISION remain open.

## Transport fuel itinerary and cleanup budgeting — 2026-09-11

Previous milestone committed as `4e93a24a65`. This increment is development only;
no new Kvothe connection or Hermes/oMLX session. It integrates itinerary planning
with existing transport workers, shared travel/service and original budget owners.
No route cap was widened, Hermes core changed, or active prompt/catalog mutated.

transport-itinerary.ts replaces the old outbound-only route helper. Before custody,
after loading and before each further productive movement it checks current quoted
outbound fuel, fresh directed home-return hops and the existing17-unit local/escape
allowance. A return from the current system uses an actual route quote; a future
return uses a qualified projection. The projected rate takes the larger of quoted
per-jump fuel and total outbound fuel divided by jumps, so contradictory fields
cannot select an implausibly cheaper component. Pinned types do not establish exact
rate/total equality. Quotes must match canonical cargo/fuel; changes during quoting
block commitment. Movement snapshots and blocked raw quote evidence persist.

servicing.ts records authenticated home fuel pricing with time, dock, ship identity
and capacity. Shared Logistics departure also captures this read-only observation,
allowing pickup away from home in the same operating run. Missing, unknown or
inapplicable home pricing blocks new custody. No remote price is invented. New
transport reserves the current tank deficit plus remaining itinerary estimate and
contingency at that dated price, within remaining original gross funds and wallet
headroom. Reassessment can increase the reservation only within those limits.
We rejected a full-tank reservation because it needlessly excluded inexpensive
local jobs: a100-credit local job can proceed with a51-credit planning reservation
at fuel price3. Actual measured cost remains distinct from that reservation.

The reservation is a planning estimate, not another hard service cap. Actual
cleanup is repriced against original gross spending and wallet limits; unexpected
fuel use or pricing can use unallocated original funds and produces an explicit
planning_overrun. Delivery income cannot enlarge the gross budget. Resumes and
linked returns keep the original owner/allocation and do not replenish it. Unknown
repair prices remain blockers. Already-arrived admitted custody still settles before
return/service blockers. Service fuel observations are run-local for new jobs;
existing custody may retain its historical allocation across resume.

Behavioral evidence: loading changes can make departure infeasible without losing
passenger custody; unexpected first-jump fuel consumption blocks the second outward
jump while allowing return/refuel within the original budget. Tests retain the
measured planning overrun. A1200-credit service quote beyond a1000-credit gross cap blocks service;
reprice200 above planned51 but below that cap succeeds, reports149 planning overrun,
and repeated cleanup does not refill the allowance. A regression probe against
isolated committed HEAD with max_spend5 boarded one passenger before ultimately
blocking cleanup; the working fix blocks before boarding (same no-boarding assertion
red on baseline, green on fix). Temporary probe directories were removed.

Validation: npm run typecheck and npm test passed118 Node tests. Required
HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python with
scripts/run_tests.sh passed50 tests across12 SpaceMolt/native-skill files. Logs:
/tmp/spacemolt-itinerary-node.log and /tmp/spacemolt-itinerary-python.log.
git diff --check passed. Tests include actual
Hermes imports, registry, BridgeClient and ExecutionHost for both transport kinds
with successful, unreachable-home and unfunded-cleanup admissions. Richer inline
receipts exercise existing table/reference compaction; the integration test now
uses the shared test decoder instead of assuming every array stays uncompressed.
No fixtures are presented as live gameplay or delivery acceptance.

Milestone files: spacemolt/src/{transport-itinerary.ts,test,
transport-itinerary-execution.test.ts,transport-budget.ts,test,execution-logistics.ts,
execution-store.ts,execution.ts,servicing.ts,shared-logistics.test.ts};
spacemolt/README.md, DECISIONS.md and Logistics SKILL.md; tests/test_spacemolt_logistics.py,
test_spacemolt_model_receipts.py and new spacemolt_evidence_helpers.py; this TODO.
Commit locally as `Plan transport fuel and cleanup spending before commitment`.
VISION is unchanged; no push and no unrelated uncommitted work.

Live checkpoint unchanged and historical: runtime
spacemolt/runtime/shared-live-passengers-outpost-20260911-02, handle6801 exited0,
bridge PID8141 absent and no locks at last verification. Frontier Station dock
frontier_station/mobile_capital/deep_range, credits194137, fuel120/120 hull105/105
shield35/35, cargo21/120 including preserved mining laser,12 free economy berths,
no passengers/freight/queued crafting. Six listed distress missions remain open;
no payouts verified. Check actual controller processes before any new connection.

Exact next action: implement measured transport elapsed-tick/deadline checkpoints
using pinned Account.currentTick and fresh custody observations before subsequent
productive legs. currentTick is the highest observed server tick, not a continuously
ticking clock; transit_arrival_tick is published only after submission. Persist the
original custody start tick/allowance across resume, record a single accepted leg's
overrun, and never cancel/replay an uncertain transit. Fresh passenger deadlines
must be checked between legs. This does not justify a preflight ETA guarantee.
Then revisit broader travel hazards/access and route allocations before fresh live
passenger acceptance. S5/S14/A6 and the full VISION remain unfinished.

## Timing work checkpoint and daemon discussion — 2026-09-11

Last completed milestone is `15627807cf`. Timing integration is unfinished and
uncommitted: execution-store.ts adds optional transport time/progress fields;
transport-time.ts/test checks persistent elapsed budgets and regressed/unknown ticks;
transport-deadlines.ts/test observes selected custody/deadlines and a fresh clock.
Execution now wires these checks into transport admission, post-load validation and
the before-leg movement callback. No already-submitted transit is cancelled or
replayed; a late arrival is recorded and prevents the next productive leg.

Pinned source audit corrected the initial clock plan: Account.currentTick is only
a high-water mark for top-level tick-bearing frames. account.refresh/get_status do
not guarantee a fresh clock. Existing shipping/active has a required response.tick;
use that authenticated read for precommit and per-leg checks, including passengers.
The deadline helper queries it even without custody, retains its clock evidence,
and does not require equality with stale Account.currentTick. Selected passenger
and personal freight identities, current ship and positive deadlines are verified.
Legacy resume may derive a conservative original baseline from recorded admission
obligations.freight.tick or accepted commitment envelope.tick; absent evidence must
not initialize a new elapsed allowance. Authenticated arrived settlement and
script-owned defensive return remain available despite time-planning blockers.

User asked whether Hermes can run as a daemon, schedule fixed tasks and accept
Discord inquiries/direction. Local Hermes supports a macOS launchd gateway,
gateway-hosted cron, Discord DM/channel sessions and scheduled delivery. The new
`src/mcp-server.ts` is a concrete boundary: one MCP process owns one bridge and
controller lock, while cron and Discord sessions call high-level SpaceMolt tools.
`mcp-config.example.yaml` and `DAEMON.md` document a dedicated profile, secret
credential file, launchd gateway, cron prompt and Discord authorization. No
credentials are stored. The adapter is typechecked but not started: no daemon
installed, schedules created, Discord messages sent, or game connections opened.
Queries use receipts or serialized fresh observations; urgent Tired reaches active
scripts, normal policy changes use handoff. Cron/chat session lifetimes must not own
or kill an active movement/cleanup.

Integration coverage now includes a late first leg/no second leg, preserved custody,
resumed original allowance and fresh selected-custody deadline checks. The deadline
observer uses shipping/active.tick rather than stale Account.currentTick. Daemon use
is now scaffolded but not configured; a first real schedule and Discord target still
require profile secrets and user-selected IDs. Preserve these helper files while
continuing.

Gateway handoff observation (2026-09-11): `hermes gateway status` reports the
launchd definition matches the installed Hermes version but is not loaded. A
manually launched default-profile gateway is authoritative at PID37628 (parent
PID1, `hermes_cli.main gateway run --external-supervisor`). Do not start a second
gateway or reload MCP beneath it. Discord credentials and one allowed user are
already present in the profile; their values remain secret and are not copied into
this repository. Enabling the MCP config requires stopping/restarting that gateway,
then checking the SpaceMolt controller lock before the MCP bridge connects. No
restart or external config mutation was performed in this turn.

MCP protocol smoke test (with an intentionally missing credential path) returned
the initialize handshake and the stable eight-tool catalog without contacting the
game. `npm run typecheck` passes after the adapter addition. The full required
SpaceMolt Python suite remains green at50 tests; no new Python behavior is claimed.

Tests for this increment: typecheck and npm test passed123 Node tests; required
Python runner passed50 tests across12 SpaceMolt/native-skill files. Logs:
/tmp/spacemolt-timing-node.log and /tmp/spacemolt-timing-python.log. git diff --check
passed. Previous full completed milestone remains118 Node/50 Python tests.
No Python implementation changed in this increment and no new Python tests run.
Live state unchanged/historical: last runtime shared-live-passengers-outpost-20260911-02,
handle6801 exited0, PID8141 absent at last verification. Credits194137, serviced
Frontier dock,12 free economy berths, cargo21/120, no passenger/freight/crafting
custody; six listed distress missions remain. No new authoritative pilot observation.

## Validation and completion record

## Direct native plugin packaging — 2026-09-11

The prior MCP scaffold was deliberately removed. SpaceMolt is now packaged at the repository's
`spacemolt/` root as a native Hermes plugin (`plugin.yaml`, `__init__.py`, `service.py`, and
`cli.py`) that can be installed from the monorepo subdirectory with
`hermes plugins install OWNER/hermes-spacemolt/spacemolt --enable`. This keeps the capability
outside Hermes core while using its normal Discord gateway and cron sessions. It is a direct
agent boundary: the fixed `spacemolt` toolset registers `observe`, `plan`, `assess`, `prepare`,
`transport`, `return`, `reconcile`, and urgent `stop` handlers against one profile-scoped Python
service. The service owns one serialized `BridgeClient`; it configures the existing TypeScript
`ExecutionHost` and only dispatches existing `execution/*` and `job/*` contracts. It does not
reimplement game mechanics or expose raw game commands.

Normal planning records `next_session_required` after the bridge handoff, so stable Discord/cron
session prompts and schemas do not mutate. Urgent Tired goes through the bridge control frame.
The external `hermes spacemolt stop` command writes a durable profile control request; it never
starts a second bridge. The gateway-owned service polls that request and signals active scripts.
Its bridge and controller runtime now live below the active `HERMES_HOME` rather than this source
checkout. `SPACEMOLT_CREDENTIALS_FILE` is required and must point to an existing secret file;
the historical hard-coded Kvothe credential fallback was removed. `hermes spacemolt install`
performs the explicit pinned `npm ci`; no `node_modules` are packaged or installed implicitly.

Development validation only: `npm run typecheck && npm test` passed 123 Node tests. The required
`HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python scripts/run_tests.sh`
passed 54 tests across 13 SpaceMolt/native-skill files. New behavioral tests prove a single
service bridge through configure/plan/handoff/assess, real temp-`HERMES_HOME` native-plugin
discovery and registry tool definitions, and a separate-process Tired request without a bridge.
A separate temporary-profile invocation of the fork's real
`python -m hermes_cli.main spacemolt setup` loaded the packaged plugin and verified existing
credentials, Node and npm without opening the game. This is not a Discord, live-model, or
live-game run.

Follow-up direct-dispatch invariant: after `spacemolt_plan` returns its handoff receipt, the
service records the originating Hermes session ID and refuses further productive calls from that
same session. A different session clears the gate; observe, reconciliation and Tired remain
available while the handoff is pending. The service test proves this route using the real handler
contract's `session_id`. The pending-session marker is profile-durable, so a replacement service
still blocks that prior session; saved host permissions and stance/mood locks are reconstructed
when a bridge reconnects. Focused required Python plugin/runner tests pass after this change. This
is still development evidence, not a live gateway restart or Discord session.

Packaging acceptance after commits `153877217b`, `3adf417c2c`, and `73f740001f`: an isolated
temporary profile ran the fork's real `hermes plugins install
file:///Users/vcarl/workspace/testbench/hermes-spacemolt#spacemolt --enable`, then
`hermes spacemolt install --yes` and `hermes spacemolt setup`. The installer cloned only the
`spacemolt` plugin subdirectory, enabled its dynamically registered toolset, ran the locked Node
install (`added 4 packages`), and reported a disconnected controller with valid fixture
credentials, Node and npm. No gateway, Discord client, oMLX model, bridge or game connection was
started. This is a local packaging acceptance, not a published remote install or live acceptance.

The direct plugin catalog now also exposes existing complete job scripts for Hunt (`track`, `hunt`)
and Industry (`gather`, `produce`), alongside the shared and Logistics tools. These map only to
the already-tested `ExecutionHost` job names; raw SpaceMolt primitives remain absent. Focused
plugin/runner tests pass after this expansion. Trade, Explore and Salvage still have no concrete
executor and therefore remain absent rather than being presented as superficial support.

D7/X3 evidence advanced for the existing Industry consumer: a behavior test now runs omitted
`gather` cycles under every productive mood and proves that the resolved `max_gather_cycles`
becomes both the requested/completed cycle count and the number of actual mine calls. It also
proves Tired's Industry catalog has no gather entry. `npm run typecheck && npm test` passed with
124 Node tests after this addition. This covers gathering only; the remaining numerical policy
consumers still need comparable evidence.

D7/X3 also has a Logistics freight-admission consumer invariant: each productive mood admits a
contract exactly at its resolved liability ceiling and blocks it one credit above that ceiling;
Tired removes transport from the catalog. This executes the real `Execution` assessment path
rather than asserting the policy table. Full `npm run typecheck && npm test` then passed 125 Node
tests. Route caps retain their existing passenger fuel-planning evidence; opportunity-switching
economics and other stance consumers remain open.

Multiplex safety follow-up: the direct service now resolves `SPACEMOLT_CREDENTIALS_FILE` through
Hermes's active profile secret scope and forwards only that resolved path to the bridge. An
unscoped multiplex call fails closed rather than borrowing a process environment credential.
The required runner passed 18 focused plugin/bridge tests, including a two-credential behavior
test proving the spawned bridge receives the active profile's path. This is still local process
evidence; it is not a multi-profile gateway or Discord connection.

Operator documentation now distinguishes this fork from an unrelated installed `hermes` binary.
It gives the Python 3.11+ editable-install bootstrap, an isolated `spacemolt` profile, and the
validated local plugin identifier `file://$PWD#spacemolt`, followed by profile-qualified direct
setup, gateway, Discord, and cron commands. The documented profile deliberately starts empty;
model, Discord, and SpaceMolt secrets must be configured there before live use.

No live controller was opened, no Discord gateway was restarted, and no schedule was created.
The gateway PID37628 and historical Frontier/Kvothe checkpoint described above remain unchanged;
their current state must be observed before any live operation. Untracked `credentials.kvothe.txt`
and `players/` were preserved. Exact next action: commit the Logistics policy evidence, then
prepare a gateway-owned Discord/cron acceptance run. A
dedicated profile and no competing controller are required before that live acceptance.

Session record, 2026-09-11: committed `9c04471ec3` (Industry mood gathering evidence),
`c8e69c5e85` (profile-scoped credentials), `e3f43f3ee7` (fork-local deployment instructions),
and `94b8267868` (Logistics mood admission evidence). Tracked worktree is clean; only the
pre-existing untracked `credentials.kvothe.txt` and `players/` remain. Tests actually run after
these changes: `cd spacemolt && npm run typecheck && npm test` (125 passing Node tests), and
`HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python
scripts/run_tests.sh tests/test_spacemolt_plugin.py tests/test_spacemolt_runner.py` (18 passing
Python tests). No live runtime, gateway, Discord session, bridge, or controller was started in
this session. The last verified pilot checkpoint remains the earlier historical Frontier Station /
Deep Range record above (194143 credits, fuel120/120, hull105/105, shield35/35, cargo21/120,
no passengers, freight, queue, or other known custody); it must be authoritatively observed
before the proposed live acceptance. The next action is to create/configure the dedicated profile
from the documented fork command, check gateway and controller ownership, then run one bounded
Hermes/Discord observation and record its gateway process handle and verified receipt.

## Dedicated profile oMLX repair — 2026-09-11

The user configured the documented dedicated `spacemolt` profile and reported a 401. Direct,
secret-redacted evidence established that oMLX at `http://127.0.0.1:8000/v1` accepts the token in
`~/.omlx/settings.json` and serves the selected `mlx-community--Qwen3.6-35B-A3B-4bit` model. The
profile `.env` value under `OPENAI_API_KEY` matched that token, but its initial bare
`model.provider: custom` route treated loopback as keyless and sent Hermes's
`no-key-required` placeholder. The profile was corrected outside the repository to a named
`providers.omlx` entry with `key_env: OPENAI_API_KEY`, `transport: chat_completions`, the local
endpoint, and `model.provider: custom:omlx`; the default model was replaced with the exact served
ID. A profile-local runtime resolution then matched the oMLX token, and a real Hermes one-shot
returned `OMLX_AUTHENTICATED`. This is genuine local model acceptance, but it did not invoke any
SpaceMolt tool or open a game connection.

Before the profile gateway restart, `spacemolt status` reported no gateway-owned bridge and the
profile runtime contained no controller lock. `gateway restart` completed; the replacement
launchd service is PID22225. No SpaceMolt bridge/controller, Discord conversation, or live game
action was started. Current next action: the user sends the documented observation-only Discord
message, then records the reply/tool receipt; controller and pilot state must be newly observed
before any productive instruction. Untracked `credentials.kvothe.txt` and `players/` remain
preserved.

## Direct Discord tool guidance repair — 2026-09-11

The profile configuration itself is correct: `spacemolt` is enabled and included in the Discord
platform toolsets, and the profile-scoped credential gate resolves successfully. The reported
`spacemostat_*` calls were never registered names. Investigation found the actual defect in the
bundled direct-plugin skills: they still directed the model to the obsolete `job__*` execution
catalog even though the native plugin exposes only `spacemolt_*` tools. The plugin prompt now
enumerates the complete direct catalog, the four bundled operational skills name the direct
tools, and the Logistics assessment receipt directs callers to `spacemolt_assess`. A real
registry test asserts every dynamically registered direct tool is named in the prompt, preventing
that instruction/schema split from returning.

Validation: `HERMES_PYTHON=/Users/vcarl/workspace/testbench/hermes-agent/.venv/bin/python
scripts/run_tests.sh tests/test_spacemolt_plugin.py` passed 5 tests, and `cd spacemolt && npm run
typecheck && npm test` passed 125 Node tests. This is development and registry evidence; it does
not prove a Discord session has received the repaired schema.

During the repair check, the existing Discord gateway already owned a live SpaceMolt bridge
(PID22338 and its controller lock). A profile-scoped Tired request was written through
`hermes spacemolt stop`; the bridge remained connected because the gateway retains its single
bridge owner while idle, so it must be cleanly stopped before replacing the installed plugin.
No second controller was opened. Exact next action: stop the existing gateway after Tired,
verify the bridge and lock exit, install this repaired plugin copy, restart one gateway, then use
a new Discord thread/session so its immutable tool catalog and prompt are built from the repaired
plugin. The user must verify the Discord reply; no productive game command should be sent until
the fresh session can call `spacemolt_observe` and return its authoritative receipt.

After Tired, `hermes gateway stop` stopped the profile gateway; process inspection found no
SpaceMolt bridge process and the controller lock was absent. The persisted gateway status receipt
still reported its old `connected: true`/PID22338 values, so it is historical rather than terminal
proof. Before reinstalling, an unexpected foreground command in the user's `ttys013` terminal was
found running `./hermes profile delete spacemolt` (parent fish PID21113). It was not interrupted or
raced. Exact next action is to wait for the user's resolution of that profile-delete command,
then re-check whether the profile still exists before any plugin installation or gateway restart.

The direct daemon guide now includes a terse division of responsibilities: SpaceMolt skills guide
Hermes's planning and high-level `spacemolt_*` calls, while scripts own mechanics, immediate
defense, verification, cleanup, and recovery. It records that planning changes require a new
session and that Tired preserves obligations through script-owned return. This documentation-only
change needs no runtime validation.

## Kvothe oMLX configuration — 2026-09-11

The user clarified that the active `kvothe` profile, rather than the deleted/recreated
`spacemolt` profile, must use oMLX. `kvothe` already selected `custom:omlx` and the exact served
Qwen model but lacked the corresponding named provider stanza and did not define
`OPENAI_API_KEY`; it therefore could not authenticate through the intended route. Its profile
configuration now has `providers.omlx` pointing at `http://127.0.0.1:8000/v1` with
`key_env: OPENAI_API_KEY`, `transport: chat_completions`, and the served
`mlx-community--Qwen3.6-35B-A3B-4bit` default. The existing oMLX `auth.api_key` was copied only
to `~/.hermes/profiles/kvothe/.env` as `OPENAI_API_KEY`; no secret entered the repository or
output.

A real forked Hermes request using `-p kvothe` returned `OMLX_AUTHENTICATED`, establishing the
authenticated model path. The launchd-supervised Kvothe gateway was then restarted and reported
PID25014. This changes no SpaceMolt plugin, bridge, controller, pilot state, or obligations. An
unused newly created `spacemolt` profile remains because the user redirected configuration to
Kvothe; do not delete it without an explicit request. Exact next action: start a new Discord
session for Kvothe and verify a normal model reply; if direct SpaceMolt operation is still wanted,
install the repaired native plugin into Kvothe only after checking the gateway/controller state.

## Scoped SpaceMolt development guide — 2026-09-11

Added `spacemolt/AGENTS.md` as the project-specific companion to the root Hermes guide. It maps
the direct native-plugin bundle, fixed model-facing catalog, skills, Python service, JSONL bridge,
TypeScript execution host, controller ownership, session handoffs, receipts, live safety rules,
oMLX profile routing, and required validation. It explicitly separates the legacy standalone
runner from the gateway-owned service and prohibits reviving MCP, raw model-facing game commands,
or a competing bridge. `git diff --check` passed; this documentation-only change needs no test
run. Exact next action remains a fresh Kvothe Discord session/model reply, followed by a
controller-state check before any direct SpaceMolt plugin install.

Added root `CLAUDE.md` with pointers to the root and scoped SpaceMolt agent instructions. This is
a documentation-only discovery file; `git diff --check` is the required validation.

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
