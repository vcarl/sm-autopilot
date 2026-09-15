# Close S40’s remaining quote-context gap: reject tank-capacity changes during find_route before classifying fuel shortfalls or attempting refueling.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/18-review.json

## Acceptance
- Add at most two behavioral tests through production travelTo and FakeLibGoalAccount, demonstrated failing before the fix.
- Capacity changes during initial, post-refuel, and subsequent-leg quotes produce contextual TravelBlocked, never FuelRouteShortfall; no further refueling or movement follows invalidation.
- Stable-context capacity refusals, fractional fuel shortages, and exact-boundary success retain their existing behavior.
- Pass the unchanged node --test spacemolt/proofs/c03-jump-route.test.ts, the full regression command in CURRENT.md, and git diff --check.
- Record fixture evidence and technical choices beside S40 in TODO.md and update CURRENT.md; keep S40 unchecked pending automatic Tired implementation.

## Scope
- spacemolt/src/travel.ts, spacemolt/src/travel-fuel-evidence.test.ts, TODO.md, CURRENT.md.
- Default: compare refreshed max_fuel with the pre-quote snapshot in the shared quote validator; this conservatively requires a fresh attempt when tank context changes.
- Default: retain existing error classes and evidence schema; contextual refusal avoids publishing fuel-crossing evidence from an invalidated quote.
- Preserve capability proofs, VISION.md, repository instructions, worklog/, and unrelated changes. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel-fuel-evidence.test.ts
- spacemolt/src/travel.ts
- worklog/2026-09-14-215016-make-s40-fuel-shortfall-classification-reject-in.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c03-jump-route.test.ts`

## Review findings
- The bounded task satisfies the accepted plan. Capacity changes invalidate quotes before fuel classification or refueling.
- TODO.md and CURRENT.md match the fixture evidence; no checklist items were newly ticked.
- The full milestone remains incomplete: S40’s automatic Tired transition is unfinished.

## Review evidence
- spacemolt/src/travel.ts:113–119: shared authoritative quote-context guard includes max_fuel.
- spacemolt/src/travel-fuel-evidence.test.ts:117: all 12 capacity-change scenarios pass through production travelTo.
- /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/17-work.events.jsonl: verified pre-fix initial/smaller/0 failure.
- CURRENT.md regression command independently passed 27/27 tests, including both production-path C3 proof tests.
- C1/C2/C3 proof hashes match CURRENT.md; git diff --check passed.

## Worker findings (claim, not verified)
- Tank capacity is quote context even when increased: conservatively reject any change during find_route and require a fresh attempt. No new retry, error class or evidence schema is needed.
- Initial, post-refuel and subsequent-leg quotes share the same validator. Capacity changes during a quote must be rejected there, before requireCapacity or refueling; later departure guards are too late.
- Stable-context re-quotes may change route cost after refueling; retain the existing capacity classification for those valid quotes.
- Departure boundaries still validate non-fuel context before fuel sufficiency, then fuel equality. This preserves fractional shortage evidence while preventing invalid context from becoming a false crossing.
- Fixture route responses are captured before server-only capacity changes, leaving cache stale until production refresh. The 12 scenarios assert recorded command sequences and refill counts, including the one refill or jump already completed before later quote invalidation.

External workflow verification: task accepted.
Task: Close S40’s remaining quote-context gap: reject tank-capacity changes during find_route before classifying fuel shortfalls or attempting refueling.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/18-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-asl10klu/checks-17.json
Milestone complete: False
