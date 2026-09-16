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
        "spacemolt": {"spacemolt_travel", "spacemolt_dock", "spacemolt_gather", "spacemolt_run",
                      "spacemolt_scripts", "spacemolt_rest", "spacemolt_reflect"},
        "spacemolt_observe": {"spacemolt_where", "spacemolt_journal", "spacemolt_storage",
                              "spacemolt_recipes", "spacemolt_quote"},
        "spacemolt_operator": {"spacemolt_direct", "spacemolt_status", "spacemolt_dispatch"},
    }
    # The pilot runs scripts; the operator sends a sentence. Each names the other's tool never.
    assert tools["spacemolt_run"][1]["parameters"]["required"] == ["params"]
    # The jobs a script may compose are named where the script is written, craft among them.
    assert "craft" in tools["spacemolt_run"][1]["description"]
    # Moving an input to the bench that wants it is a job of its own, named there too.
    assert "withdraw" in tools["spacemolt_run"][1]["description"]
    # Hunting fauna is a job of its own, so a Hunter's script can name it.
    assert "hunt" in tools["spacemolt_run"][1]["description"]
    assert tools["spacemolt_scripts"][1]["parameters"]["required"] == ["action"]
    assert tools["spacemolt_dispatch"][1]["parameters"]["required"] == ["instruction"]
    # The standing permissions are the two bounds on spending and owing; whether to hunt is the
    # operator's objective, like any other work.
    assert set(tools["spacemolt_direct"][1]["parameters"]["properties"]["permissions"]
               ["properties"]) == {"credit_reserve", "max_liability"}
    assert tools["spacemolt_travel"][1]["parameters"]["required"] == ["poi_id"]
    assert tools["spacemolt_where"][1]["parameters"]["properties"] == {}
    # Docking where the ship already is needs no argument from the model.
    assert tools["spacemolt_dock"][1]["parameters"]["required"] == []
    # A job names the site it works; home and the keep list are the script's to default.
    assert tools["spacemolt_gather"][1]["parameters"]["required"] == ["poi_id"]
    # The bench reads: ranking asks for nothing, a quote names the one recipe it prices.
    assert tools["spacemolt_recipes"][1]["parameters"]["required"] == []
    assert tools["spacemolt_quote"][1]["parameters"]["required"] == ["recipe_id"]
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]


def test_the_operators_sentence_is_bounded_and_lands_on_the_pilot():
    """One sentence of direction, and the pilot reads it at its next juncture.

    The cap is the scope of the instruction: what an operator can ask for in 80 characters is
    direction, and the pilot's own machinery is what carries it out.
    """
    from spacemolt import juncture

    juncture.write_pilot({"name": "kvothe", "objective": "fill the hold"})
    refused = spacemolt._dispatch({"instruction": "x" * 81})
    assert "81" in refused and "fewer words" in refused
    assert "instruction" not in juncture.read_pilot(), "nothing over the cap reaches the pilot"

    sentence = "y" * 80
    answer = spacemolt._dispatch({"instruction": sentence})
    recorded = juncture.read_pilot()
    assert recorded["instruction"]["text"] == sentence
    assert recorded["instruction"]["at"].endswith("Z"), "when it was said, so staleness is readable"
    assert "next juncture" in answer
    # Direction is not a setting: the operator's objective is the other tool's to change.
    assert recorded["objective"] == "fill the hold"


def test_the_bench_reads_reach_a_cron_fire():
    """The workshop counter is offered at a juncture, so the tools it points at have to be in
    the toolsets a fire carries — a counter whose call names a tool the fire lacks is a dead
    line on the menu."""
    from spacemolt import juncture

    by_toolset: dict[str, set[str]] = {}
    for definition in spacemolt.TOOL_DEFINITIONS:
        by_toolset.setdefault(definition["toolset"], set()).add(definition["name"])
    fire = set().union(*(by_toolset[name] for name in juncture.TOOLSETS))
    assert {"spacemolt_recipes", "spacemolt_quote"} <= fire


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


ENV_BRIDGE = '''
import json, os, sys
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True,
                      "result": {"webhook": os.environ.get("SPACEMOLT_JOURNAL_WEBHOOK", "")}}),
          flush=True)
'''


def test_the_journal_webhook_reaches_the_bridge_the_way_the_credentials_path_does(tmp_path, monkeypatch):
    """The drain's destination is a secret of this profile, handed to the child and nowhere else.

    Absent, the child is never handed the name at all, so a bridge with no webhook configured
    starts no drain rather than starting one pointed at nothing.
    """
    stub = tmp_path / "env_bridge.py"
    stub.write_text(ENV_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    try:
        monkeypatch.setenv("SPACEMOLT_JOURNAL_WEBHOOK", "https://example.invalid/hook")
        assert service.call("where") == {"webhook": "https://example.invalid/hook"}
        service.close_bridge()
        monkeypatch.delenv("SPACEMOLT_JOURNAL_WEBHOOK")
        assert service.call("where") == {"webhook": ""}
    finally:
        service.close_bridge()
