# Create the missing C3 fixture proof for multi-system travel and one authoritative reroute after a definitive jump failure.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/04-review.json

## Acceptance
- Write spacemolt/proofs/c03-jump-route.test.ts first, exercising production travelTo, waitForArrival, route validation, and mood fuel resolution; preserve the proof afterward.
- Prove a two-jump route reaches the target system, with each subsequent quote using refreshed position, fuel, and cargo, and final location confirmed authoritatively.
- Prove a failed jump that actually moved the pilot triggers reconciliation and routing from actual position without replaying the stale route; reaching the target despite rejection requires no further jump.
- Prove the retry allowance is shared across the entire trip: a second definitive rejection terminates retries. Pending commands and transport errors never trigger replay.
- Pass node --test spacemolt/proofs/c03-jump-route.test.ts and the existing travel validation files listed in CURRENT.md plus travel-reconciliation.test.ts.
- Record fixture evidence and technical choices in TODO.md and CURRENT.md. Keep S40 unchecked until its automatic Tired transition is demonstrated; leave capability ticking to the workflow.

## Scope
- Add the C3 proof; update TODO.md and CURRENT.md during implementation.
- Default: two behavioral tests with parameterized scenarios and shared FakeLibGoalAccount; this combines route completion and failure contracts without duplicating account machinery.
- Default: Focused mood, existing two-jump allocation, and scenario-owned fuel quotes; this exercises current policy without adding configuration.
- Default: independent server/cache state and injected time retaining two-second polling and 30-second authoritative reads; this exposes stale-location mistakes without wall-clock delays.
- Limit production changes to travel.ts only if the new proof demonstrates a defect; establish failure before fixing it.
- Preserve existing proofs, unrelated changes, VISION.md, repository instructions, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/proofs/c03-jump-route.test.ts

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c03-jump-route.test.ts`

## Review findings
- The bounded task satisfies the accepted plan. The C3 proof exercises production travel, authoritative arrival, route validation, and mood fuel resolution.
- TODO.md and CURRENT.md accurately describe fixture evidence; this task ticked no checklist items.
- The full milestone remains incomplete because S40’s automatic Tired transition is still unproved.

## Review evidence
- spacemolt/proofs/c03-jump-route.test.ts: independently passed both behavioral tests covering 12 scenarios.
- CURRENT.md regression command: independently passed all 21 tests; combined with C3, 23/23 passed.
- spacemolt/src/travel.ts, spacemolt/src/normal-route.ts, spacemolt/src/mood-policy.ts, and spacemolt/src/test-support/fake-lib-account.ts: verified production paths and independent server/cache state.
- All three proof hashes match CURRENT.md; git diff --check passed.

## Worker findings (claim, not verified)
- No production defect was demonstrated; production and shared helper remain unchanged.
- Routes are fixture assumptions: initial a→b→c; after rejected movement, actual x→d→c. Distinct next hops expose stale route replay. Successful jumps cost 10; quotes cover remaining jumps. Focused resolves its own reserve of 24; no numeric reserve or configuration is injected.
- Rejected commands do not increment the confirmed-jump count. Thus rerouting can send three commands (one rejected and two successful) within the default two-confirmed-jump allocation.
- Server/cache states stay independently cloned. Cargo pushes every two seconds cannot establish arrival. Server arrivals at 2/32 seconds are confirmed at 30/60 seconds per leg; final returned location matches authoritative state.
- The exhausted-retry scenario rejects, successfully jumps from x to d, then rejects again. This checks that a successful hop cannot replenish the retry allowance. Uncertain commands leave stale cache and reconciliation responsibility with the caller.

External workflow verification: task accepted.
Task: Create the missing C3 fixture proof for multi-system travel and one authoritative reroute after a definitive jump failure.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/04-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/checks-03.json
Milestone complete: False
