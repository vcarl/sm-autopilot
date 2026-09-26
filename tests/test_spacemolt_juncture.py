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

    # Runs that did nothing are a fact for the log, never a reason to skip the fire.
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": True}))
    _write_journal([{"event": "run", "phase": "refused", "errors": ["tsc: x"]},
                    {"event": "run", "phase": "ended", "outcome": "failed", "commands": 0},
                    {"event": "run", "phase": "ended", "outcome": "refused", "commands": 2}])
    assert gate_line() == idle
    decisions = _journal_rows("gate")
    assert [row["wake"] for row in decisions] == [True, True, False, True]
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
            "moves": [], "not_now": [],
            "text": "Menu:\n  - `hunt()` — trains gunnery (level 1, the lowest) [skill]",
            "last": None}


FACT_LINES = ("SpaceMolt juncture", "Objective (carried in):", "Goal:", "Stance:", "Permissions:",
              "Present:", "  Fuel ", "  Fitted weapons:", "Your recent runs")


def _rendered(monkeypatch, menu: dict) -> str:
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    return juncture.juncture_context({"platform": "cron"})


def test_the_situation_is_labelled_lines_of_live_facts(monkeypatch):
    context = _rendered(monkeypatch, _menu(12))
    for label in FACT_LINES + ("Suggested moves",):
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)
    assert "Run in flight: no." in context.splitlines()[0]
    assert "Stance: Hunter. Mood: Focused." in context
    assert "Your recent runs: none yet." in context
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


def test_the_recent_runs_are_facts_and_include_a_run_refused_at_the_check(monkeypatch):
    """A refusal at tsc never reached run.json, so a juncture used to open as if it had not
    happened. And a run's report is not replayed: the context says how it ended, never what an
    earlier report told the pilot to do."""
    _write_journal([
        {"event": "run", "phase": "ended", "outcome": "done", "reason": "sold 276 osmium_ore",
         "commands": 14, "work": {"credits": 3000, "items": 0, "xp": 5}},
        {"event": "reflection", "stance": "Trader", "goal": "walk a price circuit"},
        {"event": "run", "phase": "refused", "errors": ["tsc: pilot/index.ts(2,5): error TS2339: 'fule'\n    2 | x"]},
        {"event": "run", "phase": "ended", "outcome": "interrupted",
         "reason": "the bridge ended while this run was in flight; nothing was re-run"},
    ])
    context = _rendered(monkeypatch, _menu(12))
    recent = context.split("Your recent runs (newest last):\n")[1].split("\nSuggested")[0].splitlines()
    assert len(recent) == 4, recent
    assert recent[0].endswith("run done: sold 276 osmium_ore (14 commands, +3,000 cr, 5 xp)"), recent[0]
    assert "reflect: stance Trader, goal 'walk a price circuit'" in recent[1]
    assert "run refused at the check, nothing ran: tsc: pilot/index.ts(2,5): error TS2339: 'fule'" in recent[2]
    assert "run interrupted" in recent[3]


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


def test_skills_and_the_walk_away_line_read_as_what_they_are(monkeypatch):
    context = _rendered(monkeypatch, _menu(12))
    assert "Skills: weapons 3 (.level), gunnery 1 (.level), tactics 2 (.level)." in context
    assert "Walk-away" not in context
    menu = _menu(12)
    menu["present"]["walk_away"] = 94
    assert "  Walk-away: break off a fight below hull 94." in _rendered(monkeypatch, menu)


def test_an_instruction_stands_until_a_run_starts_after_it_and_rendering_writes_nothing(monkeypatch):
    """Delivered once meant moved aside as it rendered, so a fire that failed before running lost
    it (and rendering wrote the record). Now it stands until a run starts after it was given."""
    _seed({"name": "kvothe", "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T03:21:00Z"}})
    before = service.pilot_path().read_bytes()
    first = _rendered(monkeypatch, _menu(12))
    assert "Instruction (carried in 09-23 03:21Z): stay in Sol tonight" in first
    assert "stay in Sol tonight" in _rendered(monkeypatch, _menu(12)), "no run yet, so it stands"
    assert service.pilot_path().read_bytes() == before
    (service.runtime_dir() / "run.json").write_text(
        json.dumps({"script": "index.ts", "started": "2026-09-23T04:00:00Z", "ended": True}))
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
    assert "Alerts since your last wake (2, shown once):" in context
    assert ("  rent overdue at Hera Outpost: 4,200 owed; 2 of 4 missed cycles, "
            "seen 3x since 09-23 11:40Z." in context), context
    assert "  base destroyed at Far Reach: attacker Vex." in context
    assert "Alerts since" not in _rendered(monkeypatch, _menu(12))


def test_an_oversized_situation_fits_the_section_with_every_fact_line(monkeypatch):
    """Over the limit core drops the section whole, so the moves, the hold list and the older
    recent lines give way."""
    _write_journal([{"event": "run", "phase": "ended", "outcome": "done", "reason": "x" * 400,
                     "why": "y" * 400, "commands": 1}] * 5)
    hold = [{"item_id": f"salvaged_component_{i}", "quantity": i} for i in range(400)]
    menu = _menu(12, hold=hold)
    menu["text"] = "Menu:\n" + "  - `hunt()` — trains gunnery [skill]\n" * 200
    context = _rendered(monkeypatch, menu)
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    for label in FACT_LINES:
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)


def test_a_run_in_flight_is_said_in_one_line(monkeypatch):
    context = _rendered(monkeypatch, {"busy": True, "running": True, "started": "2026-09-23T14:00:00Z",
                                      "fn": "gatherUntil", "commands": 40})
    assert context.startswith("SpaceMolt juncture. Run in flight: yes — started 09-23 14:00Z, in gatherUntil")


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
