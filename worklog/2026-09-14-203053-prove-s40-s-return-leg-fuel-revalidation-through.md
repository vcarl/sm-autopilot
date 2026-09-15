# Prove S40’s return-leg fuel revalidation through production travelTo, using an outbound-and-return fixture.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/14-review.json

## Acceptance
- Add spacemolt/src/travel-return.test.ts with at most two behavioral tests using real travelTo and mood resolution, independent server/cache state, and recording command handlers.
- Complete outbound travel, then change authoritative fuel and cargo before returning. Verify the return requests a fresh route from the actual position and uses its cost rather than the outbound quote.
- Cover local travel and cross-system return: exactly return cost plus mood reserve permits movement; one fuel unit below refuses with the precise shortfall and issues no return movement.
- Demonstrate that stale cached fuel cannot authorize an unsafe return, and verify successful return against refreshed location and remaining fuel.
- Run node --test spacemolt/src/travel-return.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel.test.ts spacemolt/proofs/c01-fuel-guard.test.ts. Preserve the existing C1 proof unchanged.
- Record fixture evidence and technical choices beside S40 in TODO.md and in CURRENT.md. Leave S40 unchecked until its Tired transition is demonstrated; leave broader R7 and capability completion to their remaining work and workflow.

## Scope
- spacemolt/src/travel-return.test.ts; narrowly necessary fixes in spacemolt/src/travel.ts only if behavioral coverage exposes a defect.
- Default: compose two real travelTo calls in the fixture; this verifies the shared flight primitive without rebuilding the deleted job runner.
- Default: use asymmetric outbound/return quotes and changed cargo, with exact and one-unit-short fuel boundaries; this exposes accidental reuse of outbound assumptions.
- Default: retain D2 reserves and independent authoritative refresh behavior; this preserves existing policy and makes stale-cache defects observable.
- TODO.md and CURRENT.md evidence updates only beyond the scoped code. No worklog edits, live connections, commits, or unrelated changes.

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
- The bounded return-leg task satisfies the accepted plan. Tests exercise production travel and mood resolution without stubbing either.
- TODO.md and CURRENT.md accurately label fixture evidence and leave S40, R7, and C1 unchecked. Tired transitions and broader R7 requirements remain unfinished.

## Review evidence
- spacemolt/src/travel-return.test.ts: two tests cover eight local/cross-system scenarios, fresh return quotes, changed cargo, stale cached fuel, exact reserve boundaries, precise shortfalls, and refreshed arrival.
- Independently ran travel-return.test.ts, travel-arrival.test.ts, travel.test.ts, and proofs/c01-fuel-guard.test.ts: 9/9 passed.
- spacemolt/src/travel.ts and spacemolt/src/mood-policy.ts: inspected production refresh, quote validation, fuel guards, movement, and mood resolution.
- spacemolt/proofs/c01-fuel-guard.test.ts: SHA-256 remains 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.
- git diff --check passed.

## Worker findings (claim, not verified)
- Return travel can reuse the real flight primitive without rebuilding the deleted job runner. Each call refreshes before quoting; changed fuel and cargo must be reflected in the new quote. The fixtures deliberately make the outbound quote cheap enough to wrongly allow the unsafe return if reused.
- Tests pass only mood words to production policy. D2 Cautious/Aggressive reserves are independent expected values, not numeric caller allocations or a stubbed resolver.
- Cross-system fixtures place stations at the gate POI to isolate one jump per leg; local fixtures move between distinct POIs in the same system. This does not prove a multi-hop return or a jump followed by local travel.
- Prior arrival coverage establishes 30-second authoritative reads despite cargo pushes and bounded unresolved transit; initial in-transit reconciliation remains outside that coverage.
- ReadinessAccount is imported as a type only. Other executors still depend on deleted engine modules; this task does not repair them.

External workflow verification: task accepted.
Task: Prove S40’s return-leg fuel revalidation through production travelTo, using an outbound-and-return fixture.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/14-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/checks-13.json
Milestone complete: False
