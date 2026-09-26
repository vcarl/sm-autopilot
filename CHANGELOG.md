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
- Fuel cells are part of resupply. Wherever the ship is serviced (`service()`, the automatic
  service in `rest`, a refuel stop on a `goTo`, a gather trip; not a freighter, whose hold is its circuit's), it tops
  `fuel_cell`s up to about 5% of the hold once they fall under 1%, bounded by
  `permissions.credit_reserve` like the fuel. A live ask over 1.5× the median ask in the market
  memory is skipped and the reason reported. Selling, stowing and settling leave that reserve
  aboard.

### Changed

- A trip needs only the fuel its route costs. The mood's fuel reserve (Focused 24, Relaxed and
  Cautious 30, Opportunistic 20, Aggressive 12, Tired 0) is no longer added to travel admission,
  before departure or before the return leg; it is the line under which the runtime imposes
  Tired, and so the trigger for resupply. Before, a pilot with 26 fuel was refused a 4-fuel trip
  for want of Focused's 24 and, never crossing the line, was never Tired either. The menu's
  travel rows, `freightBoard`'s `reachable` and `hunt`'s per-hop check follow the same rule; a
  hunt hop that lands under the reserve ends the search Tired before any fight. Distress detours
  in `goTo` are still only taken when the whole trip stays above the reserve. The freighter's
  own 10-unit travel margin and the internal standing reserve floor are gone with it.
- The Python sources pass `ruff check` with its default rules: imports sorted, annotations
  unquoted, and the deliberate broad `except` clauses marked as such.
- `play.py` is executable, matching its shebang.
- `spacemolt_stop` moved from the `spacemolt_observer` toolset to `spacemolt_observe`, so a
  juncture holds it too; a window configured as the README says keeps it. `plugin.yaml` no
  longer lists the removed `spacemolt_rest`.
- Development notes moved out of the root: `VISION.md` and `GAMEPLAY.md` to `docs/`; `TODO.md`,
  `worklog/` and `ported/` to `dev/`.
