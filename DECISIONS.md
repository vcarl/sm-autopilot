# Execution decisions, 2026-09-09

These resolve D1–D10 for the shared contract and the first Hunt consumer. They do
not claim implementation of the remaining stance jobs. VISION.md is preserved.

## Authority and boundaries (D1, D3, D6, D8)

Intent checkpoint, 2026-09-10: the initiating agent may choose the CLI stance/mood
locks. Once initiated, those choices stay fixed for the execution session or
operating period; normal reconsideration belongs to a later session. A lock does
not imply that a human must make the choice. Tired remains an immediate override.

User constraints outrank agent plans; scripted safety suspensions and urgent stop
can tighten either. The agent otherwise chooses its stance, mood, objective and
home. Explicit CLI stance/mood selections are locked; an agent can still become
Tired. A new session cannot grant wildlife initiation unless the host supplies
`--allow-wildlife` (the historical `--combat` flag also grants it). Mood never grants
permission. Player, pirate, station, messaging and asset-transfer initiation is
outside this slice. Changing objective through plan does not grant new activities.

| Stance | Entry objective and eventual tools | Mechanical discretion | Requires a new agent plan |
|---|---|---|---|
| Combat | Protect/patrol with guard; authorized engage | Defensive withdrawal and target reassessment | Change protected subject or offensive target class |
| Hunt | Wildlife training/harvesting with track and permitted hunt | Fresh individual of chosen species; tactics, victim loot, return | Change species restriction, objective, stance or home |
| Industry | Gather resources (mining included), produce output | Source permitted inputs, verify output and settlement | Different production chain or learning-loss allocation |
| Trade | Realized trading outcome with trade | Requote, bounded partial fills, preserve unsold stock | Change inventory exposure or market strategy |
| Logistics | Freight/passenger delivery with transport | Custody checks, verified route adaptations | Accept a different commitment or abandon one |
| Explore | Useful observations with survey | Cover bounded nearby observations | Expand coverage budget or turn a hypothesis into productive work |
| Salvage | Recover assessed wrecks with salvage | Capacity-limited eligible item recovery | Change contested-target permissions or sell starting cargo |

All have common observe, assess, prepare and travel where implemented. Hunt and
local Industry gathering have productive tools; unsupported tools are absent.
The legacy `--industry` path is explicitly separate historical functionality.

## Moods and numbers (D2, D7)

The executable source is `src/execution-policy.ts`; skills consume the resolved
context. Values are conservative operating bounds, not probabilities or new game
intelligence. One combat tick is ten seconds in the existing controller.

| Mood | Initiate permitted wildlife | Offensive ticks | Retreat hull fraction |
|---|---|---|---|
| Relaxed | No | 12 | 0.90 |
| Cautious | Yes | 16 | 0.95 |
| Focused | Yes | 20 | 0.90 |
| Opportunistic | Yes | 20 | 0.90 |
| Aggressive | Yes | 24 | 0.80 |
| Tired | No productive admission | 1 for defensive escape context | 0.95 |

Call overrides can only reduce ticks or increase withdrawal fraction, up to 0.95.
All moods require reviewed applicable capability; unknown participants force escape.
The existing assessment's accuracy, incoming-damage and escape margins remain in
force. All retain a minimum 150,000-credit wallet reserve. Default per-job spending
is 1,000 credits (host resolver permits 0–10,000); overrides never enlarge host
spending. Preparation and cleanup share the job budget, using canonical expenditure.
Accepted refuel/repair `cost` and purchase `total_cost` supply gross expenditure;
income never replenishes it and tax components are not added to these totals.
Automatic return jobs retain the preceding job's budget owner across reconnects
and repeated returns. Their own costs remain separate for reporting. Missing paid
cost evidence prevents further spending and keeps reconciliation outstanding.
An exhausted allocation may leave service blocked; `--new-run` requires readiness
and is not a way to fund unfinished cleanup. Host budget reauthorization for that
case remains unimplemented.
Service APIs lack an atomic price cap; preflight quote and post-action actual checks
are both required. Missing all-in repair pricing is a blocker.

