"""A chat window is a client of the runner: it looks, stops a flight, and gives direction.

Discord and the command line carry a fixed toolset that never cycles and never holds a job
tool (N19, N2). An inquiry changes nothing in the game and nothing on disk; direction writes
the objective and standing bounds carried in only, and lands at the next juncture (N17).
"""
from __future__ import annotations

import json
import sys

import pytest
import spacemolt
from spacemolt import juncture, service

# Only the reads a window needs. Every action is logged so a mutating one cannot hide, and
# `context` reads the pilot record the way the real bridge does, so direction shows up there.
FAKE_BRIDGE = '''
import json, os, sys
runtime = os.environ["SPACEMOLT_RUNTIME_DIR"]
pilot_file = os.path.join(runtime, "..", "pilot.json")
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    action = request["action"]
    with open(os.path.join(runtime, "actions.log"), "a") as log:
        log.write(action + "\\n")
    with open(os.path.join(runtime, "requests.jsonl"), "a") as log:
        log.write(json.dumps(request) + "\\n")
    if action == "where":
        result = {"system": {"id": "sol", "name": "Sol"},
                  "docked_at": {"base_id": "sol_base", "name": "Sol Station"},
                  "fuel": 88, "max_fuel": 100, "hull": 96, "max_hull": 100,
                  "pois": [{"id": "belt", "name": "Belt", "type": "asteroid_belt"}]}
    elif action == "pilot":
        # The record's one writer: set fields, a null removes one, and a new objective clears
        # the goal, steps and stance the same write does not set (as src/bridge.ts does).
        pilot = json.load(open(pilot_file)) if os.path.exists(pilot_file) else {}
        patch = dict(request["params"]["set"])
        if isinstance(patch.get("objective"), str) and patch["objective"] != pilot.get("objective"):
            for key in ("goal", "steps", "stance"):
                patch.setdefault(key, None)
        for key, value in patch.items():
            if value is None:
                pilot.pop(key, None)
            else:
                pilot[key] = value
        json.dump(pilot, open(pilot_file, "w"))
        result = {"record": pilot}
    elif action == "context":
        pilot = json.load(open(pilot_file))
        result = {"text": "Objective: " + str(pilot.get("objective")) + "\\nStance: " + str(pilot.get("stance"))
                          + "\\n  - `gatherUntil('belt')` — belt quoted [credits]",
                  "busy": False, "moves": [{"call": "gatherUntil('belt')"}]}
    elif action == "stop":
        running = os.path.exists(os.path.join(runtime, "run.running"))
        result = {"stopping": running} if running else {"stopping": False, "reason": "no flight is under way"}
    elif action == "run":
        # A run that ends at once; nothing streams.
        result = {"accepted": True, "outcome": "done"}
    elif action == "query":
        # What the window's look reads: the program is the caller's; this answers for it.
        pilot = json.load(open(pilot_file))
        result = {"ok": True, "lines": [], "returned": json.dumps({"objective": pilot.get("objective")},
                                                                    separators=(",", ":"))}
    elif action == "status":
        # A script is running exactly while this marker file exists, read per request.
        result = {"running": os.path.exists(os.path.join(runtime, "run.running")), "last": None}
    else:
        result = {"unexpected": action}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
'''

PILOT = {"name": "kvothe", "stance": "Prospector", "home": "sol_base",
         "objective": "fill the hold", "permissions": {"wildlife": False, "credit_reserve": 500}}


def _seed(record: dict) -> None:
    """A pilot record on disk, as the bridge would have written it."""
    service.pilot_path().parent.mkdir(parents=True, exist_ok=True)
    service.pilot_path().write_text(json.dumps(record))


def _entry(action: str, ok: bool, payload: dict) -> str:
    """One journal line in the shape the bridge appends: request in, response out."""
    response = {"id": "1", "ok": ok, **({"result": payload} if ok else {"error": payload["error"]})}
    return json.dumps({"at": "2026-09-14T12:00:00.000Z",
                       "request": {"id": "1", "action": action, "params": {}},
                       "response": response})


@pytest.fixture
def bridged(tmp_path, monkeypatch):
    """The plugin's tools against a stub bridge; no game connection, no model."""
    stub = tmp_path / "fake_bridge.py"
    stub.write_text(FAKE_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(runtime))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    yield runtime
    service.close_bridge()


