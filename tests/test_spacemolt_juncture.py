"""A juncture: a cron fire opens a fresh conversation, reads the present, and plays.

What a fire depends on: the gate that suppresses a fire only while a run is in flight, the job
definition that carries the stance's skill through the cron toolset clamp, the context built
from live facts, the turn contract the prompt states, and the reflect tool that sets goal and
stance through the bridge. And what a reviewer depends on: every fire's decision and context in
the journal.
"""
from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import spacemolt
from spacemolt import juncture, service
from test_spacemolt_skills import _cron, _private


def _seed(record: dict) -> None:
    """A pilot record on disk, as the bridge would have written it."""
    path = service.pilot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record))


def _journal_rows(event: str) -> list[dict]:
    path = service.runtime_dir() / juncture.JOURNAL_FILE
    rows = [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []
    return [row for row in rows if row.get("event") == event]


def test_the_journal_tail_walks_back_into_rotated_journals():
    """A bridge boot renames ``gameplay.jsonl`` to ``gameplay.<stamp>.jsonl`` and starts afresh,
    so a tail read that stopped at the current file would forget every run before the restart."""
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)

    def rows(name: str, numbers: range) -> None:
        (runtime / name).write_text("".join(json.dumps({"event": "x", "n": n}) + "\n" for n in numbers))

    rows("gameplay.2026-09-27T00-00-00Z.jsonl", range(5))
    rows("gameplay.2026-09-28T00-00-00Z.jsonl", range(5, 10))
    rows(juncture.JOURNAL_FILE, range(10, 12))
    line = len(json.dumps({"event": "x", "n": 10}) + "\n")
    assert [json.loads(row)["n"] for row in juncture.journal_tail(8 * line)] == list(range(4, 12))
    assert [json.loads(row)["n"] for row in juncture.journal_tail(2 * line)] == [10, 11]
    assert len(juncture.journal_tail()) == 12
    # The gate's last run reads through it: a run before the restart is still the last one.
    (runtime / "gameplay.2026-09-28T00-00-00Z.jsonl").write_text(
        "".join(json.dumps({"event": "run", "phase": "refused"}) + "\n" for _ in range(2)))
    (runtime / juncture.JOURNAL_FILE).write_text(json.dumps({"event": "boot", "rotated_from": "x"}) + "\n")
    assert juncture._run_endings()[-1]["phase"] == "refused"


def _write_journal(rows: list[dict]) -> None:
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)
    with (runtime / juncture.JOURNAL_FILE).open("a") as journal:
        for row in rows:
            journal.write(json.dumps({"at": "2026-09-26T00:00:00.000Z", **row}) + "\n")


def test_the_gate_suppresses_a_fire_only_while_a_run_is_in_flight_and_logs_why(capsys):
    """The gate reads run.json: un-ended is a run in flight, and that is all it suppresses. No
    lock pid, no backoff — a bridge that died mid-run has its record closed at the next boot."""
    _parse_wake_gate = _cron("_parse_wake_gate")
    runtime = service.runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)

    def gate_line() -> str:
        """The last stdout line, which is the only one cron reads. An empty stdout ends the fire
        as surely as wakeAgent=false (live 2026-09-17), so it is checked for first."""
        assert juncture.gate_main() == 0
        printed = capsys.readouterr().out
        assert printed.strip(), "an empty stdout ends the fire"
        return printed.splitlines()[-1]

    _build_job_prompt = _cron("_build_job_prompt")
    idle = gate_line()
    assert _parse_wake_gate(idle) is True
    assert idle in _build_job_prompt({"prompt": juncture.JUNCTURE_PROMPT, "script": "gate"},
                                     prerun_script=(True, idle))
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": True}))
    assert gate_line() == idle

    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False}))
    line = gate_line()
    assert line == '{"wakeAgent": false}' and _parse_wake_gate(line) is False

    # Live 2026-10-05 (kvothe 06:36Z): a forced restart killed the bridge under a run, and only a fire
    # boots the next one to close it. A record older than any live run could be wakes the fire.
    now = datetime.now(timezone.utc)
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False,
                                                  "started": (now - timedelta(minutes=5)).isoformat()}))
    assert gate_line() == '{"wakeAgent": false}'
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": False,
                                                  "started": (now - timedelta(minutes=31)).isoformat()}))
    assert gate_line() == idle

    # Runs that did nothing are a fact for the log, never a reason to skip the fire.
    (runtime / "run.json").write_text(json.dumps({"script": "index.ts", "ended": True}))
    _write_journal([{"event": "run", "phase": "refused", "errors": ["tsc: x"]},
                    {"event": "run", "phase": "ended", "outcome": "failed", "commands": 0},
                    {"event": "run", "phase": "ended", "outcome": "refused", "commands": 2}])
    assert gate_line() == idle
    decisions = _journal_rows("gate")
    assert [row["wake"] for row in decisions] == [True, True, False, False, True, True]
    assert decisions[2]["reason"].startswith("a run is in flight")
    # The last run's outcome is a raw fact; no streak or verdict is drawn from it.
    assert decisions[-1]["last_run"] == "refused" and "unproductive_streak" not in decisions[-1]


