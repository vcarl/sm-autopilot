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

    def gate_line() -> str:
        """The last stdout line, which is the only one cron reads. Never judged through
        _parse_wake_gate alone: that answers True to no output at all, and no output is what
        cron ends a fire on (live 2026-09-17) — it would hide the very bug it looks for."""
        assert juncture.gate_main() == 0
        printed = capsys.readouterr().out
        assert printed.strip(), "an empty stdout ends the fire as surely as wakeAgent=false"
        return printed.splitlines()[-1]

    # Nothing running: no record at all, then one that ended. The fire wakes, and what the gate
    # said reaches its prompt as the script's output.
    from cron.scheduler_prompt import _build_job_prompt
    idle = gate_line()
    assert _parse_wake_gate(idle) is True
    assert idle in _build_job_prompt({"prompt": juncture.JUNCTURE_PROMPT, "script": "gate"},
                                     prerun_script=(True, idle))
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": True}))
    assert gate_line() == idle

    # A run in flight, and a live bridge holding the controller lock: the fire is skipped.
    (runtime / "run.json").write_text(json.dumps({"script": "gather", "ended": False}))
    assert juncture.run_in_flight() is True
    line = gate_line()
    assert line == '{"wakeAgent": false}' and _parse_wake_gate(line) is False

    # The same record with no live bridge is a gateway that died mid-run, not a run in flight:
    # the pilot is woken rather than silenced for good.
    lock.unlink()
    assert juncture.run_in_flight() is False
    assert gate_line() == idle


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


# What the bridge's `menu` answers, in its own shape: the record's fields, the present, the
# rendered moves and the last run. What these pin is what the context does with it.
def _menu(cargo_free: int, *, last: dict | None, hold: list | None = None) -> dict:
    return {"now": "2026-09-23T14:05:00.000Z", "stance": "Hunter", "mood": "Aggressive",
            "objective": "raise gunnery by 2 hunting fauna", "home": "unknown_edge_waystation",
            "permissions": {"credit_reserve": 5000, "max_liability": 100000},
            "present": {"system": "first_step", "docked_at": "first_step_station",
                        "fuel": 66, "max_fuel": 120, "hull": 105, "max_hull": 105,
                        "credits": 236373, "cargo_free": cargo_free,
                        "hold": hold if hold is not None else [{"item_id": "ore", "quantity": 12}],
                        "weapons": [{"id": "autocannon_i", "loaded": 500}],
                        "skills": {"weapons": 3, "gunnery": 1, "tactics": 2}},
            "moves": [], "not_now": [],
            "text": "Menu:\n  - `hunt()` — trains gunnery (level 1, the lowest) [skill]",
            "last": last}


LAST = {"sha": "f90d4bf12d9d", "started": "2026-09-16T00:10:00Z",
        "ended_at": "2026-09-16T00:40:00Z", "ended": True, "status": "done",
        "did": "gathered", "prose": "Done: mined 12 ore.\nGained: 12 ore."}
#: A run record from before the sha was carried: another schema, not this pilot's last run.
PRE_MERGE = {"script": "source:f90d4bf12d9d", "outcome": "done", "jobs": [],
             "reason": "Home set to frontier_station"}

FACT_LINES = ("SpaceMolt juncture", "Objective (operator):", "Permissions:", "Present:",
              "  Fuel ", "  Fitted weapons:", "Last run")


def _rendered(monkeypatch, menu: dict) -> str:
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    return juncture.juncture_context({"platform": "cron"})


def test_the_situation_is_labelled_lines_with_the_last_runs_age(monkeypatch):
    context = _rendered(monkeypatch, _menu(12, last=LAST))
    for label in FACT_LINES + ("Suggested moves",):
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)
    assert "Last run (ended 09-16 00:40Z, 7 days ago):" in context
    assert "hold full" not in context, "room in the hold leaves the full-hold note off"

    # A full hold says what it costs, and names itself as the cause of an empty gather.
    empty = dict(LAST, prose="Done: gathered nothing.")
    full = _rendered(monkeypatch, _menu(0, last=empty))
    assert "hold full: a gather needs free hold" in full and "sell(rows) or stow(rows)" in full
    assert "The hold was full (0 free)" in full


def test_the_situation_renders_only_the_permissions_the_code_knows(monkeypatch):
    """A key the code dropped is still in the record, and rendering it raw read as "wildlife
    False": the pilot spent its first turn weighing whether it could hunt (playtest 2026-09-22).
    """
    menu = _menu(12, last=LAST)
    menu["permissions"] = {"credit_reserve": 5000, "wildlife": False, "no_go": ["deep_range"]}
    context = _rendered(monkeypatch, menu)
    assert "Permissions: keep 5,000 credits; never go to deep_range." in context
    assert "wildlife" not in context


def test_a_pre_merge_run_record_is_no_last_run(monkeypatch):
    context = _rendered(monkeypatch, _menu(12, last=PRE_MERGE))
    assert "Last run: none yet." in context
    assert "frontier_station" not in context


def test_an_instruction_reaches_one_juncture_and_not_the_next(monkeypatch):
    """The operator's sentence is for the next juncture only: once rendered, it is delivered."""
    juncture.write_pilot({"name": "kvothe", "stance": "Hunter", "mood": "Aggressive",
                          "instruction": {"text": "stay in Sol tonight",
                                          "at": "2026-09-23T03:21:00Z"}})
    first = _rendered(monkeypatch, _menu(12, last=LAST))
    assert "Instruction (operator, 09-23 03:21Z, this juncture only): stay in Sol tonight" in first
    second = _rendered(monkeypatch, _menu(12, last=LAST))
    assert "stay in Sol tonight" not in second
    assert juncture.read_pilot()["instruction_delivered"]["text"] == "stay in Sol tonight"


def test_an_oversized_situation_fits_the_section_with_every_fact_line(monkeypatch):
    """Over the limit core drops the section whole, so the moves and the hold list give way."""
    hold = [{"item_id": f"salvaged_component_{i}", "quantity": i} for i in range(400)]
    menu = _menu(12, last=dict(LAST, prose="Done: a long run.\n" + "  - hunt done fought\n" * 80),
                 hold=hold)
    menu["text"] = "Menu:\n" + "  - `hunt()` — trains gunnery [skill]\n" * 200
    context = _rendered(monkeypatch, menu)
    assert len(context) <= juncture.SECTION_LIMIT, len(context)
    for label in FACT_LINES:
        assert any(line.startswith(label) for line in context.splitlines()), (label, context)


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
    # The job a fire runs carries the turn contract as its whole prompt.
    assert juncture.job_fields({"stance": "Hunter"})["prompt"] == juncture.JUNCTURE_PROMPT


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
    # The rest context carries the whole rest turn: the review, then one reflection.
    assert "spacemolt_check" in context and "spacemolt_reflect" in context
    # A travelogue too long for the section is cut before the section is: over the limit, core
    # would drop the whole of it, the rest turn included.
    report["seen"] = ["a system seen on the way " * 4] * 200
    context = juncture.juncture_context({"platform": "cron"})
    assert len(context) <= juncture.SECTION_LIMIT and "spacemolt_reflect" in context


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
