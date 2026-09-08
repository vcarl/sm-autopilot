# Live validation in progress

The implementation is functional, but the requested gameplay proofs are not yet
complete. The target wallet balance for the manual phase is **180,566 credits**,
50,000 above the observed starting balance of 130,566.

Verified:

- Local fork created from `hermes-agent`, with the integration in `spacemolt/`.
- npm `@spacemolt/lib` 14.2.0 successfully authenticates the existing Kvothe account,
  executes tick-paced actions, and returns live game state.
- Actual Hermes `AIAgent` successfully called an offline fixture tool through local
  omlx using **mlx-community--Qwen3.6-35B-A3B-4bit**, the non-MTP model requested.
  The exact messages are in `model-tool-check.json`.
- TypeScript validation, the Node policy test, and four Python integration tests pass.
- Manual gameplay completed Substrate Delivery, Concurrent Approval, Synchrony
  Relay Run, Precedence, Signal Propagation Survey, and one freight delivery.
  Wallet at the latest Nexus checkpoint: **160,911 credits**, a net gain of
  **30,345**. This includes 128 credits spent on refueling and 1,635 on a Cargo
  Expander II. Cargo capacity increased from 75 to 125; the original mining laser
  remains in cargo.

Active manual work: deliver supplied phase material to Sirius for 5,000 credits,
then return to First Step for The Frequency Gap's 16,000-credit payout. Finish
with full fuel and verify the actual wallet exceeds the target.

Freight contracts are a candidate for repeatable income: acceptance places the
package in origin storage; withdraw `package:<id>` before departure. Standard
packages occupy 100 cargo, so the original ship needed a cargo expansion.

Live findings: historical phase-matrix arbitrage no longer has supply; public
market snapshots can become stale within minutes. The Experiment's ordinary
asteroid belt is depleted and its survey revealed no hidden deposits. Prioritize
live orders and actual deposit stock over historical notes or guide price examples.

The local model has **not yet controlled the live player**. After the manual net
gain reaches 50,000, run the Hermes agent and measure multiple profitable cycles,
including fuel and repair costs, to establish self-sustaining behavior.

Private detailed receipts are in ignored `runtime/gameplay.jsonl` and runner
`runtime/*/decisions.jsonl` files. This progress note is a checkpoint, not a claim
that the user's goal has been achieved.
