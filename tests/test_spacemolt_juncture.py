"""A juncture: a cron fire opens a fresh conversation, reads the present, and plays or holds.

What a fire depends on: the busy fire that must change nothing (N4), the job definition that
carries the stance through the cron toolset clamp (N18/N20), and the contract the juncture
prompt states. The dispatch-era tests (a `script`/`params` tool that returned while the run
went on) are gone with that design: spacemolt_run now writes and runs pilot/index.ts and
blocks until it ends.
"""
from __future__ import annotations

import copy
import json
import os

import spacemolt
from spacemolt import juncture, service


def test_a_fire_while_a_script_runs_changes_nothing(monkeypatch, capsys):
    """N4: a fire that lands mid-run is a true no-op — cron's wake gate ends it before a prompt
    is built, so there is no model turn at all. The gate reads the run record the bridge keeps,
    because the shim runs outside the gateway and cannot ask the bridge anything."""
    from cron.scheduler_prompt import _parse_wake_gate

    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    lock = runtime / "controller-deadbeef.lock"
    lock.write_text(json.dumps({"pid": os.getpid()}))

    # Nothing running: no record at all, then one that ended.
    assert juncture.gate_main() == 0
    assert _parse_wake_gate(capsys.readouterr().out) is True
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": True}))
    assert juncture.gate_main() == 0
    assert _parse_wake_gate(capsys.readouterr().out) is True

    # A run in flight, and a live bridge holding the controller lock: the fire is skipped.
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": False}))
    assert juncture.run_in_flight() is True
    assert juncture.gate_main() == 0
    assert _parse_wake_gate(capsys.readouterr().out) is False

    # The same record with no live bridge is a gateway that died mid-run, not a run in flight:
    # the pilot is woken rather than silenced for good.
    lock.unlink()
    assert juncture.run_in_flight() is False
    assert juncture.gate_main() == 0
    assert _parse_wake_gate(capsys.readouterr().out) is True


def test_the_juncture_job_carries_the_stance_and_passes_the_cron_toolset_clamp(tmp_path):
    from cron import jobs as cron_jobs
    from cron.scheduler import (_CronAgentSetup, _construct_cron_agent,
                                _resolve_cron_disabled_toolsets, _resolve_cron_enabled_toolsets)

    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
                          "objective": "fill the hold", "home": "sol_base"})
    job = juncture.ensure_juncture_job()

    stored = cron_jobs.get_job(job["id"])
    # The wake gate cron runs before it builds the prompt, installed where cron will run it from.
    assert stored["script"].endswith(juncture.GATE_SCRIPT)
    from cron.scheduler_script import _resolve_script_path
    assert _resolve_script_path(stored["script"])[0] is not None, "cron must accept the path"
    # The stance's skill is its career folder's README (STANCE_FOLDER), not the stance name.
    assert stored["skills"] == ["spacemolt", "spacemolt-mining"]
    # The job tools and the reads; never the operator's toolset — a pilot does not direct itself.
    assert stored["enabled_toolsets"] == ["spacemolt", "spacemolt_observe"]
    assert "spacemolt_operator" not in stored["enabled_toolsets"]
    # The stance's own tools survive both halves of the cron clamp.
    enabled = _resolve_cron_enabled_toolsets(stored, {})
    assert {"spacemolt", "spacemolt_observe"} <= set(enabled)
    assert not {"spacemolt", "spacemolt_observe"} & set(_resolve_cron_disabled_toolsets({}))

    # A fire builds a fresh conversation: its own session, the plugin toolset, no project
    # context files and no background review fork.
    seen: dict = {}

    class RecordingAgent:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    _construct_cron_agent(RecordingAgent, stored, {}, _CronAgentSetup(model="m", runtime={}),
                          workdir=None, session_id="fire-1", session_db=None)
    assert "spacemolt" in seen["enabled_toolsets"]
    assert seen["session_id"] == "fire-1"
    assert seen["skip_context_files"] is True
    assert seen["skip_background_review"] is True

    # One cron job per pilot: rest rewrites it, never adds a second.
    juncture.write_pilot({"name": "kvothe", "stance": "Hunter", "mood": "Aggressive"})
    again = juncture.ensure_juncture_job()
    assert again["id"] == job["id"]
    assert cron_jobs.get_job(again["id"])["skills"] == ["spacemolt", "spacemolt-combat"]
    assert len(cron_jobs.load_jobs()) == 1


