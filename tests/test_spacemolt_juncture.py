"""A juncture: a cron fire opens a fresh conversation, reads the present, and plays.

What a fire depends on: the gate that suppresses a fire only while a run is in flight, the job
definition that carries the stance's skill through the cron toolset clamp, the context built
from live facts, the turn contract the prompt states, and the reflect tool that sets goal and
stance through the bridge. And what a reviewer depends on: every fire's decision and context in
the journal.
"""
from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import spacemolt
from spacemolt import juncture, service
from test_spacemolt_skills import _cron, _private


def _seed(record: dict) -> None:
    """A pilot record on disk, as the bridge would have written it."""
    path = service.pilot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))


def _journal_rows(event: str) -> list[dict]:
    path = service.runtime_dir() / juncture.JOURNAL_FILE
    rows = [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []
    return [row for row in rows if row.get("event") == event]


def test_the_journal_tail_walks_back_into_rotated_journals():
    """A bridge boot renames ``gameplay.jsonl`` to ``gameplay.<stamp>.jsonl`` and starts afresh,
    so a tail read that stopped at the current file would forget every run before the restart."""
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)

    def rows(name: str, numbers: range) -> None:
        (runtime / name).write_text("".join(json.dumps({"event": "x", "n": n}) + "\n" for n in numbers))

    rows("gameplay.2026-09-27T00-00-00Z.jsonl", range(5))
    rows("gameplay.2026-09-28T00-00-00Z.jsonl", range(5, 10))
    rows(juncture.JOURNAL_FILE, range(10, 12))
    line = len(json.dumps({"event": "x", "n": 10}) + "\n")
    assert [json.loads(row)["n"] for row in juncture.journal_tail(8 * line)] == list(range(4, 12))
    assert [json.loads(row)["n"] for row in juncture.journal_tail(2 * line)] == [10, 11]
    assert len(juncture.journal_tail()) == 12
    # The gate's streak reads through it: runs before the restart still count.
    (runtime / "gameplay.2026-09-28T00-00-00Z.jsonl").write_text(
        "".join(json.dumps({"event": "run", "phase": "refused"}) + "\n" for _ in range(2)))
    (runtime / juncture.JOURNAL_FILE).write_text(json.dumps({"event": "boot", "rotated_from": "x"}) + "\n")
    assert juncture.unproductive_streak() == 2


def _write_journal(rows: list[dict]) -> None:
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    with (runtime / juncture.JOURNAL_FILE).open("a") as journal:
        for row in rows:
            journal.write(json.dumps({"at": "2026-09-26T00:00:00.000Z", **row}) + "\n")


def test_the_gate_suppresses_a_fire_only_while_a_run_is_in_flight_and_logs_why(capsys):
    """The gate reads run.json: un-ended is a run in flight, and that is all it suppresses. No
    lock pid, no backoff — a bridge that died mid-run has its record closed at the next boot."""
    _parse_wake_gate = _cron("_parse_wake_gate")
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)

    def gate_line() -> str:
        """The last stdout line, which is the only one cron reads. An empty stdout ends the fire
        as surely as wakeAgent=false (live 2026-09-17), so it is checked for first."""
        assert juncture.gate_main() == 0
        printed = capsys.readouterr().out
        assert printed.strip(), "an empty stdout ends the fire"
        return printed.splitlines()[-1]

    _build_job_prompt = _cron("_build_job_prompt")
    idle = gate_line()
    assert _parse_wake_gate(idle) is True
    assert idle in _build_job_prompt({"prompt": juncture.JUNCTURE_PROMPT, "script": "gate"},
                                     prerun_script=(True, idle))
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": True}))
    assert gate_line() == idle

    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False}))
    line = gate_line()
    assert line == '{"wakeAgent": false}' and _parse_wake_gate(line) is False

    # Live 2026-10-05 (kvothe 06:36Z): a forced restart killed the bridge under a run, and only a fire
    # boots the next one to close it. A record older than any live run could be wakes the fire.
    now = datetime.now(timezone.utc)
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False,
                                                  "started": (now - timedelta(minutes=5)).isoformat()}))
    assert gate_line() == '{"wakeAgent": false}'
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False,
                                                  "started": (now - timedelta(minutes=31)).isoformat()}))
    assert gate_line() == idle

    # Runs that did nothing are a fact for the log, never a reason to skip the fire.
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": True}))
    _write_journal([{"event": "run", "phase": "refused", "errors": ["tsc: x"]},
                    {"event": "run", "phase": "ended", "outcome": "failed", "commands": 0},
                    {"event": "run", "phase": "ended", "outcome": "refused", "commands": 2}])
    assert gate_line() == idle
    decisions = _journal_rows("gate")
    assert [row["wake"] for row in decisions] == [True, True, False, False, True, True]
    assert decisions[2]["reason"].startswith("a run is in flight")
    assert decisions[-1]["unproductive_streak"] == 3


def test_the_juncture_job_carries_the_stance_and_passes_the_cron_toolset_clamp():
    from cron import jobs as cron_jobs

    # A stored mood and a dropped `home` are keys an older record still carries; nothing reads them.
    _seed({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
           "objective": "fill the hold", "home": "sol_base"})
    job = juncture.ensure_juncture_job()

    stored = cron_jobs.get_job(job["job_id"])
    # The wake gate, installed where cron runs it from, named relative.
    assert stored["script"] == juncture.GATE_SCRIPT
    resolved = _cron("_resolve_script_path")(stored["script"])
    assert (resolved[0] if isinstance(resolved, tuple) else resolved) is not None, "cron must accept the path"
    assert stored["skills"] == ["spacemolt:play", "spacemolt:mining"]
    assert stored["enabled_toolsets"] == ["spacemolt", "spacemolt_observe"]

    # One cron job per pilot: a stance change rewrites it, never adds a second.
    _seed({"name": "kvothe", "stance": "Hunter"})
    again = juncture.ensure_juncture_job()
    assert again["job_id"] == job["job_id"]
    assert cron_jobs.get_job(again["job_id"])["skills"] == ["spacemolt:play", "spacemolt:combat"]
    assert len(cron_jobs.load_jobs()) == 1

    # The cron clamp and the fresh conversation, through names this Hermes may have moved.
    (_CronAgentSetup, _construct_cron_agent, _resolve_cron_disabled_toolsets,
     _resolve_cron_enabled_toolsets) = _private(
        "cron.scheduler", "_CronAgentSetup", "_construct_cron_agent",
        "_resolve_cron_disabled_toolsets", "_resolve_cron_enabled_toolsets")
    enabled = _resolve_cron_enabled_toolsets(stored, {})
    assert {"spacemolt", "spacemolt_observe"} <= set(enabled)
    assert not {"spacemolt", "spacemolt_observe"} & set(_resolve_cron_disabled_toolsets({}))

    seen: dict = {}

    class RecordingAgent:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    _construct_cron_agent(RecordingAgent, stored, {}, _CronAgentSetup(model="m", runtime={}),
                          workdir=None, session_id="fire-1", session_db=None)
    assert "spacemolt" in seen["enabled_toolsets"]
    assert seen["skip_context_files"] is True


