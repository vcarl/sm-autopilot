"""Hermes plugin: play SpaceMolt by editing pilot/index.ts and running it.

Two toolsets, because a tool name is global and belongs to exactly one of them, and cron and a
platform name toolsets, never tools: ``spacemolt_player`` is what a juncture acts with — run (or
check), answer (or stop a paused run), query, reflect — and ``spacemolt_observer`` the human's
window: spacemolt_look (the query's own handler: the record, the run and the journal are reads a
query program makes), spacemolt_stop and spacemolt_direct (objective, permissions, instruction).
A chat window carries the observer and never a play tool (N19); a cron fire carries the player
and Hermes' ``todo``, and never sets its own objective.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .juncture import (
    IDLE_SCHEDULE,
    JUNCTURE_PLATFORM,
    SECTION_LIMIT,
    STANCES,
    _read_juncture,
    ensure_juncture_job,
    journal_event,
    juncture_context,
    last_juncture,
    question_text,
    read_pilot,
    rendered_objective,
    use_dispatch,
)
from .service import available, call, close_bridge, runtime_dir
from .skills_register import register_skills

logger = logging.getLogger(__name__)

#: How long an instruction carried in may be. The constraint is the scope of the instruction:
#: a sentence is direction the pilot reads at its next juncture, not a plan handed down.
_INSTRUCTION_LIMIT = 80

_FLIGHT_PROMPT = (
    "Your ship's flight computer flies the program you write: pilot/index.ts, launched with "
    "spacemolt_run. It is the one file you write, and the play README (with your stance's README, "
    "when you have a stance) is the whole reference. A flight lasts until the program returns, or "
    "until the computer ends it after about 25 minutes, while the game's clock turns; its report is "
    "what happened. Report only what tool results say."
)

_WINDOW_PROMPT = (
    "You are the pilot off duty: you talk with the human, and nothing here flies the ship. Your "
    "flying self flies on without you, taking stock between flights.\n"
    "Off duty your own recollection is hazy. spacemolt_look is how you see: a short program of reads "
    "whose main returns what you want to know. `pilot()` is your standing orders (objective, goal, "
    "steps, stance, instruction), `flight()` the flight under way or the last one, `shipLog(20)` "
    "your ship's log, newest last, and `account()`, `prices()` or `messages()` the game itself. "
    "Look before you speak of your objective, your progress, where you are or what anything cost; "
    "tell it with the log's times, and keep what you did apart from what you meant to do.\n"
    "When you and the human agree on a word to carry back, spacemolt_direct carries it, and your "
    "flying self finds it the next time it takes stock. Your flying self acts only by writing one "
    "program for the ship's flight computer, so carry an instruction back as a deed it can do in one "
    'flight ("hunt fauna at the Colony Debris Field and note my weapons level") and an objective'
    " as what done looks like and how you will report it.\n"
    "spacemolt_stop has the flight computer end the flight under way at its next safe point.\n"
    "Your memory here is shared with your flying self: keep in it what you would remember of "
    "your life — people, orders, places that matter — and leave the log's numbers to the log."
)


def _prompt(session_info: Mapping[str, Any] | None = None) -> str:
    """One section, two windows: a fire is flying the ship, a chat client is watching it.

    Rendered once per new session from that session's own platform, never from the process
    env: the same backend serves a cron fire and a Discord window (N2).
    """
    return _FLIGHT_PROMPT if (session_info or {}).get("platform") == JUNCTURE_PLATFORM else _WINDOW_PROMPT


def _schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties,
                           "required": required, "additionalProperties": False}}


def _write_pilot_file(source: str) -> None:
    """The pilot's own file, written where the bridge validates and runs it."""
    from .service import pilot_file
    path = pilot_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")


