"""The SpaceMolt plugin's two tools are clients of one bridge process."""
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


def test_both_tools_answer_from_the_one_bridge(bridged):
    observed = json.loads(spacemolt._where({}))
    assert observed["system"]["id"] == "sol"
    assert observed["pois"] == [{"id": "belt", "name": "Belt", "type": "belt"}]
    arrival = json.loads(spacemolt._travel({"poi_id": "belt"}))
    assert arrival == {"arrived": True, "location": {"system": "sol", "poi": "belt"}}
    # Both calls travelled the same connection: the plugin owns one bridge, not one per tool.
    assert service._bridge is not None and service._bridge.counter == 2


def test_register_publishes_both_tools_in_the_spacemolt_toolset():
    tools, sections, unloads = {}, {}, []

    class RecordingContext:
        def register_tool(self, name, toolset, schema, handler, **kwargs):
            tools[name] = (toolset, schema, handler, kwargs)

        def register_system_prompt_section(self, id, content, **kwargs):
            sections[id] = content

        def on_unload(self, callback):
            unloads.append(callback)

    spacemolt.register(RecordingContext())
    assert set(tools) == {"spacemolt_where", "spacemolt_travel"}
    assert {toolset for toolset, *_ in tools.values()} == {"spacemolt"}
    assert tools["spacemolt_travel"][1]["parameters"]["required"] == ["poi_id"]
    assert tools["spacemolt_where"][1]["parameters"]["properties"] == {}
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]