def test_a_rewrite_moves_a_live_job_onto_the_short_interval():
    """Cron re-anchors an interval job on completion, so the interval is the pause between
    junctures. A job created under the old 30 minutes must move when it is next rewritten."""
    from cron import jobs as cron_jobs
    _seed({"name": "kvothe"})
    job = juncture.ensure_juncture_job(schedule="30m")
    assert "30" in json.dumps(cron_jobs.get_job(job["job_id"])["schedule"])
    juncture.ensure_juncture_job()
    assert cron_jobs.get_job(job["job_id"])["schedule"]["minutes"] == 5


# What the bridge's `menu` answers, in its own shape: the record's fields, the derived mood, the
# present and the rendered moves. What these pin is what the context does with it.
def _menu(cargo_free: int, *, hold: list | None = None) -> dict:
    return {"now": "2026-09-23T14:05:00.000Z", "stance": "Hunter", "mood": "Focused",
            "objective": "raise gunnery by 2 hunting fauna", "goal": "hunt the grazers",
            "permissions": {"credit_reserve": 5000, "max_liability": 100000},
            "present": {"system": "first_step", "docked_at": "first_step_station",
                        "fuel": 66, "max_fuel": 120, "hull": 105, "max_hull": 105,
                        "credits": 236373, "cargo_free": cargo_free,
                        "hold": hold if hold is not None else [{"item_id": "ore", "quantity": 12}],
                        "weapons": [{"id": "autocannon_i", "loaded": 500}],
                        "skills": {"weapons": 3, "gunnery": 1, "tactics": 2}},
            "moves": [{"id": "m1", "gen": "missions", "call": "completeMissions()",
                       "facts": {"credits": 2000, "minutes": 0.5, "missions": ["Cull"]},
                       "said": "missions: 1 at 100% (Cull), +2,000 cr"}],
            "text": "m1 `completeMissions()` — missions: 1 at 100% (Cull), +2,000 cr",
            "last": None}


#: Four moves at the bridge's cap, as long as it lets them be.
FULL_MOVES = "\n".join(f"m{n} `tradeRun({{stops:[{{at:'base_{n}'}}]}})` — " + "f" * 115 for n in range(1, 5))


FACT_LINES = ("Between flights", "Objective:", "Goal:", "Stance:", "Permissions:",
              "Present:", "  Fuel ", "  Fitted weapons:", "Your recent flights")


def _rendered(monkeypatch, menu: dict) -> str:
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    return juncture.juncture_context({"platform": "cron"})


def test_the_situation_is_labelled_lines_of_live_facts(monkeypatch):
    context = _rendered(monkeypatch, _menu(12))
    for label in FACT_LINES + ("Moves open now",):
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)
    assert "No flight under way." in context.splitlines()[0]
    assert "Stance: Hunter. Mood: Focused." in context
    assert "Your recent flights: none yet." in context
    assert "hold full" not in context, "room in the hold leaves the full-hold note off"
    assert "hold full: a gather needs free hold" in _rendered(monkeypatch, _menu(0))


def test_a_fresh_pilot_with_no_stance_gets_the_same_context(monkeypatch):
    """No stance, no goal, no record at all: the facts, and a first goal to start from."""
    menu = _menu(12)
    for key in ("stance", "goal", "objective"):
        menu.pop(key)
    menu["mood"] = "Tired"
    menu["tired_by"] = "fuel 26 under the Cautious reserve 30"
    context = _rendered(monkeypatch, menu)
    assert "Stance: none. Mood: Tired (fuel 26 under the Cautious reserve 30)." in context
    assert f"Goal: none set yet; a first one: {juncture.FIRST_GOAL}" in context
    assert not service.pilot_path().exists(), "rendering the juncture wrote a pilot record"


def test_a_veteran_with_no_goal_is_not_told_to_learn_the_ship(monkeypatch):
    """Live 2026-10-02 (kvothe 16:55Z): an objective reset cleared the goal, and a 270k-credit
    pilot with days of play was handed the first goal. A pilot whose journal has an earning run
    is not new: the context says only that no goal is set."""
    menu = _menu(12)
    menu.pop("goal")
    _write_journal([{"event": "run", "phase": "ended", "at": "2026-10-02T15:00:00Z", "outcome": "done",
                     "commands": 9, "work": {"fn": "tradeRun", "credits": 6045}}])
    context = _rendered(monkeypatch, menu)
    assert "Goal: none set." in context.splitlines()
    assert juncture.FIRST_GOAL not in context


def test_the_recent_runs_are_facts_and_include_a_run_refused_at_the_check(monkeypatch):
    """A refusal at tsc never reached run.json, so a juncture used to open as if it had not
    happened. And a run's report is not replayed: the context says how it ended, never what an
    earlier report told the pilot to do."""
    _write_journal([
        {"event": "run", "phase": "ended", "outcome": "done", "reason": "sold 276 osmium_ore",
         "commands": 14, "work": {"credits": 3000, "items": 0, "xp": 5},
         "calls": [{"fn": "sellAt"}]},
        {"event": "reflection", "stance": "Trader", "goal": "walk a price circuit"},
        {"event": "run", "phase": "refused", "errors": ["tsc: pilot/index.ts(2,5): error TS2339: 'fule'\n    2 | x"]},
        {"event": "run", "phase": "ended", "outcome": "interrupted",
         "reason": "the bridge ended while this run was in flight; nothing was re-run",
         "why": "SpacemoltError: No response to spacemolt/get_active_missions within 15000ms"},
        # Journalled before runs carried `calls`: its work call still leads.
        {"event": "run", "phase": "ended", "outcome": "done", "reason": "mined",
         "work": {"fn": "gatherUntil", "credits": 2626}},
    ])
    context = _rendered(monkeypatch, _menu(12))
    recent = context.split("Your recent flights (newest last):\n")[1].split("\nSuggested")[0].splitlines()
    assert len(recent) == 5, recent
    # The work done leads, ahead of the return value (live 2026-09-29 buried the gains at the tail).
    assert recent[0].endswith("sellAt: +3,000 cr, 5 xp; returned done: sold 276 osmium_ore (14 commands)"), recent[0]
    assert "reflect: stance Trader, goal 'walk a price circuit'" in recent[1]
    assert "program refused at the check, nothing flew: tsc: pilot/index.ts(2,5): error TS2339: 'fule'" in recent[2]
    # An interrupted run is what the world shows: the flight ended. The plumbing's reason stays in the journal.
    assert recent[3].endswith(" flight: nothing gained; the flight ended early"), recent[3]
    assert "gatherUntil: +2,626 cr; returned done: mined" in recent[4], recent[4]


