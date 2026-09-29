# SpaceMolt plugin — working on it

Setup and operation live in [README.md](README.md). This file is for changing the code.
[docs/GAMEPLAY.md](docs/GAMEPLAY.md) is observed game mechanics, not guarantees.

## Shape

Two languages, one seam. Python is the Hermes side — tools, the juncture, the profile's files.
TypeScript is the game side — one long-lived process that owns the connection.

```
plugin.yaml          manifest: name, toolsets, the settings a working install needs
__init__.py          register(): the tools, the system-prompt sections, the observer window
service.py           bridge ownership: one Node child per Hermes process, one request in flight
juncture.py          the cron job, its prompt, its wake gate, the juncture context
skills_register.py   the play READMEs, registered as this plugin's own namespaced skills
play.py              drives the same bridge from a shell, outside Hermes
src/bridge.ts        the request loop; everything below it is game logic
src/play/            the library the pilot's program imports, one folder per career
src/play/README.md   the base skill — what the pilot reads to know how to play at all
src/play/freighter/  freighters: each its own account and connection, hosted in the bridge process
```

### The seam

`service.py` spawns `node src/bridge.ts` and talks JSON lines over its stdio. Requests run
concurrently; none is replayed. A `run` request blocks for as long as the program flies — or until
the program calls `ask()`, when the `run` answers early with the question (also kept in
`run.json`) and `answer` resumes the program and follows the run the same way. Streamed lines go to
whichever request is waiting on the run. The bridge caps a run (`RUN_CAP_MS`, then `RUN_GRACE_MS`,
26 minutes in all; a pending question is withdrawn at the cap) under `REQUEST_TIMEOUT = 1800`,
which is only a backstop. A script that ignores the stop at the cap is abandoned and the bridge
exits, so it cannot send another command. There is **no build step**: Node strips the types itself, so keep the
TypeScript erasable (no enums, namespaces or parameter properties) and keep `.ts` on relative
imports.

A run lives inside the fire that started it. When a bridge dies under a run, the next bridge to
boot closes `run.json` as `interrupted` and re-runs nothing.

The bridge is the only writer of `pilot.json` (the `pilot` request). Python reads it. The mood is
never stored: the bridge derives it on every read from the stance's working mood and the ship
(`moodNow`, `flying`), so an older record's `mood` key is dropped on read.

### The juncture