def test_the_juncture_job_carries_the_stance_and_passes_the_cron_toolset_clamp():
    from cron import jobs as cron_jobs

    # A stored mood and a dropped `home` are keys an older record still carries; nothing reads them.
    _seed({"name": "kvothe", "stance": "Prospector", "mood": "Focused",
           "objective": "fill the hold", "home": "sol_base"})
    job = juncture.ensure_juncture_job()

    stored = cron_jobs.get_job(job["job_id"])
    # The wake gate, installed where cron runs it from, named relative.
    assert stored["script"] == juncture.GATE_SCRIPT
    resolved = _cron("_resolve_script_path")(stored["script"])
    assert (resolved[0] if isinstance(resolved, tuple) else resolved) is not None, "cron must accept the path"
    assert stored["skills"] == ["spacemolt:play", "spacemolt:mining"]
    # Exactly the player's tools and Hermes' todo list; the observer's are never a fire's.
    assert stored["enabled_toolsets"] == ["spacemolt_player", "todo"]

    # One cron job per pilot: a stance change rewrites it, never adds a second.
    _seed({"name": "kvothe", "stance": "Hunter"})
    again = juncture.ensure_juncture_job()
    assert again["job_id"] == job["job_id"]
    assert cron_jobs.get_job(again["job_id"])["skills"] == ["spacemolt:play", "spacemolt:combat"]
    assert len(cron_jobs.load_jobs()) == 1

    # The cron clamp and the fresh conversation, through names this Hermes may have moved.
    (_CronAgentSetup, _construct_cron_agent, _resolve_cron_disabled_toolsets,
     _resolve_cron_enabled_toolsets) = _private(
        "cron.scheduler", "_CronAgentSetup", "_construct_cron_agent",
        "_resolve_cron_disabled_toolsets", "_resolve_cron_enabled_toolsets")
    enabled = _resolve_cron_enabled_toolsets(stored, {})
    assert {"spacemolt_player", "todo"} <= set(enabled)
    assert not {"spacemolt_player", "todo"} & set(_resolve_cron_disabled_toolsets({}))

    seen: dict = {}

    class RecordingAgent:
        def __init__(self, **kwargs):
            seen.update(kwargs)

    _construct_cron_agent(RecordingAgent, stored, {}, _CronAgentSetup(model="m", runtime={}),
                          workdir=None, session_id="fire-1", session_db=None)
    assert "spacemolt_player" in seen["enabled_toolsets"]
    assert seen["skip_context_files"] is True


def test_a_rewrite_moves_a_live_job_onto_the_short_interval():
    """Cron re-anchors an interval job on completion, so the interval is the pause between
    junctures. A job created under the old 30 minutes must move when it is next rewritten."""
    from cron import jobs as cron_jobs
    _seed({"name": "kvothe"})
    job = juncture.ensure_juncture_job(schedule="30m")
    assert "30" in json.dumps(cron_jobs.get_job(job["job_id"])["schedule"])
    juncture.ensure_juncture_job()
    assert cron_jobs.get_job(job["job_id"])["schedule"]["minutes"] == 5


