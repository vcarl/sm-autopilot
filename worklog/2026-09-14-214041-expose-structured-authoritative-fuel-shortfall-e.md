# Expose structured, authoritative fuel-shortfall evidence from production travelTo as a bounded prerequisite for S40’s Tired transition.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/10-review.json

## Acceptance
- Fuel refusals carry machine-readable actual fuel, quoted cost, effective reserve, required fuel, shortfall, destination, and observed ship/location; preserve existing TravelBlocked compatibility and precise messages.
- Cover insufficient fuel before departure, after undock, and on a refreshed return or subsequent jump. Capacity failures remain distinguishable from ordinary fuel shortages; invalid quotes and uncertain commands are not classified as fuel crossings.
- Add at most two behavioral tests using production travelTo and shared FakeLibGoalAccount. Demonstrate failure before implementation, exact-boundary success, fractional shortfalls, authoritative evidence despite stale cache, and no further movement after refusal.
- Pass the unchanged C3 fixed proof and all ten regression files listed in CURRENT.md, plus the new tests and git diff --check.
- Record fixture evidence and technical choices beside S40 in TODO.md and update CURRENT.md. Keep S40 unchecked until automatic Tired transition is implemented and verified.

## Scope
- spacemolt/src/travel.ts; new spacemolt/src/travel-fuel-evidence.test.ts; TODO.md; CURRENT.md.
- Default: a FuelRouteShortfall subclass of TravelBlocked with a structured evidence property; preserves existing catch behavior while removing the need to parse prose.
- Default: separate capacity and available-fuel failure kinds, retaining unrounded fuel units; distinguishes an infeasible route from a refillable shortage.
- Default: clone observed identity/location and retain the validated quote’s origin separately; preserves evidence when later account refreshes change state.
- Preserve all capability proofs, unrelated changes, VISION.md, repository instructions, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel.ts
- spacemolt/proofs/c03-jump-route.test.ts
- spacemolt/src/travel-fuel-evidence.test.ts
- worklog/2026-09-14-213105-create-the-missing-c3-fixture-proof-for-multi-sy.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c03-jump-route.test.ts`

## Review findings
- The bounded task satisfies the accepted plan, including the repaired capacity classification after refueling.
- TODO.md and CURRENT.md accurately describe fixture evidence; no checklist items were newly ticked.
- The milestone remains incomplete because S40’s automatic Tired transition is unfinished.

## Review evidence
- spacemolt/src/travel.ts: structured fuel evidence preserves TravelBlocked compatibility and distinguishes capacity failures.
- spacemolt/src/travel-fuel-evidence.test.ts: both behavioral tests pass; recorded pre-fix failures verified in 07-work.events.jsonl and 09-work.events.jsonl under /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/.
- CURRENT.md validation command independently passed 25/25 tests, including the production-path C3 proof.
- spacemolt/proofs/c03-jump-route.test.ts exercises multi-system completion and authoritative rerouting without stubbing travel logic. All three proof hashes match CURRENT.md.
- git diff --check passed. No files edited.

## Worker findings (claim, not verified)
- Refueling can change the route quote: checking capacity only beforehand misclassified a refreshed requirement above tank capacity. Both validated quotes now receive the same capacity check.

- All existing available-fuel refusal sites share requireFuel, so the same evidence now reaches initial, pre-undock, post-undock and later-leg refusals without message parsing.
- After undock, observed location has no dock while quoteOrigin retains the dock used for the validated quote. These are deliberately separate snapshots.
- Fixture route costs are 20 for a→b→c and 10 for b→c. Focused with operator floor 30.5 exercises the effective reserve; losses of 0.25 are retained without rounding.
- Capacity failure means required fuel exceeds observed max_fuel; capacityShortfall measures that excess while shortfall retains required minus actual fuel. Consumers must inspect kind before treating a refusal as an ordinary available-fuel margin crossing.
- Invalid quotes remain generic TravelBlocked; pending and transport errors propagate by identity. No retry or admission policy changed.

External workflow verification: task accepted.
Task: Expose structured, authoritative fuel-shortfall evidence from production travelTo as a bounded prerequisite for S40’s Tired transition.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/10-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/checks-09.json
Milestone complete: False