def test_a_full_hold_out_in_the_open_is_offered_the_move_that_works(monkeypatch):
    """`sell` and `stow` are station counters, and a belt is not a station."""
    undocked = _menu(0)
    undocked["present"]["docked_at"] = None
    out = _rendered(monkeypatch, undocked)
    assert "goTo a base" in out
    assert "sell(rows) or stow(rows) here first" not in out
    assert "sell(rows) or stow(rows) here first" in _rendered(monkeypatch, _menu(0))


def test_the_in_battle_line_comes_first_and_names_a_call_that_can_be_made(monkeypatch):
    """Live 2026-09-25: a pilot woke at hull 3/80 inside a battle and died a second later.
    `hunt` cannot fight the battle already holding the ship."""
    menu = _menu(12)
    menu["battle"] = {"opponent": "Slag-Tortoise", "tick": 7}
    menu["present"]["hull"] = 3
    menu["present"]["max_hull"] = 80
    first = _rendered(monkeypatch, menu).splitlines()[0]
    assert first.startswith("IN BATTLE NOW with Slag-Tortoise (battle tick 7, hull 3/80)."), first
    assert "disengage()" in first and "hunt" not in first
    assert "IN BATTLE" not in _rendered(monkeypatch, _menu(12))


def test_threats_at_the_poi_are_a_fact_line(monkeypatch):
    menu = _menu(12)
    menu["threats"] = ["Raider", "Empire Patrol"]
    assert "  Fighting here: Raider, Empire Patrol." in _rendered(monkeypatch, menu)
    assert "Fighting here" not in _rendered(monkeypatch, _menu(12))


def test_the_situation_renders_only_the_permissions_the_code_knows(monkeypatch):
    """A key the code dropped is still in the record, and rendering it raw read as "wildlife
    False" (playtest 2026-09-22)."""
    menu = _menu(12)
    menu["permissions"] = {"credit_reserve": 5000, "wildlife": False,
                           "no_go": ["deep_range"], "max_spend": 1000}
    context = _rendered(monkeypatch, menu)
    assert "Permissions: keep 5,000 credits." in context
    assert "Present: docked at first_step_station (first_step)." in context
    for gone in ("wildlife", "deep_range", "no_go", "max_spend"):
        assert gone not in context, gone


def test_opaque_place_ids_are_named_from_the_menu(monkeypatch):
    """Live 2026-10-02 (kvothe): the Present line and so the pilot's own replies read
    "b495c6003fc83e18f6d8cecbe6929133". The menu carries the names the bridge learned; a bare id
    reads ``Name (id)``, a quoted one is code and stays as it is."""
    base, poi = "b495c6003fc83e18f6d8cecbe6929133", "98eba8b1a7ad0520d6a7c8ea44b2d6aa"
    menu = _menu(12)
    menu["present"].update({"system": "dheneb", "docked_at": base})
    menu["held"] = {"max": 5, "missions": [{"title": "Courier", "next": f"Deliver the pouch → {poi}"}]}
    menu["text"] = f"Menu:\n  - `goTo('{base}')` — sell at {base}"
    menu["names"] = {base: "Kestrel Yard", poi: "Hex Star"}
    context = _rendered(monkeypatch, menu)
    assert f"Present: docked at Kestrel Yard ({base}) (dheneb)." in context, context
    assert f"Courier — next: Deliver the pouch → Hex Star ({poi})" in context, context
    assert f"`goTo('{base}')` — sell at Kestrel Yard ({base})" in context, context
    del menu["names"]
    assert f"Present: docked at {base} (dheneb)." in _rendered(monkeypatch, menu)


def test_the_walk_away_line_reads_as_what_it_is(monkeypatch):
    context = _rendered(monkeypatch, _menu(12))
    assert "Walk-away" not in context
    menu = _menu(12)
    menu["present"]["walk_away"] = 94
    assert "  Walk-away: break off a fight below hull 94." in _rendered(monkeypatch, menu)
    # Audit 10-04: with no weapon fitted the line is only room the moves needed.
    menu["present"]["weapons"] = []
    assert "Walk-away" not in _rendered(monkeypatch, menu)


def test_an_instruction_stands_until_a_run_starts_after_it_and_rendering_writes_nothing(monkeypatch):
    """Delivered once meant moved aside as it rendered, so a fire that failed before running lost
    it (and rendering wrote the record). Now it stands until a run starts after it was given."""
    _seed({"name": "kvothe", "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T03:21:00Z"}})
    before = service.pilot_path().read_bytes()
    first = _rendered(monkeypatch, _menu(12))
    assert "Instruction (given 09-23 03:21Z): stay in Sol tonight" in first
    assert "stay in Sol tonight" in _rendered(monkeypatch, _menu(12)), "no run yet, so it stands"
    assert service.pilot_path().read_bytes() == before
    (service.runtime_dir() / "run.json").write_text(
        json.dumps({"script": "index.ts", "started": "2026-09-23T04:00:00Z", "ended": True}))
    assert "stay in Sol tonight" not in _rendered(monkeypatch, _menu(12))


def test_a_run_from_a_context_rendered_before_the_instruction_never_consumes_it(monkeypatch):
    """Live 2026-09-29: context rendered 13:01:42.83Z, the instruction written 13:01:43.74Z, a
    run from that same juncture started 13:01:51Z — the model never saw it, but the old check
    (run started after the instruction) called it consumed. ``juncture_at`` is the run's
    context render time, and that is what must be after the instruction to consume it."""
    _seed({"name": "kvothe", "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T13:01:43.74Z"}})
    service.runtime_dir().mkdir(parents=True, exist_ok=True)
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "juncture_at": "2026-09-23T13:01:42.83Z",
         "started": "2026-09-23T13:01:51Z", "ended": True}))
    assert "stay in Sol tonight" in _rendered(monkeypatch, _menu(12)), \
        "the run's juncture render time is before the instruction, so it was never seen"
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "juncture_at": "2026-09-23T13:01:44.00Z",
         "started": "2026-09-23T13:01:51Z", "ended": True}))
    assert "stay in Sol tonight" not in _rendered(monkeypatch, _menu(12))
    # A run written before this field existed falls back to `started`.
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "started": "2026-09-23T13:01:44.00Z", "ended": True}))
    assert "stay in Sol tonight" not in _rendered(monkeypatch, _menu(12))


