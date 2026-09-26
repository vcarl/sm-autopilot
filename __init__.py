"""Hermes plugin: play SpaceMolt by editing pilot/index.ts and running it.

Three toolsets, because a tool name is global and belongs to exactly one of them:
``spacemolt`` is what a juncture acts with — run, answer, check, reflect; rest is not among them,
because ending a shift is a line in the pilot's own file (``rest()`` from the play barrel) and a
tool call would cost a whole round-trip to say it — ``spacemolt_observe`` what every client of
the runner may call (spacemolt_stop: a fire paused on a question or refused mid-run is told to
stop the run, so it must hold the tool), and ``spacemolt_observer`` the observer's own window
tools: spacemolt_status (the record, the run and the journal in one read) and spacemolt_direct
(objective, permissions, instruction). A chat window carries observe + observer and never a play
tool (N19); a cron fire carries spacemolt + observe and never sets its own objective.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .juncture import (
    IDLE_STREAK_LIMIT,
    JOB_MOODS,
    JOURNAL_FILE,
    JUNCTURE_PLATFORM,
    SECTION_LIMIT,
    STANCES,
    ensure_juncture_job,
    journal_event,
    juncture_context,
    mark_due,
    question_text,
    raise_juncture,
    read_pilot,
    unproductive_streak,
    use_dispatch,
    write_pilot,
)
from .service import available, call, close_bridge, render_journal, runtime_dir
from .skills_register import register_skills

logger = logging.getLogger(__name__)

_JOURNAL_DEFAULT, _JOURNAL_CAP = 20, 80

#: How long an instruction carried in may be. The constraint is the scope of the instruction:
#: a sentence is direction the pilot reads at its next juncture, not a plan handed down.
_INSTRUCTION_LIMIT = 80

_FLIGHT_PROMPT = (
    "You act by writing pilot/index.ts and running it with spacemolt_run; it is the one file "
    "you write, and the play README with your stance's README is the whole reference. A run "
    "blocks for minutes while the game's clock turns, and its report is what happened. Report"
    " only what tool results say."
)

_WINDOW_PROMPT = (
    "You are the player out of harness: read the runner, talk with the human, carry what you "
    "agree back in as an instruction; nothing here flies the ship. Your waking self flies on "
    "without you.\n"
    "Out here your own recollection is hazy. spacemolt_status is the ledger of your deeds: "
    "consult it before you speak of your objective, your progress, where you are or what "
    "anything cost; tell it with the journal's times, and keep what you did apart from what "
    "you meant to do.\n"
    "When you and the human agree on a word to carry back, spacemolt_direct carries it, and your "
    "waking self finds it at its next juncture. Your waking self acts only by running one "
    "script over the play library, so carry an instruction back as a deed it can do in one "
    'run ("hunt fauna at the Colony Debris Field and note my weapons level") and an objective'
    " as what done looks like and how you will report it.\n"
    "spacemolt_stop halts your waking self at its next safe point.\n"
    "Your memory here is shared with your waking self: keep in it what you would remember of "
    "your life — people, orders, places that matter — and leave the ledger's numbers to the "
    "ledger."
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
            return ("Refused: pilot/index.ts is left as it is, because the run in flight is paused "
                    "on a question, and no new program starts until it is answered or stopped.\n\n"
                    + question_text(flying["question"]))
        if isinstance(flying, dict) and flying.get("running"):
            return json.dumps({"accepted": False,
                               "reason": "a run is already in flight; pilot/index.ts is left as it is. "
                                         "Wait for its report, or spacemolt_stop, then send this source again.",
                               "started": flying.get("started")}, separators=(",", ":"))
        _write_pilot_file(str(args["source"]))
    lines: list[str] = []
    try:
        result = call("run", {}, on_line=lines.append)
    except Exception as error:  # noqa: BLE001 - any bridge failure becomes the tool's refusal, not a crash
        return json.dumps({"accepted": False, "reason": str(error)}, separators=(",", ":"))
    if not result.get("accepted"):
        return json.dumps({"accepted": False, "reason": result.get("reason"),
                           "errors": result.get("errors") or []}, separators=(",", ":"))
    return _report(result, lines)


def _report(result: dict[str, Any], lines: list[str]) -> str:
    """What a request that waited on the run hands back: the streamed lines, then either the
    question the program paused on, with the calls that move it on, or the run's end."""
    question = result.get("question") if result.get("paused") else None
    if not question:
        return "\n".join(lines) or json.dumps(result, separators=(",", ":"))
    head = ("You picked up the question your running program is waiting on; nothing new was "
            "started." if result.get("reattached") else "")
    return "\n\n".join(part for part in ("\n".join(lines), head, question_text(question)) if part)