# The context is the bridge's (src/context.ts, pinned in src/context.test.ts). What these pin is what
# Python does with its `context` reply: the text it hands core, and the juncture line it journals.
CONTEXT = {"text": "Between flights — 2026-09-23 14:05Z. No flight under way.\nObjective: raise gunnery\n"
                   "Moves open now (offers worked out from the game, each pasteable into main(), with the facts "
                   "it rests on):\n  m1 `completeMissions()` — missions: 1 at 100% (Cull), +2,000 cr",
           "busy": False,
           "moves": [{"id": "m1", "gen": "missions", "call": "completeMissions()",
                      "facts": {"credits": 2000, "minutes": 0.5, "missions": ["Cull"]},
                      "said": "missions: 1 at 100% (Cull), +2,000 cr"}]}
BUSY = {"text": "A flight is under way — started 09-27 10:20Z, in pilot, 3 commands so far.", "busy": True, "moves": []}


def _answering(monkeypatch, reply: dict) -> list[tuple]:
    """The bridge, answering ``context`` with ``reply``; returns the requests it was sent."""
    sent: list[tuple] = []
    monkeypatch.setattr(service, "call", lambda action, params=None: sent.append((action, params)) or copy.deepcopy(reply))
    return sent


def test_each_juncture_journals_the_skills_it_carried_and_the_context_it_rendered(monkeypatch):
    """For whoever reviews a fire later: which career text the pilot had, how big, and what it
    was told — without asking the pilot."""
    _seed({"name": "kvothe", "stance": "Trader"})
    sent = _answering(monkeypatch, CONTEXT)
    context = juncture.juncture_context({"platform": "cron"})
    assert sent == [("context", None)] and context == CONTEXT["text"]
    row, = _journal_rows("juncture")
    assert row["stance"] == "Trader"
    assert [skill["name"] for skill in row["skills"]] == ["spacemolt:play", "spacemolt:trading"]
    assert all(skill["bytes"] > 1000 for skill in row["skills"]), row["skills"]
    assert row["context"] == context and row["context_chars"] == len(context)
    assert row["busy"] is False and "menu_error" not in row
    # The moves rendered, as data: joinable to the next run's calls by `call`; the words stay in the context.
    assert row["moves"] == [{"id": "m1", "gen": "missions", "call": "completeMissions()",
                             "facts": {"credits": 2000, "minutes": 0.5, "missions": ["Cull"]}}], row["moves"]
    # A chat window is never handed the context, and journals nothing.
    assert juncture.juncture_context({"platform": "discord"}) == ""
    assert len(_journal_rows("juncture")) == 1 and len(sent) == 1


def test_the_cron_prompt_names_only_the_tools_that_are_the_turn():
    named = sorted(definition["name"] for definition in spacemolt.TOOL_DEFINITIONS
                   if definition["name"] in juncture.JUNCTURE_PROMPT)
    assert named == ["spacemolt_query", "spacemolt_reflect", "spacemolt_run"], named
    # A check is run's own option, and the plan is kept with Hermes' todo list.
    assert "`check: true`" in juncture.JUNCTURE_PROMPT and "todo_list" in juncture.JUNCTURE_PROMPT
    assert juncture.job_fields({"stance": "Hunter"})["prompt"] == juncture.JUNCTURE_PROMPT
    # No shift to put down and nothing that must be done before a run.
    for gone in (r"\brest\b", r"\bshift\b", "half an hour"):
        assert not re.search(gone, juncture.JUNCTURE_PROMPT.lower()), gone