ALERTS = [{"type": "facility_rent_warning", "key": "base:hera_outpost",
           "at": "2026-09-23T13:55:00Z", "first_at": "2026-09-23T11:40:00Z", "n": 3,
           "body": {"base_id": "hera_outpost", "base_name": "Hera Outpost", "credits_owed": 4200,
                    "missed_cycles": 2, "grace_cycles": 4, "message": "Rent is overdue."},
           "delivered_at": None},
          {"type": "base_destroyed", "key": "base:far_reach", "at": "2026-09-23T14:01:00Z",
           "first_at": "2026-09-23T14:01:00Z", "n": 1,
           "body": {"base_id": "far_reach", "base_name": "Far Reach", "attacker_name": "Vex"},
           "delivered_at": None}]


def test_the_alerts_the_bridge_buffered_reach_the_pilot_as_fact_lines(monkeypatch):
    menu = _menu(12)
    menu["alerts"] = ALERTS
    context = _rendered(monkeypatch, menu)
    assert "Alerts since you last took stock (2, shown once):" in context
    assert ("  rent overdue at Hera Outpost: 4,200 owed; 2 of 4 missed cycles, "
            "seen 3x since 09-23 11:40Z." in context), context
    assert "  base destroyed at Far Reach: attacker Vex." in context
    assert "Alerts since" not in _rendered(monkeypatch, _menu(12))


def test_an_oversized_situation_fits_the_section_with_every_fact_line(monkeypatch):
    """Over the limit core drops the section whole, so the hold list and the older recent lines give
    way; the moves do not."""
    _write_journal([{"event": "run", "phase": "ended", "outcome": "done", "reason": "x" * 400,
                     "why": "y" * 400, "commands": 1}] * 5)
    hold = [{"item_id": f"salvaged_component_{i}", "quantity": i} for i in range(400)]
    menu = _menu(12, hold=hold)
    menu["text"] = FULL_MOVES
    context = _rendered(monkeypatch, menu)
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    assert "  m4 `tradeRun" in context, context
    for label in FACT_LINES:
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)


# Live 2026-10-04 (kvothe 22:02Z, run 8389807d): a five-stop circuit flown out of order into the run
# cap, with ~3.8k chars of reference in the context and no list of the missions held.
HELD = {"max": 5, "missions": [
    {"title": "Five Capitals Diplomatic Circuit",
     "next": "Verify diplomatic pouch at Sol Central → confederacy_central_command, 3 jumps [2 of 5]",
     "expires_at": "2026-10-05T03:00:00.000Z"},
    {"title": "Titanium Extraction Contract", "next": "Mine titanium ore (0/20) → central_nexus, this system"}]}


def test_the_missions_held_are_listed_by_their_next_step(monkeypatch):
    menu = _menu(12)
    menu["held"] = HELD
    context = _rendered(monkeypatch, menu)
    block = context.split("Missions held (2 of 5):\n")[1].split("\nYour recent")[0].splitlines()
    assert block == [
        ("  Five Capitals Diplomatic Circuit — next: Verify diplomatic pouch at Sol Central → "
         "confederacy_central_command, 3 jumps [2 of 5]; expires 10-05 03:00Z"),
        "  Titanium Extraction Contract — next: Mine titanium ore (0/20) → central_nexus, this system"], block
    assert "Missions held" not in _rendered(monkeypatch, _menu(12))


def test_the_reference_sections_are_gone(monkeypatch):
    """Cut 10-04 for the missions block: the skills dump, the Places and one-jump-out lines, the
    earning loops and the since-the-objective deltas. What the bridge still sends is not rendered."""
    menu = _menu(12)
    menu["present"]["skills"] = {"piloting": {"level": 9, "xp": 1744, "next_level_xp": 2000}}
    menu["neighbours"] = [{"system_id": "deep_range", "jumps": 1, "visited": True}]
    menu["places"] = {"visited": 47, "systems": 120, "stationless": ["sys_1"], "refused": []}
    menu["objective_start"] = {"at": "2026-09-23T12:25:00Z", "credits": 210958}
    _write_journal([{"event": "run", "phase": "ended", "at": "2026-10-02T15:00:00Z", "outcome": "done",
                     "commands": 9, "work": {"fn": "tradeRun", "credits": 6045}}])
    context = _rendered(monkeypatch, menu)
    for gone in ("Skills:", "piloting", "Places:", "One jump out", "deep_range", "earning loops",
                 "Since the objective", "210,958"):
        assert gone not in context, (gone, context)


def test_the_missions_held_never_give_way(monkeypatch):
    """Over the limit the hold list, the chat and the older recent runs give way; the moves and the
    missions held do not. Past that, the cut ends on a line."""
    _write_journal([{"at": f"2026-10-01T1{n}:00:00Z", "event": "run", "phase": "ended", "outcome": "done",
                     "reason": "r" * 150, "commands": 1, "work": {"fn": "gatherUntil", "credits": 100}}
                    for n in range(5)])
    menu = _menu(12, hold=[{"item_id": f"salvaged_component_{i}", "quantity": i} for i in range(400)])
    menu["text"] = FULL_MOVES
    menu["steps"] = ["x" * 400] * 3
    menu["held"] = HELD
    context = _rendered(monkeypatch, menu)
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    assert "Missions held (2 of 5):" in context and "Titanium Extraction Contract — next:" in context, context
    assert len(context.split("Your recent flights (newest last):\n")[1].splitlines()) >= 3, context
    assert "  m4 `tradeRun" in context and "+400 more" in context
    # Fact lines alone over the limit: whole lines are kept, none is cut short.
    menu["objective"] = "o" * 2500
    menu["steps"] = ["s" * 1500]
    lines = _rendered(monkeypatch, menu).splitlines()
    assert sum(map(len, lines)) + len(lines) - 1 <= juncture.SECTION_LIMIT
    assert lines[-1] == "Goal: hunt the grazers", lines[-1]


