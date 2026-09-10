# Execution decisions, 2026-09-09

These resolve D1–D10 for the shared contract and the first Hunt consumer. They do
not claim implementation of the remaining stance jobs. VISION.md is preserved.

## Authority and boundaries (D1, D3, D6, D8)

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

All have common observe, assess, prepare and travel where implemented. Only Hunt
has productive tools in the new interface today; unsupported tools are absent.
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
location. Automatic choice of a temporary fallback is deferred; it must eventually
be explicit in the receipt and must never overwrite home.

## Jobs, interruption and evidence (D5, D9, D10)

A job is one bounded objective attempt plus verification and cleanup. Admission
requires a valid plan, home, permitted tool, no active job and no unreconciled job.
Every job records identity, policy snapshot, starting/final ship/cargo/skills/location,
obligations, command phases, result, actual wallet delta and blockers. The journal is
private; shareable evidence requires a separate reviewed receipt.

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
needs_reconciliation. Observation can collect evidence from a new connection, but
automatic reconciliation/resumption is not implemented yet.

Terminal outcomes distinguish completed objective, blocked attempt, interrupted,
returned_to_base and needs_reconciliation. A hunting victory requires the battle
summary to confirm our winning side, plus verified return/service. A declined fight
or stalemate remains blocked for a victory objective. Tired can return successfully
without achieving the productive objective. Existing cargo/mission/transport/queued
production records survive; cleanup never cancels, sells or declares them settled.

Other stance success contracts: Industry measures new yield/settled output and input
consumption; Trade actual fills and realized cash plus retained exposure; Logistics
authoritative delivery/custody/payment; Explore observed coverage and discoveries;
Salvage newly recovered provenance and inventory; Combat its protected objective and
battle outcome. These require dedicated executors before any completion claim.

## Deliberate first-slice limits

No automatic fallback station, verified repair-price adapter, comprehensive idle
attack subscription, reconnect resolution, all-stance job coverage, or repetition
controller is claimed. Defense currently reuses forced-escape tactical control at
job/travel checkpoints and throughout hunting combat. It does not yet guarantee an
immediate reaction while every possible noncombat command is waiting on the server.
