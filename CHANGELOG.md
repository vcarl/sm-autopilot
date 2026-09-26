# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release is cut by tagging
`vX.Y.Z`; the tag must match `version` in `plugin.yaml` and `package.json`, and the
`## [X.Y.Z]` section below becomes the GitHub Release's notes.

## [Unreleased]

### Added

- `ask({question, choices?})` in the play library: the program pauses and hands the
  question back to the model that started it, and resumes with the answer. `spacemolt_run`
  returns early with the question; the new `spacemolt_answer` tool resumes the program and waits
  on the rest of the run; `spacemolt_stop` withdraws the question and returns the report. A
  question left unanswered wakes the next juncture, which opens with it.
- Continuous integration: every pull request and push to `main` runs the TypeScript typecheck
  and tests on Node 22.18.0 and the current LTS, `ruff check`, and the Python tests against a
  pinned Hermes release. A weekly run tests against Hermes' `main` so host drift shows up early.
- A release workflow: pushing a `v*` tag checks the tag against `plugin.yaml`, `package.json`
  and this file, reruns CI, and publishes the matching section here as the GitHub Release.
- Dependabot for npm (weekly, toolchain grouped, the game client on its own) and GitHub Actions
  (monthly).
- This changelog.

### Changed

- The Python sources pass `ruff check` with its default rules: imports sorted, annotations
  unquoted, and the deliberate broad `except` clauses marked as such.
- `play.py` is executable, matching its shebang.
- `spacemolt_stop` moved from the `spacemolt_observer` toolset to `spacemolt_observe`, so a
  juncture holds it too; a window configured as the README says keeps it. `plugin.yaml` no
  longer lists the removed `spacemolt_rest`.
- Development notes moved out of the root: `VISION.md` and `GAMEPLAY.md` to `docs/`; `TODO.md`,
  `worklog/` and `ported/` to `dev/`.