def test_a_reflection_repeating_the_goal_is_not_said_twice(monkeypatch):
    """Audit 10-04 (kvothe): the recent runs closed on the reflect that set the Goal, word for word."""
    goal = "hunt the grazers"
    _write_journal([{"event": "reflection", "goal": goal},
                    {"event": "reflection", "goal": goal, "objective_done": True, "objective": "raise gunnery"},
                    {"event": "reflection", "goal": "an older goal"}])
    recent = _rendered(monkeypatch, _menu(12)).split("Your recent flights (newest last):\n")[1].split("\nSuggested")[0]
    assert recent.splitlines() == ["  09-26 00:00Z reflect: objective 'raise gunnery' retired",
                                   "  09-26 00:00Z reflect: goal 'an older goal'"], recent


# Shaped like kvothe's 10-04 17:27Z render, which ran ~3.9k chars without its moves: a Prospector,
# unarmed, maydays, five runs; now with the five missions it held.
KVOTHE_GOAL = ("Objective met; resources kept unsold in the frontier_station store. Resume earning "
               "credits or take a new objective.")
KVOTHE_MOVES = """m1 `tradeRun({stops:[{at:'frontier_station',buy:'copper_ore'},{at:'nova_terra_central'}]})` — \
route: +6,240 cr net, 3 jumps, ~6.1 min; books nova_terra_central 41t
m2 `sell([{item_id:'iron_ore',quantity:900}], {from:'store'})` — settle: 2554 iron_ore (store frontier_station) \
→ frontier_station bid 7×900, live; 0 jumps, +6,300 cr after fuel
m3 `abandonMission('7f1a3732ebe845ade0ac5435249700b5')` — drop Salvage a wreck (expired); a slot takes \
Hull Patch Run here, +4,500 cr, from Mira Tal (Dockmaster)
m4 `completeMissions()` — missions: 1 at 100% (Ore Run), +2,000 cr"""


def _kvothe_menu() -> dict:
    return {"now": "2026-10-04T17:27:00.000Z", "stance": "Prospector", "mood": "Focused", "goal": KVOTHE_GOAL,
            "steps": ["recipes() at frontier_station; note inputs and xp",
                      "craft the best refining recipe from stored ore", "check refining level; objective_done at 8"],
            "permissions": {"credit_reserve": 50000},
            "present": {"system": "distant_light", "docked_at": "frontier_station", "fuel": 140, "max_fuel": 140,
                        "hull": 75, "max_hull": 75, "credits": 361649, "cargo_free": 172, "walk_away": 67,
                        "hold": [{"item_id": "fuel_cell", "quantity": 8}], "weapons": []},
            "held": {"max": 5, "missions": [{"title": f"Contract {n}", "next": f"Deliver 20 ore (0/20) → base_{n}, "
                                             f"{n} jumps [1 of 2]", "expires_at": "2026-10-05T03:00:00Z"}
                                            for n in range(5)]},
            "moves": [], "text": KVOTHE_MOVES, "last": None}


def test_a_kvothe_sized_context_keeps_its_suggested_moves(monkeypatch):
    """Audit 10-04 (kvothe): the context ran over SECTION_LIMIT and the moves, first to give way,
    were absent from all 106 contexts rendered since 10-03. Now they sit under the ship, whole, and
    the maydays are capped beneath them."""
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / juncture.JUNCTURE_FILE).write_text(json.dumps({"juncture_id": "j0", "at": "2026-10-04T17:00:00Z"}))
    with (runtime / juncture.CHAT_FILE).open("a") as record:
        for n in range(4):
            record.write(json.dumps({"at": f"2026-10-04T17:1{n}:00Z", "event": "post", "channel": "emergency",
                                     "sender": f"Wexler {n}", "content": f"MAYDAY: Wexler {n}-QX is stranded at "
                                     "Ramen's Rest in Last Light with 3/120 fuel! Any pilots nearby, please help!"})
                         + "\n")
    recent = [{"at": "2026-10-04T17:13:00Z", "event": "run", "phase": "ended", "outcome": "done", "commands": 125,
               "reason": "6 calls gained +960 items: bought 160 copper_ore for 1286 cr (6 of it tax); last call craft done",
               "work": {"fn": "buy", "items": 960, "xp": 1172}, "calls": [{"fn": "buy"}, {"fn": "craft"}]}] * 4 + [
              {"at": "2026-10-04T17:21:00Z", "event": "reflection", "goal": KVOTHE_GOAL, "objective_done": True,
               "objective": "Get crafting, refining and mining to level 8 or higher."}]
    _write_journal(recent)
    context = _rendered(monkeypatch, _kvothe_menu())
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    assert len(KVOTHE_MOVES) <= 640, "the bridge caps the block at MOVES_CHARS"
    assert juncture._MOVES_HEAD + "\n  m1 `tradeRun(" in context, context
    assert KVOTHE_MOVES.replace("\n", "\n  ") in context, context
    assert context.index("Moves open now") < context.index("Missions held") < context.index("Chat since"), context
    assert len([line for line in context.splitlines() if "MAYDAY" in line]) == 2, context
    for label in ("Goal:", "Steps:", "Stance:", "Present:", "  Fuel ", "  Fitted weapons:",
                  "Missions held (5 of 5):", "Your recent flights"):
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)


def test_a_run_in_flight_is_said_in_one_line(monkeypatch):
    context = _rendered(monkeypatch, {"busy": True, "running": True, "started": "2026-09-23T14:00:00Z",
                                      "fn": "gatherUntil", "commands": 40})
    assert context.startswith("A flight is under way — started 09-23 14:00Z, in gatherUntil")


def test_each_juncture_journals_the_skills_it_carried_and_the_context_it_rendered(monkeypatch):
    """For whoever reviews a fire later: which career text the pilot had, how big, and what it
    was told — without asking the pilot."""
    _seed({"name": "kvothe", "stance": "Trader"})
    context = _rendered(monkeypatch, _menu(12))
    row, = _journal_rows("juncture")
    assert row["stance"] == "Trader"
    assert [skill["name"] for skill in row["skills"]] == ["spacemolt:play", "spacemolt:trading"]
    assert all(skill["bytes"] > 1000 for skill in row["skills"]), row["skills"]
    assert row["context"] == context and row["context_chars"] == len(context)
    # The moves rendered, as data: joinable to the next run's calls by `call`; the words stay in the context.
    assert row["moves"] == [{"id": "m1", "gen": "missions", "call": "completeMissions()",
                             "facts": {"credits": 2000, "minutes": 0.5, "missions": ["Cull"]}}], row["moves"]
    assert "m1 `completeMissions()`" in context
    # A chat window is never handed the context, and journals nothing.
    assert juncture.juncture_context({"platform": "discord"}) == ""
    assert len(_journal_rows("juncture")) == 1