# What the runner answers a juncture with, in the shape the rules table builds: every option
# carrying the exact call it would be taken with, and a `present` that says what the hold
# holds. The menu is the bridge's; what these pin is what the context does with it.
def _menu(cargo_free: int, *, last: dict) -> dict:
    bounds = {"spend": 1000, "fuelReserve": 24, "walkAway": 0.9}
    options = [{"job": "Hold position and watch", "reason": "the world moves between looks",
                "admissible": True, "bounds": bounds, "call": None},
               {"job": "Counter: Storage", "reason": "offered here", "admissible": True,
                "bounds": bounds, "call": {"tool": "spacemolt_storage", "params": {}}}]
    if cargo_free > 0:
        options.append({"job": "J1 Hold full of ore", "reason": "belt quoted", "admissible": True,
                        "bounds": bounds,
                        "call": {"tool": "spacemolt_run",
                                 "params": {"script": "gather",
                                            "params": {"poi_id": ["belt", "deep-belt"],
                                                       "base_id": "sol_base"}}}})
    return {"stance": "Prospector", "mood": "Focused", "objective": "fill the hold",
            "present": {"docked_at": "sol_base", "fuel": 100, "credits": 1000,
                        "cargo_free": cargo_free, "hold": [{"item_id": "ore", "quantity": 12}],
                        "storage": True, "workshop": False},
            "options": options, "unavailable": [], "last": last}


EMPTY_GATHER = {"script": "gather", "outcome": "done",
                "jobs": [{"job": "gather", "outcome": "done", "yield": []}]}
FULL_GATHER = {"script": "gather", "outcome": "done",
               "jobs": [{"job": "gather", "outcome": "done",
                         "yield": [{"item_id": "ore", "quantity": 12}]}]}


def _rendered(monkeypatch, menu: dict, *, menu_on: bool = True) -> tuple[str, dict]:
    """The context a fire is handed, and the facts inside it. The menu path is pinned on by
    default; the switch is Carl's experiment (2026-09-16), tested on its own below."""
    monkeypatch.setattr(juncture, "MENU_ENABLED", menu_on)
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    context = juncture.juncture_context({"platform": "cron"})
    return context, json.loads(context.split("\n", 1)[1])


def test_a_full_hold_says_what_it_costs_and_why_the_last_gather_came_back_empty(monkeypatch):
    context, facts = _rendered(monkeypatch, _menu(0, last=EMPTY_GATHER))
    assert "hold full" in context and "a gather needs free hold" in context
    # The line says the act, not just the cost: stow is what frees the hold here.
    # The line says the acts, not just the cost: selling or stowing is what frees the hold.
    assert "sell(rows) or stow(rows)" in context and "gatherUntil" in context
    assert facts["present"]["hold_full"]
    assert "the hold was full (cargo_free 0)" in facts["last"]["cause"]

    # Room in the hold leaves both off: the fact is timely, not permanent furniture.
    _, roomy = _rendered(monkeypatch, _menu(12, last=FULL_GATHER))
    assert "hold_full" not in roomy["present"]
    assert "cause" not in roomy["last"]


def test_an_operators_instruction_reaches_the_juncture_and_outranks_the_objective(monkeypatch):
    """The sentence the operator sent is direction from outside the pilot.

    It travels in the consultation the fire is handed, beside the present it applies to, and
    the prompt says what weight it carries — a juncture never spends a turn asking for it.
    """
    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
                          "objective": "fill the hold",
                          "instruction": {"text": "stay in Sol tonight",
                                          "at": "2026-09-15T20:00:00Z"}})
    context, facts = _rendered(monkeypatch, _menu(12, last=FULL_GATHER))
    assert facts["instruction"] == {"text": "stay in Sol tonight", "at": "2026-09-15T20:00:00Z"}
    assert "stay in Sol tonight" in context
    assert "outranks the objective" in juncture.JUNCTURE_PROMPT

    # Nothing said, nothing carried: the field is the operator's, not furniture.
    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused"})
    _, quiet = _rendered(monkeypatch, _menu(12, last=FULL_GATHER))
    assert "instruction" not in quiet


