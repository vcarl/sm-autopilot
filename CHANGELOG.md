# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the plugin uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release is cut by tagging
`vX.Y.Z`; the tag must match `version` in `plugin.yaml` and `package.json`, and the
`## [X.Y.Z]` section below becomes the GitHub Release's notes.

## [Unreleased]

### Added

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
- Development notes moved out of the root: `VISION.md` and `GAMEPLAY.md` to `docs/`; `TODO.md`,
  `worklog/` and `ported/` to `dev/`.