def _run(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Run pilot/index.ts: validate, execute, stream. Blocks until the run ends and returns
    every streamed line, ending with the prose report of the returned Outcome. A refusal
    (tsc, boundary, policy) comes back as diagnostics and nothing runs."""
    args = arguments or {}
    if args.get("check"):
        return _check(args)
    if args.get("source"):
        # Refuse BEFORE writing. A run that outlives the harness's tool deadline leaves the
        # pilot with no report, so it sends a recovery script; that write used to land on
        # pilot/index.ts and destroy the script still running, and only then was the run
        # refused as in flight. The file is the pilot's own work: the check comes first.
        try:
            flying = call("status")
        except Exception:  # noqa: BLE001 - no bridge means nothing is in flight to lose
            flying = None
        if isinstance(flying, dict) and flying.get("running") and isinstance(flying.get("question"), dict):
            return ("Refused: pilot/index.ts is left as it is, because the flight under way is paused "
                    "on a question, and no new program starts until it is answered or stopped.\n\n"
                    + question_text(flying["question"]))
        # Kept: writing now would overwrite the program that is still flying.
        if isinstance(flying, dict) and flying.get("running"):
            return json.dumps({"accepted": False,
                               "reason": "a flight is already under way; pilot/index.ts is left as it "
                                         "is and nothing new was launched.",
                               "started": flying.get("started")}, separators=(",", ":"))
        _write_pilot_file(str(args["source"]))
    lines: list[str] = []
    # The objective this fire's context named: a run started on it after the objective changed
    # is the old plan, and the report says so (the stop reaches only the run already flying).
    recorded, objective = rendered_objective()
    if not recorded:
        objective = read_pilot().get("objective")
    try:
        juncture = last_juncture()
        result = call("run", {"juncture": juncture} if juncture else {}, on_line=lines.append)
    except Exception as error:  # noqa: BLE001 - any bridge failure becomes the tool's refusal, not a crash
        return _unanswered(error, "spacemolt_run")
    if not result.get("accepted"):
        return json.dumps({"accepted": False, "reason": result.get("reason"),
                           "errors": result.get("errors") or []}, separators=(",", ":"))
    now = read_pilot().get("objective")
    if now and now != objective:
        # The context this juncture began with names the old objective; the report says what
        # the record holds now, so a reflection after it plans for the new one.
        lines.append(f"Since you last took stock, the objective became {now!r}; "
                     "the goal, steps and stance set for the old one were cleared.")
    return _report(result, lines)


def _unanswered(error: Exception, tool: str) -> str:
    """A request the flight computer never answered: the cause goes to the log, and the pilot is
    told what the world shows — nothing launched or resumed."""
    logger.warning("%s: %s", tool, error)
    return json.dumps({"accepted": False, "reason": "the flight computer did not answer; nothing "
                                                      "was launched or resumed"}, separators=(",", ":"))


def _query(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Run a read-only program from query/index.ts, beside the flight: never pilot/index.ts, so it may go
    while a flight is under way or waits on a question. Returns its lines and what main returned."""
    path = runtime_dir() / "query" / "index.ts"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str((arguments or {}).get("source") or ""), encoding="utf-8")
    try:
        juncture = last_juncture()
        result = call("query", {"juncture": juncture} if juncture else {})
    except Exception as error:  # noqa: BLE001 - any bridge failure becomes the tool's refusal, not a crash
        logger.warning("spacemolt_query: %s", error)
        return json.dumps({"ok": False, "reason": "the flight computer did not answer; nothing was read"},
                          separators=(",", ":"))
    if result.get("errors"):
        return json.dumps({"ok": False, "reason": result.get("reason"), "errors": result["errors"]},
                          separators=(",", ":"))
    tail = (f"error: {result['error']}" if result.get("error")
            else f"returned: {result.get('returned', 'nothing')}")
    return "\n".join([*(result.get("lines") or []), tail])


