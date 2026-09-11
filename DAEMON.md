# Hermes daemon, cron and Discord boundary

Hermes can keep a profile alive as a macOS launchd service, run recurring cron
sessions and receive human direction through Discord. This repository's
`src/mcp-server.ts` supplies the missing boundary: Hermes starts one MCP server
for the profile, and that server owns one SpaceMolt bridge/controller. All cron
and Discord sessions see the same high-level `spacemolt_*` tools; requests are
serialized by the bridge and the game controller lock prevents a competing
connection.

## Configure the profile

Create a dedicated Hermes profile and copy the `mcp_servers.spacemolt` block from
`mcp-config.example.yaml` into that profile's `config.yaml`. Set
`SPACEMOLT_CREDENTIALS_FILE` in the profile's environment or launchd service to a
file containing the existing `Username:` and `Password:` fields. Keep that file
outside this repository. The optional stance, mood and objective variables only
choose the initial host context; Hermes still chooses an observed home through
`spacemolt_plan`.

Enable the SpaceMolt skill in that profile, then install and start the gateway:

```sh
hermes gateway install
hermes gateway start
hermes gateway status
```

The service owns the gateway process. Do not separately run `src/bridge.ts` or
`src/mcp-server.ts` while it is active; the controller lock is intentionally a
single-owner boundary. Stop the gateway before changing the MCP command or
credentials, then install it again so launchd captures the current PATH and
environment.

## Schedule fixed work

Use Hermes cron from chat or the CLI. A scheduled session should call the
high-level MCP tools and report verified receipts, rather than issuing raw game
commands. For example:

```text
/cron add "every 2h" "Observe Kvothe. If no transport is active, assess one Logistics opportunity, choose an observed home if needed, and execute at most one verified delivery. Report custody, payout, fuel, cleanup and blockers. If Tired or unsafe, return and service."
```

Pin the model/provider for unattended work when the profile uses paid providers.
Cron runs use fresh sessions and do not inherit a Discord transcript. A cron
session must not start another controller; its MCP calls go through the already
running profile server. A `terminal` script can be used for a no-agent health
check, but fixed gameplay still needs Hermes reasoning unless the script itself
owns a fully verified objective.

## Connect Discord

Configure the Discord bot token and allowed users/channels in the same dedicated
profile, following Hermes' Discord setup. DMs answer directly; server channels
normally require an @mention. Use a private channel or `DISCORD_ALLOWED_USERS`
for Kvothe direction, and keep `group_sessions_per_user: true` unless a shared
room is deliberately desired. Ask for observations, assessments, or a return;
the scripts retain custody and cleanup ownership. “Wind down” should map to the
`spacemolt_stop` tool, which signals Tired to the active scripts without opening
a second session or replaying a movement.

The MCP catalog is loaded when the gateway session starts. Restart/reload the
gateway after changing this server definition; do not hot-swap tools in a live
conversation when prompt-cache stability matters. Discord policy changes and
stance/mood changes should use a new session handoff. A normal message cannot
cancel an uncertain game mutation; reconciliation remains script-owned.

## Current boundary and next work

This adapter is a development scaffold until a real profile is configured. It
does not contain credentials, create schedules, send Discord messages or start a
controller automatically. Before live use, verify no existing controller process
or lock, configure one profile, start the gateway, and make one read-only
`spacemolt_observe` request. Then record the runtime directory, process handle,
authoritative pilot state and outstanding obligations in `TODO.md`.

Transport now verifies custody, return reachability, fuel allocation and selected
deadlines. Elapsed tick checks permit an accepted leg to finish but prevent a
later productive leg after an observed overrun. Passenger delivery timing remains
conditional: a positive deadline is not a guaranteed ETA.