The existing Hunt keeps full launch hull/shields, at least 30 launch fuel, 15 fuel
for withdrawal, 100 loaded autocannon rounds, and ten free cargo units. Shared travel
requires quoted route fuel plus 17 units and at most two verified normal jumps per
leg. These are not configurable adjectives. They are current consumer restrictions.

No offensive retries, encounter chaining or unrelated diversions are supported.
Focused and Opportunistic therefore have identical execution in this slice.
Opportunistic switching-cost and benefit thresholds are deferred until a real
alternative-job consumer exists. Relaxed has no first strike but can scout and
escape actual combat. Tired overrides every stance and cannot be undone by plan.

Industry gathering adds bounded extraction cycles: Relaxed 2, Cautious 2, Focused 4,
Opportunistic 4, Aggressive 6, Tired 0. Call overrides only tighten the resolved
limit. These are exposure bounds, not yield guarantees. The first gathering consumer
stays in the selected home's system and retains all output; no sale, storage transfer,
production input allocation or unrelated diversion is implicit. It requires an
observed local asteroid-belt candidate, verifies actual resources after arrival,
and rechecks readiness, stop and defense between extraction commands. Candidate
discovery never claims remote resource contents or known hostile capability.
Starting cargo remains protected, transport custody blocks admission, and an uncertain
mine is never replayed from a cargo difference alone. Industry production/settlement
and opportunity switching remain unfinished.

## Home (D4)

Observe public nearby stations and authenticated current state. The agent compares
services, access, storage, proximity to work and travel costs, then chooses an observed
base identity with rationale. Persist pilot ID, system, POI, base ID, observation time
and rationale independently of conversation runtime. Directory access is provisional;
travel verifies arrival and docking. Only plan deliberately replaces home, through a
fresh-session handoff. A temporary station visit never writes home.

Reconsider when objectives, supplies, access or route costs change. If discovery has
no suitable candidate, report the discovery blocker without inventing IDs. If home
cannot be reached, preserve its identity and report the return blocker and current
location. A known route preflight or docking rejection now permits one explicit
temporary fallback: prefer the current verified dock, otherwise the nearest observed
refuel station. The fallback follows the same verified travel/reserve checks and is
recorded before movement. Missing home uses the same temporary-return policy without
creating a home. Uncertain commands or inconsistent arrival state prohibit fallback.
Failed servicing does not trigger an unbounded search for another station.

## Jobs, interruption and evidence (D5, D9, D10)

A job is one bounded objective attempt plus verification and cleanup. Admission
requires a valid plan, home, permitted tool, no active job and no unreconciled job.
Every job records identity, policy snapshot, starting/final ship/cargo/skills/location,
obligations, command phases, result, actual wallet delta and blockers. The journal is
private; shareable evidence requires a separate reviewed receipt.

The current `one_job` operating run permits one principal attempt (Hunt or gathering),
with at most one optional scouting sortie before a Hunt. A scout already visits up to
three habitats within its selected system. No eligible quarry, an admitted job blocker,
or the end of the principal attempt closes admission. Parameter validation failures
before admission can be corrected without consuming an attempt. Preparation and
observations do not consume the principal attempt, but an admitted preparation failure
still ends the run. A stop reason is separate from the actual job outcome: successfully
finishing an attempt remains completed, and a blocker remains blocked.

The durable pilot journal owns the operating-run boundary. Conversation handoffs,
changed objectives/stances, reconnects and fresh runner directories cannot reset it.
Only the host's explicit `new_run`, after reconciliation and fully serviced docking,
starts another allowance. This implements the present single-attempt contract; general
repetition until XP, production or delivery thresholds remains S17 work. The runner
interrupts planning when a script supplies a stopping reason and performs final cleanup
outside inference. Urgent Tired interrupts planning and signals active scripts directly.

| State/trigger | Required behavior |
|---|---|
| Idle + Tired/stop | Latch admission closed and queue return/service without an inference turn |
| Travel + stop | Finish/reconcile the submitted move, then exit through return checkpoints |
| Productive work + stop | No new productive admission/first strike; finish command ownership, return/service |
| Fighting + stop | Next tactical poll (normally two seconds) latches fleeing; observe battle end before return |
| Model iterations/time exhausted | Synchronous script still owns its result; runner performs final return outside inference budget |
| Normal plan change | Finish job first, archive old session, create new agent with fresh prompt/catalog and authoritative observations |
| Worker death or uncertain command | Pending checkpoint survives; block new jobs and do not replay |
| Unavailable supplies/home | Durable blocked receipt with service/return liability; never substitute success |

