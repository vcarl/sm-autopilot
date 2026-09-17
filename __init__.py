"""Hermes plugin: play SpaceMolt by editing pilot/index.ts and running it.

Three toolsets, because a tool name is global and belongs to exactly one of them:
``spacemolt`` is what a juncture acts with — run, check, rest, reflect — ``spacemolt_observe``
the reads every client of the runner may make (empty since the journal folded into status),
and ``spacemolt_operator`` the operator's own three window tools: spacemolt_status (the
record, the run and the journal in one read), spacemolt_direct (objective, permissions,
instruction) and spacemolt_stop. A chat window carries observe + operator and never a play
tool (N19); a cron fire carries spacemolt + observe and never sets its own objective.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Mapping

from pathlib import Path

from .juncture import (JOB_MOODS, JOURNAL_FILE, JUNCTURE_PLATFORM, STANCES, ensure_juncture_job,
                       journal_event, juncture_context, read_pilot, write_pilot)
from .service import available, call, close_bridge, render_journal, runtime_dir
from .skills_register import register_skills

_JOURNAL_DEFAULT, _JOURNAL_CAP = 20, 80

#: How long an operator's instruction may be. The constraint is the scope of the instruction:
#: a sentence is direction the pilot reads at its next juncture, not a plan handed down.
_INSTRUCTION_LIMIT = 80

_FLIGHT_PROMPT = (
    "SpaceMolt: you fly one live ship, and you fly it by editing one file, pilot/index.ts, "
    "and running it. The `play` library (its README is your skill) is what the file calls; "
    "`account()` inside it is the whole game.\n"
    "Report only what tool results say.\n"
    "The game's clock is real: a run blocks for minutes and streams what it does, so wait it out."
)

_WINDOW_PROMPT = (
    "SpaceMolt: you are a window on a pilot the runner flies; this conversation never owns it. "
    "spacemolt_status is the read: the objective and the standing record, whether a run is in "
    "flight and where it has got to, and the last few things the pilot actually did. Answer "
    "from it and never from memory: what you report about the objective, progress, cost and "
    "position has to be what that read says. spacemolt_direct is the operator's — it sets the "
    "objective, the standing permissions, and one sentence of instruction for the next "
    "juncture, which the pilot takes up at its next juncture rather than now, and a job "
    "already under way runs to its outcome first. spacemolt_stop ends a run at its next safe "
    "point. Nothing here starts or steers a job."
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
        _write_pilot_file(str(args["source"]))
    lines: list[str] = []
    try:
        result = call("run", {}, on_line=lines.append)
    except Exception as error:
        return json.dumps({"accepted": False, "reason": str(error)}, separators=(",", ":"))
    if not result.get("accepted"):
        return json.dumps({"accepted": False, "reason": result.get("reason"),
                           "errors": result.get("errors") or []}, separators=(",", ":"))
    return "\n".join(lines) or json.dumps(result, separators=(",", ":"))


def _check(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Validate pilot/index.ts without running it, and return the file as it stands."""
    from .service import pilot_file
    args = arguments or {}
    if args.get("source"):
        _write_pilot_file(str(args["source"]))
    verdict = call("check", {})
    path = pilot_file()
    verdict["source"] = path.read_text(encoding="utf-8") if path.is_file() else ""
    return json.dumps(verdict, separators=(",", ":"))