def test_the_cron_prompt_names_only_the_tools_that_are_the_turn():
    named = sorted(definition["name"] for definition in spacemolt.TOOL_DEFINITIONS
                   if definition["name"] in juncture.JUNCTURE_PROMPT)
    assert named == ["spacemolt_check", "spacemolt_reflect", "spacemolt_run"], named
    assert juncture.job_fields({"stance": "Hunter"})["prompt"] == juncture.JUNCTURE_PROMPT
    # No shift to put down and nothing that must be done before a run.
    for gone in (r"\brest\b", r"\bshift\b", "half an hour"):
        assert not re.search(gone, juncture.JUNCTURE_PROMPT.lower()), gone


def test_loading_the_plugin_rewrites_the_job_and_writes_no_pilot():
    """No seeding and no wake mark: a profile that has never flown is a pilot with no goal and
    no stance, and the interval brings its first juncture."""
    from cron import jobs as cron_jobs
    spacemolt.wake_on_load()
    job, = cron_jobs.load_jobs()
    assert juncture.JUNCTURE_PROMPT in job["prompt"] and job.get("manual_run_at") is None
    assert job["skills"] == ["spacemolt:play"]
    assert job["next_run_at"] is not None and job["state"] == "scheduled"
    assert not service.pilot_path().exists()
    spacemolt.wake_on_load()
    assert len(cron_jobs.load_jobs()) == 1


def test_reflect_sets_goal_and_stance_through_the_bridge_whatever_the_pilot_is_doing(monkeypatch):
    """The deadlock of 2026-09-26 in reverse: reflection used to refuse or rest depending on a
    shift state. Now it writes what it is given, through the record's one writer, and rewrites
    the job so the next fire carries the stance's skill."""
    from cron import jobs as cron_jobs
    _seed({"name": "kvothe", "objective": "fill the hold"})
    sent: list[tuple[str, dict]] = []

    def fake_call(action, params=None, on_line=None):
        sent.append((action, params or {}))
        record = json.loads(service.pilot_path().read_text())
        for key, value in (params or {}).get("set", {}).items():
            if value is None:
                record.pop(key, None)
            else:
                record[key] = value
        _seed(record)
        return {"record": record}

    monkeypatch.setattr(spacemolt, "call", fake_call)
    said = spacemolt._reflect({"goal": "walk a price circuit", "stance": "scout"})
    assert sent == [("pilot", {"set": {"goal": "walk a price circuit", "stance": "Scout"}})]
    assert "Scout" in said and "Nothing" not in said
    job, = cron_jobs.load_jobs()
    assert job["skills"] == ["spacemolt:play", "spacemolt:exploration"]
    assert _journal_rows("reflection")[-1]["stance"] == "Scout"

    # A goal alone, or the objective retired alone: nothing is required beside it.
    spacemolt._reflect({"objective_done": True})
    record = juncture.read_pilot()
    assert "objective" not in record and record["objective_completed"] == "fill the hold"
    assert record["stance"] == "Scout", "retiring the objective moved the stance"

    # Values are validated, and the text says what is valid.
    sent.clear()
    bad = spacemolt._reflect({"stance": "Cowboy"})
    assert "Cowboy" in bad and "Prospector" in bad and sent == []
    assert "Nothing to write" in spacemolt._reflect({})
    assert "Nothing written" in spacemolt._reflect({"steps": "price an upgrade"}) and sent == []

    # Live 2026-09-30 (kvothe): subtasks ("price an upgrade") were dropped every fire. The
    # checklist is its own field, stored whole, and an empty list clears it.
    spacemolt._reflect({"steps": [" price an upgrade ", "", "fly the circuit_board loop"]})
    assert sent[-1] == ("pilot", {"set": {"steps": ["price an upgrade", "fly the circuit_board loop"]}})
    assert _journal_rows("reflection")[-1]["steps"] == ["price an upgrade", "fly the circuit_board loop"]
    spacemolt._reflect({"steps": []})
    assert sent[-1] == ("pilot", {"set": {"steps": None}}) and "steps" not in juncture.read_pilot()


def test_the_steps_reach_the_context_under_the_goal(monkeypatch):
    menu = _menu(12)
    menu["steps"] = ["price an upgrade", "fly the circuit_board loop"]
    lines = _rendered(monkeypatch, menu).splitlines()
    goal = next(i for i, line in enumerate(lines) if line.startswith("Goal:"))
    assert lines[goal + 1] == "Steps: 1) price an upgrade; 2) fly the circuit_board loop", lines
    assert not any(line.startswith("Steps:") for line in _rendered(monkeypatch, _menu(12)).splitlines())


_GATEWAY_LOAD = """
import json, sys
sys.path.insert(0, sys.argv[1])
from tools.registry import registry
assert registry.get_entry("cronjob_manage") is None, "the premise: core tools load after plugins"
from hermes_cli.plugins import discover_plugins
discover_plugins()
from cron.jobs import load_jobs
print(json.dumps(load_jobs()))
"""


