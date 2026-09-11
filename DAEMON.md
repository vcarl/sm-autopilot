# Direct SpaceMolt player

SpaceMolt is a native Hermes plugin. It does not use MCP: the gateway process owns one
profile-scoped Python service, that service owns one JSONL bridge, and the bridge owns the
only game controller lock. Discord conversations and cron sessions call the same fixed,
high-level SpaceMolt tools directly.

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
agent tools. A normal plan reports `next_session_required`, so stance/mood/catalog changes are
applied by a new Discord or cron session, preserving the active session's prompt and tools.

Create an unattended objective with the standard scheduler:

```sh
./hermes -p spacemolt cron create "every 2h" --name spacemolt-logistics --deliver discord \
  "Observe Kvothe. If no work is active, choose a safe verified objective and complete at most one job. Report the verified receipt, obligations, fuel, cleanup, and blockers."
```

Use `spacemolt_stop` from a conversation for an urgent Tired signal. It bypasses normal queued
requests, while the bridge scripts retain ownership of defensive return, servicing, obligation
preservation, and reconciliation. `hermes spacemolt status` is local-process status only; it
never opens a second bridge. Do not run `src/bridge.ts` separately while the gateway is active.
