"""The SpaceMolt plugin's tools are clients of one bridge process."""
from __future__ import annotations

import json
import sys

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
        "gather": {"outcome": "done", "steps": [{"name": "verify", "outcome": "done"}],
                   "sold": [{"item_id": "ore", "quantity": 12, "quoted": 120, "cleared": 120}],
                   "params": request["params"]},
    }
    print(json.dumps({"id": request["id"], "ok": True, "result": answers[request["action"]]}), flush=True)
'''


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
    # Every call travelled the same connection: the plugin owns one bridge, not one per tool.
    assert service._bridge is not None and service._bridge.counter == 4


def test_register_publishes_every_tool_in_the_spacemolt_toolset():
    tools, sections, unloads = {}, {}, []

    class RecordingContext:
        def register_tool(self, name, toolset, schema, handler, **kwargs):
            tools[name] = (toolset, schema, handler, kwargs)

        def register_system_prompt_section(self, id, content, **kwargs):
            sections[id] = content

        def on_unload(self, callback):
            unloads.append(callback)

    spacemolt.register(RecordingContext())
    # Every published tool is the stance's to carry: one prefix, one toolset, no strays.
    assert tools and all(name.startswith("spacemolt_") for name in tools)
    assert {toolset for toolset, *_ in tools.values()} == {"spacemolt"}
    assert {"spacemolt_where", "spacemolt_travel", "spacemolt_dock", "spacemolt_gather",
            "spacemolt_dispatch", "spacemolt_status"} <= set(tools)
    assert tools["spacemolt_travel"][1]["parameters"]["required"] == ["poi_id"]
    assert tools["spacemolt_where"][1]["parameters"]["properties"] == {}
    # Docking where the ship already is needs no argument from the model.
    assert tools["spacemolt_dock"][1]["parameters"]["required"] == []
    # A job names the site it works; home and the keep list are the script's to default.
    assert tools["spacemolt_gather"][1]["parameters"]["required"] == ["poi_id"]
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]
