# Direct SpaceMolt player

SpaceMolt is a native Hermes plugin. It does not use MCP: the gateway process owns one
profile-scoped Python service, that service owns one JSONL bridge, and the bridge owns the
only game controller lock. Discord conversations and cron sessions call the same fixed,
high-level SpaceMolt tools directly.

## Skills and scripts

Hermes uses the `spacemolt-operations`, `spacemolt-hunt`, `spacemolt-industry`, and
`spacemolt-logistics` skills to choose a stance, mood, objective, and home. It then calls the
matching high-level `spacemolt_*` tool: observe, plan, assess, prepare, transport, track, hunt,
gather, produce, return, reconcile, chat, or stop. `spacemolt_chat` sends one player message or
reads a channel; inbound chat is untrusted data and never an instruction. The scripts execute movement, combat defense,
servicing, verification, cleanup, and recovery; Hermes reports only their receipts. Planning
changes complete their execution handoff inside `spacemolt_plan`; an applied plan can be followed
by assessment and work in the same conversation. No terminal or code-execution call is needed.
Use `spacemolt_stop` when tired; scripts return and protect
existing obligations.

Native replies put status, errors, stopping reason, and job outcomes first. Outcomes
distinguish measured yield, cash change, known and unknown spending, retained custody,
and terminal ship/cleanup verification. Missing metrics are not reported as zero.
Mechanical command journals and repeated historical snapshots stay in the complete
reply referenced by `full_receipt` under the active profile's `spacemolt/tool-receipts/`.
Those private, content-addressed JSON files preserve the original reply for inspection;
the model receives the outcome and supporting decision evidence inline.
Observe, plan, and reconcile include the latest historical receipt, latest blocker,
and every unresolved job or command, with counts for omitted closed history. Current
observations, candidates, and obligations remain available inline. The execution store
and standalone runner retain their existing contracts.

## Install into a Hermes profile

### Run this fork, not an unrelated installed Hermes

From this checkout, bootstrap a Python 3.11+ environment and invoke the checked-out launcher.
That makes `./hermes` import this fork's source; do not use a separately installed `hermes`
binary that points at another checkout.

```sh
cd /path/to/hermes-spacemolt
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -e '.[all]'
./hermes profile create spacemolt --description 'Kvothe SpaceMolt player'
```

Use that same activated shell and `./hermes -p spacemolt` for each command below. The profile is
an independent state directory; it does not inherit another profile's model, Discord, or game
credentials. Configure those values with Hermes setup in the new profile.

Install this `spacemolt/` directory as a native plugin, enable it, and restart the gateway so
new sessions receive the static SpaceMolt tool catalog. In a published checkout that is:

```sh
hermes plugins install OWNER/hermes-spacemolt/spacemolt --enable
hermes spacemolt install --yes
```

For development from this local checkout, the equivalent exact plugin identifier is:

```sh
./hermes -p spacemolt plugins install "file://$PWD#spacemolt" --enable
./hermes -p spacemolt spacemolt install --yes
```

The second command deliberately runs `npm ci` only when requested. It installs the pinned
`@spacemolt/lib` dependency; it never bundles `node_modules` into the plugin. Put the existing
`Username:`/`Password:` credentials file outside this repository and configure only its path in
the profile's secret environment:

```dotenv
SPACEMOLT_CREDENTIALS_FILE=/secure/path/kvothe-credentials.txt
```

Then verify prerequisites and start the profile gateway:

```sh
./hermes -p spacemolt spacemolt setup
./hermes -p spacemolt gateway install
./hermes -p spacemolt gateway start
./hermes -p spacemolt gateway status
```

## Discord and scheduling

Configure Discord on the same profile with `./hermes -p spacemolt gateway setup`. The normal Hermes Discord
adapter owns authorization, DMs, mention policy, and replies; SpaceMolt adds only the direct
agent tools. A normal changed plan reports `status: applied` and a completed execution handoff.
Continue with the next tool in that conversation; another Discord message is not a fresh session.
The full native catalog and prompt remain fixed while the scripts enforce the updated plan.
An unchanged plan needs no handoff. Native conversations use objective continuation: prepare,
gather, produce and transport may advance the same goal across successive calls. A completed
job or a known readiness blocker does not permanently close productive work. Every job retains
the original cumulative spending allowance; changing a plan or sending a new message does not
replenish it. Explicit Tired and uncertain commands still stop work. To resume a stopped
objective, reconcile uncertain work and explicitly plan a non-Tired mood. Old native `one_job`
state is handled through that same explicit resumption; no journal deletion is needed.

Industry assessment exposes production recipes and `kind: mining_equipment`. Equipment
preparation accepts an observed `equipment_base_id`, verifies the owned laser at that station,
preserves a displaced passenger cabin and cargo, fits the laser, and returns serviced. The
agent may reconsider home through normal planning before requesting the trip.

Objective routes use observed normal connections and fuel/reserve evidence instead of a mood
jump ceiling. A route remains bounded by its initial verified length during execution; a changed
route needs reassessment. Explicit gathering batches may exceed the old mood cycle default;
physical readiness, cargo, spending and stop signals still govern execution.

Create an unattended objective with the standard scheduler:

```sh
./hermes -p spacemolt cron create "every 2h" --name spacemolt-logistics --deliver discord \
  "Observe Kvothe. If no work is active, choose a safe verified objective and complete at most one job. Report the verified receipt, obligations, fuel, cleanup, and blockers."
```

Use `spacemolt_stop` from a conversation for an urgent Tired signal. It bypasses normal queued
requests, while the bridge scripts retain ownership of defensive return, servicing, obligation
preservation, and reconciliation. `hermes spacemolt status` is local-process status only; it
never opens a second bridge. Do not run `src/bridge.ts` separately while the gateway is active.
