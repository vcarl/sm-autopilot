"""The SpaceMolt plugin's tools are clients of one bridge process."""
from __future__ import annotations

import json
import os
import re
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
        "stop": {"stopping": False, "reason": "no flight is under way"},
        "status": {"running": False, "last": None},
    }
    if request["action"] == "run":
        for text in ("flight launched t0", "▶ service", "✓ service  done", "Done: serviced.", "flight ended  done  3 commands"):
            print(json.dumps({"id": request["id"], "event": "line", "text": text}), flush=True)
    print(json.dumps({"id": request["id"], "ok": True, "result": answers[request["action"]]}), flush=True)
'''

# A bridge with a run in flight: `status` says so and `run` refuses, as the real one does.
BUSY_BRIDGE = '''
import json, sys
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    answers = {
        "status": {"running": True, "started": "t0", "fn": "hunt"},
        "run": {"accepted": False, "reason": "a flight is already under way; stop it or wait", "running": True},
    }
    print(json.dumps({"id": request["id"], "ok": True,
                      "result": answers.get(request["action"], {})}), flush=True)
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
    assert played.splitlines()[0] == "flight launched t0"
    assert played.splitlines()[-2:] == ["Done: serviced.", "flight ended  done  3 commands"]
    assert service.pilot_file().read_text() == "export default async function main() {}\n"
    # A check answers the diagnostics beside the file as it stands.
    checked = json.loads(spacemolt._check({}))
    assert checked["ok"] is True and checked["source"].startswith("export default")
    assert json.loads(spacemolt._stop({}))["stopping"] is False
    assert json.loads(spacemolt._status({}))["run"]["running"] is False
    # Every call travelled the same connection: the plugin owns one bridge, not one per tool.
    # Five: `run` asks `status` first, before it writes anything (see below).
    assert service._bridge is not None and service._bridge.counter == 5


def test_an_edit_to_the_pilot_carries_the_check_and_any_other_edit_passes_through(bridged, tmp_path,
                                                                                  monkeypatch):
    """The pilot is outside any git repo, so core's LSP never reports on it: the plugin does."""
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    pilot = str(service.pilot_file())
    wrote = json.dumps({"bytes_written": 3, "files_modified": [pilot]})
    for tool in ("write_file", "patch"):
        seen = json.loads(spacemolt._check_after_edit(tool_name=tool, args={}, result=wrote))
        assert seen["files_modified"] == [pilot] and seen["lsp_diagnostics"].endswith(": ok")
    # Elsewhere, or a write that failed, the result stands and no bridge is asked.
    service.close_bridge()
    elsewhere = json.dumps({"bytes_written": 3, "files_modified": [str(tmp_path / "notes.ts")]})
    failed = json.dumps({"error": "denied", "files_modified": [pilot]})
    assert spacemolt._check_after_edit(tool_name="write_file", args={}, result=elsewhere) is None
    assert spacemolt._check_after_edit(tool_name="patch", args={}, result=failed) is None
    assert spacemolt._check_after_edit(tool_name="terminal", args={}, result=wrote) is None
    assert service._bridge is None