One cron job per pilot, named for it, rewritten from the pilot record every time it is touched
(`ensure_juncture_job`, schedule included). What a fire carries is entirely `job_fields()`: the
prompt, the skills, the fixed toolsets, and the gate script. The interval is `IDLE_SCHEDULE = "5m"`
and cron re-anchors it on a fire's completion, so it is the pause between junctures. There is no
other wake: nothing marks the job due. (A mark made while a fire holds the job is erased by
cron's `mark_job_run`, which is how every in-fire wake silently did nothing from 09-16 to 09-26.)

The **gate** (`install_gate`, `gate_main`) is a shim written into `HERMES_HOME/scripts/` and
named on the job as a *relative* path — cron resolves relative scripts there, and the tool layer
rejects absolute ones. Cron runs it before it builds the prompt, and a fire whose gate prints
`{"wakeAgent": false}` ends with no model turn. It runs outside the gateway, so it reads
`runtime/run.json`. It suppresses exactly one thing, a run in flight (not ended) that is not
paused on a question; a paused run wakes the fire, and the gate prints the question, which cron
puts at the head of the prompt. Every decision is journalled with its reason.

The **context** (`juncture_context`) is built from live facts at fire time: the bridge's `menu`
(present, derived mood, threats, suggested moves) and the pilot's own recent runs and reflections
from the journal. It writes nothing but a `juncture` journal line — the skills carried, their
sizes, and the context itself — so a reviewer can see what the pilot was told.

Cron is reached through the **`cronjob_manage` tool**, via `ctx.dispatch_tool` (the plugin API)
or the tool registry when there is no plugin context. `check_cronjob_requirements` gates schema
*exposure*, not dispatch, so both work. The plugin imports no `cron.*` module.

### Skills

The play READMEs *are* the skills. `ctx.register_skill("mining", …)` makes the career README
resolvable as `spacemolt:mining`, and a cron job names it that way. A fire carries the base
README plus the stance's career README; the stance exists so a smaller model is not handed every
career at once. Nothing is copied or linked
into the profile's skills directory.

The failure mode to design against: cron **skips** a skill it cannot resolve, logs a warning, and
fires anyway. The pilot then flies with no career knowledge and looks perfectly healthy. So a
test that only proves nothing raised proves nothing — assert the README's text reaches the
prompt.

### The pilot record

`runtime/../pilot.json`: objective, goal, stance, permissions, instruction. Every field is
optional — a profile with no record is a pilot with no goal and no stance, and it flies. Written
only by the bridge's `pilot` request, which `spacemolt_reflect` and `spacemolt_direct` send. An
instruction stands until a run whose context was rendered after it was given (a rerender counts —
see `juncture_rerender` below).

### Telemetry

`runtime/gameplay.jsonl` is also the analysis record: raw, joinable facts, no verdicts, never in
the pilot's context. Every line has `at` (UTC ISO, `Z`) and `event`.

- `gate`: `gate_id` (the gate runs in its own process, before any juncture exists).
- `juncture`: `juncture_id`, `gate_id`/`gate_at` of the latest gate, `job_id` (parsed from cron's
  `cron_<job_id>_<ts>` session id) and `session_id`, `model`, `provider`, `code_sha` (git HEAD),
  `sources` (the TypeScript fingerprint), `skills_sha`, `context_sha`, `build_s`. The id is kept in
  `runtime/juncture.json`; `spacemolt_run` sends it as the run request's `juncture` param.
- `juncture_rerender`: the same session rendered the context again (Hermes rebuilt the system
  prompt on compression). Same `juncture_id`, the fresh `context_sha`/`context`, and a `reason`.
  `runtime/juncture.json`'s `at` moves to this render's time (an instruction the pilot sees only
  because of the rerender must count as seen), which also shifts `since_juncture_s` on the next
  run to mean "since this render," not the fire's first one.
- `run` `started`: `run_id`, `juncture_id`, `juncture_at` (when that context was rendered; also on `run.json`), `since_juncture_s`, `code_sha`, `sources`, `start_state`
  (credits, fuel, hull, cargo, skills, place, active missions — account memory only, no storage).
- `run` `ended`: `end_state`, `calls` (each top-level call's `cost`, `gained`, `started_at`,
  `seconds`; first 40, `calls_total`).
- Every line written while a run is bound carries its `run_id`; a freighter's lines carry
  `freighter` instead. Python-written lines (`gate`, `juncture`, `reflection`) never carry `run_id`.
- `trade` (buy/sell/refuel/repair: `unit_price`, `fills`, and `quote` — the book or posted price the
  caller held), `mission` (accepted/completed/abandoned; `already_active` for an accept that sent nothing; `expired` when a mission seen running is next read expired or gone past its deadline), `stranded`, `death`, and `pilot` with `prev`.

Joins: `juncture_id` juncture → run; `run_id` run → everything in it; `job_id` + `at` juncture →
Hermes' `cron/usage_audit.jsonl` (tokens, LLM time, model).

Rotation: each bridge boot (`bootJournal` in `run-record.ts`, right after the controller lock)
renames a non-empty `gameplay.jsonl` to `gameplay.<UTC stamp>.jsonl` (`2026-09-28T04-53-54Z`;
`_<pid>` on a same-second clash), then writes the interrupted-run close and the `boot` line into the
fresh file; `boot` carries `rotated_from`, so the chain walks back. `service.py` rotates
`bridge.stderr.log` the same way (`rotate_log`) before it opens it. Rotated files are never deleted.
Python appends to `gameplay.jsonl` by name per line, so it follows the rename. Readers of the recent
past go through one tail walker per language — `readJournal` (TS: reflection, the menu, the
rendered window, `play/service.ts`) and `journal_tail` (Python: the gate, the recent-runs context)
— which read the current file, then rotated ones newest first, until they have enough.

## Tests

| | |
|---|---|
| `npm run typecheck` | must be clean |
| `npm test` | the TypeScript: game logic, the bridge, the play library |
| `pytest` | the Python: junctures, the gate, the channel, skills |
| `uvx ruff@0.16.9 check .` | must be clean; default rules, no config, the version CI pins |

The Python tests import `cron` and `hermes_cli` to prove the plugin works against the real host,
so they need the Hermes tree and an interpreter with Hermes' own dependencies. `conftest.py` finds
that tree at `$HERMES_AGENT_ROOT`, or `~/.hermes/hermes-agent` — where `hermes` installs it — and
binds this directory to the package name `spacemolt` that Hermes imports the plugin under. Run
them with a Python that has Hermes installed, e.g.
`/path/to/hermes-agent/.venv/bin/python -m pytest`. Every test gets a throwaway `HERMES_HOME`;
none of them may touch a real install. Where one reaches a *private* Hermes name, it goes through
`_private()` in `tests/test_spacemolt_skills.py`, which skips rather than fails: those names were
never a plugin surface, and a red suite meaning "the host refactored" teaches nothing.

Prefer asserting `job_fields()` output as data over driving cron's internals.

## Flying a change in a real profile

The tests prove the plugin against Hermes; only a real profile proves it against the game. The
dev profile's plugin is a symlink to a worktree of this repo that is never worked in, only
pointed:

```
~/.hermes/profiles/<profile>/plugins/spacemolt -> ~/workspace/sm-autopilot-live   (detached HEAD)
```

To fly a branch:

```
git -C ~/workspace/sm-autopilot-live switch --detach <branch>
npm --prefix ~/workspace/sm-autopilot-live ci            # only if package-lock.json changed
hermes --profile <profile> gateway restart               # Python is imported once; see below
```

Then check it landed: the juncture job in `~/.hermes/profiles/<profile>/cron/jobs.json` lists
`spacemolt:play` and the stance's skill, and `logs/errors.log` has no `skill not found` or
`Plugin spacemolt:` warning since the restart. The pilot's state lives in the profile
(`spacemolt/runtime/`, `spacemolt/pilot.json`), not the checkout, so switching branches never
touches it. Detached, so any branch can be flown while it stays checked out where it is worked on.

## Commits and releases

Commits are [Conventional Commits](https://www.conventionalcommits.org), because the changelog is
generated from them: `type(scope): summary`, and a body that says why. `feat`, `fix` and `perf`
reach users' release notes; `refactor`, `test`, `docs`, `chore`, `build` and `ci` do not. The
scope is the subsystem — `juncture`, `bridge`, `play`, `skills`, `service` — and becomes the
package name once this is a monorepo.

A change the user must act on — edit a setting, re-run setup, upgrade Hermes — takes `!` after the
type and a `BREAKING CHANGE:` footer saying *what to do*. Those footers become the release's
"Action required" section, verbatim, so write them for the person installing the bot. The footer
is only read after a body paragraph; without one, the notes fall back to the summary line.

Versions are CalVer, `YYYY.M.patch`, and only what a user installs carries one. Carl cuts releases
and sets versions; an agent never does. `npx git-cliff --unreleased` previews the notes
(`cliff.toml`).

## Things that have gone wrong, so they are load-bearing now

- **A 420-second tool timeout killed an 11-minute run**, and the pilot's next program overwrote
  the one still flying. Hence `timeouts.tools.sequential_call: 1860` in the profile, and
  `spacemolt_run` refusing to write `pilot/index.ts` while a run is in flight.
- **A gate that printed nothing suppressed every juncture.** Cron ends a fire whose script
  produced no output, so "wake normally" must be *prose*, never silence.
- **States that refused the one act that would leave them deadlocked a fresh pilot** (09-26): no
  stance refused every run, so the ship could not be serviced, so rest refused, so no stance. There
  is no shift state now, a missing stance refuses nothing, and the mood is derived. Do not add a
  gate a pilot must satisfy before it may act; report the condition instead.
- **Wakes raised from inside a fire were erased by cron** for ten days, and the throttle built on
  them governed nothing. The interval is the only clock; do not mark the job due from a fire.
- **Auto-resume turned every bridge spawn into a detached, uncapped re-run** of an old script.
  An un-ended run is closed `interrupted` at boot instead.
- **A fresh install never got a juncture job.** Gateway startup loads plugins before the core
  tools, so `cronjob_manage` did not exist yet during `register()`, and the load swallowed
  "Unknown tool". `cron_manage` imports `tools.cronjob_tools` itself, and a failed write goes to
  the journal (`wake_failed`) and the log. Only a fresh interpreter shows this; pytest has the
  tools loaded already.
- **A test run wrote a pilot record, a lock and a cron job into `~/.hermes`** (09-25), before the
  conftest redirect existed. The redirect now precedes binding the plugin, and every test asserts
  the runtime directory is under its own home.
- **Python changes do not reach a running pilot.** `service.py` fingerprints the TypeScript so a
  stale bridge is visible, but the plugin's Python is imported once. A change there needs a
  gateway restart, and a broken juncture means the pilot never wakes again.