def _stop(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Ask the run in flight to stop at its next safe point; it returns `partial`."""
    return json.dumps(call("stop", {}), separators=(",", ":"))


def _status(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """The whole answer to "what is the pilot doing": the standing record, the run, the journal.

    One read, because the three questions an operator asks are one question: what was asked of
    the pilot (the record the operator wrote), what it is doing about it right now (the runner),
    and what it has actually done (the journal). A window that had to call three tools answered
    the objective from a mining snapshot.
    """
    try:
        run = call("status")
    except Exception:  # noqa: BLE001 - no bridge means nothing is flying; the record still reads
        run = None
    return json.dumps({"pilot": read_pilot(), "run": run, "journal": _journal_lines(arguments)},
                      separators=(",", ":"))


def _rest(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """End the shift. The runner decides whether it may, clears the record and journals it;
    this rewrites the pilot's one cron job so the next fire carries no stance skill (N18)."""
    result = call("rest")
    if result.get("rested"):
        ensure_juncture_job()
    return json.dumps(result, separators=(",", ":"))


def _reflect(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Open the next shift: a goal, the stance that pursues it, and the mood it starts in.

    The only place a stance is chosen (N8), and only at rest. A stance change is a handoff
    (N12): this writes the record, rewrites the cron job for the new stance's skills and asks
    for the next fire, which opens a fresh conversation with those skills and the same
    toolset. Mood moves inside the shift after this; nothing here touches it again.
    """
    args = arguments or {}
    record = read_pilot()
    if record.get("stance"):
        return (f"Nothing written: the pilot is on shift in the {record['stance']} stance. "
                "Reflection happens at rest — rest at home, which clears the stance, and the "
                "next juncture reflects.")
    if args.get("objective_done"):
        record["objective_done"] = True
        write_pilot(record)
        journal_event("reflection", objective_done=True, objective=record.get("objective"))
        return ("Recorded: the operator's objective is done. The pilot stays at rest and says the "
                "same at every wakeup until the operator gives it something new.")
    goal = str(args.get("goal") or "").strip()
    stance = {name.lower(): name for name in STANCES}.get(str(args.get("stance") or "").strip().lower())
    mood = {name.lower(): name for name in JOB_MOODS}.get(str(args.get("mood") or "").strip().lower())
    if not goal or stance is None or mood is None:
        return ("Nothing written. A shift opens with a goal, one stance of "
                f"{', '.join(STANCES)}, and an initial mood of {', '.join(JOB_MOODS)} — or with "
                "objective_done when the operator's objective is complete.")
    record.update(goal=goal, stance=stance, mood=mood)
    record.pop("objective_done", None)  # a new goal is the objective being pursued again
    write_pilot(record)
    journal_event("reflection", goal=goal, stance=stance, mood=mood)
    from cron.jobs import trigger_job

    trigger_job(ensure_juncture_job()["id"])
    return (f"Shift open: {stance}, starting {mood}, goal {goal!r}. End the turn — the stance "
            "begins in a fresh conversation carrying its own skills, due on the next scheduler "
            "tick, and the mood moves inside the shift from here.")


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
    from cron.jobs import trigger_job

    try:
        running = bool((call("status") or {}).get("running"))
    except Exception:
        running = False  # no bridge means nothing is flying; a juncture is safe to ask for
    if running:
        return " A script is running, so the runner raises the juncture when it ends."
    trigger_job(ensure_juncture_job()["id"])
    return " The pilot is idle, so that juncture is due on the next scheduler tick."


def _direct(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Set the objective, the standing permissions, and one sentence for the next juncture.

    Nothing else in the record moves: stance and mood are the pilot's, chosen at rest, and
    Tired is the stop, not a direction.

    RISK (Carl, 2026-09-15): `instruction` is model-generated text conveying a user's
    intention, and the pilot parses it as outside instruction that outranks the objective for
    one juncture. A window that paraphrases badly steers the pilot. What bounds it: the 80
    characters cap how much a sentence can ask for; the lint bounds what any script it leads
    to may reach; the rules check between jobs, the credit reserve and the wall-clock cap
    bound what a run can do. Pass the operator's words as they were said, shortened by
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
                "operator's.")
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
                       "Play: run pilot/index.ts. Pass `source` to replace the file first; omit "
                       "it to run the file as it stands (the example on first use). The file is "
                       "one module: `import {…} from 'play'` (or 'play/<folder>', '@spacemolt/lib' "
                       "for types, './<name>.ts' for your own helpers) and "
                       "`export default async function main()` that returns the last Outcome. It "
                       "is typechecked, boundary-checked and policy-checked first; a refusal comes "
                       "back as diagnostics. The run blocks and streams one line per move, then "
                       "the prose report of the Outcome main returned. No cap; spacemolt_stop "
                       "ends it. The play README (your skill) lists every function; `account()` "
                       "is the whole game when nothing there fits.",
                       {"source": {"type": "string",
                                   "description": "Optional: the TypeScript of pilot/index.ts, "
                                                  "written before the run."}},
                       [])},
    {"name": "spacemolt_check", "toolset": "spacemolt", "handler": _check,
     "description": "Validate pilot/index.ts without running it; returns the diagnostics and the file.",
     "schema": _schema("spacemolt_check",
                       "Validate without playing: tsc, the import boundary and the game policy "
                       "over pilot/index.ts and the './<name>.ts' files it imports. Pass `source` "
                       "to replace the file first. Returns ok, errors, and the file as it stands, "
                       "so a wrong field name costs a check, not a run.",
                       {"source": {"type": "string",
                                   "description": "Optional: the TypeScript of pilot/index.ts, "
                                                  "written before the check."}},
                       [])},
    {"name": "spacemolt_rest", "toolset": "spacemolt", "handler": _rest,
     "description": "End the shift: rest at home, which clears the stance and the mood.",
     "schema": _schema("spacemolt_rest",
                       "Put the evening down. Call this docked at home with no run in flight, on a "
                       "ship this base has brought as far up as it can; the refusal says what is "
                       "still missing. It is the one act that ends a shift: it clears the stance, "
                       "the mood and the goal, a Tired the world imposed included, and the next "
                       "juncture reflects.",
                       {}, [])},
    {"name": "spacemolt_reflect", "toolset": "spacemolt", "handler": _reflect,
     "description": "At rest, open the next shift with a goal, a stance and an initial mood.",
     "schema": _schema("spacemolt_reflect",
                       "Open the next shift. Callable only at rest, and the only place a stance "
                       "is chosen. The shift begins in a fresh conversation with its own skills, "
                       "so call this once and end the turn. The mood moves inside the shift "
                       "afterwards; this never sets it again.",
                       {"goal": {"type": "string",
                                 "description": "What this shift will do to advance the "
                                                "operator's objective. One line."},
                        "stance": {"type": "string", "enum": list(STANCES),
                                   "description": "The kind of evening this is."},
                        "mood": {"type": "string", "enum": list(JOB_MOODS),
                                 "description": "The attitude the shift starts in: one of "
                                                "Cautious, Focused, Opportunistic, Aggressive."},
                        "objective_done": {"type": "boolean",
                                           "description": "Instead of a shift: the operator's "
                                                          "bounded objective is complete. The "
                                                          "pilot stays at rest until the operator "
                                                          "gives it something new."}},
                       [])},
    {"name": "spacemolt_stop", "toolset": "spacemolt_operator", "handler": _stop,
     "description": "Ask the run in flight to stop at its next safe point.",
     "schema": _schema("spacemolt_stop",
                       "End the run in flight: every library function checks the flag between "
                       "commands, finishes the command it is on, and returns partial. The run's "
                       "report follows in the conversation that started it.",
                       {}, [])},
    {"name": "spacemolt_status", "toolset": "spacemolt_operator", "handler": _status,
     "description": "The one read: what the objective is, what the pilot is doing, what happened.",
     "schema": _schema("spacemolt_status",
                       "The whole state of the pilot in one read — call this for \"what is the "
                       "objective\", \"what is the pilot doing\" and \"what happened\" alike. "
                       "Returns `pilot` (the standing record the operator wrote: objective, "
                       "objective_done, goal, stance, mood, home, the last instruction, the "
                       "permissions), `run` (the run in flight — function and step, elapsed "
                       "seconds, commands sent, fuel, hull, credits — or the last run's outcome "
                       "when idle, null when the runner is not up) and `journal` (the tail of "
                       "the pilot's journal, newest last, one line per thing it actually did). "
                       "Never claim progress the journal does not show.",
                       {"limit": {"type": "integer", "minimum": 1, "maximum": _JOURNAL_CAP,
                                  "description": f"How many journal entries, newest last. "
                                                 f"Defaults to {_JOURNAL_DEFAULT}."}},
                       [])},
    # The operator's sentence becomes the pilot's direction: model-generated text conveying a
    # user's intention, which the pilot reads as outside instruction. The cap is what bounds
    # how much one sentence can ask for; see the handler's docstring for the rest of the fence.
    {"name": "spacemolt_direct", "toolset": "spacemolt_operator", "handler": _direct,
     "description": "Set the operator's objective, standing permissions, or one sentence of "
                    "instruction for the next juncture.",
     "schema": _schema("spacemolt_direct",
                       "Record what the operator wants: the objective that outlives every shift, "
                       "the bounds it works inside, and/or one sentence of instruction for the "
                       "next juncture only. Pass any one of them; at least one is required. The "
                       "pilot takes this up at its next juncture, not now, and a job under way "
                       "runs to its outcome first. A permission left unnamed keeps the value it "
                       "had. This sets nothing else: stance and mood are the pilot's.",
                       {"instruction": {"type": "string", "maxLength": _INSTRUCTION_LIMIT,
                                        "description": "One sentence for the next juncture only, "
                                                       f"at most {_INSTRUCTION_LIMIT} characters, "
                                                       "in the operator's own words (shorten by "
                                                       "dropping words). It outranks the "
                                                       "objective for that one juncture."},
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
    """A process that just loaded the pilot rewrites its juncture job (audit 2026-09-15: the live
    job carried a prompt three revisions old) and owes it one look around: the juncture is marked
    due now instead of waiting for the idle schedule (Carl, 2026-09-15). A run still in flight
    raises its own juncture when it ends, so nothing is marked then, and the bridge is not
    touched: a plugin load opens no game socket. Without a pilot record there is no one to wake.
    """
    from .juncture import ensure_juncture_job
    from .service import pilot_path
    if not pilot_path().is_file():
        return
    record = runtime_dir() / "run.json"
    try:
        # The job is rewritten on every load so a prompt or skill revision reaches the next
        # fire; the wake itself waits when a run is in flight.
        job = ensure_juncture_job()
        if record.is_file() and not json.loads(record.read_text()).get("ended", True):
            return
        from cron.jobs import trigger_job
        trigger_job(job["id"])
    except Exception:  # noqa: BLE001 - a wake that fails costs nothing; the schedule still comes round
        pass


def register(ctx) -> None:
    wake_on_load()
    for definition in TOOL_DEFINITIONS:
        ctx.register_tool(**definition, check_fn=available,
                          requires_env=["SPACEMOLT_CREDENTIALS_FILE"], emoji="🚀")
    # One section, rendered from the session's own platform: a fire is told how to fly the
    # ship, a chat window how to watch it. Never from the process env — one backend serves both.
    ctx.register_system_prompt_section("spacemolt.flight", _prompt, position="after_memory", max_chars=1200)
    # The menu is delivered, not fetched (N15): core renders this once for a new session and
    # freezes the bytes into its prompt, so a juncture never spends a turn asking what it
    # already needed to know, and nothing changes under the conversation afterwards.
    ctx.register_system_prompt_section("spacemolt.juncture", juncture_context,
                                       position="after_memory", max_chars=4000)
    register_skills(ctx, Path(__file__).resolve().parent)
    ctx.on_unload(close_bridge)