def test_a_run_sent_while_one_is_in_flight_is_refused_without_touching_the_script(tmp_path, monkeypatch):
    """The pilot's own work is not overwritten by the recovery script it sends after a timeout.

    A long run outlives the harness's per-tool deadline, so the pilot never sees its report and
    sends a fresh `spacemolt_run`. That write used to land on pilot/index.ts before the bridge
    refused it, destroying the script that was still running.
    """
    stub = tmp_path / "busy_bridge.py"
    stub.write_text(BUSY_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    try:
        flying = "// the script that is running\nexport default async function main() { return hunt(); }\n"
        script = service.pilot_file()
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_bytes(flying.encode())
        before = script.read_bytes()

        answer = json.loads(spacemolt._run({"source": "export default async function main() {}\n"}))

        assert answer["accepted"] is False
        assert "under way" in answer["reason"]
        assert script.read_bytes() == before, "the running script was overwritten"
    finally:
        service.close_bridge()


def test_register_publishes_every_tool_in_the_spacemolt_toolset(monkeypatch):
    # register() hands the plugin's tool dispatcher to juncture, which holds it on the module.
    # monkeypatch puts the real one back afterwards, so no later test writes cron jobs through
    # this stub.
    monkeypatch.setattr("spacemolt.juncture._dispatch_tool", None)
    tools, sections, unloads, skills = {}, {}, [], []

    class RecordingContext:
        def register_skill(self, name, path, **kwargs):
            skills.append(name)

        def dispatch_tool(self, tool_name, args, **kwargs):
            """The seam the juncture job is written through. Answering `list` with nothing is
            enough for register(): wake_on_load swallows what a create then fails on."""
            return json.dumps({"success": True, "count": 0, "jobs": []})

        def register_tool(self, name, toolset, schema, handler, **kwargs):
            tools[name] = (toolset, schema, handler, kwargs)

        def register_system_prompt_section(self, id, content, **kwargs):
            sections[id] = (content, kwargs)

        def on_unload(self, callback):
            unloads.append(callback)

        def register_hook(self, name, callback):
            pass

    spacemolt.register(RecordingContext())
    # One prefix, no strays, and each tool in exactly one of the three toolsets: the job tools
    # a fire flies with, what any client may call, and the window's own read and direction.
    assert tools and all(name.startswith("spacemolt_") for name in tools)
    by_toolset: dict[str, set[str]] = {}
    for name, (toolset, *_rest) in tools.items():
        by_toolset.setdefault(toolset, set()).add(name)
    assert by_toolset == {
        "spacemolt": {"spacemolt_run", "spacemolt_answer", "spacemolt_chat", "spacemolt_check", "spacemolt_reflect"},
        "spacemolt_observe": {"spacemolt_stop"},
        "spacemolt_observer": {"spacemolt_direct", "spacemolt_status"},
    }
    # The pilot plays by running its file; the observer sends a sentence or stops a run.
    assert tools["spacemolt_run"][1]["parameters"]["required"] == []
    assert "pilot/index.ts" in tools["spacemolt_run"][1]["description"]
    assert "source" in tools["spacemolt_check"][1]["parameters"]["properties"]
    # Direction is one tool: objective, permissions and the sentence, any one of them enough.
    assert tools["spacemolt_direct"][1]["parameters"]["required"] == []
    assert (tools["spacemolt_direct"][1]["parameters"]["properties"]["instruction"]["maxLength"]
            == spacemolt._INSTRUCTION_LIMIT)
    # The standing permissions are the two bounds on spending and owing; whether to hunt is the
    # objective carried in, like any other work.
    assert set(tools["spacemolt_direct"][1]["parameters"]["properties"]["permissions"]
               ["properties"]) == {"credit_reserve", "max_liability"}
    # Flying, docking, mining and every read are calls inside the pilot's file, not tools.
    assert not {"spacemolt_travel", "spacemolt_dock", "spacemolt_gather", "spacemolt_where",
                "spacemolt_storage", "spacemolt_scripts"} & set(tools)
    # The READMEs of the play library are the skills, registered under the plugin's namespace by
    # their bare names — `spacemolt:mining`, never `spacemolt:spacemolt-mining`.
    assert "play" in skills and "mining" in skills
    assert not any(name.startswith("spacemolt") for name in skills), skills
    # Credentials gate the tools out of the schema, and unload must release the bridge.
    assert all(kwargs["requires_env"] == ["SPACEMOLT_CREDENTIALS_FILE"] for *_, kwargs in tools.values())
    assert sections and unloads == [service.close_bridge]
    # The flight section goes to the cron fire alone, and either rendering fits its limit (core
    # skips an oversized section whole).
    flight, flight_kwargs = sections["spacemolt.flight"]
    assert flight({"platform": "cron"}) == spacemolt._FLIGHT_PROMPT
    assert flight({"platform": "discord"}) != spacemolt._FLIGHT_PROMPT
    assert all(len(flight({"platform": p})) <= flight_kwargs["max_chars"] for p in ("cron", "discord"))


def test_no_tool_tells_the_pilot_to_call_a_tool_that_is_not_registered():
    """A description naming a tool that does not exist is a dead end the pilot cannot see around.

    `spacemolt_reflect` told the pilot that "spacemolt_rest at a base is what makes it callable"
    for a while after `spacemolt_rest` was removed — so a pilot that wanted to open a new shift
    was sent looking for a tool it did not hold. That is the same unattended deadlock the rest
    move was careful to avoid, reintroduced as prose: reflection is the only way to change stance,
    and nothing recovers a pilot that cannot reach it. Every mention has to name something real.
    """
    from spacemolt import TOOL_DEFINITIONS

    registered = {row["name"] for row in TOOL_DEFINITIONS}
    assert registered, "no tools registered"
    named = re.compile(r"spacemolt_[a-z_]+")
    for row in TOOL_DEFINITIONS:
        name = row["name"]
        text = json.dumps({"description": row.get("description", ""), "schema": row.get("schema")})
        for mention in sorted(set(named.findall(text))):
            # A tool may name itself, and a toolset is not a tool.
            if mention in {name, "spacemolt_observer"}:
                continue
            assert mention in registered, (
                f"{name} names {mention}, which is not a registered tool")


def test_the_observers_sentence_is_bounded_and_lands_on_the_pilot(monkeypatch):
    """One sentence of direction, and the pilot reads it at its next juncture. The cap is the
    scope of the instruction, and setting it leaves the objective alone."""

    sent: list[dict] = []

    def fake_call(action, params=None, on_line=None):
        assert action == "pilot", action
        sent.append(params["set"])
        return {"record": {"objective": "fill the hold", **params["set"]}}

    monkeypatch.setattr(spacemolt, "call", fake_call)
    assert "Nothing to set" in spacemolt._direct({}), "a direction with nothing in it sets nothing"
    refused = spacemolt._direct({"instruction": "x" * 81})
    assert "81" in refused and "fewer words" in refused
    assert sent == [], "nothing over the cap reaches the pilot"

    sentence = "y" * 80
    answer = spacemolt._direct({"instruction": sentence})
    patch, = sent
    assert patch["instruction"]["text"] == sentence
    assert patch["instruction"]["at"].endswith("Z"), "when it was said, so staleness is readable"
    assert "objective" not in patch, "a sentence is not an objective"
    assert "next time it takes stock" in answer


def test_status_answers_the_objective_the_run_and_what_happened_in_one_read(bridged, tmp_path,
                                                                           monkeypatch):
    """The window asked "what is our objective?" and got a mining snapshot, because the record
    was in no read it had. One tool now carries all three."""
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))

    service.pilot_path().parent.mkdir(parents=True, exist_ok=True)
    service.pilot_path().write_text(json.dumps({"name": "kvothe", "objective": "buy a hauler",
                                                "stance": "Prospector", "permissions": {"credit_reserve": 500}}))
    answer = json.loads(spacemolt._status({}))
    assert set(answer) == {"pilot", "run", "journal"}
    assert answer["pilot"]["objective"] == "buy a hauler"
    assert answer["pilot"]["permissions"] == {"credit_reserve": 500}
    assert answer["run"]["running"] is False
    assert answer["journal"] == [], "no journal file yet is an empty account, not an error"