def test_loading_the_plugin_rewrites_the_job_and_writes_no_pilot():
    """No seeding and no wake mark: a profile that has never flown is a pilot with no goal and
    no stance, and the interval brings its first juncture."""
    from cron import jobs as cron_jobs
    spacemolt.wake_on_load()
    job, = cron_jobs.load_jobs()
    assert juncture.JUNCTURE_PROMPT in job["prompt"] and job.get("manual_run_at") is None
    assert job["skills"] == ["spacemolt:play"]
    assert job["next_run_at"] is not None and job["state"] == "scheduled"
    assert not service.pilot_path().exists()
    spacemolt.wake_on_load()
    assert len(cron_jobs.load_jobs()) == 1


def test_reflect_sets_goal_and_stance_through_the_bridge_whatever_the_pilot_is_doing(monkeypatch):
    """The deadlock of 2026-09-26 in reverse: reflection used to refuse or rest depending on a
    shift state. Now it writes what it is given, through the record's one writer, and rewrites
    the job so the next fire carries the stance's skill."""
    from cron import jobs as cron_jobs
    _seed({"name": "kvothe", "objective": "fill the hold"})
    sent: list[tuple[str, dict]] = []

    def fake_call(action, params=None, on_line=None):
        sent.append((action, params or {}))
        record = json.loads(service.pilot_path().read_text())
        for key, value in (params or {}).get("set", {}).items():
            if value is None:
                record.pop(key, None)
            else:
                record[key] = value
        _seed(record)
        return {"record": record}

    monkeypatch.setattr(spacemolt, "call", fake_call)
    said = spacemolt._reflect({"goal": "walk a price circuit", "stance": "scout"})
    assert sent == [("pilot", {"set": {"goal": "walk a price circuit", "stance": "Scout"}})]
    assert "Scout" in said and "Nothing" not in said
    job, = cron_jobs.load_jobs()
    assert job["skills"] == ["spacemolt:play", "spacemolt:exploration"]
    assert _journal_rows("reflection")[-1]["stance"] == "Scout"

    # A goal alone, or the objective retired alone: nothing is required beside it.
    spacemolt._reflect({"objective_done": True})
    record = juncture.read_pilot()
    assert "objective" not in record and record["objective_completed"] == "fill the hold"
    assert record["stance"] == "Scout", "retiring the objective moved the stance"

    # Values are validated, and the text says what is valid.
    sent.clear()
    bad = spacemolt._reflect({"stance": "Cowboy"})
    assert "Cowboy" in bad and "Prospector" in bad and sent == []
    assert "Nothing to write" in spacemolt._reflect({})
    assert "Nothing written" in spacemolt._reflect({"steps": "price an upgrade"}) and sent == []

    # Live 2026-09-30 (kvothe): subtasks ("price an upgrade") were dropped every fire. The
    # checklist is its own field, stored whole, and an empty list clears it.
    spacemolt._reflect({"steps": [" price an upgrade ", "", "fly the circuit_board loop"]})
    assert sent[-1] == ("pilot", {"set": {"steps": ["price an upgrade", "fly the circuit_board loop"]}})
    assert _journal_rows("reflection")[-1]["steps"] == ["price an upgrade", "fly the circuit_board loop"]
    spacemolt._reflect({"steps": []})
    assert sent[-1] == ("pilot", {"set": {"steps": None}}) and "steps" not in juncture.read_pilot()


_GATEWAY_LOAD = """
import json, sys
sys.path.insert(0, sys.argv[1])
from tools.registry import registry
assert registry.get_entry("cronjob_manage") is None, "the premise: core tools load after plugins"
from hermes_cli.plugins import discover_plugins
discover_plugins()
from cron.jobs import load_jobs
print(json.dumps(load_jobs()))
"""