def test_a_fresh_profile_loaded_as_the_gateway_loads_it_gets_its_juncture_job(tmp_path):
    """Live 2026-09-26: gateway startup calls ``discover_plugins()`` before anything imports the
    core tools, so ``cronjob_manage`` was not yet registered when ``register()`` wrote the job
    through ``ctx.dispatch_tool``. The load swallowed "Unknown tool", and a fresh install never
    had a job. In-process tests cannot see it — pytest has the tools loaded by then — so this is a
    fresh interpreter on a fresh home, the plugin installed and enabled, and nothing else."""
    import subprocess
    import sys

    from conftest import HERMES, ROOT

    home = tmp_path / "fresh"
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "spacemolt").symlink_to(ROOT, target_is_directory=True)
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - spacemolt\n  disabled: []\n")
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_TEST_ISOLATION": str(home)}
    done = subprocess.run([sys.executable, "-c", _GATEWAY_LOAD, str(HERMES)], env=env, cwd=tmp_path,
                          capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0, done.stderr[-2000:]
    jobs = json.loads(done.stdout.strip().splitlines()[-1])
    assert [job["skills"] for job in jobs] == [["spacemolt:play"]], done.stderr[-2000:]


def test_a_failed_job_write_on_load_is_written_down(monkeypatch):
    """A load that cannot write the job leaves a pilot that never flies and looks idle, so the
    failure goes to the journal and the log rather than nowhere."""
    def refuse(**args):
        raise RuntimeError("cronjob_manage list: Unknown tool: cronjob_manage")

    monkeypatch.setattr(spacemolt, "ensure_juncture_job", refuse)
    spacemolt.wake_on_load()
    events = [json.loads(line) for line in
              (service.runtime_dir() / juncture.JOURNAL_FILE).read_text().splitlines()]
    assert events[-1]["event"] == "wake_failed" and "Unknown tool" in events[-1]["error"]


def test_the_juncture_journals_its_join_keys_and_its_id_reaches_the_run_request(monkeypatch):
    """Telemetry: the juncture line carries the ids a later analysis joins on — its own, the gate
    before it, cron's job — and the run the fire starts is asked for under the same juncture id."""
    _seed({"name": "kvothe", "stance": "Trader"})
    juncture.gate_main()
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(_menu(12)))
    juncture.juncture_context({"platform": "cron", "session_id": "cron_abc123_20260927_101500",
                               "model": "claude-test"})
    gate, = _journal_rows("gate")
    row, = _journal_rows("juncture")
    assert re.fullmatch(r"[0-9a-f]{32}", row["juncture_id"])
    assert row["gate_id"] == gate["gate_id"] and row["job_id"] == "abc123" and row["model"] == "claude-test"
    assert row["at"].endswith("Z") and row["build_s"] >= 0 and row["skills_sha"] and row["context_sha"]
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(spacemolt, "call",
                        lambda action, params=None, on_line=None: sent.append((action, params)) or {"accepted": True})
    spacemolt._run({})
    assert sent == [("run", {"juncture": {"juncture_id": row["juncture_id"], "at": row["at"]}})]


def test_a_rerender_within_the_same_fire_keeps_its_juncture(monkeypatch):
    """Live 2026-09-28 13:37Z: Hermes' context compression re-rendered the juncture context four
    hours into a fire and minted a second juncture on the stale gate. Same session, same
    juncture: the fresh context is kept, and the re-render is its own event."""
    _seed({"name": "kvothe", "stance": "Trader"})
    juncture.gate_main()
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(_menu(12)))
    fire = {"platform": "cron", "session_id": "cron_abc123_20260927_101500"}
    first = juncture.juncture_context(fire)
    again = juncture.juncture_context(fire)
    assert again == first and again
    row, = _journal_rows("juncture")
    rerender, = _journal_rows("juncture_rerender")
    assert rerender["juncture_id"] == row["juncture_id"] and rerender["session_id"] == fire["session_id"]
    assert rerender["reason"] and rerender["context_sha"]
    # The juncture id is unchanged, but the recorded render time moves to this rerender: an
    # instruction the pilot only saw because of the rerender must count as seen by the next run.
    last = juncture.last_juncture()
    assert last["juncture_id"] == row["juncture_id"]
    assert last["at"] == rerender["at"] and last["at"] != row["at"]
    juncture.juncture_context({**fire, "session_id": "cron_abc123_20260927_111500"})
    assert len(_journal_rows("juncture")) == 2


def test_a_rerender_updates_the_render_time_so_a_run_from_it_consumes_a_late_instruction(monkeypatch):
    """Live 2026-09-29: an instruction written after the first render but before a mid-fire
    rerender reaches the model in the rerendered context, but ``juncture.json``'s ``at`` used to
    stay at the first render time, so a run from that rerendered context still failed the
    "rendered after the instruction" check in ``_pending_instruction`` and the instruction was
    shown again next fire even though the pilot had already seen it."""
    _seed({"name": "kvothe", "stance": "Trader",
           "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T13:01:43.00Z"}})
    juncture.gate_main()
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(_menu(12)))
    fire = {"platform": "cron", "session_id": "cron_abc123_20260927_101500"}
    first = juncture.juncture_context(fire)
    assert "stay in Sol tonight" in first, "the instruction predates the first render"
    again = juncture.juncture_context(fire)
    assert "stay in Sol tonight" in again, "and the rerender, so the model saw it twice"
    rendered_at = juncture.last_juncture()["at"]
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "juncture_at": rendered_at,
         "started": "2026-09-23T13:02:00Z", "ended": True}))
    assert "stay in Sol tonight" not in _rendered(monkeypatch, _menu(12)), \
        "a run from the rerendered context consumed the instruction"


def test_a_busy_rerender_does_not_advance_the_render_time(monkeypatch):
    """A rerender while a run is in flight renders ``_busy(menu)``, which carries no instruction
    (only the non-busy branch builds one). Advancing ``at`` to that rerender anyway would let a
    later run judge the instruction as already seen, though it was never actually shown."""
    _seed({"name": "kvothe", "stance": "Trader",
           "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T13:01:43.00Z"}})
    juncture.gate_main()
    fire = {"platform": "cron", "session_id": "cron_abc123_20260927_101500"}
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(_menu(12)))
    first = juncture.juncture_context(fire)
    assert "stay in Sol tonight" in first
    first_at = juncture.last_juncture()["at"]
    busy_menu = {"busy": True, "running": True, "started": "2026-09-27T10:20:00Z",
                 "fn": "pilot", "commands": 3}
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(busy_menu))
    again = juncture.juncture_context(fire)
    assert "stay in Sol tonight" not in again, "the busy render carries no instruction"
    rerender, = _journal_rows("juncture_rerender")
    assert rerender["at"] != first_at, "the journal still logs the rerender's own time"
    last = juncture.last_juncture()
    assert last["at"] == first_at, "but the render time on file does not advance"