def test_look_and_query_are_one_read_that_changes_nothing(bridged):
    """The window's look is the pilot's query under its own name: one handler, one `query` request,
    the program written to query/index.ts. The record, the flight and the log are reads inside it
    (`pilot()`, `flight()`, `shipLog()`), so nothing in the game or on disk moves (T7, T8)."""
    runtime = bridged
    _seed(dict(PILOT))
    before = service.pilot_path().read_bytes()
    by_name = {definition["name"]: definition for definition in spacemolt.TOOL_DEFINITIONS}
    assert by_name["spacemolt_look"]["handler"] is by_name["spacemolt_query"]["handler"]
    source = ("import {flight, pilot, shipLog} from 'play';\n"
              "export default async function main() { return {pilot: pilot(), flight: flight(), log: shipLog(20)}; }\n")
    answered = by_name["spacemolt_look"]["handler"]({"source": source})
    assert answered.endswith('returned: {"objective":"fill the hold"}'), answered
    assert (runtime / "query" / "index.ts").read_text() == source
    assert set((runtime / "actions.log").read_text().split()) == {"query"}
    assert service.pilot_path().read_bytes() == before
    # The window's prompt says where those reads are.
    window_prompt = spacemolt._prompt({"platform": "discord"})
    assert all(read in window_prompt for read in ("`pilot()`", "`flight()`", "`shipLog(20)`")), window_prompt


def test_direction_sets_objective_and_permissions_and_lands_at_the_next_juncture(bridged):
    _seed(dict(PILOT))

    answer = spacemolt._direct({"objective": "buy a hauler", "permissions": {"credit_reserve": 2000}})
    assert "next time it takes stock" in answer, "direction is integrated at a juncture, not applied now"

    record = juncture.read_pilot()
    assert record["objective"] == "buy a hauler"
    # A standing permission left unnamed keeps its bound; the asking widens nothing else (T11).
    assert record["permissions"] == {"wildlife": False, "credit_reserve": 2000}
    # A new objective retires the old plan: the stance (and with it the career skill a fire
    # carries) and any goal go, and the job is rewritten to carry the base skill only.
    assert {key: record.get(key) for key in ("name", "stance", "goal", "home")} == \
        {"name": "kvothe", "stance": None, "goal": None, "home": "sol_base"}
    from cron import jobs as cron_jobs
    [job] = cron_jobs.load_jobs()
    assert job["skills"] == [juncture.qualified(juncture.SHARED_SKILL)]
    # Nothing was flying, so nothing was stopped.
    assert "flies on to its outcome first" in answer
    # Written by the bridge, the record's one writer.
    assert "pilot" in (bridged / "actions.log").read_text().split()

    # The next juncture is built from the record the observer wrote (T9, N17).
    context = juncture.juncture_context({"platform": "cron"})
    assert "buy a hauler" in context and "gatherUntil('belt')" in context
    # The window itself is never handed a menu: it is a client, not the pilot (N2, N19).
    assert juncture.juncture_context({"platform": "discord"}) == ""


def test_direction_marks_nothing_due_the_interval_brings_the_juncture(bridged):
    """A mark made while a fire held the job was erased by cron (09-16 to 09-26), so direction
    marks nothing: the interval is minutes, and the answer says so."""
    from cron import jobs as cron_jobs
    _seed(dict(PILOT))
    from datetime import datetime
    answer = spacemolt._direct({"objective": "buy a hauler"})
    [job] = cron_jobs.load_jobs()
    assert datetime.fromisoformat(job["next_run_at"]) > datetime.now().astimezone(), \
        "the rewrite re-anchors the interval; it never makes the job due"
    assert "within 5m" in answer, answer


def test_a_new_objective_stops_the_run_in_flight_and_the_same_one_does_not(bridged):
    _seed({**PILOT, "goal": "mine the belt"})
    (bridged / "run.running").touch()
    same = spacemolt._direct({"objective": "fill the hold"})
    assert juncture.read_pilot()["goal"] == "mine the belt", "the same text is not a new objective"
    assert "stop" not in (bridged / "actions.log").read_text().split()
    assert "flies on to its outcome first" in same
    answer = spacemolt._direct({"objective": "explore new areas"})
    assert "stop" in (bridged / "actions.log").read_text().split()
    assert "asked to stop at its next safe point" in answer, answer
    assert "goal" not in juncture.read_pilot()


