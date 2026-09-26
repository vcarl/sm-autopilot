# Port the T28 recording-account harness to send(tool, action, payload), migrate travel-arrival.test.ts, and verify the shared harness in adjacent tests.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/10-review.json

## Acceptance
- Adapt FakeLibGoalAccount into a reusable test helper with recorded tool/action/payload calls, programmable handlers, independent authoritative and cached state, and recorded refreshes. Remove dependencies on deleted setpoint modules.
- Migrate travel-arrival.test.ts to the helper while preserving every existing scenario and behavioral assertion through production travelTo/waitForArrival: dropped arrivals, unrelated cache pushes, authoritative reads, deadline success, unresolved timeout, and no movement replay.
- Add at most two adjacent behavioral tests verifying namespace-sensitive dispatch, payload recording, error propagation, and server/cache independence until refresh.
- Pass node --test spacemolt/src/fake-lib-account.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel.test.ts spacemolt/src/travel-return.test.ts spacemolt/src/travel-policy.test.ts spacemolt/src/travel-multihop.test.ts spacemolt/proofs/c01-fuel-guard.test.ts spacemolt/proofs/c02-travel-poi.test.ts.
- Preserve both existing proofs byte-for-byte: C1 SHA-256 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa; C2 SHA-256 5699934aa2121939c6ef81e421c890b0753e465e85a1abec412366909d785354.
- Record fixture evidence and technical choices beside T28 in TODO.md and update CURRENT.md. Leave T18, T28, and S40 unchecked until their remaining requirements are satisfied; capability ticking remains workflow-owned.

## Scope
- New spacemolt/src/test-support/fake-lib-account.ts, new spacemolt/src/fake-lib-account.test.ts, and migration of spacemolt/src/travel-arrival.test.ts; worker evidence updates in TODO.md and CURRENT.md.
- Default: retain the FakeLibGoalAccount name and port only the consumed account surface; omit manager, market, and observation machinery to keep this migration bounded.
- Default: use send(tool, action, payload) with handlers keyed by tool/action and records shaped as {tool, action, payload}; this matches the installed library and prevents namespace collisions.
- Default: reject unregistered commands instead of returning implicit success; explicit empty replies remain available for movement scenarios.
- Default: clone server/cache state and recorded payloads, with injected time and scenario-owned handlers; this prevents shared-reference mutations from masquerading as authoritative reads.
- Keep existing timing and payload scenarios. Preserve production code, ported source material, all existing proofs, VISION.md, repository instructions, worklog/, and unrelated changes. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- spacemolt/src/travel-arrival.test.ts
- spacemolt/src/travel.ts
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md
- spacemolt/proofs/c02-travel-poi.test.ts
- spacemolt/src/fake-lib-account.test.ts
- spacemolt/src/test-support/fake-lib-account.ts
- worklog/2026-09-14-205025-implement-and-prove-c2-local-poi-travel-includin.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded harness migration satisfies the accepted plan; no actionable deficiencies found.
- TODO.md and CURRENT.md accurately describe fixture evidence. No checklist items were newly ticked.
- The full milestone remains incomplete: S40’s Tired transition and T28’s remaining ports and fixture replacements are unfinished.

## Review evidence
- spacemolt/src/test-support/fake-lib-account.ts: namespace-sensitive dispatch, cloned call records, independent server/cache state, and recorded refreshes.
- spacemolt/src/fake-lib-account.test.ts and spacemolt/src/travel-arrival.test.ts: two helper tests and preserved production travel scenarios.
- Independently reran all eight required test files: 17/17 passed. Scoped strict TypeScript check and git diff --check passed.
- spacemolt/proofs/c02-travel-poi.test.ts exercises production travelTo/waitForArrival end to end at fixture level, including authoritative arrival and existing transit without replay.
- Both proof hashes match acceptance: C1 82b6ab47bf132466a4885a4af508418859068294dcc1418f8d3649d386dc11fa; C2 5699934aa2121939c6ef81e421c890b0753e465e85a1abec412366909d785354.

## Worker findings (claim, not verified)
- The obsolete Proxy flattened tool namespaces and defaulted unknown commands to success. The shared helper uses nested tool/action handlers and explicit replies. It intentionally omits manager, market, and observation surfaces.
- Travel still consumes a slash-qualified command callback; the arrival fixture splits that name and forwards to `send`. Timing and server movement remain scenario-owned, while recording and authoritative refresh live in the helper.
- Sparse fixture state is cast to the library GameState only at the helper boundary. Sending does not update cache; refresh clones server state, so later server changes cannot masquerade as fresh reads.
- The first scoped typecheck invoked from the repository root could not resolve Node typings. Running the same command from `spacemolt/` passed; use that working directory.
- Existing unrelated changes, both proofs, VISION.md, repository instructions, and worklog/ were preserved. No commits, pushes, deployments, or live connections.

External workflow verification: task accepted.
Task: Port the T28 recording-account harness to send(tool, action, payload), migrate travel-arrival.test.ts, and verify the shared harness in adjacent tests.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/10-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-09.json
Milestone complete: False
