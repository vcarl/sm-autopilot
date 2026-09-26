# Implement the fuel-reserve portion of R7’s tighten-only operator overrides through the existing mood resolver and production travelTo path.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/18-review.json

## Acceptance
- An operator fuel-reserve floor can increase the mood’s reserve but cannot decrease it. Without an override, existing D2 behavior remains unchanged.
- Production departure uses quoted cost plus the effective reserve against refreshed actual fuel. Exact equality permits departure; insufficient fuel refuses with the precise shortfall before movement.
- Reject negative, non-finite, or nonnumeric overrides before game commands. Preserve rejection of mood combined with a numeric script allocation.
- Add at most two behavioral tests in spacemolt/src/travel-policy.test.ts using real travelTo and mood resolution with independent server/cache state. Cover local and cross-system movement, tighter and weaker overrides, fractional shortfalls, capacity, and fuel changes before departure.
- Run node --test spacemolt/src/travel-policy.test.ts spacemolt/src/travel.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel-return.test.ts spacemolt/proofs/c01-fuel-guard.test.ts. Preserve the existing C1 proof unchanged.
- Record fixture evidence and technical choices beside R7 in TODO.md and in CURRENT.md. Leave R7 and S40 unchecked while their remaining requirements are unfinished; capability completion remains workflow-owned.

## Scope
- spacemolt/src/mood-policy.ts, spacemolt/src/travel.ts, and spacemolt/src/travel-policy.test.ts; worker evidence updates in TODO.md and CURRENT.md.
- Default: an internal operator policy object with an optional fuelReserveFloor in units; separating operator policy from script allocations preserves authority without introducing model-facing numeric controls.
- Default: effective reserve is max(D2 reserve, operator floor), without rounding; weaker overrides become harmless while fractional fuel remains accurate.
- Default: retain the existing refuel and departure revalidation sequence, applying the effective reserve throughout; this avoids a second fuel-admission path.
- No changes to VISION.md, repository instructions, worklog/, existing proofs, unrelated work, or model tool schemas. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/mood-policy.ts
- spacemolt/src/travel.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/src/travel-policy.test.ts
- worklog/2026-09-14-203053-prove-s40-s-return-leg-fuel-revalidation-through.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c01-fuel-guard.test.ts`

## Review findings
- The bounded operator-reserve task satisfies the accepted plan.
- TODO.md and CURRENT.md accurately describe fixture evidence and limitations; no checklist items were newly ticked.
- The full milestone remains incomplete: broader R7 requirements and S40’s Tired transition remain unfinished.

## Review evidence
- spacemolt/src/mood-policy.ts and spacemolt/src/travel.ts: validated tighten-only resolution and integration with existing departure guards.
- spacemolt/src/travel-policy.test.ts: two behavioral tests exercise real production paths, independent server/cache state, invalid inputs, fractional boundaries, capacity, refueling, and fuel changes.
- Independently reran all five required test files: 11/11 passed. git diff --check passed.
- spacemolt/proofs/c01-fuel-guard.test.ts exercises real travel and mood resolution; SHA-256 remains 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.
- TODO.md:50 and CURRENT.md record the implementation and retain R7, S40, and C1 as incomplete.

## Worker findings (claim, not verified)
- The effective reserve is resolved once at travel entry and feeds the existing quote/refuel/departure sequence. No second fuel-admission path was added.
- Operator policy is a separate internal object requiring a mood; it cannot silently disappear on the numeric script-allocation path. No model tool schema changed.
- Refuel callbacks must leave account state refreshed for re-quoting; the fixture refreshes after its simulated service, preserving the existing callback contract.
- Capacity refusal reports actual-fuel and capacity shortfalls separately. Fractional fixtures use quarter/half units to verify no rounding.
- Prior arrival/return regressions pass, but initial in-transit reconciliation and automatic Tired transitions are not established by these tests.
- Other executors still reference deleted engine modules outside this task's scope. Unrelated work was preserved; no worklog edits, commits, or live connections.

External workflow verification: task accepted.
Task: Implement the fuel-reserve portion of R7’s tighten-only operator overrides through the existing mood resolver and production travelTo path.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/18-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-wchhuiyx/checks-17.json
Milestone complete: False
