# Migrate the remaining travel and fuel-policy fixtures to the shared FakeLibGoalAccount as a bounded T28 task.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/18-review.json

## Acceptance
- Migrate travel.test.ts and travel-policy.test.ts through FakeLibGoalAccount.send(tool, action, payload), exercising production travelTo without duplicate account refresh or command-recording implementations.
- Preserve all five existing tests and scenarios: fuel loss, refueling, capacity, return quotes, bounded retries, uncertain movement, interruption, finite routes, operator floors, and invalid policy input.
- Replace no-op refreshes with independent server/cache state. Scenario handlers mutate account.server; authoritative refreshes establish arrival and fuel. Invalid policy must cause neither sends nor refreshes.
- Pass node --test spacemolt/src/fake-lib-account.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel.test.ts spacemolt/src/travel-return.test.ts spacemolt/src/travel-policy.test.ts spacemolt/src/travel-multihop.test.ts spacemolt/proofs/c01-fuel-guard.test.ts spacemolt/proofs/c02-travel-poi.test.ts.
- Preserve both capability proofs byte-for-byte and pass git diff --check.
- Record fixture evidence and technical choices beside T28 in TODO.md and update CURRENT.md. Leave broader T28 and S40 unchecked while their remaining requirements are unfinished.

## Scope
- spacemolt/src/travel.test.ts, spacemolt/src/travel-policy.test.ts, TODO.md, CURRENT.md.
- Default: reuse existing nested handlers, {tool, action, payload} records, and refresh records without expanding the helper; this limits migration scope.
- Default: retain existing numerical boundaries, payloads, errors, and injected timing; this preserves behavioral coverage.
- Default: refuel callbacks mutate server state and explicitly refresh before returning; this models verified servicing with independent cache state.
- Preserve production code, shared helper, proofs, ported references, VISION.md, repository instructions, worklog/, and unrelated changes. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel-policy.test.ts
- spacemolt/src/travel.test.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- worklog/2026-09-14-210320-migrate-the-t28-return-fuel-fixtures-in-travel-r.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded fixture migration satisfies the accepted plan; all five tests and existing scenarios are preserved.
- TODO.md and CURRENT.md accurately describe fixture evidence and remaining work. No checklist items were newly ticked.
- The full milestone remains incomplete: broader T28 requirements and S40’s automatic Tired transition remain unfinished.

## Review evidence
- spacemolt/src/travel.test.ts and spacemolt/src/travel-policy.test.ts exercise production travelTo through FakeLibGoalAccount.send, with independent server/cache state and zero sends or refreshes for invalid policy.
- Independently reran all eight required test files: 17/17 passed. git diff --check passed.
- spacemolt/proofs/c02-travel-poi.test.ts exercises production travelTo/waitForArrival, verifying authoritative arrival and existing transit without movement replay.
- Both capability proof SHA-256 hashes match the preserved values recorded in CURRENT.md and worklog/2026-09-14-205815-port-the-t28-recording-account-harness-to-send-t.md.

## Worker findings (claim, not verified)
- The helper clones constructor input. Scenario mutations must target `account.server`; cache changes only on refresh unless a scenario explicitly simulates a push.
- Production travel's command callback uses slash-qualified names. Each fixture splits that name only at the adapter boundary; sends and refreshes have separate shared records, so invalid-policy checks must assert both are empty.
- Refueling must refresh before returning because travel immediately re-quotes against cached ship state. A server-only refuel would correctly trigger a changed-quote refusal.
- The interruption fixture throws `Tired` from its injected movement check after a jump; it does not prove the unfinished automatic Tired transition. Route costs remain fixture assumptions, not live measurements.

External workflow verification: task accepted.
Task: Migrate the remaining travel and fuel-policy fixtures to the shared FakeLibGoalAccount as a bounded T28 task.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/18-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-17.json
Milestone complete: False
