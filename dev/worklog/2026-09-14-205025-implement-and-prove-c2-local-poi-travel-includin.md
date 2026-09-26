# Implement and prove C2 local POI travel, including reconciliation of transit already underway, through production travelTo.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/04-review.json

## Acceptance
- Create spacemolt/proofs/c02-travel-poi.test.ts first, using node:test and real travelTo/waitForArrival. Demonstrate the existing initial-transit failure before changing production code; preserve the proof afterward.
- Use independent authoritative and cached state, recording command handlers, and an injected clock. Verify ordinary local travel issues one movement command and completes only after an authoritative read confirms the target POI with transit cleared.
- Verify already-arrived state requires an authoritative read and no movement. Existing transit reaching the target requires no new movement; transit settling elsewhere in the current system permits one freshly quoted local move afterward.
- A cached target POI while still in transit never establishes arrival. Unresolved transit reaches the bounded timeout without movement or a settled checkpoint. Preserve ship-identity checks and checkpoint interruption during waiting.
- Preserve the existing bounded retry policy: definitive transit rejection reconciles before further movement; pending commands and transport uncertainty never trigger blind replay.
- Pass node --test spacemolt/proofs/c02-travel-poi.test.ts spacemolt/proofs/c01-fuel-guard.test.ts spacemolt/src/travel.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel-return.test.ts spacemolt/src/travel-policy.test.ts spacemolt/src/travel-multihop.test.ts.
- Record fixture evidence and technical choices beside S40/T28 in TODO.md and in CURRENT.md. Identify the completed C2 portion; leave broader S40/T28 requirements unchecked and capability ticking to the workflow.

## Scope
- spacemolt/src/travel.ts and new spacemolt/proofs/c02-travel-poi.test.ts; worker evidence updates in TODO.md and CURRENT.md.
- Adapt the relevant ported go-to-poi behavioral cases and recording-handler pattern. Default: keep the fixture local to the proof; this avoids expanding the task into the entire T28 harness migration.
- Default: reuse waitForArrival with existing 2-second polling, 30-second authoritative reads, and 600-second bound; this preserves established timing while avoiding another reconciliation loop.
- Default: authoritative refresh overrides cached arrival, including the ported cache-only shortcut; this follows VISION.md and C2's live-read contract.
- Preserve existing proofs, fixed authority, worklog/, and unrelated changes. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/proofs/c02-travel-poi.test.ts

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded C2 task satisfies the accepted plan; no actionable deficiencies found.
- TODO.md and CURRENT.md accurately describe fixture evidence. No checklist items were newly ticked.
- The full milestone remains incomplete: S40’s Tired transition and T28’s remaining ports and harness migration are unfinished.

## Review evidence
- spacemolt/src/travel.ts: initial transit reconciles before movement; cached arrival requires authoritative confirmation.
- spacemolt/proofs/c02-travel-poi.test.ts: exercises production travel paths, independent server/cache state, bounded waiting, interruption, and retry restrictions.
- Independently reran all seven required test files: 15/15 passed. git diff --check passed.
- /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/03-work.events.jsonl: records proof-first failures for initial transit and premature cached arrival, followed by passing checks.
- spacemolt/proofs/c01-fuel-guard.test.ts: preserved SHA-256 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa.

## Worker findings (claim, not verified)
- Reconciliation reuses the same wait loop as movement arrival; it does not spend the existing single definitive-rejection retry. A new quote is made only after a stable location is observed.
- A cached arrival can now cause an earlier authoritative read than the periodic interval. If that read still shows transit, waiting continues to the original deadline.
- The local recording fixture adapts ported go-to-poi behavior without restoring the old goal context or migrating the full Proxy harness. The port's cache-only success shortcut conflicts with C2 and VISION.md and was intentionally not retained.
- Movement replies contain no arrival evidence. Empty replies, stale cache, changing cargo pushes, and independent authoritative state prevent command acceptance from standing in for arrival.
- Existing C1 proof and travel regressions remain unchanged. Unrelated pre-existing changes in CLAUDE.md, .claude/, D7-ENUMERATION-PROPOSAL.md, and SETPOINT-BORROWING.md were preserved. No worklog edits, commits, pushes, deployments, or live connections.

External workflow verification: task accepted.
Task: Implement and prove C2 local POI travel, including reconciliation of transit already underway, through production travelTo.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/04-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-03.json
Milestone complete: False
