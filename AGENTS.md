# SpaceMolt plugin — working on it

Setup and operation live in [README.md](README.md). This file is for changing the code.
[docs/GAMEPLAY.md](docs/GAMEPLAY.md) is observed game mechanics, not guarantees.

## Principles

These decide most design questions here. Put them in every brief you hand a subagent: it does
not read this file unless told to.

- **Observe, don't gate.** Do not add a refusal, guard or precondition a pilot must satisfy before
  it may act. Log the condition for the developers, or name it to the pilot as information (a
  `not_now` row, a clause in `did`). The only refusals kept are ones that prevent real damage, such
  as overwriting a program still flying. Accreted gates are how a fresh pilot deadlocked on 09-26
  (see the last section).
- **The pilot's context is the game and its own acts, not our plumbing.** No streaks, gate
  reasons, skills-loaded notes or other internal state in its prompt. Those go to the journal.
- **Telemetry is raw, joinable facts, never verdicts.** Ids, before/after state, version stamps,
  per-call cost and gain. No "productive" booleans, targets, thresholds or alarms: success is
  judged later, by people, across many indicators.
- **Tired exists only to guarantee resupply.** When a pilot is Tired, the runtime drives the ship
  to fuel and repair without depending on the pilot writing it. Tired never blocks work.

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
other wake: nothing marks the job due (see the last section for why).

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

`runtime/../pilot.json`: objective, goal, steps, stance, permissions, instruction. Every field is
optional — a profile with no record is a pilot with no goal and no stance, and it flies. Written
only by the bridge's `pilot` request, which `spacemolt_reflect` and `spacemolt_direct` send.

An instruction stands until a run starts from a context rendered after the instruction was given
(`_pending_instruction` compares the run's `juncture_at` with the instruction's `at`). A run from
a context rendered earlier never saw it, so it does not consume it.

### Telemetry

`runtime/gameplay.jsonl` is also the analysis record: raw, joinable facts, no verdicts, never in
the pilot's context. Every line has `at` (UTC ISO, `Z`) and `event`.

- `gate`: `gate_id` (the gate runs in its own process, before any juncture exists).
- `juncture`: `juncture_id`, `gate_id`/`gate_at` of the latest gate, `job_id` (parsed from cron's
  `cron_<job_id>_<ts>` session id) and `session_id`, `model`, `provider`, `code_sha` (git HEAD),
  `sources` (the TypeScript fingerprint), `skills_sha`, `context_sha`, `build_s`. The id is kept in
  `runtime/juncture.json`; `spacemolt_run` sends it as the run request's `juncture` param.
  `juncture.json` also keeps the `objective` the context was rendered with; every `spacemolt_run`
  report while it differs from the record's says the objective changed.
- `juncture_rerender`: the same session rendered the context again (Hermes rebuilt the system
  prompt on compression). Same `juncture_id`, the fresh `context_sha`/`context`, and a `reason`.
  A non-busy rerender also moves `juncture.json`'s `at` to its own time, because its context can
  carry an instruction; a busy one cannot, so it leaves `at` (and `objective`) alone.
- `run` `started`: `run_id`, `juncture_id`, `juncture_at` (the `at` of the render the run came
  from; also written to `run.json`), `since_juncture_s` (from that render), `code_sha`, `sources`,
  `start_state` (credits, fuel, hull, cargo, skills, place, active missions — account memory only,
  no storage).
- `run` `ended`: `outcome`, `reason` (the run's, from its top earning call when the returned
  call is not it: `ofTheRun` in `prose.ts`; each call's own status is in `calls`), `work` (the run summary: the first work call's `fn` and
  `status`, total `credits`/`items`/`xp`), `end_state`, and `calls` (each top-level call's `fn`,
  `status`, `cost`, `gained`, `started_at`, `seconds`; first 40, `calls_total`). No `start_state`:
  pair it with its `started` line by `run_id`.
- Every line written while a run is bound carries its `run_id`; a freighter's lines carry
  `freighter` instead. Python-written lines (`gate`, `juncture`, `reflection`) never carry `run_id`.
- `trade` (buy/sell/refuel/repair: `unit_price`, `fills`, and `quote`, the book or posted price the
  caller held), `mission` (`accepted`/`completed`/`abandoned`; `already_active` for an accept that
  sent nothing; `expired` when a mission seen running is next read expired or past its deadline),
  `stranded`, `death`, and `pilot` with `prev`.
- `deps_installed` (`lock_sha256`, `seconds`) when a bridge start ran `npm ci`; `deps_failed`
  (`lock_sha256`, `error`, and `seconds`/`output` when npm ran). Nothing when the stamp matched.

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
them with a Python that has Hermes installed. On the maintainer's machine that is the testbench checkout
(`~/.hermes/hermes-agent/venv` is the live install and has no pytest):

```
HERMES_AGENT_ROOT=~/workspace/testbench/hermes-agent ~/workspace/testbench/hermes-agent/.venv/bin/python -m pytest -q
```

Every test gets a throwaway `HERMES_HOME`;
none of them may touch a real install. Where one reaches a *private* Hermes name, it goes through
`_private()` in `tests/test_spacemolt_skills.py`, which skips rather than fails: those names were
never a plugin surface, and a red suite meaning "the host refactored" teaches nothing.

Prefer asserting `job_fields()` output as data over driving cron's internals.

## Flying a change in a real profile

The tests prove the plugin against Hermes; only a real profile proves it against the game. A
profile's `plugins/spacemolt` is one of two things, and they upgrade differently:

- **An install** (a directory, with `plugins/.install-metadata.json` naming a pinned `revision`):
  what a user has. It flies released commits only, upgraded with
  `hermes --profile <profile> plugins install vcarl/sm-autopilot --ref <full sha> --enable --force`,
  and a gateway restart; the first bridge start then runs `npm ci` itself. `/shipit-locally` does exactly that,
  waits out a run in flight, and checks it landed; a human invoking it is the approval for that
  one profile and ref.
- **A dev symlink** to a worktree of this repo that is never worked in, only pointed. It flies any
  branch:

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

Which profile is which is machine-local, so check rather than assume:
`ls -l ~/.hermes/profiles/*/plugins/` shows symlinks, and an install has `.install-metadata.json`.

## Reading a pilot's day

Most bugs here are found by reading what a live pilot did, not by tests. Everything is under
`~/.hermes/profiles/<profile>/`:

| | |
|---|---|
| `spacemolt/runtime/gameplay.jsonl` + `gameplay.<stamp>.jsonl` | the journal; rotated at every bridge boot, so a day spans several files |
| `spacemolt/runtime/programs/<sha>.ts` | every program the pilot ran; a run's `source` names it |
| `spacemolt/runtime/run.json` | the run now (or last); `ended:false` means one is in flight |
| `spacemolt/runtime/bridge.stderr*.log` | the bridge's stderr, rotated with the journal |
| `spacemolt/pilot.json` | objective, goal, stance, the standing instruction |
| `cron/output/<job_id>/<local time>.md` | each fire's final reply: what the model said it did |
| `cron/jobs.json` | the juncture job as cron holds it: prompt, skills, schedule |
| `logs/gateway.log`, `logs/errors.log` | the gateway; restarts are `Stopping gateway for restart` |

Clocks: the journal is UTC. `gateway.log` and the `cron/output` filenames are **local time**
(EDT, UTC−4), so match a restart to the `boot` line it caused. `state.db` keeps a fire's tool
calls but not the model's reasoning: its words are only in `cron/output`.

To see what code a pilot was flying, read `code_sha` on `juncture` and `run started` lines, not
the checkout: an install and a symlink both report their own HEAD.

```
# How each run ended, and what its work call earned
jq -c 'select(.event=="run" and .phase=="ended") | {at, outcome, reason, fn: .work.fn, cr: .work.credits}' gameplay.jsonl
# Credits in and out per run: pair started and ended by run_id
jq -s -c '[.[]|select(.event=="run")] | group_by(.run_id) | map({run_id, start: (map(select(.phase=="started"))[0].start_state.credits), end: (map(select(.phase=="ended"))[0].end_state.credits)})' gameplay.jsonl
# What the pilot was told at each juncture
jq -r 'select(.event=="juncture") | .at, .context' gameplay.jsonl
```

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

Versions are CalVer, `YYYY.M.patch`, and only what a user installs carries one. The maintainer cuts
releases and sets versions; an agent never does unless asked for that release. Then:

1. Take the next patch after the latest `vYYYY.M.*` tag of the month (`2026.9.1` → `2026.9.2`).
   `v2026.9.7` is left from an older date-based scheme; ignore it when ordering.
2. Write the `## [version] - date` section of `CHANGELOG.md` by hand, under `## [Unreleased]`, in
   Keep a Changelog form (`### Added` / `### Fixed` / …), for the person installing the bot.
   `npx git-cliff --unreleased` (`cliff.toml`) previews what the commits say; it does not write
   the file.
3. Set the version in `plugin.yaml`, `package.json` and `package-lock.json`
   (`npm version <v> --no-git-tag-version` does the last two).
4. Commit `chore(release): <version>`, put `main` on it, tag `v<version>` (annotated), and push
   `main` then the tag.
5. The tag push runs `.github/workflows/release.yml`: it fails unless the tag, both version fields
   and the CHANGELOG section agree, reruns CI, then publishes the GitHub Release from that section
   with the install command pinned to the tagged commit. Watch it (`gh run watch`); the release
   is not done until it passes.

## Code conventions

- Match the density of the file you are in. The TypeScript is terse (one-line bodies, few
  blank lines); the Python is plain.
- A comment says why, and when the why is a live incident, it cites it:
  `// Live 2026-09-29 (kvothe 17:38Z): a paying trip returned completeMissions()'s refusal`.
  Tests that pin such a behavior carry the same line.
- A shortcut with a known ceiling carries a `ponytail:` comment naming the ceiling and when to lift
  it.

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
- **Wakes raised from inside a fire were erased by cron** from 09-16 to 09-26: a mark made while a
  fire holds the job is overwritten by cron's `mark_job_run`, so the throttle built on them
  governed nothing. The interval is the only clock; do not mark the job due from a fire.
- **An operator instruction was consumed by a run that never saw it** (09-29): it was written 1 s
  after the context rendered, and "any run started after it" counted as seen. Hence `juncture_at`
  on the run, compared with the instruction, not the run's start time.
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
- **An upgrade left the plugin with no `node_modules`** (09-29): `plugins install --force`
  replaces the directory, Hermes never installs a plugin's dependencies, and every bridge died
  on `ERR_MODULE_NOT_FOUND` until someone ran `npm ci`. `ensure_node_deps` now runs it before
  every spawn whose stamp (the lockfile's hash, written after a successful install) is missing
  or stale, under a `flock` on `package-lock.json` so two spawners never install at once.
