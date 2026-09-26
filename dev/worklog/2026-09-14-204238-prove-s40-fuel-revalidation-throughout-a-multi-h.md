# Prove S40 fuel revalidation throughout a multi-hop return ending with local travel and docking.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/22-review.json

## Acceptance
- Add at most two behavioral tests using production travelTo and mood resolution, independent authoritative/cache state, and recording game-command handlers.
- Exercise an outbound trip followed by a loaded return comprising two jumps and a nonzero-cost local leg. Verify each quote uses the refreshed position, fuel, and cargo.
- At exact quoted-cost-plus-effective-reserve boundaries, verify successful movement and authoritative docking with the reserve retained.
- Introduce an authoritative fuel shortfall after an intermediate arrival and separately before the final local leg. Verify the precise shortfall in units and no subsequent movement or docking, despite stale cached fuel.
- Pass node --test spacemolt/src/travel-multihop.test.ts spacemolt/src/travel-return.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel-policy.test.ts spacemolt/src/travel.test.ts spacemolt/proofs/c01-fuel-guard.test.ts. Preserve the existing C1 proof unchanged.
- Record fixture evidence and technical choices beside S40 in TODO.md and in CURRENT.md. Keep S40 and R7 unchecked until their remaining requirements are satisfied.

## Scope
- spacemolt/src/travel-multihop.test.ts; narrowly necessary fixes in travel.ts or normal-route.ts only if these tests expose a defect.
- Default: two return jumps plus a distinct station POI with positive local travel cost; this exercises successive guards within the existing jump allocation.
- Default: asymmetric outbound/return costs, changed cargo, and quarter-unit shortfalls; these distinguish fresh quotes from reused assumptions without floating-point ambiguity.
- Default: use Focused mood with absent and tighter operator reserve floors; this exercises both policy paths without changing D2.
- Worker evidence updates only in TODO.md and CURRENT.md. Preserve unrelated changes, fixed authority, existing proofs, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/mood-policy.ts
- spacemolt/src/travel.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/src/travel-multihop.test.ts
- spacemolt/src/travel-policy.test.ts
- worklog/2026-09-14-203053-prove-s40-s-return-leg-fuel-revalidation-through.md
- worklog/2026-09-14-203708-implement-the-fuel-reserve-portion-of-r7-s-tight.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c01-fuel-guard.test.ts`

## Review findings
- The bounded task satisfies the accepted plan; no actionable deficiencies found.
- TODO.md and CURRENT.md accurately describe fixture evidence. No checklist items were newly ticked.
- The full milestone remains incomplete: S40’s Tired transition and broader R7 requirements remain unfinished.

## Review evidence
- spacemolt/src/travel-multihop.test.ts: two tests exercise production travel and mood resolution, refreshed multi-hop quotes, exact reserve boundaries, authoritative docking, and precise shortfalls preventing subsequent movement.
- Independently reran all six required test files: 13/13 tests passed. git diff --check passed.
- spacemolt/proofs/c01-fuel-guard.test.ts exercises real production paths and retains SHA-256 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.
- TODO.md:135 and CURRENT.md record the verified behavior and remaining limitations.

## Worker findings (claim, not verified)
- Existing travel re-quotes after every jump arrival and before a distinct local destination. Two return jumps fit the default allocation; the final local quote has zero jumps and a positive cost.
- Fixture movement and docking replies are empty; only authoritative refresh updates cache. Quarter-unit losses are applied after arrival in the game handler, before refresh, leaving cached fuel high enough to authorize an unsafe next leg if trusted.
- Asymmetric empty/loaded prices and distinct gate/station POIs prevent the outbound quote or system arrival from standing in for a complete return.
- This task composes the shared flight primitive, without rebuilding the deleted job runner or claiming automatic Tired behavior. Unrelated pre-existing changes were preserved; worklog was not edited.

External workflow verification: task accepted.
Task: Prove S40 fuel revalidation throughout a multi-hop return ending with local travel and docking.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/22-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/checks-21.json
Milestone complete: False
