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
- Manual gameplay completed Substrate Delivery for 2,500 credits and unlocked
  Concurrent Approval. Refueling cost 128 credits. Cargo Expander II cost 1,635
  credits, increasing cargo capacity from 75 to 125; the original mining laser is
  preserved in cargo. Wallet after these actions: 131,263 credits.

Active manual work: complete the 20,000-credit Signal Propagation Survey while
advancing nearby delivery chains. The Frequency Gap is also active, with the
Experiment visit done and return to First Step still required. Freight contracts
are a candidate for repeatable income: acceptance places the package in origin
storage; withdraw `package:<id>` before departure. Standard packages occupy 100
cargo, so the original ship needed a cargo expansion.

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
