# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are CalVer,
`YYYY.M.patch`. A release is cut by tagging `vYYYY.M.patch`; the tag must match `version` in
`plugin.yaml` and `package.json`, and the `## [YYYY.M.patch]` section below becomes the GitHub Release's notes.

## [Unreleased]

## [2026.10.0] - 2026-10-01

### Added

- `exploreNearby({systems?, jumps?, survey?, avoid?})` visits the nearest systems this pilot has
  never been to, scouting each, and reports what it found and what is left in range. `avoid`
  skips a system as a stop or on the route; which systems are safe enough is the pilot's call.
  What it learns of each system (police, security, pirates seen) is kept in `systems.json`.
- The juncture's Present line names the systems one jump out, each visited or not, with what is
  known about it.

### Changed

- Setting a new objective through `spacemolt_direct` clears the goal and stance set for the old
  one (unless the same call sets them), rewrites the juncture job so the old career skill is no
  longer carried, and stops a run in flight at its next safe point. Every run report in a fire
  planned for the old objective says the objective changed.

### Fixed

- The menu finds the nearest unvisited system anywhere within five jumps from one map read,
  where it once checked three neighbours one jump out and said nothing past them. Its row
  states what is known (empire, stronghold, pirates seen) and never drops a system for danger;
  when nothing is in range it says where the nearest unvisited system is.
- A reflection or direction whose juncture-job rewrite fails is logged and journalled, not
  raised after the record was already written.

## [2026.9.2] - 2026-09-29

### Added

- The industry career: `recipes`, `quote`, `supply`, `craft`, `jobs`, `materials`, `facilities`
  and `buildFacility`. A craft quotes the whole order at the bench it names, stocks the store,
  escrows once, waits out the queue and settles on the store delta. `materials` walks a recipe
  to its raw inputs, `jobs` reads the queue from anywhere, and a pilot can build a facility of
  its own. The base README names these calls, so a pilot that does not carry the industry skill
  uses them instead of raw commands.
- The juncture's Present line shows each skill's xp toward its next level.

### Fixed

- An operator instruction given after the juncture rendered was consumed by a run from that
  same juncture, so the model never saw it. A run now records when its context was rendered
  (`juncture_at`), and only a run from a context shown after the instruction consumes it.
- Recent runs lead with the work done and what it earned; the program's return value comes
  after. A paying run that returned a refusal no longer reads as a failure.
- The menu no longer offers a ship the pilot's Piloting cannot fly; it names the gap under
  "not now". It offers to refit modules sitting in the store, shows the ask and any better
  remembered bid on sell rows, and ranks `abandonMission` first when every slot is stuck.
- A sell summarises its fills by item and names a better bid remembered elsewhere.
- `gatherUntil({maxTrips})` makes that many trips without `until`.
- A dropped connection during `goTo`, `gatherUntil`, `hunt` or `freightBoard` is reported as
  `failed`, not as a refusal or a skipped stop.
- A run summary keeps a working call's own status when a later call's refusal ended the run.

## [2026.9.1] - 2026-09-29

### Fixed

- `account().commands.<tool>.<action>(params)` sends its params as the payload. The lib binds a
  no-param action (salvage `quote`/`sell`/`scrap`/`insure`, market `analyze_market`, …) as
  `(requestId)`, so a pilot's params became the request id and the call timed out. Every raw
  command now goes through the runtime: journalled, and ridden through a reconnect.
- An unawaited promise or a throw in the pilot's program fails its run with the error as `why`,
  instead of taking the bridge down. A run the bridge died under is closed `interrupted` with the
  dead bridge's last error, and the juncture's recent runs show it.
- Tired resupply names the bases in `places.json`, nearest by route first, where it once looked
  only for docks in the journal and found none. When resupply still finds no base, the work goes
  on and is journalled, as it already did when resupply was unaffordable: Tired no longer gates
  work.