def test_a_fresh_profile_loaded_as_the_gateway_loads_it_gets_its_juncture_job(tmp_path):
    """Live 2026-09-26: gateway startup calls ``discover_plugins()`` before anything imports the
    core tools, so ``cronjob_manage`` was not yet registered when ``register()`` wrote the job
    through ``ctx.dispatch_tool``. The load swallowed "Unknown tool", and a fresh install never
    had a job. In-process tests cannot see it — pytest has the tools loaded by then — so this is a
    fresh interpreter on a fresh home, the plugin installed and enabled, and nothing else."""
    import subprocess
    import sys

    from conftest import HERMES, ROOT

    home = tmp_path / "fresh"
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "spacemolt").symlink_to(ROOT, target_is_directory=True)
    (home / "config.yaml").write_text("plugins:\n  enabled:\n    - spacemolt\n  disabled: []\n")
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_TEST_ISOLATION": str(home)}
    done = subprocess.run([sys.executable, "-c", _GATEWAY_LOAD, str(HERMES)], env=env, cwd=tmp_path,
                          capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0, done.stderr[-2000:]
    jobs = json.loads(done.stdout.strip().splitlines()[-1])
    assert [job["skills"] for job in jobs] == [["spacemolt:play"]], done.stderr[-2000:]


def test_a_failed_job_write_on_load_is_written_down(monkeypatch):
    """A load that cannot write the job leaves a pilot that never flies and looks idle, so the
    failure goes to the journal and the log rather than nowhere."""
    def refuse(**args):
        raise RuntimeError("cronjob_manage list: Unknown tool: cronjob_manage")

    monkeypatch.setattr(spacemolt, "ensure_juncture_job", refuse)
    spacemolt.wake_on_load()
    events = [json.loads(line) for line in
              (service.runtime_dir() / juncture.JOURNAL_FILE).read_text().splitlines()]
    assert events[-1]["event"] == "wake_failed" and "Unknown tool" in events[-1]["error"]


def test_the_juncture_journals_its_join_keys_and_its_id_reaches_the_run_request(monkeypatch):
    """Telemetry: the juncture line carries the ids a later analysis joins on — its own, the gate
    before it, cron's job — and the run the fire starts is asked for under the same juncture id."""
    _seed({"name": "kvothe", "stance": "Trader"})
    juncture.gate_main()
    _answering(monkeypatch, CONTEXT)
    juncture.juncture_context({"platform": "cron", "session_id": "cron_abc123_20260927_101500",
                               "model": "claude-test"})
    gate, = _journal_rows("gate")
    row, = _journal_rows("juncture")
    assert re.fullmatch(r"[0-9a-f]{32}", row["juncture_id"])
    assert row["gate_id"] == gate["gate_id"] and row["job_id"] == "abc123" and row["model"] == "claude-test"
    assert row["at"].endswith("Z") and row["build_s"] >= 0 and row["skills_sha"] and row["context_sha"]
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(spacemolt, "call",
                        lambda action, params=None, on_line=None: sent.append((action, params)) or {"accepted": True})
    spacemolt._run({})
    assert sent == [("run", {"juncture": {"juncture_id": row["juncture_id"], "at": row["at"]}})]


def test_a_rerender_within_the_same_fire_keeps_its_juncture(monkeypatch):
    """Live 2026-09-28 13:37Z: Hermes' context compression re-rendered the juncture context four
    hours into a fire and minted a second juncture on the stale gate. Same session, same
    juncture: the fresh context is kept, and the re-render is its own event."""
    _seed({"name": "kvothe", "stance": "Trader"})
    juncture.gate_main()
    _answering(monkeypatch, CONTEXT)
    fire = {"platform": "cron", "session_id": "cron_abc123_20260927_101500"}
    first = juncture.juncture_context(fire)
    again = juncture.juncture_context(fire)
    assert again == first and again
    row, = _journal_rows("juncture")
    rerender, = _journal_rows("juncture_rerender")
    assert rerender["juncture_id"] == row["juncture_id"] and rerender["session_id"] == fire["session_id"]
    assert rerender["reason"] and rerender["context_sha"]
    # The juncture id is unchanged, but the recorded render time moves to this rerender: an
    # instruction the pilot only saw because of the rerender must count as seen by the next run
    # (live 2026-09-29; the bridge compares a run's `juncture_at` with the instruction, pinned in
    # src/context.test.ts).
    last = juncture.last_juncture()
    assert last["juncture_id"] == row["juncture_id"]
    assert last["at"] == rerender["at"] and last["at"] != row["at"]
    juncture.juncture_context({**fire, "session_id": "cron_abc123_20260927_111500"})
    assert len(_journal_rows("juncture")) == 2


def test_a_busy_rerender_does_not_advance_the_render_time(monkeypatch):
    """A rerender while a run is in flight renders the flight under way, which carries no
    instruction. Advancing ``at`` to that rerender anyway would let a later run judge the
    instruction as already seen, though it was never actually shown (live 2026-09-29)."""
    _seed({"name": "kvothe", "stance": "Trader", "objective": "fill the hold",
           "instruction": {"text": "stay in Sol tonight", "at": "2026-09-23T13:01:43.00Z"}})
    juncture.gate_main()
    fire = {"platform": "cron", "session_id": "cron_abc123_20260927_101500"}
    _answering(monkeypatch, CONTEXT)
    juncture.juncture_context(fire)
    first_at = juncture.last_juncture()["at"]
    _answering(monkeypatch, BUSY)
    again = juncture.juncture_context(fire)
    assert again == BUSY["text"]
    rerender, = _journal_rows("juncture_rerender")
    assert rerender["at"] != first_at and rerender["busy"] is True, "the journal still logs the rerender's own time"
    last = juncture.last_juncture()
    assert last["at"] == first_at, "but the render time on file does not advance"
    assert juncture.rendered_objective() == (True, "fill the hold")


def test_a_failed_game_read_is_journalled_with_the_context_the_bridge_rendered_without_it(monkeypatch):
    """Live 2026-10-02 (kvothe): 20 fires lost the whole juncture section to a failed menu read,
    and wrote no juncture, so their runs carried the previous juncture's id (09-30 16:32Z). The
    bridge renders the record and the journal without the game (src/context.test.ts) and names
    the failed read; the juncture is written like any other."""
    _answering(monkeypatch, {"text": "The game did not answer this time", "busy": False, "moves": [],
                             "menu_error": "ConnectionClosedError: WebSocket connection closed"})
    context = juncture.juncture_context({"platform": "cron", "session_id": "cron_abc123_20261002_104212"})
    row, = _journal_rows("juncture")
    assert row["menu_error"] == "ConnectionClosedError: WebSocket connection closed" and row["context"] == context
    assert juncture.last_juncture() == {"juncture_id": row["juncture_id"], "at": row["at"]}


def test_a_bridge_that_cannot_be_reached_still_hands_over_the_record(monkeypatch):
    """No bridge at all ("bridge failed to start", live 2026-10-02): the record needs none, so the
    fire still carries the objective and the standing instruction, and says nothing else was read."""
    _seed({"name": "kvothe", "stance": "Trader", "objective": "reach 1,000,000 cr", "goal": "work the ore route",
           "goal_at": "2026-10-02T15:10:00Z", "instruction": {"text": "scan markets for cheap materials", "at": "2026-10-02T16:34:58Z"}})

    def closed(action, params=None):
        raise RuntimeError("bridge failed to start")

    monkeypatch.setattr(service, "call", closed)
    context = juncture.juncture_context({"platform": "cron"})
    for text in ("The ship did not answer this time", "Objective: reach 1,000,000 cr",
                 "Instruction (given 10-02 16:34Z): scan markets for cheap materials",
                 "Goal (set 10-02 15:10Z): work the ore route"):
        assert text in context, (text, context)
    row, = _journal_rows("juncture")
    assert row["menu_error"] == "RuntimeError: bridge failed to start" and row["context"] == context
    # The render carried the instruction, so a run from it consumes it, as any other render.
    (service.runtime_dir() / "run.json").write_text(json.dumps(
        {"script": "index.ts", "juncture_at": row["at"], "started": row["at"], "ended": True}))
    assert "scan markets" not in juncture.juncture_context({"platform": "cron"})


#: Our plumbing, which the pilot never hears of: it lives in the world, not in the harness (10-05).
HARNESS_WORDS = re.compile(r"\b(hermes|cron|juncture|bridge|journal|telemetry|interrupted|gate|skill)",
                           re.IGNORECASE)
#: The program flies: a flight is launched, under way, ended (10-05). `spacemolt_run`, in backticks, is a name.
RUN_WORD = re.compile(r"\bruns?\b", re.IGNORECASE)


def _descriptions(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from ([value] if key == "description" and isinstance(value, str) else _descriptions(value))
    elif isinstance(node, list | tuple):
        for value in node:
            yield from _descriptions(value)


def test_the_pilot_hears_the_world_and_never_the_harness(monkeypatch, capsys):
    """The maintainer, 10-05: the cron player experiences the world it is in, not Hermes, its
    interruptions or its callback loop. Every prompt-facing text Python writes; the contexts the
    bridge renders are pinned the same way in src/context.test.ts."""
    _seed({"name": "kvothe", "objective": "x", "goal": "y",
           "instruction": {"text": "stay in Sol", "at": "2026-09-23T03:21:00Z"}})
    question = {"question": "sell now?", "choices": ["yes", "no"], "asked_at": "2026-09-23T14:00:00Z"}
    chat_pause = {"chat": {"channel": "private", "from": "Zed", "sender_id": "p1", "text": "hi"},
                  "asked_at": "2026-09-23T14:00:00Z", "question": "chat"}

    def closed(action, params=None):
        raise RuntimeError("bridge failed to start")

    monkeypatch.setattr(service, "call", closed)
    texts = [juncture.JUNCTURE_PROMPT, juncture.juncture_context({"platform": "cron"}),
             juncture.question_text(question), juncture.question_text(chat_pause),
             spacemolt._prompt({"platform": "cron"})]
    juncture.gate_main()
    texts.append(capsys.readouterr().out)
    fire = list(texts)
    texts.append(spacemolt._prompt({"platform": "discord"}))
    # A result key the observer reads (`journal`) is a name, not a word to the pilot.
    texts += [re.sub(r"`[^`]*`", "", text) for text in _descriptions(
        [{k: v for k, v in tool.items() if k != "handler"} for tool in spacemolt.TOOL_DEFINITIONS])]
    for text in texts:
        found = HARNESS_WORDS.search(text) or RUN_WORD.search(re.sub(r"`[^`]*`", "", text))
        assert not found, (found and found.group(0), text)
    # The tools and toolsets the two-toolset split removed are named nowhere a model reads, and the
    # fire's texts never send it to the window's brake: it stops a paused flight through answer.
    readmes = [path.read_text() for path in (Path(spacemolt.__file__).parent / "src" / "play").rglob("README.md")]
    gone = re.compile(r"spacemolt_(check|chat|status|observe)\b")
    for text in texts + readmes + [json.dumps(tool["schema"]) for tool in spacemolt.TOOL_DEFINITIONS]:
        assert not gone.search(text), (gone.search(text).group(0), text)
    cron_side = fire + readmes + [
        json.dumps(tool["schema"]) for tool in spacemolt.TOOL_DEFINITIONS if tool["toolset"] == "spacemolt_player"]
    assert not [text for text in cron_side if "spacemolt_stop" in text]
    assert "Instruction (given 09-23 03:21Z): stay in Sol" in texts[1], texts[1]


def test_the_play_readmes_speak_of_flights_not_runs():
    """The skills the pilot reads call a program's execution a flight (10-05); a craft's runs
    are the game's own word, and a call is re-run in code, so only "a run" as a noun is caught."""
    noun = re.compile(r"\b(a|the|this|each|every|that|your|next|last) runs?\b", re.IGNORECASE)
    for readme in (Path(spacemolt.__file__).parent / "src" / "play").rglob("README.md"):
        found = noun.search(re.sub(r"`[^`]*`", "", readme.read_text()))
        assert not found, (readme, found and found.group(0))