def test_a_stance_fire_carries_the_root_readme_and_its_career_readme():
    """The skills a fire lists are the play README and the stance's folder README, under the
    plugin's own namespace — which is how a plugin skill is looked up."""
    from spacemolt import juncture, skills_register

    named = skills_register.readme_skills(service.HERE)
    assert "play" in named and named["play"].name == "README.md"
    for stance, folder in juncture.STANCE_FOLDER.items():
        fields = juncture.job_fields({"stance": stance})
        assert fields["skills"] == ["spacemolt:play", f"spacemolt:{folder}"]
        assert folder in named, stance
    # No stance carries the base skill alone.
    assert juncture.job_fields({})["skills"] == ["spacemolt:play"]


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
        assert service.call("status") == {"webhook": "https://example.invalid/hook"}
        service.close_bridge()
        monkeypatch.delenv("SPACEMOLT_JOURNAL_WEBHOOK")
        assert service.call("status") == {"webhook": ""}
    finally:
        service.close_bridge()


@pytest.fixture
def reloadable(bridged, tmp_path, monkeypatch):
    """A bridge whose TypeScript is a temp ``src/`` tree this test can edit."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "bridge.ts").write_text("// v1\n")
    monkeypatch.setattr(service, "HERE", tmp_path)
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    return src


def test_an_unchanged_source_tree_keeps_the_bridge_it_has(reloadable):
    """A juncture that finds the same code on disk reuses the connection it has: a recycle
    costs a re-authenticate, so it happens because the code moved, not because time passed."""
    service.call("status")
    first = service._bridge
    service.call("status")
    assert service._bridge is first
    # And what it booted on is written down, so which code is running is a read, not a guess.
    assert first.sources == service.source_fingerprint()
    log = (service.runtime_dir() / service.BRIDGE_STDERR).read_text()
    assert f"[bridge] booting on {first.sources}" in log


def test_a_changed_source_tree_recycles_the_bridge(reloadable):
    """The reason the cron pilot never ran new code: Node reads the sources once, and the
    bridge outlived every commit. A juncture now boots a fresh one when the sources moved."""
    service.call("status")
    old = service._bridge
    (reloadable / "job.ts").write_text("// added since it booted\n")

    service.call("status")

    new = service._bridge
    assert new is not old and new.process.pid != old.process.pid
    assert new.sources != old.sources
    # The stale one went first: it holds the controller lock and the journal a new one wants.
    assert old.process.poll() is not None, "a stale bridge was left holding the game lock"


def test_a_bridge_boot_rotates_the_stderr_log_it_opens(reloadable):
    """Each boot starts a fresh ``bridge.stderr.log``; the last one is kept beside it, stamped."""
    service.call("status")
    first = service._bridge.sources
    (reloadable / "job.ts").write_text("// added since it booted\n")
    service.call("status")
    runtime = service.runtime_dir()
    rotated = sorted(runtime.glob("bridge.stderr.*.log"))
    assert len(rotated) == 1
    assert re.fullmatch(r"bridge\.stderr\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ(_\d+)?\.log", rotated[0].name)
    assert f"[bridge] booting on {first}" in rotated[0].read_text()
    assert f"[bridge] booting on {first}" not in (runtime / service.BRIDGE_STDERR).read_text()


def test_a_source_change_during_a_run_defers_the_reload(reloadable):
    """A juncture that arrives mid-run carries on with the bridge it has. Tearing down a
    working run to pick up an edit costs more than the wait, and the journal says so."""
    from spacemolt import juncture

    service.call("status")
    live = service._bridge
    runtime = service.runtime_dir()
    (runtime / "run.json").write_text(json.dumps({"script": "hunt", "started": "t0", "ended": False}))
    (runtime / "controller-1.lock").write_text(json.dumps({"pid": os.getpid()}))
    (reloadable / "job.ts").write_text("// added while the run is out at the belt\n")

    service.call("status")

    assert service._bridge is live and live.process.poll() is None
    entries = [json.loads(line) for line
               in (runtime / juncture.JOURNAL_FILE).read_text().splitlines() if line.strip()]
    deferred = [entry for entry in entries if "reload deferred" in entry.get("message", "")]
    assert len(deferred) == 1, "the deferral is recorded, once, not on every read during the run"
    assert deferred[0]["booted_on"] == live.sources
