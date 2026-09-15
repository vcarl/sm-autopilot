# Make S40 fuel-shortfall classification reject invalidated ship and route context before reporting a fuel crossing.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/14-review.json

## Acceptance
- Add at most two behavioral tests through production travelTo and FakeLibGoalAccount; demonstrate failure before fixing.
- At pre-undock and post-undock refresh boundaries, changed ship identity, location, transit, cargo load, or tank capacity must invalidate the quote without producing FuelRouteShortfall or issuing further movement.
- Fuel-only loss under otherwise valid quote context retains precise, unrounded FuelRouteShortfall evidence, including after undock and on subsequent legs.
- Pass node --test spacemolt/proofs/c03-jump-route.test.ts, the full regression command in CURRENT.md, the new scenarios, and git diff --check.
- Record fixture evidence and technical choices beside S40 in TODO.md and update CURRENT.md. Keep S40 unchecked pending automatic Tired implementation.

## Scope
- spacemolt/src/travel.ts, spacemolt/src/travel-fuel-evidence.test.ts, TODO.md, CURRENT.md.
- Default: validate non-fuel quote context before classifying fuel loss; this prevents stale route costs becoming false margin-crossing evidence while preserving genuine fuel-only refusals.
- Default: retain existing error classes and messages for valid fuel shortages; use contextual TravelBlocked refusals for invalidated quotes, avoiding new schemas or retry behavior.
- Preserve capability proofs, unrelated changes, VISION.md, repository instructions, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c03-jump-route.test.ts`

## Review findings
- The bounded task satisfies the accepted plan: invalidated context blocks departure before fuel-shortfall classification at both refresh boundaries.
- TODO.md and CURRENT.md accurately report fixture evidence. No checklist items were newly ticked; S40’s automatic Tired transition remains unfinished.

## Review evidence
- spacemolt/src/travel.ts: verified context validation precedes requireFuel at both departure boundaries.
- spacemolt/src/travel-fuel-evidence.test.ts: all 28 context-invalidation scenarios pass; fractional fuel-only evidence remains covered.
- CURRENT.md regression command independently passed 26/26 tests; standalone spacemolt/proofs/c03-jump-route.test.ts passed 2/2 through production paths.
- /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/13-work.events.jsonl: verified pre-fix hook/ship/0.25 assertion failure.
- C1/C2/C3 proof hashes match CURRENT.md; git diff --check passed.

## Worker findings (claim, not verified)
- Check non-fuel quote context first, then fuel sufficiency, then fuel equality. Checking fuel first misclassifies unrelated context invalidation; checking fuel equality first hides genuine fractional shortages behind a generic refusal.
- Post-undock validation deliberately accepts the expected removal of docking while retaining the quoted system and POI. Evidence keeps observed location separate from quoteOrigin, which retains the original dock.
- Empty fixture command responses leave cache stale. Server-only invalidations at beforeMove or undock become visible on the production refresh; recorded sends prove there is no subsequent movement.
- Capacity evidence remains distinct from available-fuel evidence. Refueling can change route cost, so both the initial and refreshed quote still receive capacity checks.

External workflow verification: task accepted.
Task: Make S40 fuel-shortfall classification reject invalidated ship and route context before reporting a fuel crossing.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/14-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/checks-13.json
Milestone complete: False
