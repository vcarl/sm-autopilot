# Prove S40’s forced authoritative arrival reads through the production travel path, adapting the ported wait-for-location behavioral tests.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/10-review.json

## Acceptance
- Add spacemolt/src/travel-arrival.test.ts with at most two behavioral tests using production travelTo and waitForArrival, independent server/cache state, recording command handlers, and a deterministic clock.
- Demonstrate that unrelated cargo updates cannot postpone authoritative location refreshes: a dropped arrival update is discovered within the 30-second refresh interval, and the movement command is issued only once.
- Demonstrate that unresolved transit reaches ArrivalUnresolved at the configured deadline, without replaying movement or claiming arrival; an authoritative arrival observed at the deadline may succeed.
- Run node --test spacemolt/src/travel-arrival.test.ts and node --test spacemolt/proofs/c01-fuel-guard.test.ts spacemolt/src/travel.test.ts. Preserve the existing C1 proof unchanged.
- Record fixture evidence and technical choices beside S40 in TODO.md and in CURRENT.md. Keep S40 unchecked until its return-fuel and Tired requirements are also demonstrated.

## Scope
- spacemolt/src/travel-arrival.test.ts; narrowly necessary fixes in spacemolt/src/travel.ts only if the new behavioral tests expose a defect.
- Reference spacemolt/ported/setpoint/tests/dispatcher/wait-for-location.test.ts; omit its frozen-constant assertion and adapt its semantics to ArrivalUnresolved.
- Default: retain 30-second authoritative reads, 2-second polling, and the existing 600-second wait bound; this balances query traffic with discovery of dropped location updates.
- Default: use existing clock/sleep injection and an independent recording fixture; this exercises production control flow without wall-clock delays or live connections.
- TODO.md and CURRENT.md evidence updates; preserve unrelated changes and leave worklog/, repository instructions, and VISION.md untouched.

## Changed files
- CLAUDE.md
- CURRENT.md
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c01-fuel-guard.test.ts`

## Review findings
- Accepted the bounded S40 arrival task: two behavioral tests exercise production travel and arrival waiting without stubbing either.
- TODO.md and CURRENT.md accurately label fixture evidence and leave S40, R7, and C1 incomplete. No checklist items were newly ticked.
- The full milestone still requires S40 return-fuel/Tired behavior and broader R7 requirements.

## Review evidence
- spacemolt/src/travel-arrival.test.ts: independently rerun, 2/2 passed; covers periodic authoritative refresh despite cargo updates, deadline outcomes, and no movement replay for travel and jumps.
- spacemolt/proofs/c01-fuel-guard.test.ts and spacemolt/src/travel.test.ts: independently rerun, 5/5 passed.
- C1 proof SHA-256 unchanged: 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.
- spacemolt/src/travel.ts: inspected production refresh scheduling, deadline checks, and movement control flow.
- TODO.md S40 evidence and CURRENT.md match observed results; git diff --check passed.

## Worker findings (claim, not verified)
- `ReadinessAccount` exposes state and authoritative refresh, with no freshness flag. The fixture pushes cargo into cached state while withholding location; production scheduling remains independent of those updates.
- `waitForArrival` refreshes immediately, periodically, and at the deadline. It tests the refreshed arrival before throwing on timeout, so an arrival observed exactly at the bound can succeed.
- `travelTo` checks initial stable position before movement. These tests enter transit through the actual movement command and cover its arrival wait; they do not claim initial in-transit reconciliation.
- The ported frozen-constant test was omitted. Timing assertions exercise observable control flow with injected time, without wall-clock delays.
- Other executors still depend on deleted engine modules outside this task's scope. Prior post-undock shortfall handling remains covered by the unchanged travel regression tests.

External workflow verification: task accepted.
Task: Prove S40’s forced authoritative arrival reads through the production travel path, adapting the ported wait-for-location behavioral tests.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/10-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/checks-09.json
Milestone complete: False
