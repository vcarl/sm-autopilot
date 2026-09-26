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
juncture.py          the cron job, its prompt, its wake gate, the pilot record
skills_register.py   the play READMEs, registered as this plugin's own namespaced skills
wake_juncture.py     a one-shot the bridge spawns when a run ends, to ask for the next juncture
play.py              drives the same bridge from a shell, outside Hermes
src/bridge.ts        the request loop; everything below it is game logic
src/play/            the library the pilot's program imports, one folder per career
src/play/README.md   the base skill — what the pilot reads to know how to play at all
src/play/freighter/  freighters: each its own account and connection, hosted in the bridge process
```

### The seam

`service.py` spawns `node src/bridge.ts` and talks JSON lines over its stdio. One request in
flight; no replay. A `run` request blocks for as long as the program flies, up to
`REQUEST_TIMEOUT = 1800` — or until the program calls `ask()`, when the `run` answers early with
the question (also kept in `run.json`) and `answer` resumes the program and follows the run the
same way. Streamed lines go to whichever request is waiting on the run. There is **no build step**: Node strips the types itself, so keep the
TypeScript erasable (no enums, namespaces or parameter properties) and keep `.ts` on relative
imports.

A run outlives the conversation that started it. That is the whole reason the juncture exists,
and it is why anything that must happen at a run's end happens in `run.ts`, not in a tool
handler — no handler is waiting by then.

### The juncture

One cron job per pilot, named for it, rewritten from the pilot record every time it is touched
(`ensure_juncture_job`). What a fire carries is entirely `job_fields()`: the prompt, the stance's
skills, the fixed toolsets, and the gate script.

The **gate** (`install_gate`, `gate_main`) is a shim written into `HERMES_HOME/scripts/` and
named on the job as a *relative* path — cron resolves relative scripts there, and the tool layer
rejects absolute ones. Cron runs it before it builds the prompt, and a fire whose gate prints
`{"wakeAgent": false}` ends with no model turn. It runs outside the gateway, so it cannot ask the
bridge anything; it reads `runtime/run.json` instead. A run in flight that is paused on a question
wakes the fire anyway, and the gate prints the question, which cron puts at the head of the prompt.

Cron is reached through the **`cronjob_manage` tool**, via `ctx.dispatch_tool` (the plugin API)
or the tool registry when there is no plugin context. `check_cronjob_requirements` gates schema
*exposure*, not dispatch, so both work. The one exception is `mark_due`, which needs
`cron.jobs.trigger_job` — its docstring says why, and that is the plugin's only import from a
Hermes module. Do not "finish the job" by routing it through `cronjob_manage`'s `run`: that
executes the fire in the calling process, which is wrong in all three places it happens.

### Skills

The play READMEs *are* the skills. `ctx.register_skill("mining", …)` makes the career README
resolvable as `spacemolt:mining`, and a cron job names it that way. Nothing is copied or linked
into the profile's skills directory.

The failure mode to design against: cron **skips** a skill it cannot resolve, logs a warning, and
fires anyway. The pilot then flies with no career knowledge and looks perfectly healthy. So a
test that only proves nothing raised proves nothing — assert the README's text reaches the
prompt.

### The pilot record

`runtime/../pilot.json`: objective, goal, stance, mood, permissions. Written by the runner at
rest and by the observer; never by the agent directly. `wake_on_load` seeds one on a profile that
has never flown, because nothing else on this path does and a juncture will not fire without it.

## Tests

| | |
|---|---|
| `npm run typecheck` | must be clean |
| `npm test` | the TypeScript: game logic, the bridge, the play library |
| `pytest` | the Python: junctures, the channel, rest, skills, the wake |
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
  the one still flying. Hence `timeouts.tools.sequential_call: 1860` in the profile.
- **A gate that printed nothing suppressed every juncture.** Cron ends a fire whose script
  produced no output, so "wake normally" must be *prose*, never silence.
- **A gateway that died mid-run left `run.json` un-ended forever**, and a gate that believed it
  silenced the pilot for good. The controller lock has the last word.
- **A refused-run loop ran at model speed.** Three runs that did nothing in a row stop the
  immediate chaining and let the 30-minute interval govern; one productive run restores it, with
  no state to reset — the streak is derived from the journal.
- **A fresh install never got a juncture job.** Gateway startup loads plugins before the core
  tools, so `cronjob_manage` did not exist yet during `register()`, and the wake swallowed
  "Unknown tool". `cron_manage` imports `tools.cronjob_tools` itself, and a failed wake goes to
  the journal (`wake_failed`) and the log. Only a fresh interpreter shows this; pytest has the
  tools loaded already.
- **Python changes do not reach a running pilot.** `service.py` fingerprints the TypeScript so a
  stale bridge is visible, but the plugin's Python is imported once. A change there needs a
  gateway restart, and a broken juncture means the pilot never wakes again.
