"""A juncture: a cron fire opens a fresh conversation, reads the menu, dispatches, and exits.

The script then runs on in the bridge, which outlives the conversation (N5). These are the
three things a fire depends on: the idle fire, the busy fire that must change nothing (N4),
and the job definition that carries the stance through the cron toolset clamp (N18/N20).
"""
from __future__ import annotations

import copy
import json
import sys

import pytest

import spacemolt
from spacemolt import juncture, service

# A bridge that starts one script and keeps it running: nothing here ever finishes, so a
# tool that returns at all returned before its run ended.
FAKE_BRIDGE = '''
import json, sys

running, starts = None, 0
MENU = {"stance": "Prospector", "mood": "Focused", "objective": "fill the hold",
        "present": {"docked_at": "sol_base", "fuel": 100, "credits": 1000},
        "options": [{"job": "J1 Hold full of ore", "reason": "belt quoted", "admissible": True,
                     "bounds": {"spend": 200, "fuelReserve": 24, "walkAway": 0.4}}],
        "unavailable": [], "last": None}
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    action, params = request["action"], request.get("params") or {}
    if action == "menu":
        result = dict(MENU) if running is None else {"busy": True, **running}
    elif action == "run":
        if running is not None:
            result = {"accepted": False, "reason": "a script is already running", **running}
        else:
            starts += 1
            running = {"script": params["script"],
                       "record": {"script": params["script"], "started": "2026-09-15T00:00:00Z",
                                  "last_job": "gather", "ended": False}}
            result = {"accepted": True, "dispatched": params, **running}
    elif action == "status":
        result = {"running": running is not None, "starts": starts, **(running or {})}
    else:
        result = {"unexpected": action}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
'''


@pytest.fixture
def bridged(tmp_path, monkeypatch):
    """The plugin's tools against a stub bridge; no game connection, no model."""
    stub = tmp_path / "fake_bridge.py"
    stub.write_text(FAKE_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    yield
    service.close_bridge()


def test_an_idle_fire_is_given_the_menu_then_dispatches_and_returns_while_the_script_runs(bridged):
    # The fire's first context carries the menu; no tool fetched it.
    context = juncture.juncture_context({"platform": "cron"})
    assert "J1 Hold full of ore" in context and "Prospector" in context
    assert "fill the hold" in context, "the objective the options are weighed against"
    # A session that is not a juncture never opens the game to build a prompt (N19).
    assert juncture.juncture_context({"platform": "discord"}) == ""
    assert juncture.juncture_context({}) == ""

    trips = {"poi_id": "belt", "item_id": "ore", "quantity": 36, "max_runs": 3}
    started = json.loads(spacemolt._dispatch({"script": "gather-until", "params": trips}))
    assert started["accepted"] is True
    assert started["script"] == "gather-until"
    # The script and its parameters reach the runner exactly as the agent named them.
    assert started["dispatched"] == {"script": "gather-until", "params": trips}
    # The conversation may end here: the run is still on its first job.
    assert started["record"]["ended"] is False
    assert json.loads(spacemolt._status({}))["running"] is True
    published = {definition["name"] for definition in spacemolt.TOOL_DEFINITIONS}
    assert "spacemolt_menu" not in published, "the menu is delivered into the fire, never fetched"


def test_a_fire_while_a_script_runs_changes_nothing(bridged):
    spacemolt._dispatch({"script": "gather", "params": {"poi_id": "belt"}})

    busy = juncture.juncture_context({"platform": "cron"})
    assert "gather" in busy and "end the turn" in busy
    assert "J1 Hold full of ore" not in busy, "a busy juncture offers nothing to choose"

    refused = json.loads(spacemolt._dispatch({"script": "gather", "params": {"poi_id": "other"}}))
    assert refused["accepted"] is False
    assert refused["script"] == "gather"

    status = json.loads(spacemolt._status({}))
    assert status["starts"] == 1, "the busy fire must not have started a second script"
    assert status["record"]["ended"] is False


def test_the_juncture_job_carries_the_stance_and_passes_the_cron_toolset_clamp(tmp_path):
    from cron import jobs as cron_jobs
    from cron.scheduler import (_CronAgentSetup, _construct_cron_agent,
                                _resolve_cron_disabled_toolsets, _resolve_cron_enabled_toolsets)

    juncture.write_pilot({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
                          "objective": "fill the hold", "home": "sol_base"})
    job = juncture.ensure_juncture_job()

    stored = cron_jobs.get_job(job["id"])
    assert stored["skills"] == ["spacemolt", "spacemolt-prospector"]
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
    assert cron_jobs.get_job(again["id"])["skills"] == ["spacemolt", "spacemolt-hunter"]
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
                        "call": {"tool": "spacemolt_dispatch",
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


def _rendered(monkeypatch, menu: dict) -> tuple[str, dict]:
    """The context a fire is handed, and the facts inside it."""
    monkeypatch.setattr(service, "call", lambda action, params=None: copy.deepcopy(menu))
    context = juncture.juncture_context({"platform": "cron"})
    return context, json.loads(context.split("\n", 1)[1])


def test_every_option_carries_the_call_it_would_be_taken_with(monkeypatch):
    _, facts = _rendered(monkeypatch, _menu(12, last=FULL_GATHER))
    published = {definition["name"] for definition in spacemolt.TOOL_DEFINITIONS}
    for option in facts["options"]:
        assert "call" in option, f"{option['job']}: no call to take it with"
        if option["call"] is None:
            continue  # hold, watch, and the counters no tool reaches yet
        assert option["call"]["tool"] in published, option["job"]
        assert isinstance(option["call"]["params"], dict), option["job"]
    gather = next(option for option in facts["options"]
                  if (option["call"] or {}).get("tool") == "spacemolt_dispatch")
    # Two mining sites are admissible, so the option offers both: the parameters carry the
    # choice the pilot makes, never a destination chosen for it.
    poi_id = gather["call"]["params"]["params"]["poi_id"]
    assert isinstance(poi_id, list) and len(poi_id) == 2, poi_id
    # The base belongs in base_id. A station id in poi_id is the mistake the menu prevents.
    assert gather["call"]["params"]["params"]["base_id"] == "sol_base"
    assert "sol_base" not in poi_id


def test_a_full_hold_says_what_it_costs_and_why_the_last_gather_came_back_empty(monkeypatch):
    context, facts = _rendered(monkeypatch, _menu(0, last=EMPTY_GATHER))
    assert "hold full" in context and "a gather needs free hold" in context
    # The line says the act, not just the cost: stow is what frees the hold here.
    assert "Dispatch stow" in context and "script stow" in context
    assert facts["present"]["hold_full"]
    assert "hold was full at departure" in facts["last"]["cause"]

    # Room in the hold leaves both off: the fact is timely, not permanent furniture.
    _, roomy = _rendered(monkeypatch, _menu(12, last=FULL_GATHER))
    assert "hold_full" not in roomy["present"]
    assert "cause" not in roomy["last"]


def test_the_cron_prompt_leaves_the_tools_to_their_own_descriptions():
    """The turn contract only: nothing about which tool does what (playtest 2026-09-15)."""
    named = sorted(definition["name"] for definition in spacemolt.TOOL_DEFINITIONS
                   if definition["name"] in juncture.JUNCTURE_PROMPT)
    assert named == [], f"the prompt names tools the descriptions own: {named}"
    assert "four ways" in juncture.JUNCTURE_PROMPT, "it still teaches how a juncture ends"
