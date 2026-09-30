---
name: shipit-locally
description: Upgrade a local Hermes profile's installed spacemolt plugin to a released commit, restart its gateway, and verify the pilot is flying it. A human invokes this; invoking it is the approval for this one profile and this one ref.
argument-hint: "[profile, default kvothe] [tag or full SHA, default the latest release]"
disable-model-invocation: true
allowed-tools: Bash(hermes --profile * plugins install *), Bash(hermes --profile * gateway restart), Bash(npm ci --prefix *)
---

# Ship it locally

Put a local pilot on released code the way a user upgrades: `hermes plugins install --ref <sha>
--force`, `npm ci`, gateway restart. This is not the dev loop in AGENTS.md ("Flying a change in a
real profile", a symlink to `sm-autopilot-live`); a profile whose `plugins/spacemolt` is a symlink
is not an install, so stop and say so.

## What invoking this approves, and what it does not

Approved, for the named profile only: reinstalling its `spacemolt` plugin at the resolved commit,
`npm ci` in that plugin directory, and restarting that profile's gateway.

Not approved: merging, tagging, pushing, editing versions, touching any other profile, and
anything under the profile's `spacemolt/` (runtime, `pilot.json`). The pilot's state is not part
of a deploy. If a step below would need any of those, stop and ask.

## Steps

`P` is the profile (`$ARGUMENTS` first word, default `kvothe`); `H=~/.hermes/profiles/$P`.

1. **Resolve the ref to one full SHA.** Default: the latest GitHub release
   (`gh release view --json tagName -q .tagName`). A tag resolves with
   `git ls-remote origin "refs/tags/<tag>^{}"`; a SHA must be 40 hex characters and reachable on
   origin (`git ls-remote origin` / `git branch -r --contains`). Only pushed code ships: the
   install fetches from GitHub, not this checkout. For a tag, confirm its Release workflow passed
   (`gh run list --workflow Release --branch <tag>`); if it did not, stop.
2. **Preflight.** `$H/plugins/spacemolt` exists and is not a symlink.
   `$H/plugins/.install-metadata.json` gives the current `revision`; if it already equals the
   SHA, report that and stop.
3. **Wait out a run in flight.** Read `$H/spacemolt/runtime/run.json`. A restart under a run
   closes it `interrupted`, so:
   - `ended: true` (or no file): go on.
   - `ended: false` with a `question`: the run is paused on `ask()` and waits for a juncture, not
     for time. Stop and tell the user, who decides whether to interrupt it.
   - `ended: false` otherwise: wait for it with Monitor (an until-loop on `"ended":true`). Runs
     are capped at 26 minutes from `started`; if it is still open 30 minutes after `started`,
     stop and report rather than restart under it.
   Re-read `run.json` immediately before step 4: a juncture may have started a new run.
4. **Install.** `hermes --profile $P plugins install vcarl/sm-autopilot --ref <sha> --enable --force`.
5. **Dependencies.** `npm ci --prefix $H/plugins/spacemolt`. Always, not only when the lockfile
   changed: `--force` reinstalls the directory.
6. **Restart.** `hermes --profile $P gateway restart`. Python is imported once per gateway
   process; without this the pilot keeps the old plugin.
7. **Verify it landed.** Each of these, with what you saw:
   - `.install-metadata.json` `revision` is the SHA.
   - `$H/cron/jobs.json`: the juncture job's skills include `spacemolt:play` and the stance's
     skill.
   - `$H/logs/errors.log` and `gateway.log` since the restart: no `skill not found`, no
     `Plugin spacemolt:` warning, no traceback from the plugin.
   - The next `juncture` line in `$H/spacemolt/runtime/gameplay.jsonl` carries `code_sha` equal
     to the SHA. Junctures are about 5 minutes apart (`IDLE_SCHEDULE`); wait with Monitor, up to
     15 minutes. No juncture in that time is a failure to report, not to paper over.
8. **Report.** Profile, old → new revision, the release it came from, whether a run was waited
   out, and each check in step 7. If anything failed, say which step, with the log lines, and
   leave the profile as it is: do not reinstall the old revision unless the user asks.

## If this session cannot run a step

A worktree-isolated session may refuse commands that reach outside its worktree. Do not work
around the refusal. Hand the user the remaining steps as one fish-safe line
(`cmd1; and cmd2; and cmd3`), then do the verification in step 7 once they say it ran.
