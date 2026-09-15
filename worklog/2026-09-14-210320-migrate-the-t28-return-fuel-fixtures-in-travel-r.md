# Migrate the T28 return-fuel fixtures in travel-return.test.ts and travel-multihop.test.ts to the shared FakeLibGoalAccount.

- status: accepted
- review: accept
- artifacts: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy
- review file: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/14-review.json

## Acceptance
- Both files exercise production travelTo through FakeLibGoalAccount.send(tool, action, payload), replacing their duplicated account refresh and command-recording implementations.
- Preserve all four existing behavioral tests and scenarios: local/cross-system returns, cargo-dependent quotes, exact reserve boundaries, precise shortfalls, multi-hop revalidation, and authoritative arrival/docking.
- Preserve independent server/cache state and verify that fuel loss after either return jump prevents further movement or docking despite stale cached fuel.
- Pass node --test spacemolt/src/fake-lib-account.test.ts spacemolt/src/travel-arrival.test.ts spacemolt/src/travel.test.ts spacemolt/src/travel-return.test.ts spacemolt/src/travel-policy.test.ts spacemolt/src/travel-multihop.test.ts spacemolt/proofs/c01-fuel-guard.test.ts spacemolt/proofs/c02-travel-poi.test.ts.
- Preserve C1 and C2 proofs byte-for-byte and pass git diff --check.
- Record fixture evidence and technical choices beside T28 in TODO.md and update CURRENT.md. Leave broader T28 and S40 unchecked while their remaining requirements are unfinished.

## Scope
- spacemolt/src/travel-return.test.ts, spacemolt/src/travel-multihop.test.ts, TODO.md, CURRENT.md.
- Default: use existing nested tool/action handlers and {tool, action, payload} call records directly; this removes duplicate machinery without expanding the shared helper.
- Default: retain scenario-owned quote observations, fuel-loss events, payloads, and numerical boundaries; this preserves behavioral coverage during migration.
- Preserve production code, immutable proofs, ported reference files, repository instructions, worklog/, and unrelated changes. No live connection, commit, push, or deployment.

## Changed files
- CLAUDE.md
- CURRENT.md
- TODO.md
- .claude/settings.json
- D7-ENUMERATION-PROPOSAL.md
- SETPOINT-BORROWING.md

## Checks
- exit 0: `git diff --check`
- exit 0: `node --test spacemolt/proofs/c02-travel-poi.test.ts`

## Review findings
- The bounded fixture migration satisfies the accepted plan; all four behavioral tests and their assertions are preserved.
- TODO.md and CURRENT.md accurately describe fixture evidence and unfinished work. No checklist items were newly ticked.
- The full milestone remains incomplete: broader T28 ports and S40’s Tired transition remain unfinished.

## Review evidence
- Commit f293df4ffd: inspected migrations in spacemolt/src/travel-return.test.ts and spacemolt/src/travel-multihop.test.ts.
- spacemolt/src/test-support/fake-lib-account.ts: independent server/cache state and command recording preserve fuel-loss assertions.
- spacemolt/proofs/c02-travel-poi.test.ts exercises production travelTo/waitForArrival, including authoritative arrival and existing transit without replay.
- Independently reran all eight required test files: 17/17 passed. git diff --check passed.
- C1 and C2 proof SHA-256 hashes match the accepted values recorded in worklog/2026-09-14-205815-port-the-t28-recording-account-harness-to-send-t.md.

## Worker findings (claim, not verified)
- Mutate `account.server`, not the constructor input: the helper clones initial state. Refresh independently clones server state into cache; empty movement/docking replies establish no arrival evidence.
- The helper records sends before invoking handlers, preserving fuel-loss `callIndex` semantics. Assertions after that index allow only a fresh route quote, proving neither movement nor docking follows a return-jump loss.
- Quotes and fuel-loss events remain scenario-owned. Multi-hop costs 19/10/4 include the paid station approach; these are fixture assumptions, not verified live server quote semantics.
- Travel's callback still uses slash-qualified command names, so each fixture splits the name at its adapter boundary. Assertions inspect shared tool/action/payload records directly.

- HEAD advanced externally during this task to `f293df4ffd` and includes the two fixture migrations, so they no longer appear in the working-tree diff. No commit command was issued by this task; review that commit for the fixture changes and the working-tree diff for this handoff/T28 evidence.

External workflow verification: task accepted.
Task: Migrate the T28 return-fuel fixtures in travel-return.test.ts and travel-multihop.test.ts to the shared FakeLibGoalAccount.
Review: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/14-review.json
Checks: /var/folders/_4/1kmc70zj6s18v8ls6cxn81m40000gn/T/codex-workflow-ckun91qy/checks-13.json
Milestone complete: False