def test_a_failed_game_read_still_renders_the_record_and_the_journal(monkeypatch):
    """Live 2026-10-02 (kvothe): 20 fires lost the whole juncture section to a failed menu read
    ("WebSocket connection closed", "No response to spacemolt/get_status within 15000ms"). They
    flew with no objective and no instruction, and wrote no juncture, so their runs carried the
    previous juncture's id (09-30 16:32Z). The record and the journal need no game."""
    _seed({"name": "kvothe", "stance": "Trader", "objective": "reach 1,000,000 cr",
           "goal": "work the ore route", "steps": ["buy at alpha", "sell at beta"],
           "instruction": {"text": "scan markets for cheap materials", "at": "2026-10-02T16:34:58Z"}})
    _write_journal([{"event": "run", "phase": "ended", "at": "2026-10-02T15:00:00Z",
                     "started": "2026-10-02T14:50:00Z", "outcome": "done", "commands": 9,
                     "work": {"fn": "tradeRun", "credits": 6045},
                     "calls": [{"fn": "tradeRun", "stops": ["alpha", "beta"], "seconds": 600}]}])
    juncture._write_juncture({"juncture_id": "old", "at": "2026-10-02T14:00:00Z"})

    def closed(action, params=None):
        raise RuntimeError("WebSocket connection closed")

    monkeypatch.setattr(service, "call", closed)
    context = juncture.juncture_context({"platform": "cron", "session_id": "cron_abc123_20261002_104212"})
    for text in ("The game did not answer this time", "Objective: reach 1,000,000 cr",
                 "Instruction (given 10-02 16:34Z): scan markets for cheap materials",
                 "Goal: work the ore route", "Steps: 1) buy at alpha; 2) sell at beta", "Stance: Trader.",
                 "tradeRun: +6,045 cr", "Your recent flights (newest last):"):
        assert text in context, (text, context)
    for absent in ("Present:", "Mood:", "  Fuel ", "Since the objective"):
        assert absent not in context, (absent, context)
    row, = _journal_rows("juncture")
    assert row["menu_error"] == "RuntimeError: WebSocket connection closed" and row["context"] == context
    assert juncture.last_juncture() == {"juncture_id": row["juncture_id"], "at": row["at"]}
    # The render carried the instruction, so a run from it consumes it, as any other render.
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "juncture_at": row["at"], "started": row["at"], "ended": True}))
    assert "scan markets" not in juncture.juncture_context({"platform": "cron"})


def test_a_failed_game_read_during_a_run_says_the_run_is_in_flight(monkeypatch):
    """Without the game, run.json still says whether a run is flying: the context must not say
    "Run in flight: no" over one that is."""
    service.runtime_dir().mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc) - timedelta(minutes=3)
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "started": started.strftime("%Y-%m-%dT%H:%M:%SZ"), "ended": False,
         "last_job": "tradeRun"}))

    def timed_out(action, params=None):
        raise TimeoutError("No response to spacemolt/get_status within 15000ms")

    monkeypatch.setattr(service, "call", timed_out)
    context = juncture.juncture_context({"platform": "cron"})
    assert context == f"A flight is under way — started {started.strftime('%m-%d %H:%MZ')}, in tradeRun."
    assert _journal_rows("juncture")[0]["busy"] is True


#: Our plumbing, which the pilot never hears of: it lives in the world, not in the harness (10-05).
HARNESS_WORDS = re.compile(r"\b(hermes|cron|juncture|bridge|journal|telemetry|interrupted|gate|skill)",
                           re.IGNORECASE)
#: The program flies: a flight is launched, under way, ended (10-05). `spacemolt_run`, in backticks, is a name.
RUN_WORD = re.compile(r"\bruns?\b", re.IGNORECASE)


def _descriptions(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from ([value] if key == "description" and isinstance(value, str) else _descriptions(value))
    elif isinstance(node, list | tuple):
        for value in node:
            yield from _descriptions(value)


def test_the_pilot_hears_the_world_and_never_the_harness(monkeypatch, capsys):
    """The maintainer, 10-05: the cron player experiences the world it is in, not Hermes, its
    interruptions or its callback loop. Every prompt-facing text, rendered from a full fixture."""
    _seed({"name": "kvothe", "instruction": {"text": "stay in Sol", "at": "2026-09-23T03:21:00Z"}})
    _write_journal([
        {"event": "run", "phase": "ended", "outcome": "done", "reason": "sold ore", "commands": 3,
         "work": {"credits": 900}, "calls": [{"fn": "sellAt"}]},
        {"event": "reflection", "stance": "Trader", "goal": "walk a circuit", "objective_done": True, "objective": "x"},
        {"event": "run", "phase": "refused", "errors": ["tsc: pilot/index.ts(2,5): error TS2339: 'fule'"]},
        {"event": "run", "phase": "ended", "outcome": "interrupted",
         "reason": "the bridge ended while this run was in flight; nothing was re-run",
         "why": "SpacemoltError: bridge closed", "calls": [{"fn": "tradeRun"}]},
    ])
    menu = _menu(0)
    menu.update(alerts=[{"type": "facility_rent_warning", "key": "b1", "n": 1,
                         "body": {"base_name": "Sol", "credits_owed": 50}}] * 5,
                battle={"opponent": "raider", "tick": 4}, threats=["raider"],
                held={"max": 5, "missions": [{"title": "Cull", "next": "hunt 3 grazers"}]})
    question = {"question": "sell now?", "choices": ["yes", "no"], "asked_at": "2026-09-23T14:00:00Z"}
    chat_pause = {"chat": {"channel": "private", "from": "Zed", "sender_id": "p1", "text": "hi"},
                  "asked_at": "2026-09-23T14:00:00Z", "question": "chat"}
    texts = [juncture.JUNCTURE_PROMPT, _rendered(monkeypatch, menu),
             _rendered(monkeypatch, {"busy": True, "started": "2026-09-23T14:00:00Z", "fn": "gatherUntil"}),
             _rendered(monkeypatch, {"busy": True, "started": "2026-09-23T14:00:00Z", "question": question}),
             juncture.question_text(question), juncture.question_text(chat_pause),
             spacemolt._prompt({"platform": "cron"}), spacemolt._prompt({"platform": "discord"})]
    juncture.gate_main()
    texts.append(capsys.readouterr().out)
    # A result key the observer reads (`journal`) is a name, not a word to the pilot.
    texts += [re.sub(r"`[^`]*`", "", text) for text in _descriptions(
        [{k: v for k, v in tool.items() if k != "handler"} for tool in spacemolt.TOOL_DEFINITIONS])]
    for text in texts:
        found = HARNESS_WORDS.search(text) or RUN_WORD.search(re.sub(r"`[^`]*`", "", text))
        assert not found, (found and found.group(0), text)
    assert "Instruction (given 09-23 03:21Z): stay in Sol" in texts[1], texts[1]
    assert "tradeRun: nothing gained; the flight ended early" in texts[1], texts[1]


def test_the_play_readmes_speak_of_flights_not_runs():
    """The skills the pilot reads call a program's execution a flight (10-05); a craft's runs
    are the game's own word, and a call is re-run in code, so only "a run" as a noun is caught."""
    noun = re.compile(r"\b(a|the|this|each|every|that|your|next|last) runs?\b", re.IGNORECASE)
    for readme in (Path(spacemolt.__file__).parent / "src" / "play").rglob("README.md"):
        found = noun.search(re.sub(r"`[^`]*`", "", readme.read_text()))
        assert not found, (readme, found and found.group(0))