A healthy command rejection permits cleanup. Ambiguous send or post-send refresh
failure latches the existing CommandBoundary: no cleanup mutation is then safe.
Every command is saved pending before send and confirmed only after its required
refresh; uncertainty is explicit. On restart, unfinished jobs become
needs_reconciliation. The runner now invokes bounded reconciliation before inference
and when a job reports uncertainty. It uses the library's existing reconnect/re-auth
rather than opening a competing controller, waiting up to 30 seconds for authentication.

The journal captures pre-command state and the received response before the post-command
refresh. A retained response proves the command outcome, not the productive objective.
Fresh location may resolve pending travel/docking; observed quarry participation may
resolve a lost hunt response. Actual combat receives forced defensive escape. A previously
observed battle ID is used to query its exact terminal summary when it has ended; a
missing battle with no prior observation is never interpreted as a failed hunt.

Reconciliation records authoritative state and missions/freight/passengers/production,
per-action evidence and cleanup in the original job. It does not replay purchases,
attacks, craft submissions or deliveries. Unproven effects stay needs_reconciliation
with evidence and an explicit next step. Resolved work returns/services and ends as
interrupted (or returned_to_base for a return job), preserving the original policy and
keeping stop latched. This is recovery to a safe terminal state, not productive resumption.
Underlying transport failure, ongoing transit, ship changes, older checkpoints without
necessary pre-action evidence and absent battle history may still require intervention.

Terminal outcomes distinguish completed objective, blocked attempt, interrupted,
returned_to_base and needs_reconciliation. A hunting victory requires the battle
summary to confirm our winning side, plus verified return/service. A declined fight
or stalemate remains blocked for a victory objective. Tired can return successfully
without achieving the productive objective. Existing cargo/mission/transport/queued
production records survive; cleanup never cancels, sells or declares them settled.

Obligation checks (2026-09-10): shared observations retain server identities, deadlines
and queue metadata. Missing lists never mean empty. Hunt/track admission blocks onboard
passengers or freight carried by this pilot (including unknown carrier role), because
this executor has no delivery/deadline plan. Shipper/recipient/invited-carrier records
without custody and background production do not alone block Hunt. Return still
services safely and preserves commitments; it does not take a delivery detour or
automatically unload, sell, cancel, or settle them. Dedicated Logistics routing remains
work to implement. Receipts retain admission `obligations`, refresh `obligations_after`
after cleanup, and expose `obligation_verification`. Disappearance from a queue is not
proof of settlement. Failed terminal observation prevents a successful terminal status;
command uncertainty preserves the last evidence and defers fresh checks to recovery.

Other stance success contracts: Industry measures new yield/settled output and input
consumption; Trade actual fills and realized cash plus retained exposure; Logistics
authoritative delivery/custody/payment; Explore observed coverage and discoveries;
Salvage newly recovered provenance and inventory; Combat its protected objective and
battle outcome. These require dedicated executors before any completion claim.

## Deliberate first-slice limits

A bounded temporary return fallback and shield recovery wait are implemented. Shield
recovery polls at two-second intervals for at most 120 seconds, preserving dock/ship
identity and rechecking defense. Timeout or changed hull/fuel/docking stays blocked.
No verified repair-price adapter, general economic-effect recovery, all-stance job
coverage, or repetition controller is claimed.

Event-driven defense (2026-09-10) subscribes to own battle notifications plus startup
and post-refresh reconnect checks. The bridge queue remains the sole command owner.
Notifications only latch an assessment; battle status must establish participation.
Idle defense runs as a durable return job, even while a normal handoff is pending.
Unexpected combat suspends productive work and preserves obligations through forced
escape/return. Active Hunt retains tactical ownership of its intentional battle.
A safety return invalidated by defense recomputes its route/service inputs once,
records the reassessment, and leaves repeated disruption blocked. It never resends
an uncertain command. Service waits check defense every two seconds; unresolved
server commands cannot be preempted. Additional stance-specific waits and live
acceptance remain to be validated.