def test_the_cron_prompt_leaves_the_tools_to_their_own_descriptions():
    """The turn contract only: nothing about which tool does what (playtest 2026-09-15).

    The exception is how a juncture plays: writing and running pilot/index.ts is the turn
    contract itself, so the prompt names the two tools that do it — the check before the run,
    and the run. Everything else is left to its own description.
    """
    named = sorted(definition["name"] for definition in spacemolt.TOOL_DEFINITIONS
                   if definition["name"] in juncture.JUNCTURE_PROMPT)
    assert named == ["spacemolt_check", "spacemolt_run"], \
        f"the prompt names tools the descriptions own: {named}"
    assert "three ways" in juncture.JUNCTURE_PROMPT, "it still teaches how a juncture ends"


def test_the_prompt_says_a_juncture_plays_by_writing_pilot_index_and_rest_reviews_it():
    """Code is the gameplay interface: playing is writing and running pilot/index.ts, and rest
    reviews the file the shift was flown with before the next goal is chosen."""
    prompt = juncture.JUNCTURE_PROMPT
    assert "writing pilot/index.ts with spacemolt_run" in prompt, "playing is running the file"
    assert "spacemolt_check first when unsure" in prompt
    for kind in ("play", "hold", "rest at home"):
        assert kind in prompt, kind
    # The skill is the library, and the escape hatch when nothing in it fits is named.
    assert "the play library's README" in prompt and "`account()` is the whole game" in prompt
    assert "pilot/<name>.ts" in prompt, "helpers worth keeping have somewhere to live"
    # Rest is a code review before it is a choice of goal.
    assert "review pilot/index.ts against how its runs ended" in prompt
    assert "then pick the goal, the stance and the mood" in prompt


def test_the_rest_context_carries_the_scripts_the_review_reads(monkeypatch):
    """A resting fire is handed the pilot's own code beside how it ran (N7)."""
    report = {"at_rest": True, "objective": "buy a combat ship", "home": "sol_base",
              "stagnation": ["stances never chosen: Hunter"],
              "scripts": [{"name": "buy-hull", "saved": True, "bytes": 812, "runs": 2,
                           "params": {"type": "object", "properties": {}},
                           "last": [{"outcome": "blocked", "reason": "credits short"},
                                    {"outcome": "failed", "reason": "no shipyard here"}]},
                          {"name": "gather", "runs": 9}]}
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(report))
    context = juncture.juncture_context({"platform": "cron"})
    assert "buy-hull" in context and "no shipyard here" in context
    # The context says what the section is for, not just that it is there.
    assert "`scripts` is the pilot's own code beside how it ran" in context
    assert "write a better version (spacemolt_check with `source`)" in context


def test_loading_the_plugin_wakes_an_idle_pilot_once_and_leaves_a_running_one_alone(monkeypatch):
    from cron import jobs as cron_jobs
    from spacemolt import service
    runtime = service.runtime_dir(); runtime.mkdir(parents=True, exist_ok=True)
    assert cron_jobs.load_jobs() == []
    spacemolt.wake_on_load()  # no pilot record: no one to wake
    assert cron_jobs.load_jobs() == []
    juncture.write_pilot({"name": "kvothe", "stance": "Industrialist", "mood": "Cautious"})
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": False}))
    spacemolt.wake_on_load()  # a run in flight raises its own juncture at its end, but the job is rewritten
    job, = cron_jobs.load_jobs()
    assert juncture.JUNCTURE_PROMPT in job["prompt"] and job.get("manual_run_at") is None
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": True}))
    spacemolt.wake_on_load()
    job, = cron_jobs.load_jobs()
    assert job["next_run_at"] is not None and job["state"] == "scheduled"


def test_with_the_menu_off_the_juncture_keeps_the_present_and_the_last_run_only(monkeypatch):
    context, facts = _rendered(monkeypatch, _menu(0, last=FULL_GATHER), menu_on=False)
    assert "options" not in facts and "unavailable" not in facts
    assert facts["present"]["cargo_free"] == 0 and facts["last"]["script"] == "gather"
    assert "option" not in context.split("\n", 1)[0]