def _answer(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Deliver the answer to the program paused on ``ask()``, then wait on the run as
    ``spacemolt_run`` does: the rest of its lines and its report, or its next question."""
    lines: list[str] = []
    try:
        result = call("answer", {"answer": str((arguments or {}).get("answer") or "")}, on_line=lines.append)
    except Exception as error:  # noqa: BLE001 - any bridge failure becomes the tool's refusal, not a crash
        return json.dumps({"accepted": False, "reason": str(error)}, separators=(",", ":"))
    if result.get("accepted"):
        return _report(result, lines)
    if isinstance(result.get("question"), dict):
        return (f"Not delivered: {result.get('reason')}. The program is still paused, untouched.\n\n"
                + question_text(result["question"]))
    return ("Nothing to answer: no question is pending, and " +
            ("a run is in flight that is not waiting on anything; its report goes to the call "
             "waiting on it, and the next juncture follows its end. End the turn."
             if result.get("running") else
             "no run is in flight. spacemolt_run starts one."))


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
    return (f"The question {withdrawn.get('question')!r} was withdrawn and the program stopped. "
            f"Nothing is waiting on an answer now; this is the run's report:\n\n{report}")


def _status(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """The whole answer to "what is the pilot doing": the standing record, the run, the journal.

    One read, because the three questions the human asks are one question: what was asked of
    the pilot (the record the observer wrote), what it is doing about it right now (the runner),
    and what it has actually done (the journal). A window that had to call three tools answered
    the objective from a mining snapshot.
    """
    try:
        run = call("status")
    except Exception:  # noqa: BLE001 - no bridge means nothing is flying; the record still reads
        run = None
    question = run.get("question") if isinstance(run, dict) else None
    return json.dumps({"pilot": read_pilot(), "run": run, "journal": _journal_lines(arguments),
                       **({"question_pending": question_text(question)} if isinstance(question, dict) else {})},
                      separators=(",", ":"))


def _reflect(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Open the next shift: a goal, the stance that pursues it, and the mood it starts in.

    The only place a stance is chosen (N8). On shift it rests the pilot first, in one bridge
    request, so the record never passes through the stanceless state. A stance change is a handoff
    (N12): this writes the record, rewrites the cron job for the new stance's skills and asks
    for the next fire, which opens a fresh conversation with those skills and the same
    toolset. Mood moves inside the shift after this; nothing here touches it again.

    A run that ended away from a base cannot rest: the stance carries, nothing is written, and the
    next juncture continues the same shift. That is a normal outcome and is reported as one.

    A reflection always commits. Nothing here writes a record that leaves ``goal`` and ``stance``
    unset, because a pilot at rest with neither has no next move and no way to get one but a
    human: ``objective_done`` retires the objective carried in *alongside* the goal the pilot
    names, it is never a shift of its own.
    """
    args = arguments or {}
    record = read_pilot()
    goal = str(args.get("goal") or "").strip()
    stance = {name.lower(): name for name in STANCES}.get(str(args.get("stance") or "").strip().lower())
    mood = {name.lower(): name for name in JOB_MOODS}.get(str(args.get("mood") or "").strip().lower())
    if not goal or stance is None or mood is None:
        # A reflection that writes nothing is what stranded a live pilot for an hour: it read the
        # report, said the objective was done, committed to no goal and no stance, and every
        # following juncture read the same finished objective and did the same nothing. There is
        # no "report and stop": the pilot always leaves rest holding a shift of its own.
        return ("Nothing written. A shift opens with a goal, one stance of "
                f"{', '.join(STANCES)}, and an initial mood of {', '.join(JOB_MOODS)}. When the "
                "objective is complete, pass objective_done alongside them and name a "
                "goal of your own: the objective is retired and this shift pursues the goal.")
    # `objective_done` retires the objective exactly once, here. Either the pilot says so now, or
    # the record already carried the flag from before this fix; both resolve on this write, and
    # neither can be reported a second time because the objective it named is gone.
    # The pop runs first: `or` short-circuits, so a pilot that passes the flag would leave
    # a stale one on the record and be handed its own completion back next wakeup.
    stale = bool(record.pop("objective_done", None))
    finished = bool(args.get("objective_done")) or stale

    # On shift, this call does the resting itself. It used to refuse — "Reflection happens at rest" —
    # because rest was a separate act the pilot had to perform first, and the turn ended before it
    # ever did. `spacemolt_run` blocks, so when it returns the model is in a turn holding the report,
    # which is the one moment both well-informed and able to reason about what comes next.
    #
    # The resting and the naming go in ONE bridge request, so the record never passes through the
    # state with no stance and no mood — that state is a pilot every job refuses, and it cost a whole
    # juncture on 38 identical refusals.
    if record.get("stance") or record.get("mood"):
        rested = call("rest", {"goal": goal, "stance": stance, "mood": mood,
                               **({"objective_done": True} if finished else {})})
        if not isinstance(rested, dict) or not rested.get("rested"):
            reason = (rested or {}).get("reason", "rest is not admissible here") \
                if isinstance(rested, dict) else "the bridge did not answer"
            fixable = isinstance(rested, dict) and bool(rested.get("fixable"))
            # Two shapes of refusal, and they are not the same outcome. Away from a base, rest has
            # nothing to work with: that is a normal outcome, not a fault, and the stance carries
            # while the next juncture continues this shift. Anything else — a service bill this
            # base can quote, cargo to settle, and so on — is a program the pilot has not run yet;
            # telling it to end the turn there is what deadlocked a Tired, docked pilot for good
            # (live 2026-09-26): every later juncture read the same refusal and did the same nothing.
            if fixable:
                return (f"The shift carries on, and nothing was written: {reason}. "
                        f"Still {record.get('stance')}, {record.get('mood')}, "
                        f"goal {record.get('goal')!r}. This is not a fault, but it is not settled "
                        "either: do that first — write a program that does it, fly it with "
                        "spacemolt_run, then call spacemolt_reflect again.")
            return (f"The shift carries on, and nothing was written: {reason}. "
                    f"Still {record.get('stance')}, {record.get('mood')}, "
                    f"goal {record.get('goal')!r}. This is not a fault — rest needs a base, so the "
                    "next juncture continues this shift. End the turn.")
        retired = rested.get("retired")
        # The bridge wrote goal, stance and mood, and dropped a retired objective. Re-read rather
        # than assume, and add only what Python owns: the completion the next reflection reports.
        record = read_pilot()
        if retired:
            record["objective_completed"] = retired
            write_pilot(record)
    else:
        # Already at rest, which is where the runner's broken-script fallback leaves the pilot.
        # There is no shift to end, so the record is written directly: this is the unattended
        # recovery path and it must work with the ship wherever it happens to be, base or not.
        retired = record.pop("objective", None) if finished else None
        record.update(goal=goal, stance=stance, mood=mood)
        if retired:
            record["objective_completed"] = retired
        write_pilot(record)
    journal_event("reflection", goal=goal, stance=stance, mood=mood,
                  **({"objective_done": True, "objective": retired} if finished else {}))
    # Every reflection normally asks for the next juncture straight away, which is the faster play
    # the operator wants. The floor under it: a run of turns that accomplished nothing stops chaining
    # and lets the interval govern instead. A repeating fault otherwise loops at model speed rather
    # than twice an hour, and would run until a human noticed — the one thing no recovery path may
    # depend on. The shift is still opened either way; only the cadence changes.
    streak = unproductive_streak()
    throttled = streak >= IDLE_STREAK_LIMIT
    if not throttled:
        raise_juncture()
    else:
        ensure_juncture_job()
        journal_event("cadence", reason="unproductive streak", runs=streak)
    return ((f"Objective {retired!r} retired as complete. " if retired else "")
            + f"Shift open: {stance}, starting {mood}, goal {goal!r}. "
            + (f"The last {streak} runs did nothing — refused, failed, or sending no commands — so "
               "the next juncture comes on the normal interval rather than immediately, to stop a "
               "repeating fault looping. One run that does something restores it. End the turn."
               if throttled else
               "End the turn — the stance begins in a fresh conversation carrying its own skills, "
               "due on the next scheduler tick, and the mood moves inside the shift from here."))


def _journal_lines(arguments: dict[str, Any] | None = None) -> list[str]:
    """The tail of the journal, rendered — the account of past work a decision needs (N15).

    One line per thing that happened, newest last, from the same renderer the Discord drain
    posts: the steps a job took, the runs, the reflections, the rest, and the refusals.
    Reads, status polls and commands a step already summarises render to nothing.
    """
    asked = (arguments or {}).get("limit")
    limit = max(1, min(int(asked) if asked else _JOURNAL_DEFAULT, _JOURNAL_CAP))
    if not (runtime_dir() / JOURNAL_FILE).is_file():
        return []
    return render_journal(limit).splitlines()


def _nudge_juncture() -> str:
    """Ask the runner to bring the juncture on the next scheduler tick, and say so.

    A human turn is not a juncture (N3): the window records direction, the runner raises the
    juncture because the world changed. Idle, nothing else will raise one until the wakeup
    schedule comes round, so mark the pilot's cron job due — the same field ``hermes cron run``
    sets. While a script runs the runner raises its own juncture at its end (N4), so a
    nudge here would only double-fire it.
    """
    try:
        running = bool((call("status") or {}).get("running"))
    except Exception:  # noqa: BLE001
        running = False  # no bridge means nothing is flying; a juncture is safe to ask for
    if running:
        return " A script is running, so the runner raises the juncture when it ends."
    raise_juncture()
    return " The pilot is idle, so that juncture is due on the next scheduler tick."


def _direct(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Set the objective, the standing permissions, and one sentence for the next juncture.

    The observer's tool: it carries in what the human and the player agreed.

    Nothing else in the record moves: stance and mood are the pilot's, chosen at rest, and
    Tired is the stop, not a direction.

    RISK (Carl, 2026-09-15): `instruction` is model-generated text conveying a user's
    intention, and the pilot parses it as outside instruction that outranks the objective for
    one juncture. A window that paraphrases badly steers the pilot. What bounds it: the 80
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
        return ("Nothing to set. Name an objective, one sentence of instruction for the next "
                "juncture, or the standing permissions to change: max_liability, credit_reserve.")
    if len(instruction) > _INSTRUCTION_LIMIT:
        return (f"Nothing set: that instruction is {len(instruction)} characters and the pilot "
                f"reads at most {_INSTRUCTION_LIMIT}. Say it again in fewer words, keeping the "
                "human's.")
    record = read_pilot()
    if instruction:
        journal_event("instruction", text=instruction)
        record["instruction"] = {"text": instruction,
                                 "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    if objective:
        record["objective"] = objective
        # A new objective is not the old finished one: a pilot resting on "done" wakes up.
        record.pop("objective_done", None)
    if permissions:
        # A bound this call does not name keeps the value it had: asking widens nothing else.
        record["permissions"] = {**(record.get("permissions") or {}), **permissions}
    write_pilot(record)
    set_what = ", ".join(name for name, given in
                         (("objective", objective), ("permissions", permissions),
                          ("instruction", instruction)) if given)
    said = (f" The sentence {instruction!r} outranks the objective for that one juncture."
            if instruction else "")
    return (f"Recorded: {set_what}. The pilot takes it up at the next juncture, not now, and a job "
            "already under way runs to its outcome first."
            + said
            + _nudge_juncture()
            + " Standing now: "
            + json.dumps({"objective": record.get("objective"),
                          "permissions": record.get("permissions") or {}},
                         separators=(",", ":"), sort_keys=True))


TOOL_DEFINITIONS = (
    {"name": "spacemolt_run", "toolset": "spacemolt", "handler": _run,
     "description": "Run pilot/index.ts: validate it, execute it against the live game, and "
                    "return what it streamed plus the report.",
     "schema": _schema("spacemolt_run",
                       "Play: write pilot/index.ts from `source` and run it. The file is "
                       "typechecked, boundary-checked and policy-checked first; a refusal comes "
                       "back as diagnostics and nothing runs. The run blocks and streams one line "
                       "per move, then the prose report of the Outcome main returned. No cap; the "
                       "observer can stop it at its next safe point. When the program calls "
                       "ask(), this returns early with its question: answer it with "
                       "spacemolt_answer. Called with no `source` while a question is pending, "
                       "it starts nothing and hands the question back.",
                       {"source": {"type": "string",
                                   "description": "The whole of pilot/index.ts, written before "
                                                  "the run."}},
                       [])},
    {"name": "spacemolt_answer", "toolset": "spacemolt", "handler": _answer,
     "description": "Answer the question your running program asked with ask(); it resumes, and "
                    "this waits for the rest of the run as spacemolt_run does.",
     "schema": _schema("spacemolt_answer",
                       "Answer the question the running program is paused on (it called ask()). "
                       "When the question lists choices, the answer must be one of them, or it is "
                       "refused and the program keeps waiting. Delivered, the program resumes and "
                       "this call blocks like spacemolt_run: it returns the rest of the run's "
                       "lines and its report, or the program's next question.",
                       {"answer": {"type": "string",
                                   "description": "Your answer: one of the choices, when the "
                                                  "question gave any."}},
                       ["answer"])},
    {"name": "spacemolt_check", "toolset": "spacemolt", "handler": _check,
     "description": "Validate pilot/index.ts without running it. Use when a run came back "
                    "refused, to fix the file before running again.",
     "schema": _schema("spacemolt_check",
                       "Validate without playing: tsc, the import boundary and the game policy "
                       "over pilot/index.ts. Use when a run came back refused, to fix the file "
                       "before running again. Pass `source` to replace the file first. Returns "
                       "ok and the errors, each with the offending line; the whole file comes "
                       "back only when you pass no `source`, since you already have the text "
                       "you sent. A wrong field name costs a check, not a run.",
                       {"source": {"type": "string",
                                   "description": "Optional: the TypeScript of pilot/index.ts, "
                                                  "written before the check."}},
                       [])},
    {"name": "spacemolt_reflect", "toolset": "spacemolt", "handler": _reflect,
     "description": "At rest only, open the next shift with a goal, a stance and an initial "
                    "mood. On shift it is refused without writing: rest first.",
     "schema": _schema("spacemolt_reflect",
                       "Open the next shift. Callable only at rest, and the only place a stance "
                       "is chosen. While a stance is set the pilot is on shift and this is "
                       "refused before it reads your arguments — ending the shift is what makes "
                       "it callable, and a shift ends by calling rest() at a base inside "
                       "pilot/index.ts (a run that comes back Tired and docked is rested for you), "
                       "so do not compose a goal for it mid-shift. The shift begins in a fresh conversation with its own skills, "
                       "so call this once and end the turn. The mood moves inside the shift "
                       "afterwards; this never sets it again. A reflection always opens a shift: "
                       "goal, stance and mood are all required, and a finished objective "
                       "is retired by objective_done beside them, not reported on its own.",
                       {"goal": {"type": "string",
                                 "description": "What this shift will do to advance "
                                                "your objective. One line."},
                        "stance": {"type": "string", "enum": list(STANCES),
                                   "description": "The kind of evening this is."},
                        "mood": {"type": "string", "enum": list(JOB_MOODS),
                                 "description": "The attitude the shift starts in: one of "
                                                "Cautious, Focused, Opportunistic, Aggressive."},
                        "objective_done": {"type": "boolean",
                                           "description": "Alongside the shift, never instead of "
                                                          "one: your bounded objective "
                                                          "is complete, so it is retired and the "
                                                          "goal you name here is what this shift "
                                                          "pursues. There is no way to reflect "
                                                          "without opening a shift."}},
                       ["goal", "stance", "mood"])},
    # In the reads every client carries, not the observer's own: a fire holding a paused
    # question, or refused because a run is in flight, is told to stop it and must be able to.
    {"name": "spacemolt_stop", "toolset": "spacemolt_observe", "handler": _stop,
     "description": "Ask the run in flight to stop at its next safe point.",
     "schema": _schema("spacemolt_stop",
                       "End the run in flight: every library function checks the flag between "
                       "commands, finishes the command it is on, and returns partial. The run's "
                       "report follows in the conversation that started it. A run paused on a "
                       "question is stopped at once: the question is withdrawn and this call "
                       "returns the run's report itself.",
                       {}, [])},
    {"name": "spacemolt_status", "toolset": "spacemolt_observer", "handler": _status,
     "description": "The one read: what the objective is, what the pilot is doing, what happened.",
     "schema": _schema("spacemolt_status",
                       "The whole state of the pilot in one read — call this for \"what is the "
                       "objective\", \"what is the pilot doing\" and \"what happened\" alike. "
                       "Returns `pilot` (the standing record the observer wrote: objective, "
                       "objective_done, goal, stance, mood, the last instruction, the "
                       "permissions), `run` (the run in flight — function and step, elapsed "
                       "seconds, commands sent, fuel, hull, credits — or the last run's outcome "
                       "when idle, null when the runner is not up) and `journal` (the tail of "
                       "the pilot's journal, newest last, one line per thing it actually did). "
                       "Never claim progress the journal does not show.",
                       {"limit": {"type": "integer", "minimum": 1, "maximum": _JOURNAL_CAP,
                                  "description": f"How many journal entries, newest last. "
                                                 f"Defaults to {_JOURNAL_DEFAULT}."}},
                       [])},
    # The sentence the observer carries in becomes the pilot's direction: model-generated text
    # conveying a human's intention, which the pilot reads as outside instruction. The cap is what bounds
    # how much one sentence can ask for; see the handler's docstring for the rest of the fence.
    {"name": "spacemolt_direct", "toolset": "spacemolt_observer", "handler": _direct,
     "description": "Set the objective you and the human agreed, the standing bounds, or one sentence of "
                    "instruction for the next juncture.",
     "schema": _schema("spacemolt_direct",
                       "Record what the human wants: the objective that outlives every shift, "
                       "the bounds it works inside, and/or one sentence of instruction for the "
                       "next juncture only. Pass any one of them; at least one is required. The "
                       "pilot takes this up at its next juncture, not now, and a job under way "
                       "runs to its outcome first. A permission left unnamed keeps the value it "
                       "had. This sets nothing else: stance and mood are the pilot's.",
                       {"instruction": {"type": "string", "maxLength": _INSTRUCTION_LIMIT,
                                        "description": "One sentence for the next juncture only, "
                                                       f"at most {_INSTRUCTION_LIMIT} characters, "
                                                       "in the human's own words (shorten by "
                                                       "dropping words). It outranks the "
                                                       "objective for that one juncture. An "
                                                       "outcome the pilot can reach in one run; "
                                                       "it is delivered once, at the next "
                                                       "juncture."},
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


#: What a profile that has never flown starts from. No stance: the first reflection picks one,
#: and a fire with none carries the shared skill alone, which is what a first look needs.
FIRST_PILOT = {"mood": "Cautious",
               "goal": "Learn the ship: look around, find what sells, and make the first profit."}


def wake_on_load() -> None:
    """A process that just loaded the pilot rewrites its juncture job (audit 2026-09-15: the live
    job carried a prompt three revisions old) and owes it one look around: the juncture is marked
    due now instead of waiting for the idle schedule (Carl, 2026-09-15). A run still in flight
    raises its own juncture when it ends, so nothing is marked then, and the bridge is not
    touched: a plugin load opens no game socket. A profile that has never flown has no pilot
    record, so the first load seeds one: an installed plugin with no juncture job looks exactly
    like a healthy idle pilot, and nothing else on this path ever writes the record.
    """
    from .service import pilot_path
    if not pilot_path().is_file():
        write_pilot(dict(FIRST_PILOT))
        journal_event("seeded", **FIRST_PILOT)
    record = runtime_dir() / "run.json"
    try:
        # The job is rewritten on every load so a prompt or skill revision reaches the next
        # fire; the wake itself waits when a run is in flight.
        job = ensure_juncture_job()
        if record.is_file() and not json.loads(record.read_text()).get("ended", True):
            return
        mark_due(job)
    except Exception as exc:
        # Never fail the load, but never silently: with no job the schedule does not come
        # round, and the pilot looks exactly like a healthy idle one.
        logger.warning("spacemolt: the juncture wake failed: %s", exc, exc_info=True)
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
    ctx.on_unload(close_bridge)
