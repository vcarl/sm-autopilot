"""The SpaceMolt plugin's tools are clients of one bridge process."""
from __future__ import annotations

import json
import os
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
        "run": {"accepted": True, "status": "done", "reason": "serviced", "prose": "Done: serviced.",
                "started": "t0", "commands": 3},
        "check": {"ok": True, "entry": "pilot/index.ts", "sha": "abc", "errors": []},
        "stop": {"stopping": False, "reason": "nothing is running"},
        "status": {"running": False, "last": None},
    }
    if request["action"] == "run":
        for text in ("run started t0", "▶ service", "✓ service  done", "Done: serviced.", "run ended  done  3 commands"):
            print(json.dumps({"id": request["id"], "event": "line", "text": text}), flush=True)
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


def test_every_tool_answers_from_the_one_bridge(bridged, tmp_path, monkeypatch):
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    # Playing is running pilot/index.ts: a source passed is written there first, and what
    # comes back is every streamed line, the report last.
    played = spacemolt._run({"source": "export default async function main() {}\n"})
    assert played.splitlines()[0] == "run started t0"
    assert played.splitlines()[-2:] == ["Done: serviced.", "run ended  done  3 commands"]
    assert service.pilot_file().read_text() == "export default async function main() {}\n"
    # A check answers the diagnostics beside the file as it stands.
    checked = json.loads(spacemolt._check({}))
    assert checked["ok"] is True and checked["source"].startswith("export default")
    assert json.loads(spacemolt._stop({}))["stopping"] is False
    assert json.loads(spacemolt._status({}))["run"]["running"] is False
    # Every call travelled the same connection: the plugin owns one bridge, not one per tool.
    assert service._bridge is not None and service._bridge.counter == 4


def test_register_publishes_every_tool_in_the_spacemolt_toolset():
    tools, sections, unloads, skills = {}, {}, [], []

    class RecordingContext:
        def register_skill(self, name, path, **kwargs):
            skills.append(name)

        def register_tool(self, name, toolset, schema, handler, **kwargs):
            tools[name] = (toolset, schema, handler, kwargs)

        def register_system_prompt_section(self, id, content, **kwargs):
            sections[id] = (content, kwargs)

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
        "spacemolt": {"spacemolt_run", "spacemolt_check", "spacemolt_rest", "spacemolt_reflect"},
        "spacemolt_operator": {"spacemolt_direct", "spacemolt_status", "spacemolt_stop"},
    }
    # The pilot plays by running its file; the operator sends a sentence or stops a run.
    assert tools["spacemolt_run"][1]["parameters"]["required"] == []
    assert "pilot/index.ts" in tools["spacemolt_run"][1]["description"]
    assert "source" in tools["spacemolt_check"][1]["parameters"]["properties"]
    # Direction is one tool: objective, permissions and the sentence, any one of them enough.
    assert tools["spacemolt_direct"][1]["parameters"]["required"] == []
    assert (tools["spacemolt_direct"][1]["parameters"]["properties"]["instruction"]["maxLength"]
            == spacemolt._INSTRUCTION_LIMIT)
    # The standing permissions are the two bounds on spending and owing; whether to hunt is the
    # operator's objective, like any other work.
    assert set(tools["spacemolt_direct"][1]["parameters"]["properties"]["permissions"]
               ["properties"]) == {"credit_reserve", "max_liability"}
    # Flying, docking, mining and every read are calls inside the pilot's file, not tools.
    assert not {"spacemolt_travel", "spacemolt_dock", "spacemolt_gather", "spacemolt_where",
                "spacemolt_storage", "spacemolt_scripts"} & set(tools)
    # The READMEs of the play library are the skills: the root one and one per career.
    assert "spacemolt" in skills and "spacemolt-mining" in skills
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]
    # The flight section goes to the cron fire alone, and either rendering fits its limit (core
    # skips an oversized section whole).
    flight, flight_kwargs = sections["spacemolt.flight"]
    assert flight({"platform": "cron"}) == spacemolt._FLIGHT_PROMPT
    assert flight({"platform": "discord"}) != spacemolt._FLIGHT_PROMPT
    assert all(len(flight({"platform": p})) <= flight_kwargs["max_chars"] for p in ("cron", "discord"))


