# Port T28’s unresolved-location go-to-POI scenarios through production travelTo and the shared FakeLibGoalAccount.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/22-review.json

## Acceptance
- Add two behavioral tests covering initially unknown authoritative location: resolution at the target requires no movement; resolution elsewhere permits one freshly quoted local move; unresolved location times out without commands or settled checkpoints.
- Exercise production travelTo/waitForArrival with independent server/cache state. Stale cached target coordinates and unrelated cargo pushes must not establish arrival or postpone authoritative reads.
- Verify returned location against refreshed server state, and verify interruption or ship replacement prevents further movement.
- Pass the new tests and the existing eight-file travel validation, including node --test spacemolt/proofs/c02-travel-poi.test.ts; preserve both capability proofs byte-for-byte.
- Record fixture evidence and technical choices beside T28 in TODO.md and update CURRENT.md. Keep broader T28 and S40 unchecked while their remaining requirements are unfinished.

## Scope
- Add spacemolt/src/travel-location.test.ts; update TODO.md and CURRENT.md during implementation.
- Default: reuse FakeLibGoalAccount and existing send(tool, action, payload) records without expanding the helper; scenarios retain ownership of server changes.
- Default: inject time, retain 2-second polling and 30-second authoritative reads, and use a 65,001-ms timeout scenario; this exercises the final partial wait without wall-clock delays.
- Preserve production behavior unless a new test demonstrates a defect; any necessary fix is limited to unknown-location reconciliation in spacemolt/src/travel.ts.
- Preserve existing changes, immutable proofs, ported references, repository instructions, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel-policy.test.ts
- spacemolt/src/travel.test.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/src/travel-location.test.ts
- worklog/2026-09-14-210320-migrate-the-t28-return-fuel-fixtures-in-travel-r.md
- worklog/2026-09-14-210854-migrate-the-remaining-travel-and-fuel-policy-fix.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded task satisfies the accepted plan. Both new tests exercise production travel and verify authoritative reconciliation, timeout, interruption, and ship identity.
- TODO.md and CURRENT.md accurately describe fixture evidence; no checklist items were newly ticked.
- The full milestone remains incomplete: broader T28 requirements and S40’s automatic Tired transition remain unfinished.

## Review evidence
- spacemolt/src/travel-location.test.ts: independently reran the nine-file validation; all 19 tests passed.
- spacemolt/src/travel.ts and spacemolt/src/test-support/fake-lib-account.ts: verified real travel paths and independent server/cache state.
- spacemolt/proofs/c02-travel-poi.test.ts: exercises local travel and existing transit through production code with authoritative arrival confirmation.
- Both capability proof SHA-256 hashes match CURRENT.md; production, helper, and proofs have no working-tree changes.
- git diff --check passed.

## Worker findings (claim, not verified)
- Production already reconciles unknown location through `waitForArrival`; these scenarios required no behavior change.
- The shared helper clones constructor input. Scenarios mutate `account.server`; refresh independently replaces cache. Cargo pushes deliberately update only cached cargo.
- Location resolving at 2/32 seconds is discovered at 30/60 seconds. When it resolves elsewhere, the local move arrives on the server two seconds later and is confirmed at the next 30-second read.
- The unaligned timeout performs a final 1,001-ms wait and authoritative read at 65,001 ms. Ship replacement is detected at the 30-second read; the injected operator stop interrupts at two seconds. These are fixture measurements, not live observations or proof of automatic Tired handling.

External workflow verification: task accepted.
Task: Port T28’s unresolved-location go-to-POI scenarios through production travelTo and the shared FakeLibGoalAccount.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/22-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-21.json
Milestone complete: False