- The juncture's `walk_away` is the stance's line, not Tired's.
- A mission to sell a wreck at a salvage yard is no longer offered as fitting `tradeRun`; the
  combat README names the way to sell one.
- `hunt` hints name this system's real POI ids instead of `<poi id>` placeholders.

## [2026.9.0] - 2026-09-28

### Added

- Telemetry for later analysis, all in `gameplay.jsonl`: `gate_id`, `juncture_id` and `run_id`
  join a fire to the run it launched and every event inside it; `run/started` and `run/ended`
  carry the ship's start and end state, every helper call with its full cost and gain, and the
  code, context and skills versions; trades record the unit price and the quote in hand;
  `mission`, `stranded` and `death` events; the `pilot` event records the previous value. See
  the Telemetry section of AGENTS.md.
- The runtime logs rotate when the bridge boots: `gameplay.jsonl` becomes
  `gameplay.<boot time>.jsonl` and `bridge.stderr.log` likewise. Nothing is pruned, and readers
  of recent history walk back into the rotated files.
- Fuel cells aboard are burned automatically in space when fuel drops under the reserve, before
  the ship is ever Tired, and first when resupply cannot reach or afford a base.
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
  resupply when Tired, a refuel stop on a `goTo`, a gather trip; not a freighter, whose hold is its circuit's), it tops
  `fuel_cell`s up to about 5% of the hold once they fall under 1%, bounded by
  `permissions.credit_reserve` like the fuel. A live ask over 1.5× the median ask in the market
  memory is skipped and the reason reported. Selling, stowing and settling leave that reserve
  aboard.

### Changed

- The juncture cycle is simpler. There is no shift or rest state: the mood is derived from the
  ship on every read and never stored (a `mood` left in `pilot.json` is ignored); the stance is
  optional and only chooses the one career skill a fire carries, and a missing stance refuses
  nothing; `spacemolt_reflect` sets goal, stance or objective at any time. The juncture runs
  every 5 minutes, and its gate holds a fire back only while a run is in flight and not paused
  on a question. The in-fire wakes that cron discarded are gone (`wake_juncture.py` with them).
  A run is asked to stop at 24 minutes and cut off at 26 inside the bridge; a bridge that boots
  on an unfinished run closes it as interrupted and re-runs nothing. Only the bridge writes
  `pilot.json`. Existing juncture jobs are rewritten on the next gateway load.
- Tired always ends in resupply, without the program asking: the next work call, and the end of
  every run, service here or fly to the nearest base that services. `service()` buys what the
  wallet covers, fuel first, rather than refusing the whole bill. Credits under the reserve no
  longer make the ship Tired, and a Tired ship that cannot afford resupply keeps working to pay
  for it.
- Helpers that need a station counter (market, missions, spreads, storage, service) dock
  themselves when a base is at the ship's POI, and otherwise say where the ship is and which
  bases the system has. `goTo` says when it ends undocked and why. Lines a program writes with
  `note()` are marked `✎` in the stream.
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

### Fixed

- `withdraw()` counts each item's cargo size, so a withdrawal the hold cannot take whole moves
  what fits, shares the room across rows in proportion to their footprint, and reports the rest
  short, where before the game refused it outright.
- A run always ends and writes its record, whatever shape its program returns; a report that
  cannot be rendered says why instead of leaving the run open.
- Faction intel calls (filing trade intel, the ledger and intel-map reads) are made only when the
  player is in a faction, instead of failing on every book.
- A context compression mid-fire keeps the fire's juncture instead of starting a new one; the
  re-render is journalled as `juncture_rerender`.
- The menu reads a ship class from the catalogue once per process, not on every render.
- A run is named for its first work call rather than a read such as `quote`; missions that expire
  and accepts of an already-active mission are journalled.
- Awaited sleeps and the run's time cap keep Node's event loop alive, so a program waiting on one
  is never cut short; tests pass in any timezone and ruff accepts the package root.
