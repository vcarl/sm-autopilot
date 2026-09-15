"""The SpaceMolt plugin's tools are clients of one bridge process."""
from __future__ import annotations

import json
import signal
import sys
import time

import pytest

import spacemolt
from spacemolt import service

FAKE_BRIDGE = '''
import json, sys
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    answers = {
        "where": {"system": {"id": "sol", "name": "Sol"}, "pois": [{"id": "belt", "name": "Belt", "type": "belt"}]},
        "travel": {"arrived": True, "location": {"system": "sol", "poi": request["params"].get("poi_id")}},
        "dock": {"docked": True, "docked_at": "sol_base", "already_docked": False},
        "storage": {"base_id": "sol_base", "items": [{"item_id": "ore", "quantity": 340}],
                    "ships": 0, "locations": [], "params": request["params"]},
        "gather": {"outcome": "done", "steps": [{"name": "verify", "outcome": "done"}],
                   "sold": [{"item_id": "ore", "quantity": 12, "quoted": 120, "cleared": 120}],
                   "params": request["params"]},
    }
    print(json.dumps({"id": request["id"], "ok": True, "result": answers[request["action"]]}), flush=True)
'''

# A bridge that never reads stdin: closing it is not enough to end this one.
STUBBORN_BRIDGE = """
import json, sys, time
print("stubborn bridge up", file=sys.stderr, flush=True)
print(json.dumps({"event": "ready"}), flush=True)
while True:
    time.sleep(0.05)
"""


@pytest.fixture
def bridged(tmp_path, monkeypatch):
    """Point the plugin at a stub bridge; no game connection, one owned process."""
    stub = tmp_path / "fake_bridge.py"
    stub.write_text(FAKE_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    yield
    service.close_bridge()


def test_every_tool_answers_from_the_one_bridge(bridged):
    observed = json.loads(spacemolt._where({}))
    assert observed["system"]["id"] == "sol"
    assert observed["pois"] == [{"id": "belt", "name": "Belt", "type": "belt"}]
    arrival = json.loads(spacemolt._travel({"poi_id": "belt"}))
    assert arrival == {"arrived": True, "location": {"system": "sol", "poi": "belt"}}
    assert json.loads(spacemolt._dock({})) == {"docked": True, "docked_at": "sol_base", "already_docked": False}
    # An omitted home leaves the bridge to default it to the dock the ship is at.
    job = json.loads(spacemolt._gather({"poi_id": "belt", "keep": ["cabin_economy"]}))
    assert job["outcome"] == "done"
    assert job["params"] == {"poi_id": "belt", "keep": ["cabin_economy"]}
    # No station named: the bridge defaults to the current base.
    here = json.loads(spacemolt._storage({}))
    assert here["params"] == {}
    # A named station is passed through unchanged, for a look without travelling.
    elsewhere = json.loads(spacemolt._storage({"station_id": "other_base"}))
    assert elsewhere["params"] == {"station_id": "other_base"}
    # Every call travelled the same connection: the plugin owns one bridge, not one per tool.
    assert service._bridge is not None and service._bridge.counter == 6


def test_register_publishes_every_tool_in_the_spacemolt_toolset():
    tools, sections, unloads, skills = {}, {}, [], []

    class RecordingContext:
        def register_skill(self, name, path, **kwargs):
            skills.append(name)

        def register_tool(self, name, toolset, schema, handler, **kwargs):
            tools[name] = (toolset, schema, handler, kwargs)

        def register_system_prompt_section(self, id, content, **kwargs):
            sections[id] = content

        def on_unload(self, callback):
            unloads.append(callback)

    spacemolt.register(RecordingContext())
    # One prefix, no strays, and each tool in exactly one of the three toolsets: the job tools
    # a fire flies with, the reads any client may make, and the one tool that sets direction.
    assert tools and all(name.startswith("spacemolt_") for name in tools)
    by_toolset: dict[str, set[str]] = {}
    for name, (toolset, *_rest) in tools.items():
        by_toolset.setdefault(toolset, set()).add(name)
    assert by_toolset == {
        "spacemolt": {"spacemolt_travel", "spacemolt_dock", "spacemolt_gather", "spacemolt_dispatch",
                      "spacemolt_rest", "spacemolt_reflect"},
        "spacemolt_observe": {"spacemolt_where", "spacemolt_status", "spacemolt_journal", "spacemolt_storage"},
        "spacemolt_operator": {"spacemolt_direct"},
    }
    assert tools["spacemolt_travel"][1]["parameters"]["required"] == ["poi_id"]
    assert tools["spacemolt_where"][1]["parameters"]["properties"] == {}
    # Docking where the ship already is needs no argument from the model.
    assert tools["spacemolt_dock"][1]["parameters"]["required"] == []
    # A job names the site it works; home and the keep list are the script's to default.
    assert tools["spacemolt_gather"][1]["parameters"]["required"] == ["poi_id"]
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]


def test_close_bridge_ends_a_bridge_that_ignores_its_closed_stdin(tmp_path, monkeypatch):
    """Unload must leave no bridge behind: a bridge that outlives its gateway holds the game
    lock and, under launchd, the supervisor's stderr pipe — so the wrapper never sees EOF."""
    stub = tmp_path / "stubborn_bridge.py"
    stub.write_text(STUBBORN_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(runtime))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    monkeypatch.setattr(service, "CLOSE_TIMEOUT", 2.0)
    bridge = service.Bridge()
    monkeypatch.setattr(service, "_bridge", bridge)
    try:
        started = time.monotonic()
        service.close_bridge()  # what ctx.on_unload(close_bridge) runs
        elapsed = time.monotonic() - started
        assert bridge.process.poll() == -signal.SIGTERM, "a bridge is asked to stop, not killed outright"
        assert elapsed < 30, f"close_bridge must be bounded, took {elapsed:.1f}s"
        assert service._bridge is None
        # The bridge's noise went to its own log, never to the stderr the gateway inherited.
        assert "stubborn bridge up" in (runtime / service.BRIDGE_STDERR).read_text()
    finally:
        bridge.process.kill()