def test_the_window_carries_no_job_tools_and_the_juncture_no_direction_tool():
    by_toolset: dict[str, set[str]] = {}
    for definition in spacemolt.TOOL_DEFINITIONS:
        by_toolset.setdefault(definition["toolset"], set()).add(definition["name"])

    # Two toolsets: cron and a platform name toolsets, and a tool name has exactly one.
    assert set(by_toolset) == {"spacemolt_player", "spacemolt_observer"}
    window = by_toolset["spacemolt_observer"]
    fire = by_toolset["spacemolt_player"]
    assert window == {"spacemolt_look", "spacemolt_stop", "spacemolt_direct"}
    assert fire == {"spacemolt_run", "spacemolt_query", "spacemolt_answer", "spacemolt_reflect"}
    assert not window & {"spacemolt_run", "spacemolt_scripts"}
    # Acting is running a script; a fire that could fly by hand would not write one.
    published = {definition["name"] for definition in spacemolt.TOOL_DEFINITIONS}
    assert not published & {"spacemolt_travel", "spacemolt_dock", "spacemolt_gather"}
    assert "spacemolt_direct" not in fire, "only the observer sets the objective"
    assert juncture.job_fields({"stance": "Prospector"})["enabled_toolsets"] == list(juncture.TOOLSETS)
    # A tool name is global and has exactly one toolset: no tool may claim two homes.
    names = [definition["name"] for definition in spacemolt.TOOL_DEFINITIONS]
    assert len(names) == len(set(names))
    # The window is told about the tools it has, never about the ones it does not.
    window_prompt = spacemolt._prompt({"platform": "discord"})
    assert all(name in window_prompt for name in window), "the window names every tool it has"
    assert not any(name in window_prompt for name in ("spacemolt_run", "spacemolt_scripts"))


def test_the_fire_and_the_window_each_hold_their_own_half():
    """A fire looks with query and stops a paused flight through answer; the window looks with
    look and brakes with stop. Neither holds the other's name for the same act."""
    by_toolset: dict[str, set[str]] = {}
    for definition in spacemolt.TOOL_DEFINITIONS:
        by_toolset.setdefault(definition["toolset"], set()).add(definition["name"])
    resolve = lambda names: set().union(*(by_toolset.get(name, set()) for name in names))

    fire = resolve(juncture.TOOLSETS)
    window = resolve(("spacemolt_observer",))
    assert "spacemolt_query" in fire and "spacemolt_query" not in window
    assert "spacemolt_look" in window and "spacemolt_look" not in fire
    # Direction comes from outside the pilot: the window sends the sentence, the fire reads it.
    assert "spacemolt_direct" not in fire, "a pilot does not instruct itself"
    assert "spacemolt_direct" in window, "the observer's window is where a sentence is sent"
    # The window's brake is stop; the fire drops a question with answer's `stop`.
    assert "spacemolt_stop" in window and "spacemolt_stop" not in fire
    assert "stop" in spacemolt.TOOL_DEFINITIONS[[d["name"] for d in spacemolt.TOOL_DEFINITIONS].index(
        "spacemolt_answer")]["schema"]["parameters"]["properties"]
    assert "spacemolt_answer" in fire and "spacemolt_answer" not in window


def test_a_run_in_a_fire_rendered_for_an_old_objective_says_the_objective_changed(bridged):
    """The stop reaches only the run already flying: a fire whose context named the old objective
    may start another run for the old plan, and every report in it says what the record holds."""
    _seed(dict(PILOT))
    juncture.juncture_context({"platform": "cron", "session_id": "cron_abc_20261001_101500"})
    assert "objective became" not in spacemolt._run({})
    spacemolt._direct({"objective": "explore new areas"})
    for _ in range(2):
        report = spacemolt._run({})
        assert "the objective became 'explore new areas'" in report, report
    # The next fire is rendered with the new objective, and its runs say nothing.
    juncture.juncture_context({"platform": "cron", "session_id": "cron_abc_20261001_103000"})
    assert "objective became" not in spacemolt._run({})


def test_the_stop_on_a_new_objective_carries_its_reason(bridged):
    _seed(dict(PILOT))
    (bridged / "run.running").touch()
    spacemolt._direct({"objective": "explore new areas"})
    requests = [json.loads(line) for line in (bridged / "requests.jsonl").read_text().splitlines()]
    [stop] = [row for row in requests if row["action"] == "stop"]
    assert stop["params"] == {"reason": "objective"}


def test_a_failed_job_rewrite_still_stops_the_run_and_answers(bridged, monkeypatch):
    _seed(dict(PILOT))
    (bridged / "run.running").touch()

    def broken():
        raise RuntimeError("cron is down")

    monkeypatch.setattr(spacemolt, "ensure_juncture_job", broken)
    answer = spacemolt._direct({"objective": "explore new areas"})
    assert "asked to stop at its next safe point" in answer, answer
    assert juncture.read_pilot()["objective"] == "explore new areas"
    rows = [json.loads(line) for line in (bridged / "gameplay.jsonl").read_text().splitlines()]
    assert any(row["event"] == "wake_failed" and "cron is down" in row["error"] for row in rows), rows
