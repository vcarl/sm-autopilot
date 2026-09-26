# Port T28’s post-rejection unknown-location navigation scenarios through production travelTo and FakeLibGoalAccount.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/26-review.json

## Acceptance
- Add two behavioral tests: a definitive jump rejection followed by unknown location resolves at the destination without replay, or elsewhere with a fresh route quote before another jump.
- Verify re-quoting uses authoritative origin, fuel, and cargo. A refreshed fuel shortfall prevents further movement and reports the shortfall.
- Verify unresolved location times out without another movement; a second definitive rejection ends retries; pending commands and transport errors never trigger replay.
- Run the new test file and the nine-file travel validation listed in CURRENT.md, including node --test spacemolt/proofs/c02-travel-poi.test.ts. Preserve both capability proofs byte-for-byte and pass git diff --check.
- Record fixture evidence and technical choices beside T28 in TODO.md and update CURRENT.md. Keep T28 and S40 unchecked while their remaining requirements are unfinished.

## Scope
- Add spacemolt/src/travel-reconciliation.test.ts; update TODO.md and CURRENT.md during implementation.
- Default: reuse shared send(tool, action, payload) handlers with independent server/cache state; this avoids another fixture implementation.
- Default: use the supported in_transit definitive rejection, injected time, existing 2-second polling and 30-second authoritative reads, and a 65,001-ms timeout; this tests reconciliation without changing error classification or waiting in real time.
- Default: use Cautious fuel policy and scenario-owned route quotes; this exercises existing policy rather than adding configuration.
- Limit any production fix to a defect demonstrated by these scenarios in spacemolt/src/travel.ts; prove regression tests fail before the fix.
- Preserve ported references, existing tests, unrelated changes, VISION.md, repository instructions, and worklog/. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/src/travel-reconciliation.test.ts

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded task satisfies the accepted plan; no actionable deficiencies found.
- TODO.md and CURRENT.md accurately describe fixture evidence. No checklist items were newly ticked.
- The full milestone remains incomplete: broader T28 requirements and S40’s automatic Tired transition remain unfinished.

## Review evidence
- spacemolt/src/travel-reconciliation.test.ts: independently passed 2/2 tests covering authoritative rerouting, fuel shortfall, timeout, bounded retries, and uncertain commands through production travelTo.
- CURRENT.md: independently reran the documented nine-file validation; 19/19 passed.
- spacemolt/proofs/c02-travel-poi.test.ts: verifies production local travel, authoritative arrival, and waiting out existing transit without replay.
- Both capability proof SHA-256 hashes match CURRENT.md; production and shared helper are unchanged. git diff --check passed.

## Worker findings (claim, not verified)
- Existing production reconciliation satisfies these scenarios without a behavior change. The port uses supported `in_transit`, not the reference fixture's `already_in_transit`; error classification is unchanged.
- The shared helper clones input; handlers mutate `account.server`. Refresh replaces cache independently; only cargo pushes update cache while waiting.
- Resolution at 2/32 seconds is observed at 30/60 seconds despite cargo pushes. A successful retry arrives on the server two seconds later and is confirmed at the next 30-second read. Route costs are scenario-owned fixture assumptions.
- The 65,001-ms timeout includes a final 1,001-ms wait and authoritative read. No post-rejection settled checkpoint occurs while location remains unknown.
- Rejected commands do not increment the returned confirmed-jump count. Pending and transport errors propagate to the caller immediately with stale cache; further reconciliation remains the caller's responsibility.

External workflow verification: task accepted.
Task: Port T28’s post-rejection unknown-location navigation scenarios through production travelTo and FakeLibGoalAccount.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/26-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-25.json
Milestone complete: False
