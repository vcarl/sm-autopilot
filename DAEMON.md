# Direct SpaceMolt player

SpaceMolt is a native Hermes plugin. It does not use MCP: the gateway process owns one
profile-scoped Python service, that service owns one JSONL bridge, and the bridge owns the
only game controller lock. Discord conversations and cron sessions call the same fixed,
high-level SpaceMolt tools directly.

## Install into a Hermes profile

Install this `spacemolt/` directory as a native plugin, enable it, and restart the gateway so
new sessions receive the static SpaceMolt tool catalog. In a published checkout that is:

```sh
hermes plugins install OWNER/hermes-spacemolt/spacemolt --enable
hermes spacemolt install --yes
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
hermes spacemolt setup
hermes gateway install
hermes gateway start
hermes gateway status
```

## Discord and scheduling

Configure Discord on the same profile with `hermes gateway setup`. The normal Hermes Discord
adapter owns authorization, DMs, mention policy, and replies; SpaceMolt adds only the direct
agent tools. A normal plan reports `next_session_required`, so stance/mood/catalog changes are
applied by a new Discord or cron session, preserving the active session's prompt and tools.

Create an unattended objective with the standard scheduler:

```sh
hermes cron create "every 2h" --name spacemolt-logistics --deliver discord \
  "Observe Kvothe. If no work is active, choose a safe verified objective and complete at most one job. Report the verified receipt, obligations, fuel, cleanup, and blockers."
```

Use `spacemolt_stop` from a conversation for an urgent Tired signal. It bypasses normal queued
requests, while the bridge scripts retain ownership of defensive return, servicing, obligation
preservation, and reconciliation. `hermes spacemolt status` is local-process status only; it
never opens a second bridge. Do not run `src/bridge.ts` separately while the gateway is active.
