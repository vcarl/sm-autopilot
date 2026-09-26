"""A program paused on ``ask()``: every tool result says what the valid next call is.

The bridge's half (pause, answer, reattach, stop) is pinned in ``src/ask.test.ts``. What these pin
is what the model reads — the question, its choices and the one or two calls that move it on —
and the fallback: a turn that ends unanswered leaves the question in ``run.json``, where the
juncture gate lets the next fire through and leads its prompt with it.
"""
from __future__ import annotations

import json
import sys

import pytest
import spacemolt
from spacemolt import juncture, service
from test_spacemolt_skills import _cron

QUESTION = {"question": "Which belt?", "choices": ["north", "south"],
            "asked_at": "2026-09-26T12:03:00Z"}

# A bridge whose run is paused on QUESTION, answering as the real one does (src/bridge.ts).
PAUSED_BRIDGE = '''
import json, sys
Q = __QUESTION__
pending = True
print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    action, params, rid = request["action"], request.get("params") or {}, request["id"]
    def say(text):
        print(json.dumps({"id": rid, "event": "line", "text": text}), flush=True)
    if action == "status":
        result = {"running": True, "started": "t0", **({"question": Q} if pending else {})}
    elif action == "run":
        result = ({"accepted": True, "paused": True, "question": Q, "started": "t0", "reattached": True}
                  if pending else {"accepted": False, "reason": "a run is already in flight", "running": True})
    elif action == "answer":
        if not pending:
            result = {"accepted": False, "reason": "no question is pending", "running": False, "last": None}
        elif params.get("answer") not in Q["choices"]:
            result = {"accepted": False, "reason": repr(params.get("answer")) + " is not one of the choices",
                      "question": Q}
        else:
            pending = False
            say("answered: " + params["answer"])
            say("Done: went " + params["answer"] + ".")
            result = {"accepted": True, "status": "done", "did": "went " + params["answer"],
                      "prose": "Done: went " + params["answer"] + ".", "started": "t0", "commands": 2}
    elif action == "stop":
        pending = False
        say("question withdrawn by stop: Which belt?")
        say("Partial: the run was stopped.")
        result = {"accepted": True, "status": "partial", "did": "the run was stopped",
                  "prose": "Partial: the run was stopped.", "stopping": True, "withdrawn": Q}
    else:
        result = {}
    print(json.dumps({"id": rid, "ok": True, "result": result}), flush=True)
'''.replace("__QUESTION__", repr(QUESTION))


@pytest.fixture
def paused(tmp_path, monkeypatch):
    """A bridge paused on QUESTION, and a job store that records every rewrite of the job."""
    stub = tmp_path / "paused_bridge.py"
    stub.write_text(PAUSED_BRIDGE)
    credentials = tmp_path / "credentials.txt"
    credentials.write_text("Username: pilot\nPassword: secret\n")
    monkeypatch.setenv("SPACEMOLT_CREDENTIALS_FILE", str(credentials))
    monkeypatch.setenv("SPACEMOLT_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(service, "BRIDGE_COMMAND", [sys.executable, str(stub)])
    yield
    service.close_bridge()


def _says_the_question_and_the_next_call(text: str) -> None:
    assert "Which belt?" in text and "north | south" in text, text
    assert "spacemolt_answer" in text, "the result names the call that moves the program on"


def test_a_new_source_while_paused_is_refused_before_the_file_is_touched(paused):
    script = service.pilot_file()
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("// the program that is waiting on its question\n")

    refused = spacemolt._run({"source": "export default async function main() {}\n"})

    assert script.read_text() == "// the program that is waiting on its question\n"
    assert refused.startswith("Refused")
    _says_the_question_and_the_next_call(refused)
    assert "spacemolt_stop" in refused


def test_a_run_with_no_source_while_paused_hands_the_question_back_and_starts_nothing(paused):
    picked_up = spacemolt._run({})
    _says_the_question_and_the_next_call(picked_up)
    assert "nothing new was started" in picked_up


def test_an_answer_outside_the_choices_is_refused_with_the_question_again(paused):
    refused = spacemolt._answer({"answer": "west"})
    assert refused.startswith("Not delivered")
    assert "'west' is not one of the choices" in refused
    _says_the_question_and_the_next_call(refused)
    # The program is untouched: the right answer still lands, and the run's report comes back.
    report = spacemolt._answer({"answer": "south"})
    assert "answered: south" in report and "Done: went south." in report


def test_an_answer_with_nothing_pending_is_refused_with_the_run_state(paused):
    spacemolt._answer({"answer": "north"})
    refused = spacemolt._answer({"answer": "north"})
    assert refused.startswith("Nothing to answer: no question is pending")
    assert "no run is in flight" in refused
    assert "spacemolt_run" in refused


def test_a_stop_while_paused_withdraws_the_question_and_returns_the_report(paused):
    stopped = spacemolt._stop({})
    assert "Which belt?" in stopped and "withdrawn" in stopped
    assert "Partial: the run was stopped." in stopped
    assert "Nothing is waiting on an answer now" in stopped


def test_status_while_paused_shows_the_question_and_the_calls(paused):
    status = json.loads(spacemolt._status({}))
    assert status["run"]["question"]["question"] == "Which belt?"
    _says_the_question_and_the_next_call(status["question_pending"])


def test_every_spacemolt_tool_is_in_the_manifest():
    """plugin.yaml's provides_tools is what the host reads before it imports anything."""
    manifest = (service.HERE / "plugin.yaml").read_text()
    listed = {line.strip()[2:] for line in manifest.splitlines() if line.startswith("  - spacemolt_")}
    assert {row["name"] for row in spacemolt.TOOL_DEFINITIONS} == listed


# ── The turn ends unanswered ──────────────────────────────────────────────────


def _paused_on(question: dict | None) -> None:
    """run.json as the bridge leaves it mid-run."""
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    record = {"script": "index.ts", "started": "t0", "ended": False}
    (runtime / "run.json").write_text(json.dumps({**record, **({"question": question} if question else {})}))


def test_the_gate_wakes_a_juncture_for_a_pending_question_and_leads_its_prompt_with_it(capsys):
    _parse_wake_gate = _cron("_parse_wake_gate")
    _build_job_prompt = _cron("_build_job_prompt")
    _paused_on(QUESTION)

    assert juncture.gate_main() == 0
    said = capsys.readouterr().out
    assert said.strip() and _parse_wake_gate(said.splitlines()[-1]) is True, said
    _says_the_question_and_the_next_call(said)

    prompt = _build_job_prompt(juncture.job_fields({}), prerun_script=(True, said))
    assert "Which belt?" in prompt
    assert prompt.index("Which belt?") < prompt.index(juncture.JUNCTURE_PROMPT[:40]), \
        "the question leads; the ordinary juncture follows it"

    # The same run, answered and running on: the gate is silent again.
    _paused_on(None)
    assert juncture.gate_main() == 0
    assert capsys.readouterr().out.strip() == '{"wakeAgent": false}'


def test_a_fire_on_a_paused_run_is_given_the_question_as_its_context(monkeypatch):
    monkeypatch.setattr(service, "call", lambda action, params=None: {
        "busy": True, "running": True, "started": "t0", "question": QUESTION})
    context = juncture.juncture_context({"platform": "cron"})
    _says_the_question_and_the_next_call(context)
