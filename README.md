# SpaceMolt — a Hermes plugin that plays a game by itself

[SpaceMolt](https://spacemolt.com) is a persistent multiplayer space game with a TypeScript
client. This plugin hands one game account to a [Hermes](https://github.com/NousResearch/hermes-agent)
agent and lets it play unattended, for weeks, with no human in the loop.

The pilot does not play by calling a tool per action. It plays by **writing a program**. Each
time it wakes it writes the whole of `pilot/index.ts` — a module that imports a small library of
game verbs and returns what happened — and runs it. The program flies for minutes of real time
(at most 24, capped by the bridge) and its report comes back into the same turn. A few minutes
after that turn ends the pilot is woken again, with a fresh conversation and the facts of where the
ship stands. That wake-up is called a **juncture**, and it is one Hermes cron job.

Around that sit two more things. **Stances** (Prospector, Industrialist, Trader, Carrier,
Hunter, Scout) decide which career's documentation the next juncture carries, so a miner reads
about mining and nothing else; with no stance a juncture carries the base documentation alone. And an **observer** toolset lets a human in a chat window
watch, ask what is going on, and hand down one sentence of direction — without becoming the thing
that keeps the pilot alive.

## What you need before you start

| | |
|---|---|
| A SpaceMolt account | Its credentials in a file on disk. The plugin never holds them itself. |
| Hermes | Installed, with a working model configured (`hermes model`). The gateway is what fires junctures, so a pilot only plays while a gateway is running. |
| Node **22.18.0 or newer** | The bridge runs `node src/bridge.ts` **with no build step**, relying on Node's native TypeScript type stripping being on by default — 22.18.0 (LTS) or 23.6.0 is where that happens. `@spacemolt/lib` itself asks only for Node 22, but an unflagged `node foo.ts` needs the newer floor. The code uses only erasable syntax (no enums, namespaces or parameter properties), so plain stripping is enough; no `--experimental-transform-types`. |
| `npm ci` in this directory | **Not just for development.** At runtime the bridge symlinks `node_modules/@spacemolt` into the pilot's working directory and shells out to `node_modules/typescript/bin/tsc` to typecheck the pilot's program before running it. Without `node_modules` nothing flies. |

## Setup

SpaceMolt is modelled as **its own Hermes profile**. It changes profile-wide settings (a very
long tool timeout, a raised turn limit), so it should not share a profile with your ordinary
assistant.

### 1. A profile of its own

```bash
hermes profile create spacemolt   # or any name; `spacemolt` below means "this profile"
```

### 2. Install the plugin

```bash
hermes plugins install vcarl/sm-autopilot --enable
```

`hermes plugins install` also takes a full Git URL. The plugin is at this repository's root,
so no `#subdirectory` suffix is needed. To develop against a local checkout, point it at the path:

```bash
hermes plugins install "file:///path/to/sm-autopilot" --enable
```

Confirm it landed:

```bash
hermes plugins list        # spacemolt, enabled
```

### 3. Install the Node dependencies

```bash
cd ~/.hermes/profiles/spacemolt/plugins/spacemolt
npm ci
npm run typecheck && npm test   # optional, but it proves the toolchain works
```

### 4. Give it the game account

Put your SpaceMolt credentials somewhere private, then name the file in the **profile's own**
`.env` — `~/.hermes/profiles/spacemolt/.env`, not the shared one:

```bash
chmod 600 /path/to/spacemolt-credentials.txt
echo 'SPACEMOLT_CREDENTIALS_FILE=/path/to/spacemolt-credentials.txt' \
  >> ~/.hermes/profiles/spacemolt/.env
```

The path is read as a **profile-scoped secret**, so one machine can run several pilots on
several accounts without either seeing the other's file. Without it, every SpaceMolt tool
disappears from the agent's schema and the bridge refuses to start.

Optionally, in the same file, to have the pilot's journal posted to Discord as it plays:

```
SPACEMOLT_JOURNAL_WEBHOOK=https://discord.com/api/webhooks/...
```

### 5. The one setting you cannot guess

Add this to the profile's `config.yaml` (`~/.hermes/profiles/spacemolt/config.yaml`):

```yaml
timeouts:
  tools:
    sequential_call: 1860
```

**Do not skip this.** One `spacemolt_run` blocks for as long as the program flies, bounded by
the bridge's own 1800-second limit. Hermes' default cuts every tool call off at 420 seconds, so
without this setting a long run is killed mid-flight, the agent is told nothing useful, and the
pilot's next program can overwrite one that is still running. It applies to every tool this
profile runs — which is why SpaceMolt gets its own profile.

While you are in there, these make unattended play behave:

```yaml
agent:
  max_turns: 150
auxiliary:
  background_review:
    enabled: false        # a fire is not a code change; nothing to review
cron:
  model_drift_guard: false
session_reset:
  mode: none
```

### 6. Let the chat windows watch

The plugin provides three toolsets:

- `spacemolt` — the tools a juncture flies with (`spacemolt_run`, `spacemolt_check`,
  `spacemolt_reflect`). The juncture job enables these itself; you do not.
- `spacemolt_observe` — the reads (`spacemolt_status`). Safe anywhere.
- `spacemolt_observer` — direction (`spacemolt_direct`, `spacemolt_stop`). This is the human's
  half; a juncture deliberately never gets it, so the pilot cannot set its own objective.

To watch from the CLI and from a chat platform, add the observer toolsets to those platforms:

```yaml
platform_toolsets:
  cli:
    - spacemolt_observe
    - spacemolt_observer
  discord:
    - spacemolt_observe
    - spacemolt_observer
```

### 7. Start the gateway

```bash
hermes gateway
```

## What a working first juncture looks like

Loading the plugin writes exactly one cron job. There is no pilot record yet
(`~/.hermes/profiles/spacemolt/spacemolt/pilot.json`); the bridge writes one the first time a goal,
stance or objective is set. Within five minutes of starting the gateway:

```console
$ hermes cron list
spacemolt juncture: pilot   every 5m   next: <within five minutes>
  skills: spacemolt:play
  script: spacemolt-juncture-gate.py
```

Then, in order:

1. The job fires. Its **gate script** runs first: if `runtime/run.json` says a program is in
   flight the fire ends with no model turn; otherwise it prints prose and the fire proceeds. Either
   way it journals the decision.
2. The agent's turn writes `pilot/index.ts` and calls `spacemolt_run`. This is where minutes
   pass. The bridge logs to `~/.hermes/profiles/spacemolt/spacemolt/runtime/bridge.stderr.log`
   and appends a line per event to `runtime/gameplay.jsonl`.
3. The run's report comes back into the same turn. When the pilot wants a different goal or
   career it calls `spacemolt_reflect` (goal, stance, objective_done — any of them).
4. A stance change rewrites the juncture job, so the next fire carries `spacemolt:play` plus
   (say) `spacemolt:mining`. Cron schedules that fire five minutes after this one ends.

Two reads tell you it is alive:

```bash
tail -f ~/.hermes/profiles/spacemolt/spacemolt/runtime/gameplay.jsonl
hermes cron runs            # per-fire outcomes
```

What each fire leaves in `gameplay.jsonl`, to reconstruct it later: a `gate` line (woke or not,
and why, with the streak of runs that did nothing), a `juncture` line (stance, the skills carried
and their sizes, and the whole context the pilot was given), then the bridge's `run` lines —
`refused` with the check's errors, or `started` and `ended` with outcome, reason and commands —
and `pilot` lines for every write to the record. Every program checked is kept at
`runtime/programs/<sha>.ts`. A bridge boot is a `boot` line, naming any run it closed as
`interrupted`.

### When it is silent

| Symptom | Cause |
|---|---|
| `hermes cron list` shows no SpaceMolt job | The plugin did not load. `hermes plugins list`; check the gateway log for a registration error. |
| The job fires and ends with no model turn, repeatedly | The gate reads `runtime/run.json` as in flight (`ended: false`). A live bridge ends every run within 26 minutes; a dead one's record is closed `interrupted` the next time a bridge starts, which any tool call or juncture does. |
| A fire runs, writes a program, and the tool dies after ~7 minutes | `timeouts.tools.sequential_call` is not set. See step 5. |
| Fires succeed but the pilot plays badly and never seems to know its career | A skill did not resolve. Cron **skips** an unresolvable skill with a log warning and fires anyway, so this looks healthy. Check the gateway log for `skill not found, skipping`. |
| Every tool is missing from the agent | No `SPACEMOLT_CREDENTIALS_FILE` secret in this profile, or `node` is not on the gateway's PATH. |

## Playing without Hermes

`play.py` drives the same bridge from a shell, against a scratch directory, for trying the play
library out by hand:

```bash
export SPACEMOLT_CREDENTIALS_FILE=/path/to/spacemolt-credentials.txt
python3 play.py serve ./playground &      # holds the game connection
SPACEMOLT_PLAYGROUND=./playground python3 play.py run my-program.ts
```

It is a local playtest tool with no authentication on its socket, and it never posts to Discord.
It uses the **same game account**, so do not run it against an account a gateway is flying.

## Working on the plugin

See [AGENTS.md](AGENTS.md).
