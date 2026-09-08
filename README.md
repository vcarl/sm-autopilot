# Hermes SpaceMolt

This local Hermes fork runs the real `AIAgent` loop against omlx and a persistent
`@spacemolt/lib` WebSocket connection. The model chooses individual game actions;
the bridge handles authentication, serialization, and waiting for game outcomes.

The integration is contained in this directory. Hermes core files are unchanged.
The fork starts from commit `b3399c139624a0081d70397741a5b45f60fbe1f4` of the
neighboring `hermes-agent` checkout, on branch `spacemolt-local-agent`.

## Live proof

Manual play earned **51,117 net credits**. The actual local Hermes agent then
completed six freight deliveries over two sessions for **19,697 net credits**
after fuel, unlocking licensed carrier status. That freight trial ended at
**201,380 credits**; this is a historical result, not the current live balance.
Both sessions finished fully fueled, undamaged, with original cargo preserved
and no active freight obligations. See [verified results](evidence/PROGRESS.md),
[manual receipts](evidence/manual-proof.json), and
[autonomous receipts](evidence/autonomous-proof.json).

The model occasionally misstates arithmetic in its prose reports. Use the
runner's independently measured wallet deltas and carrier records for accounting.

## Setup

Use Node 22+ and the Hermes Python environment (Python 3.11–3.13). From this directory:

```sh
npm ci
npm run typecheck
npm test
../../hermes-agent/.venv/bin/python runner.py --probe-model
../../hermes-agent/.venv/bin/python runner.py --smoke-model
```

The local default model is `mlx-community--Qwen3.6-35B-A3B-4bit`. The runner reads omlx's
host, port, and API key from `~/.omlx/settings.json` and verifies the requested
model through `/v1/models`. Keys are never put into prompts or checked-in config.

By default the bridge reads `Username: ` and `Password: ` from the existing
`/Users/vcarl/workspace/testbench/roci-testing/players/kvothe/me/credentials.txt`.
Set `SPACEMOLT_CREDENTIALS_FILE` to use another credential file.

## Play

Stop any other client controlling Kvothe before running:

```sh
../../hermes-agent/.venv/bin/python runner.py \
  --cycles 1 --iterations 60 --seconds-per-cycle 3600 \
  --objective 'Choose profitable live freight contracts. Acceptance leaves packages in origin storage: withdraw and verify cargo before departure. Preserve starting assets, finish deliveries, and end docked and fully refueled with no active contracts.'
```

Use `--resume` to continue saved conversation history. To continue the verified
freight trial, add `--runtime runtime/live-non-mtp --resume`. That trial ended
docked at Frontier Station in Void Gate; query live state for the present location.
For recipe, mining, and market experiments, use the [industry workflow](INDUSTRY.md)
and a separate conversation runtime. Catalog data and rate-limit cooldowns now
persist across runner restarts in `runtime/catalog-cache.json`; discovery screens
the whole catalog locally before requesting live quotes. [Gameplay observations](GAMEPLAY.md)
record the mechanics learned during development. `--cycles` bounds consecutive
work sessions, and `--iterations` bounds each session's agent loop. Game actions
take real time. Do not interrupt and blindly replay a purchase or other mutation
whose outcome is unknown; inspect live state before continuing.

`runtime/` contains private, ignored game receipts, model decisions, and checkpoint
files. `evidence/` contains reviewed summaries. Profit means realized wallet change
after purchases and ship servicing; selling starting inventory or consuming fuel
must be accounted for separately. One-time mission rewards demonstrate progression,
but repeated profitable cycles are needed to establish self-sustaining behavior.

## Design

- `src/bridge.ts`: persistent authenticated library connection, a curated game
  command catalog, JSON-lines requests, and gameplay receipts.
- `runner.py`: real Hermes registration and tool dispatch, local model discovery,
  bounded sessions, isolated Hermes home, and resumable conversation evidence.
- `config.example.yaml`: isolated Hermes settings for the game sessions.

The enabled tools cover observation, navigation, mining, production experiments, markets, personal storage,
missions, freight contracts, equipment and ship upgrades, and servicing the current ship. Messaging and asset transfers to other
players are outside this toolset. The model does not receive account credentials.

Freight acceptance puts its package into origin station storage. Inspect its size,
withdraw `package:<id>`, and verify it appears in cargo before departure. The
carrier profile describes liability limits and the deliveries required for advancement.

Current game contracts come from the installed library's `COMMANDS.md` and generated
`ACTIONS` catalog. Public references: [library](https://github.com/SpaceMolt/spacemolt-lib),
[markets](https://spacemolt.com/docs/markets), and
[client protocol](https://spacemolt.com/docs/guides/client-dev).
