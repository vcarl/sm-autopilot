"""A chat window is a client of the runner: it observes, reads the journal, and gives direction.

Discord and the command line carry a fixed toolset that never cycles and never holds a job
tool (N19, N2). An inquiry changes nothing in the game and nothing on disk; direction writes
the operator's objective and standing permissions only, and lands at the next juncture (N17).
"""
from __future__ import annotations

import json
import sys

import pytest

import spacemolt
from spacemolt import juncture, service

# Only the reads a window needs. Every action is logged so a mutating one cannot hide, and
# `menu` reads the pilot record the way the real bridge does, so direction shows up there.
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
    if action == "where":
        result = {"system": {"id": "sol", "name": "Sol"},
                  "docked_at": {"base_id": "sol_base", "name": "Sol Station"},
                  "fuel": 88, "max_fuel": 100, "hull": 96, "max_hull": 100,
                  "pois": [{"id": "belt", "name": "Belt", "type": "asteroid_belt"}]}
    elif action == "menu":
        pilot = json.load(open(pilot_file))
        result = {"stance": pilot.get("stance"), "mood": pilot.get("mood"),
                  "objective": pilot.get("objective"), "permissions": pilot.get("permissions"),
                  "present": {"docked_at": "sol_base", "fuel": 88},
                  "options": [{"job": "J1 Hold full of ore", "reason": "belt quoted",
                               "admissible": True}],
                  "unavailable": [], "last": None}
    elif action == "status":
        result = {"running": False, "last": None}
    else:
        result = {"unexpected": action}
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
'''

PILOT = {"name": "kvothe", "stance": "Prospector", "mood": "Focused", "home": "sol_base",
         "objective": "fill the hold", "permissions": {"wildlife": False, "credit_reserve": 500}}


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


def test_an_inquiry_is_answered_from_state_and_journal_with_nothing_changed(bridged):
    runtime = bridged
    lines = [_entry("where", True, {"fuel": 88}) for _ in range(57)]
    lines.append(_entry("dock", True, {"docked": True, "docked_at": "sol_base"}))
    lines.append(_entry("gather", True, {"outcome": "done", "yield": [{"item_id": "ore", "quantity": 42}]}))
    lines.append(_entry("travel", False, {"error": "no route to belt with 12 fuel"}))
    (runtime / "gameplay.jsonl").write_text("\n".join(lines) + "\n")
    juncture.write_pilot(dict(PILOT))
    before = service.pilot_path().read_bytes()

    observed = json.loads(spacemolt._where({}))
    assert observed["docked_at"]["base_id"] == "sol_base" and observed["fuel"] == 88

    recent = json.loads(spacemolt._journal({}))
    assert len(recent) == 10, "ten entries by default; a window is not handed the whole shift"
    assert len(json.loads(spacemolt._journal({"limit": 999}))) == 50, "the ask is capped"
    assert [row["action"] for row in recent[-3:]] == ["dock", "gather", "travel"]
    assert recent[-1]["ok"] is False and "no route" in recent[-1]["result"]
    assert recent[-2]["ok"] is True and "42" in recent[-2]["result"]
    assert all(set(row) == {"at", "action", "ok", "result"} for row in recent), "compacted, not replayed"
    assert len(json.dumps(recent)) < 4000, "the journal answer stays small (N16)"

    # An inquiry asks the game to look, never to act, and moves nothing on disk (T7, T8).
    assert (runtime / "actions.log").read_text().split() == ["where"]
    assert service.pilot_path().read_bytes() == before


def test_direction_sets_objective_and_permissions_and_lands_at_the_next_juncture(bridged):
    juncture.write_pilot(dict(PILOT))

    answer = spacemolt._direct({"objective": "buy a hauler", "permissions": {"credit_reserve": 2000}})
    assert "next juncture" in answer, "direction is integrated at a juncture, not applied now"

    record = juncture.read_pilot()
    assert record["objective"] == "buy a hauler"
    # A standing permission left unnamed keeps its bound; the asking widens nothing else (T11).
    assert record["permissions"] == {"wildlife": False, "credit_reserve": 2000}
    assert {key: record[key] for key in ("name", "stance", "mood", "home")} == \
        {"name": "kvothe", "stance": "Prospector", "mood": "Focused", "home": "sol_base"}

    # The next juncture is built from the record the operator wrote (T9, N17).
    context = juncture.juncture_context({"platform": "cron"})
    assert "buy a hauler" in context and "J1 Hold full of ore" in context
    # The window itself is never handed a menu: it is a client, not the pilot (N2, N19).
    assert juncture.juncture_context({"platform": "discord"}) == ""


def test_the_window_carries_no_job_tools_and_the_juncture_no_direction_tool():
    by_toolset: dict[str, set[str]] = {}
    for definition in spacemolt.TOOL_DEFINITIONS:
        by_toolset.setdefault(definition["toolset"], set()).add(definition["name"])

    window = by_toolset["spacemolt_observe"] | by_toolset["spacemolt_operator"]
    fire = by_toolset["spacemolt"] | by_toolset["spacemolt_observe"]
    assert {"spacemolt_where", "spacemolt_status", "spacemolt_journal", "spacemolt_direct"} == window
    assert not window & {"spacemolt_dispatch", "spacemolt_travel", "spacemolt_dock", "spacemolt_gather"}
    assert "spacemolt_direct" not in fire, "only the operator sets the objective"
    assert juncture.job_fields({"stance": "Prospector"})["enabled_toolsets"] == list(juncture.TOOLSETS)
    # A tool name is global and has exactly one toolset: no tool may claim two homes.
    names = [definition["name"] for definition in spacemolt.TOOL_DEFINITIONS]
    assert len(names) == len(set(names))
    # The window is told about the tools it has, never about the ones it does not.
    window_prompt = spacemolt._prompt({"platform": "discord"})
    assert "spacemolt_journal" in window_prompt
    assert not any(name in window_prompt for name in ("spacemolt_gather", "spacemolt_dispatch"))
