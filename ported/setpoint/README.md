# Ported from setpoint (verbatim, not yet runnable)

Copied 2026-09-14 from `~/workspace/testbench/setpoint` at commit
`ea47eb2974071f64f2b72aaabe9f4952472bdf9a`, paths preserved. These files are
outside `src/`, so `npm test` and `npm run typecheck` do not see them. Every
test still imports `bun:test` and reaches into setpoint's `src/` by relative
path; none runs here yet. This directory is a parts bin for the rebuild, not a
suite.

What each group is for (TODO.md IDs):

- `tests/dispatcher/lib-fakes.ts`, `tests/helpers/deep-partial.ts`,
  `tests/accounts/fakes.ts` — the Proxy-based fake account and its helpers.
  Target: the fixture harness (T18). Keep `FakeLibGoalAccount`; drop the
  manager half; retype `commands` to our `send(tool, action, params)`.
- `tests/dispatcher/wait-for-location.test.ts`, `lib-primitives/*` — flight
  primitive: travel, dock, refuel, route (S40). Drop the `DEFAULT_MAX_WAIT_MS`
  assertion in wait-for-location; it is a frozen constant.
- `lib-loops/fuel-route-guard.test.ts` — reserve check before departure and
  before the return leg (S40).
- `lib-compounds/mine-until-full`, `ensure-cargo`, `mine-with-jettison`,
  `sell-at-station*`, `unload-at-station`, `transfer-storage-to-faction` —
  gathering and custody (S9, S38). `cargo_full` is a success terminal.
- `lib-compounds/ensure-hull`, `ensure-magazines`, `ensure-fueled` — servicing
  as end states (S6, S42).
- `lib-loops/mining-loop`, `enhanced-mining-loop`, `mining-precheck`,
  `guard-loop`, `tests/dispatcher/lib-sequence.test.ts` — chain semantics:
  re-check per iteration, bounded, abort at every boundary (R14, N22).
- `tests/dispatcher/goals.test.ts` + `src/dispatcher/goals.ts` — `reconciled()`:
  success is a hard AND, a failed subject carries observed state. The receipt
  shape (S44).
- `tests/server/job-manager.test.ts` — outcome derived at read time, explicit
  resumable set on restart, terminal-write guard (S43). Uses `bun:sqlite`;
  port the three rules against our JSON journal.
- `tests/combat/*` — pure battle-event reducer with bystander filtering,
  bounded flee, defense beneath work, post-combat recovery (S41, D7).
- `tests/accounts/server-notices.test.ts` — chat and pushes as untrusted data;
  unsolicited moves with no `request_id` (S41, T17).
- `tests/state/crafting-events-store.test.ts` — bounded event retention.

Porting rule: swap `bun:test` for `node:test` + `node:assert/strict`, point
imports at our modules, keep test names as relations. Do not add bun.
