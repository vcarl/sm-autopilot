# Implement the C1-facing portion of R7: resolve fuel reserve from mood in the real departure path, beginning by writing the missing C1 proof.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/06-review.json

## Acceptance
- Create spacemolt/proofs/c01-fuel-guard.test.ts first. Exercise production mood resolution and travelTo through a recording game-account fixture; never stub the resolver, guard, or movement implementation. Preserve the proof afterward.
- Use D2's authoritative mood table. Under otherwise identical conditions, changing mood changes departure eligibility without supplying a numeric reserve from the caller.
- Prove departure at exactly quoted route cost plus resolved reserve, and refusal one unit below. Refusal reports the actual shortfall in fuel units and issues no undock, jump, or travel command.
- Cover insufficient tank capacity, a route quote inconsistent with observed fuel, and refreshed fuel differing from cached fuel. No unsafe movement may occur.
- Remove travel's runtime dependency on the deleted engine through industry.ts without restoring placeholder rules or weakening existing checks.
- Run node --test spacemolt/proofs/c01-fuel-guard.test.ts and node --test spacemolt/src/travel.test.ts; record actual results as fixture evidence.
- Record choices and verified progress beside R7 in TODO.md and in CURRENT.md. Leave broader R7 and S40 requirements unchecked unless independently demonstrated; capability checkboxes remain workflow-owned.

## Scope
- spacemolt/proofs/c01-fuel-guard.test.ts and a minimal recording fixture adapted from the ported fake-account pattern.
- spacemolt/src/travel.ts, a topical mood-policy module, and narrowly required response-decoding extraction and import updates.
- Default: use D2 reserves unchanged and compare fuel without rounding; this preserves unit-based thresholds and exact boundary behavior.
- Default: keep numeric margins internal to scripts and accept mood at the production policy boundary; this prevents per-call agent tuning.
- Default: fixture refresh copies independent authoritative game state into the account, and unexpected commands throw; this exposes stale-state and accidental-mutation defects.
- TODO.md and CURRENT.md evidence only; no worklog edits, live connections, commits, or unrelated rebuild work.

## Changed files
- CLAUDE.md
- TODO.md
- spacemolt/src/combat-fit.ts
- spacemolt/src/combat.ts
- spacemolt/src/equipment-retrieval.ts
- spacemolt/src/gather.ts
- spacemolt/src/industry.ts
- spacemolt/src/logistics.ts
- spacemolt/src/obligations.ts
- spacemolt/src/passenger-fit.ts
- spacemolt/src/passenger-supply.ts
- spacemolt/src/passengers.ts
- spacemolt/src/recovery.ts
- spacemolt/src/servicing.ts
- spacemolt/src/shared-production.ts
- spacemolt/src/transport-deadlines.ts
- spacemolt/src/transport-itinerary.ts
- spacemolt/src/travel.test.ts
- spacemolt/src/travel.ts
- .claude/settings.json
- CURRENT.md
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/proofs/c01-fuel-guard.test.ts
- spacemolt/src/mood-policy.ts
- spacemolt/src/response-details.ts

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c01-fuel-guard.test.ts`

## Review findings
- Accepted the bounded C1-facing R7 task: real mood resolution and departure guards satisfy the planned fixture checks.
- TODO.md and CURRENT.md accurately distinguish verified progress from unfinished R7 and S40 requirements. No checklist items were newly ticked.
- The full milestone remains incomplete because broader R7 and S40 dependencies are not demonstrated.

## Review evidence
- spacemolt/proofs/c01-fuel-guard.test.ts: independently rerun, 2/2 passed; exercises production travel and mood resolution without stubbing either.
- spacemolt/src/travel.test.ts: independently rerun, 3/3 passed, including refreshed post-undock shortfalls for jump and local travel.
- spacemolt/src/travel.ts and spacemolt/src/mood-policy.ts: inspected fuel checks and authoritative D2 reserves.
- git diff --check passed; proof SHA-256 matches CURRENT.md: 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.

## Worker findings (claim, not verified)
- Fuel can change after undocking. A pre-undock check alone cannot supply the post-undock refusal; apply the shared fuel check after refresh before the generic changed-state guard.
- A post-undock shortfall blocks jump/travel; undock has already occurred. Pre-undock shortfalls issue no undock, jump, or travel. Quote inconsistencies remain separate refusals.
- D2 reserves are fuel units, not historical R7 tick values. Mood plus numeric allocation is rejected; internal script allocations remain supported. Relaxed/Tired travel does not establish job-admission permission.
- Other executors still depend on deleted engine modules outside this task's scope.
- No worklog edits, live operations, commits, pushes, or deployments. Unrelated changes were preserved.

External workflow verification: task accepted.
Task: Implement the C1-facing portion of R7: resolve fuel reserve from mood in the real departure path, beginning by writing the missing C1 proof.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/06-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/checks-05.json
Milestone complete: False