def _report(result: dict[str, Any], lines: list[str]) -> str:
    """What a request that waited on the run hands back: the streamed lines, then either the
    question the program paused on, with the calls that move it on, or the run's end."""
    question = result.get("question") if result.get("paused") else None
    if not question:
        return "\n".join(lines) or json.dumps(result, separators=(",", ":"))
    head = ("You picked up the question your program in flight is waiting on; nothing new was "
            "started." if result.get("reattached") else "")
    return "\n\n".join(part for part in ("\n".join(lines), head, question_text(question)) if part)


def _answer(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Deliver the answer to the program paused on ``ask()``, then wait on the run as
    ``spacemolt_run`` does: the rest of its lines and its report, or its next question. With
    ``stop``, the flight is stopped instead, as ``spacemolt_stop`` does."""
    if (arguments or {}).get("stop"):
        return _stop()
    lines: list[str] = []
    try:
        result = call("answer", {"answer": str((arguments or {}).get("answer") or "")}, on_line=lines.append)
    except Exception as error:  # noqa: BLE001 - any bridge failure becomes the tool's refusal, not a crash
        return _unanswered(error, "spacemolt_answer")
    if result.get("accepted"):
        return _report(result, lines)
    if isinstance(result.get("question"), dict):
        return (f"Not delivered: {result.get('reason')}. The flight is still paused, untouched.\n\n"
                + question_text(result["question"]))
    return ("Nothing to answer: no question is pending, and " +
            ("a flight is under way that is not waiting on anything; its report goes to the call "
             "waiting on it, and you take stock again after it ends. End the turn."
             if result.get("running") else
             "no flight is under way. spacemolt_run launches one."))


def _check(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Validate pilot/index.ts, and echo the file only to a caller that has not just sent it.

    A source passed is the caller's own text: echoing it back was three quarters of every
    result. The diagnostics carry the offending line themselves (`check` in run.ts), which is
    the part of the file the caller actually needs back.
    """
    from .service import pilot_file
    args = arguments or {}
    sent = bool(args.get("source"))
    if sent:
        _write_pilot_file(str(args["source"]))
    verdict = call("check", {})
    if not sent:
        path = pilot_file()
        verdict["source"] = path.read_text(encoding="utf-8") if path.is_file() else ""
    return json.dumps(verdict, separators=(",", ":"))


def _check_after_edit(tool_name: str = "", result: Any = None, **_: Any) -> str | None:
    """A write_file/patch that lands on the pilot's .ts carries the check's verdict back.

    The pilot lives outside any git repo, so core's post-write LSP never fires there; this is
    that feedback, keyed the same (`lsp_diagnostics`). Both tools report the absolute paths
    they wrote in `files_modified` (V4A multi-file included), and a failed edit has `error`.
    Fail open: no bridge, no verdict, the edit's own result stands.
    """
    if tool_name not in ("write_file", "patch") or not isinstance(result, str):
        return None
    try:
        edited = json.loads(result)
        pilot = (runtime_dir() / "pilot").resolve()
        if edited.get("error") or not any(
                p.endswith(".ts") and Path(p).resolve().is_relative_to(pilot)
                for p in edited.get("files_modified") or ()):
            return None
        verdict = call("check", {})
    except Exception:  # noqa: BLE001 - never break a write over its diagnostics
        return None
    edited["lsp_diagnostics"] = (
        "spacemolt check (tsc, import boundary, game policy): ok" if verdict.get("ok") else
        "spacemolt check (tsc, import boundary, game policy) failed; spacemolt_run will refuse "
        f"this pilot:\n<diagnostics file=\"{verdict.get('entry')}\">\n"
        + "\n".join(verdict.get("errors") or []) + "\n</diagnostics>")
    return json.dumps(edited, ensure_ascii=False)


#: How a todo item's status reads in the steps; pending is the bare line.
_TODO_STATUS = {"in_progress": "in progress", "completed": "done", "cancelled": "dropped"}
#: ponytail: the steps are a fact line the context never cuts, so the list kept is 20 items of 160
#: characters; the journal keeps the whole list. Raise it if a plan ever needs more.
_STEPS, _STEP_CHARS = 20, 160


def _keep_todos(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "",
                **_: Any) -> None:
    """A juncture's todo_list, kept as the pilot's steps. Hermes holds the list per session, and the
    next fire is a new session, so a write in the session the latest juncture rendered into is
    journalled raw and set as the steps through the bridge, the record's one writer. A read, a chat
    window's list and a failed write are left alone. Never changes the result; fails open."""
    if tool_name != "todo_list" or not isinstance(args, dict) or args.get("todos") is None:
        return
    try:
        rendered = _read_juncture() or {}
        listed = json.loads(result) if isinstance(result, str) else {}
        if not session_id or rendered.get("session_id") != session_id or not isinstance(listed.get("todos"), list):
            return
        todos = [item for item in listed["todos"] if isinstance(item, dict)]
        steps = [str(item.get("content") or "")[:_STEP_CHARS]
                 + (f" ({_TODO_STATUS[item['status']]})" if item.get("status") in _TODO_STATUS else "")
                 for item in todos[:_STEPS]]
        journal_event("todo", juncture_id=rendered.get("juncture_id"), session_id=session_id,
                      revision=listed.get("revision"), todos=todos)
        call("pilot", {"set": {"steps": steps or None}})
    except Exception as error:  # noqa: BLE001 - the plan is never worth the pilot's tool result
        logger.warning("spacemolt: the todo list was not kept as steps: %s", error)


def _stop(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Ask the run in flight to stop at its next safe point; it returns `partial`. A run paused
    on a question has no one waiting on it, so this call waits for the unwind and hands back
    the report itself."""
    lines: list[str] = []
    result = call("stop", {}, on_line=lines.append)
    withdrawn = result.get("withdrawn") if isinstance(result, dict) else None
    if not isinstance(withdrawn, dict):
        return json.dumps(result, separators=(",", ":"))
    report = "\n".join(lines) or str(result.get("prose") or "")
    return (f"The question {withdrawn.get('question')!r} was withdrawn and the flight stopped. "
            f"Nothing is waiting on an answer now; this is the flight's report:\n\n{report}")


def _rewrite_job() -> None:
    """Rewrite the juncture job after the record changed. The record is already written, so a
    failed cron write must not turn the answer into a traceback: it is logged and journalled,
    and the next plugin load rewrites the job."""
    try:
        ensure_juncture_job()
    except Exception as exc:
        logger.warning("spacemolt: the juncture job could not be rewritten: %s", exc, exc_info=True)
        journal_event("wake_failed", error=f"{type(exc).__name__}: {exc}")


def _reflect(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Set the goal, the stance, or retire a finished objective — any of them, none required.

    The stance is which career README the next juncture carries: this writes it through the
    bridge (the record's one writer) and rewrites the cron job, so the next fire loads it. Nothing
    here depends on what the pilot is doing; a missing stance is a pilot with the base skill only.
    """
    args = arguments or {}
    goal = str(args.get("goal") or "").strip()
    asked = str(args.get("stance") or "").strip()
    stance = {name.lower(): name for name in STANCES}.get(asked.lower())
    done = bool(args.get("objective_done"))
    if asked and stance is None:
        # Validation, not a gate: a stance with no career README would load nothing.
        return f"Nothing written: {asked!r} is not a stance. The stances: {', '.join(STANCES)}."
    steps = args.get("steps")
    if steps is not None and not (isinstance(steps, list) and all(isinstance(step, str) for step in steps)):
        # Shape, not content: the bridge stores a list of strings.
        return "Nothing written: steps is a list of short strings."
    steps = [step.strip() for step in steps if step.strip()] if steps is not None else None
    if not (goal or stance or done or steps is not None):
        return "Nothing to write: pass a goal, steps, a stance, or objective_done."
    record = read_pilot()
    patch: dict[str, Any] = {**({"goal": goal} if goal else {}), **({"stance": stance} if stance else {})}
    if steps is not None:
        # The whole list each time; an empty one clears it.
        patch["steps"] = steps or None
    retired = record.get("objective") if done or record.get("objective_done") else None
    if done or record.get("objective_done"):
        patch.update(objective=None, objective_done=None,
                     **({"objective_completed": retired} if retired else {}))
    call("pilot", {"set": patch})
    journal_event("reflection", **({"goal": goal} if goal else {}), **({"steps": steps} if steps is not None else {}),
                  **({"stance": stance} if stance else {}),
                  **({"objective_done": True, "objective": retired} if done else {}))
    _rewrite_job()
    said = [f"goal {goal!r}" if goal else "",
            (f"{len(steps)} step(s)" if steps else "steps cleared") if steps is not None else "",
            f"stance {stance}" if stance else "",
            f"objective {retired!r} retired" if retired else ("objective retired" if done else "")]
    return ("Recorded: " + ", ".join(bit for bit in said if bit) + "."
            + (f" From your next turn you carry the {stance} README." if stance else ""))


def _direct(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Set the objective, the standing permissions, and one sentence for the next juncture.

    The observer's tool: it carries in what the human and the player agreed.

    A new objective (different text) clears the goal, its steps and the stance, which were the
    plan for the old one — the bridge's pilot request does that — rewrites the juncture job so the next fire
    carries no stale career skill, and stops a run in flight at its next safe point, so the
    next juncture plans under the new objective. The mood is derived from the ship.

    RISK (2026-09-15): `instruction` is model-generated text conveying a user's
    intention, and the pilot parses it as outside instruction that outranks the objective until
    its next run starts. A window that paraphrases badly steers the pilot. What bounds it: the 80
    characters cap how much a sentence can ask for; the lint bounds what any script it leads
    to may reach; the rules check between jobs, the credit reserve and the wall-clock cap
    bound what a run can do. Pass the human's words as they were said, shortened by
    dropping words.
    """
    args = arguments or {}
    objective = str(args.get("objective") or "").strip()
    permissions = args.get("permissions") or {}
    instruction = str(args.get("instruction") or "").strip()
    if not objective and not permissions and not instruction:
        return ("Nothing to set. Name an objective, one sentence of instruction for the pilot's "
                "next turn, or the standing permissions to change: max_liability, credit_reserve.")
    if len(instruction) > _INSTRUCTION_LIMIT:
        return (f"Nothing set: that instruction is {len(instruction)} characters and the pilot "
                f"reads at most {_INSTRUCTION_LIMIT}. Say it again in fewer words, keeping the "
                "human's.")
    patch: dict[str, Any] = {}
    new_objective = bool(objective) and objective != read_pilot().get("objective")
    if instruction:
        journal_event("instruction", text=instruction)
        patch["instruction"] = {"text": instruction,
                                "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    if objective:
        # A new objective is not the old finished one.
        patch.update(objective=objective, objective_done=None)
    if permissions:
        # A bound this call does not name keeps the value it had: asking widens nothing else.
        patch["permissions"] = {**(read_pilot().get("permissions") or {}), **permissions}
    written = call("pilot", {"set": patch})
    record = written["record"]
    # The bridge keeps every field that decodes and names each it left as it was.
    dropped = written.get("dropped") or {}
    stopped = False
    if new_objective:
        _rewrite_job()
        # The same stop spacemolt_stop sends: the program ends at its next checkpoint, never
        # mid-command, and a question it is paused on is withdrawn. The reason rides in the
        # request's params, which the request journal line keeps with the run's id.
        try:
            stopped = bool(call("stop", {"reason": "objective"}).get("stopping"))
        except Exception as error:  # noqa: BLE001 - the record is written; a run left flying ends on its own
            logger.warning("spacemolt: stop on a new objective failed: %s", error)
    set_what = ", ".join(name for name, given in
                         (("objective", objective), ("permissions", permissions),
                          ("instruction", instruction)) if given)
    said = (f" The sentence {instruction!r} outranks the objective for that one turn."
            if instruction else "")
    after = ("the flight under way was asked to stop at its next safe point" if stopped
             else "a flight already under way flies on to its outcome first")
    return (f"Recorded: {set_what}."
            + (" Any goal, steps and stance set for the old one were cleared." if new_objective else "")
            + f" The pilot takes it up the next time it takes stock — within {IDLE_SCHEDULE} of its "
            f"last turn ending — and {after}."
            + said
            + "".join(f" Not written: {name} ({why})." for name, why in dropped.items())
            + " Standing now: "
            + json.dumps({"objective": record.get("objective"),
                          "permissions": record.get("permissions") or {}},
                         separators=(",", ":"), sort_keys=True))


TOOL_DEFINITIONS = (
    {"name": "spacemolt_run", "toolset": "spacemolt_player", "handler": _run,
     "description": "Launch a flight: the ship's flight computer flies pilot/index.ts against the live "
                    "game, and this returns what it streamed plus the report. With `check`, it only "
                    "checks the file.",
     "schema": _schema("spacemolt_run",
                       "Play: write pilot/index.ts from `source` and launch it. The flight computer "
                       "checks the file first (typecheck, import boundary, game policy); a refusal "
                       "comes back as diagnostics and nothing flies. The flight blocks and streams "
                       "one line per move, then the report of the Outcome main returned. A flight "
                       "lasts until the program returns, or until the computer ends it after about "
                       "25 minutes: asked to stop at 24, cut off two minutes later. When the program "
                       "calls ask(), the flight computer pauses the flight and this returns early "
                       "with its question: answer it with spacemolt_answer. Called with no `source` "
                       "while a question is pending, it launches nothing and hands the question back.",
                       {"source": {"type": "string",
                                   "description": "The whole of pilot/index.ts, written before "
                                                  "the flight (or the check)."},
                        "check": {"type": "boolean",
                                  "description": "Check only, nothing flies: the typecheck, the import "
                                                 "boundary and the game policy over pilot/index.ts. "
                                                 "Returns ok and the errors, each with its offending "
                                                 "line; the whole file comes back only when you pass "
                                                 "no `source`. A wrong field name costs a check, not "
                                                 "a flight."}},
                       [])},
    {"name": "spacemolt_query", "toolset": "spacemolt_player", "handler": _query,
     "description": "Look before you act: send a short program that only reads the game, and get "
                    "back what it returned within seconds.",
     "schema": _schema("spacemolt_query",
                       "Look around before you act: a short program over the play library that "
                       "only reads (prices, books, missions, the map, storage, your freighters, "
                       "messages()) and returns what you want to know. It is written to "
                       "query/index.ts, never pilot/index.ts, so it goes while a flight is under way "
                       "and while it waits on your answer. Every game command it sends must be a "
                       "read: one that changes anything (travel, dock, buy, sell, accept...) is "
                       "refused by name and not sent, and ask() is not available; chat() is the one "
                       "send the game counts as a read, so a reply can go from here. Checked like a "
                       "flight; stopped after 90 seconds. Returns its lines and what main returned: "
                       "return only the data you need.",
                       {"source": {"type": "string",
                                   "description": "The whole of query/index.ts: imports from "
                                                  "'play', and `export default async function "
                                                  "main()` returning what you want to see."}},
                       ["source"])},
    # The window's own name for the same read: one handler, one query request.
    {"name": "spacemolt_look", "toolset": "spacemolt_observer", "handler": _query,
     "description": "See what the pilot is doing and what the game shows: a short program that "
                    "only reads, answered within seconds.",
     "schema": _schema("spacemolt_look",
                       "See for yourself: a short program over the play library that only reads, "
                       "returning what you want to know. `pilot()` is the standing record (objective, "
                       "goal, steps, stance, the last instruction, the permissions); `flight()` the "
                       "flight under way (when it started, the call it is in, a question it waits on) "
                       "or the last one with its outcome; `shipLog(n)` the last n entries of the "
                       "ship's log, newest last, one line per thing the pilot actually did; and the "
                       "game's own reads (`account()`, `prices()`, `missions()`, `storage()`, "
                       "`messages()`). Nothing that changes the game is sent. Stopped after 90 "
                       "seconds. Never claim progress the log does not show.",
                       {"source": {"type": "string",
                                   "description": "The whole program: imports from 'play', and "
                                                  "`export default async function main()` returning "
                                                  "what you want to see, e.g. `return {pilot: "
                                                  "pilot(), flight: flight(), log: shipLog(20)}`."}},
                       ["source"])},
    {"name": "spacemolt_answer", "toolset": "spacemolt_player", "handler": _answer,
     "description": "Answer the question your program asked with ask(), or stop the flight instead; "
                    "answered, the flight resumes, and this waits for the rest of it as spacemolt_run does.",
     "schema": _schema("spacemolt_answer",
                       "Answer the question the flight is paused on (your program called ask(), or a "
                       "message matched its `interrupts`). When the question lists choices, the answer "
                       "must be one of them, or it is refused and the flight keeps waiting. Delivered, "
                       "the flight resumes and this call blocks like spacemolt_run: it returns the "
                       "rest of the flight's lines and its report, or the program's next question. "
                       "With `stop`, the flight ends instead: the question is withdrawn and this "
                       "returns the flight's report.",
                       {"answer": {"type": "string",
                                   "description": "Your answer: one of the choices, when the "
                                                  "question gave any."},
                        "stop": {"type": "boolean",
                                 "description": "End the flight instead of answering."}},
                       [])},
    {"name": "spacemolt_reflect", "toolset": "spacemolt_player", "handler": _reflect,
     "description": "Set the goal, the steps, the stance, or retire a finished objective. Each is optional.",
     "schema": _schema("spacemolt_reflect",
                       "Set what your next flights pursue: a goal, steps, a stance, or objective_done "
                       "(any of them; at least one). The stance chooses which career README you "
                       "carry from your next turn; with none you carry the play README alone. It "
                       "takes effect the next time you take stock, and nothing needs a stance to fly.",
                       # Live 2026-09-30 (kvothe): goals averaged ~300 characters — a log of
                       # where it had been — and subtasks ("price an upgrade") were dropped
                       # every fire. The context carries the runs and missions held now; the goal is
                       # the next step, and the checklist has its own field.
                       {"goal": {"type": "string",
                                 "description": "The next step toward your objective, in one short "
                                                "line: what the next flight does. Not a log of where "
                                                "you have been; the ship's state carries your flights "
                                                "and the missions you hold."},
                        "steps": {"type": "array", "items": {"type": "string"},
                                  "description": "Optional checklist toward the objective, a few "
                                                 "short lines (e.g. 'price an upgrade'). Pass the "
                                                 "whole list each time; [] clears it. Cleared when "
                                                 "the objective changes."},
                        "stance": {"type": "string", "enum": list(STANCES),
                                   "description": "The career you read up on from your next turn."},
                        "objective_done": {"type": "boolean",
                                           "description": "Your objective is complete: it is "
                                                          "retired. Name a goal beside it to say "
                                                          "what comes next."}},
                       [])},
    {"name": "spacemolt_stop", "toolset": "spacemolt_observer", "handler": _stop,
     "description": "Have the flight computer end the flight under way at its next safe point.",
     "schema": _schema("spacemolt_stop",
                       "End the flight under way: every library function checks between commands, "
                       "finishes the command it is on, and returns partial. The flight's report "
                       "follows in the conversation that launched it. A flight paused on a "
                       "question is stopped at once: the question is withdrawn and this call "
                       "returns the flight's report itself.",
                       {}, [])},
    # The sentence the observer carries in becomes the pilot's direction: model-generated text
    # conveying a human's intention, which the pilot reads as outside instruction. The cap is what bounds
    # how much one sentence can ask for; see the handler's docstring for the rest of the fence.
    {"name": "spacemolt_direct", "toolset": "spacemolt_observer", "handler": _direct,
     "description": "Set the objective you and the human agreed, the standing bounds, or one sentence of "
                    "instruction for the pilot's next turn.",
     "schema": _schema("spacemolt_direct",
                       "Record what the human wants: the objective that outlives every shift, "
                       "the bounds it works inside, and/or one sentence of instruction for the "
                       "pilot's next turn only. Pass any one of them; at least one is required. The "
                       "pilot takes this up the next time it takes stock, not now, and a flight "
                       "under way flies on to its outcome first. A permission left unnamed keeps the value it "
                       "had. This sets nothing else: goal, steps and stance are the pilot's.",
                       {"instruction": {"type": "string", "maxLength": _INSTRUCTION_LIMIT,
                                        "description": "One sentence for the pilot's next turn, "
                                                       f"at most {_INSTRUCTION_LIMIT} characters, "
                                                       "in the human's own words (shorten by "
                                                       "dropping words). It outranks the "
                                                       "objective until the pilot's next flight "
                                                       "launches. An outcome the pilot can reach in "
                                                       "one flight."},
                        "objective": {"type": "string",
                                      "description": "What the pilot is to accomplish. Outlives every "
                                                     "shift; bounded or open-ended."},
                        "permissions": {"type": "object", "additionalProperties": False,
                                        "description": "Standing bounds. Only the ones named change.",
                                        "properties": {
                                            "max_liability": {"type": "number",
                                                              "description": "Most the pilot may owe on one "
                                                                             "freight or passenger job."},
                                            "credit_reserve": {"type": "number",
                                                               "description": "Credits kept back for fuel "
                                                                              "and repair, never spent."}}}},
                       [])},
)


def wake_on_load() -> None:
    """A process that just loaded the plugin rewrites its juncture job (audit 2026-09-15: the live
    job carried a prompt three revisions old). The interval brings the first juncture; a record
    that does not exist yet is simply a pilot with no goal and no stance, and the bridge writes one
    when there is something to write. A plugin load opens no game socket.
    """
    try:
        ensure_juncture_job()
    except Exception as exc:
        # Never fail the load, but never silently: with no job the schedule does not come
        # round, and the pilot looks exactly like a healthy idle one.
        logger.warning("spacemolt: the juncture job could not be written: %s", exc, exc_info=True)
        journal_event("wake_failed", error=f"{type(exc).__name__}: {exc}")


def register(ctx) -> None:
    # Before wake_on_load, which writes the juncture job through the host's tool dispatcher.
    use_dispatch(ctx.dispatch_tool)
    wake_on_load()
    for definition in TOOL_DEFINITIONS:
        ctx.register_tool(**definition, check_fn=available,
                          requires_env=["SPACEMOLT_CREDENTIALS_FILE"], emoji="🚀")
    # One section, rendered from the session's own platform: a fire is told how to fly the
    # ship, a chat window how to watch it. Never from the process env — one backend serves both.
    ctx.register_system_prompt_section("spacemolt.flight", _prompt, position="after_memory", max_chars=1600)
    # The menu is delivered, not fetched (N15): core renders this once for a new session and
    # freezes the bytes into its prompt, so a juncture never spends a turn asking what it
    # already needed to know, and nothing changes under the conversation afterwards.
    ctx.register_system_prompt_section("spacemolt.juncture", juncture_context,
                                       position="after_memory", max_chars=SECTION_LIMIT)
    register_skills(ctx, Path(__file__).resolve().parent)
    ctx.register_hook("transform_tool_result", _check_after_edit)
    ctx.register_hook("transform_tool_result", _keep_todos)
    ctx.on_unload(close_bridge)