def test_the_operators_sentence_is_bounded_and_lands_on_the_pilot():
    """One sentence of direction, and the pilot reads it at its next juncture.

    The cap is the scope of the instruction: what an operator can ask for in 80 characters is
    direction, and the pilot's own machinery is what carries it out. It rides on the one
    direction tool beside the objective, and setting it leaves the objective alone.
    """
    from spacemolt import juncture

    juncture.write_pilot({"name": "kvothe", "objective": "fill the hold"})
    assert "Nothing to set" in spacemolt._direct({}), "a direction with nothing in it sets nothing"
    refused = spacemolt._direct({"instruction": "x" * 81})
    assert "81" in refused and "fewer words" in refused
    assert "instruction" not in juncture.read_pilot(), "nothing over the cap reaches the pilot"
    assert juncture.read_pilot()["objective"] == "fill the hold"

    sentence = "y" * 80
    answer = spacemolt._direct({"instruction": sentence})
    recorded = juncture.read_pilot()
    assert recorded["instruction"]["text"] == sentence
    assert recorded["instruction"]["at"].endswith("Z"), "when it was said, so staleness is readable"
    assert "next juncture" in answer
    # A sentence is not an objective: the standing one is untouched unless it was named.
    assert recorded["objective"] == "fill the hold"


def test_status_answers_the_objective_the_run_and_what_happened_in_one_read(bridged, tmp_path,
                                                                           monkeypatch):
    """The window asked "what is our objective?" and got a mining snapshot, because the record
    was in no read it had. One tool now carries all three."""
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    from spacemolt import juncture

    juncture.write_pilot({"name": "kvothe", "objective": "buy a hauler", "stance": "Prospector",
                          "mood": "Focused", "permissions": {"credit_reserve": 500}})
    answer = json.loads(spacemolt._status({}))
    assert set(answer) == {"pilot", "run", "journal"}
    assert answer["pilot"]["objective"] == "buy a hauler"
    assert answer["pilot"]["permissions"] == {"credit_reserve": 500}
    assert answer["run"]["running"] is False
    assert answer["journal"] == [], "no journal file yet is an empty account, not an error"


def test_a_stance_fire_carries_the_root_readme_and_its_career_readme():
    """The skills a fire lists are the play README and the stance's folder README, by the
    names skills_register links into the profile's skills dir."""
    from spacemolt import juncture, skills_register

    named = skills_register.readme_skills(service.HERE)
    assert "spacemolt" in named and named["spacemolt"].name == "README.md"
    for stance, folder in juncture.STANCE_FOLDER.items():
        fields = juncture.job_fields({"stance": stance})
        assert fields["skills"] == ["spacemolt", f"spacemolt-{folder}"]
        assert f"spacemolt-{folder}" in named, stance
    assert juncture.job_fields({})["skills"] == ["spacemolt"]


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


def test_the_bridge_is_handed_the_argv_that_raises_the_next_juncture(tmp_path, monkeypatch):
    """The runner raises the juncture at a run's end (N4), and it does it by running Python:
    the cron jobs file has a cross-process lock only Python takes, so the bridge is told
    exactly what to run rather than left to guess at an interpreter or a venv."""
    stub = tmp_path / "env_bridge.py"
    stub.write_text(ENV_BRIDGE.replace("SPACEMOLT_JOURNAL_WEBHOOK", "SPACEMOLT_WAKE"))
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    try:
        argv = json.loads(service.call("status")["webhook"])
    finally:
        service.close_bridge()
    assert argv[0] == sys.executable
    assert argv[1].endswith("wake_juncture.py")
    # And what that argv needs to import: the plugin's parent and the Hermes tree.
    roots = service.wake_env()["PYTHONPATH"].split(os.pathsep)
    assert str(service.HERE.parent) in roots


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
        assert service.call("status") == {"webhook": "https://example.invalid/hook"}
        service.close_bridge()
        monkeypatch.delenv("SPACEMOLT_JOURNAL_WEBHOOK")
        assert service.call("status") == {"webhook": ""}
    finally:
        service.close_bridge()
