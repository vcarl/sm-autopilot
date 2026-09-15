"""A juncture: a cron fire opens a fresh conversation, reads the menu, dispatches, and exits.

The chain then runs on in the bridge, which outlives the conversation (N5). These are the
three things a fire depends on: the idle fire, the busy fire that must change nothing (N4),
and the job definition that carries the stance through the cron toolset clamp (N18/N20).
"""
from __future__ import annotations

import json
import sys

import pytest

import spacemolt
from spacemolt import juncture, service

# A bridge that starts one chain and keeps it running: nothing here ever finishes, so a
# tool that returns at all returned before its chain ended.
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
    elif action == "job":
        if running is not None:
            result = {"accepted": False, "reason": "a chain is already running", **running}
        else:
            starts += 1
            running = {"chain_id": "chain-%d" % starts,
                       "record": {"kind": "loop", "length": 3, "position": 0, "ended": False}}
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


def test_an_idle_fire_is_given_the_menu_then_dispatches_and_returns_while_the_chain_runs(bridged):
    # The fire's first context carries the menu; no tool fetched it.
    context = juncture.juncture_context({"platform": "cron"})
    assert "J1 Hold full of ore" in context and "Prospector" in context
    assert "fill the hold" in context, "the objective the options are weighed against"
    # A session that is not a juncture never opens the game to build a prompt (N19).
    assert juncture.juncture_context({"platform": "discord"}) == ""
    assert juncture.juncture_context({}) == ""

    started = json.loads(spacemolt._dispatch({"job": "gather", "poi_id": "belt", "repeat": 3}))
    assert started["accepted"] is True
    assert started["chain_id"] == "chain-1"
    assert started["dispatched"] == {"job": "gather", "poi_id": "belt", "repeat": 3}
    # The conversation may end here: the chain is still on job 1 of 3.
    assert started["record"] == {"kind": "loop", "length": 3, "position": 0, "ended": False}
    assert json.loads(spacemolt._status({}))["running"] is True
    published = {definition["name"] for definition in spacemolt.TOOL_DEFINITIONS}
    assert "spacemolt_menu" not in published, "the menu is delivered into the fire, never fetched"


def test_a_fire_while_a_chain_runs_changes_nothing(bridged):
    spacemolt._dispatch({"job": "gather", "poi_id": "belt"})

    busy = juncture.juncture_context({"platform": "cron"})
    assert "chain-1" in busy and "end the turn" in busy
    assert "J1 Hold full of ore" not in busy, "a busy juncture offers nothing to choose"

    refused = json.loads(spacemolt._dispatch({"job": "gather", "poi_id": "other"}))
    assert refused["accepted"] is False
    assert refused["chain_id"] == "chain-1"

    status = json.loads(spacemolt._status({}))
    assert status["starts"] == 1, "the busy fire must not have started a second chain"
    assert status["record"]["position"] == 0


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
