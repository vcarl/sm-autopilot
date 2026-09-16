"""Hermes plugin: look around a SpaceMolt system and play it by running code.

Three toolsets, because a tool name is global and belongs to exactly one of them:
``spacemolt`` is what a juncture acts with — run a script, keep a script, rest, reflect — ``spacemolt_observe`` the reads every
client of the runner may make, and ``spacemolt_operator`` the operator's own window tools:
direction, and the script-is-running read the chat window asks for while a juncture already
has the answer in its context. A chat window carries observe + operator and never a job tool
(N19); a cron fire carries spacemolt + observe and never sets its own objective.
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
    "SpaceMolt: you fly one live ship, and you fly it by running code. A script is where "
    "the jobs, the moves between them and the rest of the game's commands are composed.\n"
    "Report only what tool results say.\n"
    "The game's clock is real: one call can take a minute or more, so wait it out."
)

_WINDOW_PROMPT = (
    "SpaceMolt: you are a window on a pilot the runner flies; this conversation never owns it. "
    "spacemolt_where reads the ship's live position, fuel and hull, spacemolt_status says "
    "whether a job is running right now, and spacemolt_journal returns the last few things the "
    "pilot actually did, and spacemolt_storage reads what it holds at a base without going "
    "there. Answer from those reads and never from memory: what you report about "
    "progress, cost and position has to be what the game and the journal say. spacemolt_direct "
    "is the operator's — it sets the objective and the standing permissions, which the pilot "
    "takes up at its next juncture rather than now, and a job already under way runs to its "
    "outcome first. Nothing here starts, steers or stops a job."
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


def _where(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    return json.dumps(call("where"), separators=(",", ":"))


def _storage(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    station_id = str((arguments or {}).get("station_id") or "")
    return json.dumps(call("storage", {"station_id": station_id} if station_id else {}), separators=(",", ":"))


def _recipes(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    args = arguments or {}
    params = {name: str(args[name]) for name in ("search", "base_id") if args.get(name)}
    return json.dumps(call("recipes", params), separators=(",", ":"))


def _quote(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    args = arguments or {}
    params: dict[str, Any] = {"recipe_id": str(args.get("recipe_id") or "")}
    if args.get("quantity"):
        params["quantity"] = args["quantity"]
    return json.dumps(call("quote", params), separators=(",", ":"))


def _run(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Start one script in the runner: one the runner has, or one the pilot just wrote.

    The script owns its own parameters, so a script that will not take these says why and
    this answers with the library — one turn to correct, rather than a guess repeated.
    """
    args = arguments or {}
    params: dict[str, Any] = {"params": args.get("params") or {}}
    for name in ("script", "source"):
        if args.get(name):
            params[name] = str(args[name])
    try:
        return json.dumps(call("run", params), separators=(",", ":"))
    except Exception as error:  # the runner refuses before anything reaches the game
        return json.dumps({"accepted": False, "reason": str(error),
                           "scripts": call("scripts", {"action": "list"})}, separators=(",", ":"))


def _scripts(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """The pilot's library: what it may run, what a script looks like, and what it keeps.

    A saved script outlives the conversation that wrote it, which is what lets the pilot
    build its own management systems on top of the jobs rather than retype them.
    """
    args = arguments or {}
    params: dict[str, Any] = {"action": str(args.get("action") or "list")}
    for name in ("name", "source", "search"):
        if args.get(name):
            params[name] = str(args[name])
    try:
        return json.dumps(call("scripts", params), separators=(",", ":"))
    except Exception as error:  # the lint refuses a script before it is ever written down
        return json.dumps({"ok": False, "reason": str(error)}, separators=(",", ":"))


def _status(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    return json.dumps(call("status"), separators=(",", ":"))


def _rest(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """End the shift. The runner decides whether it may, clears the record and journals it;
    this rewrites the pilot's one cron job so the next fire carries no stance skill (N18)."""
    result = call("rest")
    if result.get("rested"):
        ensure_juncture_job()
    return json.dumps(result, separators=(",", ":"))


def _scripts_saved_since_rest() -> list[str]:
    """The scripts the pilot saved during this rest — what its code review actually changed.

    The bridge already writes one request line per call, so the saves are on record; reading
    them back keeps the reflection line true without a second tally to fall out of step.

    ponytail: the journal is read whole and walked forward. Rest happens once an evening.
    """
    path = runtime_dir() / JOURNAL_FILE
    if not path.is_file():
        return []
    names: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("event") == "rest":
            names.clear()  # a rest opens the review; what came before belongs to the last shift
        request = entry.get("request") or {}
        params = request.get("params") or {}
        if request.get("action") == "scripts" and params.get("action") == "save" and params.get("name"):
            names.append(str(params["name"]))
    return names


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
    journal_event("reflection", goal=goal, stance=stance, mood=mood,
                  scripts_reviewed=_scripts_saved_since_rest())
    from cron.jobs import trigger_job

    trigger_job(ensure_juncture_job()["id"])
    return (f"Shift open: {stance}, starting {mood}, goal {goal!r}. End the turn — the stance "
            "begins in a fresh conversation carrying its own skills, due on the next scheduler "
            "tick, and the mood moves inside the shift from here.")


def _journal(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """The tail of the journal, rendered — the account of past work a decision needs (N15).

    One line per thing that happened, newest last, from the same renderer the Discord drain
    posts: the steps a job took, the runs, the reflections, the rest, and the refusals.
    Reads, status polls and commands a step already summarises render to nothing.
    """
    asked = (arguments or {}).get("limit")
    limit = max(1, min(int(asked) if asked else _JOURNAL_DEFAULT, _JOURNAL_CAP))
    if not (runtime_dir() / JOURNAL_FILE).is_file():
        return "The journal is empty: this pilot has done nothing yet."
    return render_journal(limit) or "Nothing in the journal's tail is worth a line."


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
    """Set the objective and the standing permissions. Nothing else in the record moves: stance
    and mood are the pilot's, chosen at rest, and Tired is the stop, not a direction."""
    args = arguments or {}
    objective = str(args.get("objective") or "").strip()
    permissions = args.get("permissions") or {}
    if not objective and not permissions:
        return ("Nothing to set. Name an objective, or the standing permissions to change: "
                "max_liability, credit_reserve.")
    record = read_pilot()
    if objective:
        record["objective"] = objective
        # A new objective is not the old finished one: a pilot resting on "done" wakes up.
        record.pop("objective_done", None)
    if permissions:
        # A bound this call does not name keeps the value it had: asking widens nothing else.
        record["permissions"] = {**(record.get("permissions") or {}), **permissions}
    write_pilot(record)
    return ("Direction recorded. The pilot takes it up at the next juncture, not now, and a job "
            "already under way runs to its outcome first."
            + _nudge_juncture()
            + " Standing now: "
            + json.dumps({"objective": record.get("objective"),
                          "permissions": record.get("permissions") or {}},
                         separators=(",", ":"), sort_keys=True))


def _dispatch(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Send the pilot one sentence of direction from the operator's window.

    RISK (Carl, 2026-09-15): this is model-generated text conveying a user's intention, and
    the pilot parses it as outside instruction that outranks the objective for one juncture.
    A window that paraphrases badly steers the pilot. What bounds it: the 80 characters cap
    how much a sentence can ask for; the lint bounds what any script it leads to may reach;
    the rules check between jobs, the credit reserve and the wall-clock cap bound what a run
    can do. Pass the operator's words as they were said, shortened by dropping words.
    """
    instruction = str((arguments or {}).get("instruction") or "").strip()
    if not instruction:
        return ("Nothing sent. Give the pilot one sentence of direction, at most "
                f"{_INSTRUCTION_LIMIT} characters, in the operator's own words.")
    if len(instruction) > _INSTRUCTION_LIMIT:
        return (f"Nothing sent: that is {len(instruction)} characters and the pilot reads at most "
                f"{_INSTRUCTION_LIMIT}. Say it again in fewer words, keeping the operator's.")
    record = read_pilot()
    journal_event("instruction", text=instruction)
    record["instruction"] = {"text": instruction,
                             "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    write_pilot(record)
    return (f"Sent: {instruction!r}. The pilot reads it at its next juncture, where it outranks "
            "the objective, and a job already under way runs to its outcome first."
            + _nudge_juncture())


TOOL_DEFINITIONS = (
    {"name": "spacemolt_where", "toolset": "spacemolt_observe", "handler": _where,
     "description": "Read the ship's live location, fuel, hull, the POIs of this system and the systems it connects to.",
     "schema": _schema("spacemolt_where",
                       "Read the ship's live location, fuel, hull, the points of interest in this system, "
                       "and connections: the systems a jump reaches from here.",
                       {}, [])},
    {"name": "spacemolt_run", "toolset": "spacemolt", "handler": _run,
     "description": "Run one script in the runner — a shipped one, one you saved, or one you "
                    "write here — and return at once.",
     "schema": _schema("spacemolt_run",
                       "Start the option you chose. The script runs on in the runner after this "
                       "conversation ends, so this returns immediately. After this call, say what "
                       "you started and end the turn. The runner raises the next juncture when the "
                       "script ends, and runs one script at a time. Name either script or source. "
                       "Scripts you can name: gather, gather-until, stock-up, stow, withdraw, craft, "
                       "hunt, plus any you saved; spacemolt_scripts lists them with their params.\n"
                       "A script you write is one module:\n"
                       "- it imports from '../jobs/index.ts' alone; inside a script you may call the "
                       "jobs gather, hunt, stow, withdraw, craft, the helpers travel, dock, where, "
                       "storage, service, journal, and the scripts gatherUntil and stockUp;\n"
                       "- `export const params` is the JSON schema of what it takes, checked "
                       "before it runs;\n"
                       "- `export default async (ctx, params)` returns a JobOutcome: "
                       "{job, outcome: done | blocked | failed, reason, result};\n"
                       "- every job is named for an end state and skips what already holds, so "
                       "running one twice is safe.\n"
                       "For anything no job does — buying, selling, fitting, commissioning a "
                       "hull, taking a contract — a script calls "
                       "`command(ctx, 'tool/action', params)`, which is the whole game; "
                       "`spacemolt_scripts commands` shows the real signatures.",
                       {"script": {"type": "string",
                                   "description": "A script the runner ships or you saved."},
                        "source": {"type": "string",
                                   "description": "Instead of script: the TypeScript of a script "
                                                  "you wrote for this run."},
                        "params": {"type": "object",
                                   "description": "What that script's own params schema asks for."}},
                       ["params"])},
    {"name": "spacemolt_scripts", "toolset": "spacemolt", "handler": _scripts,
     "description": "The script library: list what can be run, read one, or save one you wrote.",
     "schema": _schema("spacemolt_scripts",
                       "Your library. list names every script with the parameters it takes, the "
                       "runner's own and the ones you saved. read returns one script's source: the "
                       "shipped scripts are the worked examples to write yours from. save lints a "
                       "script of yours and keeps it under its name, after which spacemolt_run "
                       "names it and a restart still has it — this is how the pilot builds systems "
                       "on top of the jobs. commands searches the game's own command reference "
                       "and returns the matching signatures — the name, the parameters and the "
                       "return type — so a script calls `command(ctx, 'tool/action', params)` "
                       "with what the server really takes.",
                       {"action": {"type": "string",
                                   "enum": ["list", "read", "save", "commands"],
                                   "description": "list the library, read one script, save one, "
                                                  "or search the game's commands."},
                        "search": {"type": "string",
                                   "description": "For commands: text a command line must "
                                                  "contain, such as 'buy' or 'shipyard'."},
                        "name": {"type": "string",
                                 "description": "For read and save: lowercase letters, digits and "
                                                "hyphens, and your own rather than a shipped one."},
                        "source": {"type": "string",
                                   "description": "For save: the TypeScript of the script."}},
                       ["action"])},
    {"name": "spacemolt_rest", "toolset": "spacemolt", "handler": _rest,
     "description": "End the shift: rest at home, which clears the stance and the mood.",
     "schema": _schema("spacemolt_rest",
                       "Put the evening down. Call this docked at home with the runner idle, on a "
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
    {"name": "spacemolt_storage", "toolset": "spacemolt_observe", "handler": _storage,
     "description": "Read what the pilot holds in storage at the current base, or a named base, without travelling.",
     "schema": _schema("spacemolt_storage",
                       "Read storage at the base the ship is docked at, or a named base, without "
                       "travelling there. Read-only: it does not deposit, withdraw, or reach a "
                       "base you have never visited via other characters' storage.",
                       {"station_id": {"type": "string",
                                       "description": "Optional: a base id or station poi id to view "
                                                      "instead of the current base."}},
                       [])},
    {"name": "spacemolt_recipes", "toolset": "spacemolt_observe", "handler": _recipes,
     "description": "Rank the catalog's recipes by what this base's storage, the hold and the other bases hold.",
     "schema": _schema("spacemolt_recipes",
                       "Rank the catalog's recipes by what the pilot already holds. Read this "
                       "docked, before quoting. Reads only. A craft draws its inputs from this "
                       "base's storage, so craftable now is what this base's storage covers, and "
                       "after stowing is what a deposit of the hold here would add. Nearly is "
                       "one or two inputs short, and names the base each one sits at so a fetch "
                       "is plannable; facility only needs a facility. Each input says how much "
                       "is held here, how much is in the hold, and what sits elsewhere.",
                       {"search": {"type": "string",
                                   "description": "Optional: narrow to recipes whose name, id, "
                                                  "category or output item contains this text."},
                        "base_id": {"type": "string",
                                    "description": "Optional: the base to report against; defaults "
                                                   "to the base the ship is docked at now."}},
                       [])},
    {"name": "spacemolt_quote", "toolset": "spacemolt_observe", "handler": _quote,
     "description": "Quote one recipe: the exact bill, the output and this base's buy price for it. The buy price is information for an output you mean to sell; an output the objective keeps has no margin test.",
     "schema": _schema("spacemolt_quote",
                       "Quote one recipe: the exact bill, output and this base's buy price for "
                       "it. A dry run; nothing is consumed or queued. Quote before committing. "
                       "The margin walks the buy book, so it is what the output really fetches "
                       "rather than the top price times the quantity. The server may quote "
                       "fewer runs than the quantity asked for and reports the runs it will do; "
                       "the bill and the margin are for those runs. A base with no workshop, or "
                       "a recipe that needs a facility, comes back refused with the reason and "
                       "the nearest place that can make it.",
                       {"recipe_id": {"type": "string",
                                      "description": "A recipe id spacemolt_recipes listed."},
                        "quantity": {"type": "integer", "minimum": 1,
                                     "description": "How many units of the output to quote. "
                                                    "Defaults to one."}},
                       ["recipe_id"])},
    {"name": "spacemolt_status", "toolset": "spacemolt_operator", "handler": _status,
     "description": "For the chat window: whether a script runs right now.",
     "schema": _schema("spacemolt_status",
                       "For the chat window: whether a script runs right now — the running "
                       "script and where it has got to, or the last run's outcome when the pilot "
                       "is idle. A juncture reads the same fact from the context it was given.",
                       {}, [])},
    {"name": "spacemolt_journal", "toolset": "spacemolt_observe", "handler": _journal,
     "description": "Read the last few things the pilot actually did.",
     "schema": _schema("spacemolt_journal",
                       "The tail of the pilot's journal, newest last: one line per thing the "
                       "pilot did — the steps of each job, the runs, the reflections, the rest, "
                       "and anything the game refused. This is the account of past work — never "
                       "claim progress it does not show.",
                       {"limit": {"type": "integer", "minimum": 1, "maximum": _JOURNAL_CAP,
                                  "description": f"How many entries, newest last. "
                                                 f"Defaults to {_JOURNAL_DEFAULT}."}},
                       [])},
    {"name": "spacemolt_direct", "toolset": "spacemolt_operator", "handler": _direct,
     "description": "Set the operator's objective and standing permissions for the pilot.",
     "schema": _schema("spacemolt_direct",
                       "Record what the operator wants the pilot to accomplish and the bounds it "
                       "works inside. The pilot takes this up at its next juncture, not now, and a "
                       "job under way runs to its outcome first. A permission left unnamed keeps "
                       "the value it had. This sets nothing else: stance and mood are the pilot's.",
                       {"objective": {"type": "string",
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
    # The operator's sentence becomes the pilot's direction: model-generated text conveying a
    # user's intention, which the pilot reads as outside instruction. The cap is what bounds
    # how much one sentence can ask for; see the handler's docstring for the rest of the fence.
    {"name": "spacemolt_dispatch", "toolset": "spacemolt_operator", "handler": _dispatch,
     "description": "Send the pilot one sentence of direction from the operator.",
     "schema": _schema("spacemolt_dispatch",
                       "Send the pilot one sentence of direction, at most "
                       f"{_INSTRUCTION_LIMIT} characters. Pass the operator's words as they were "
                       "said; shorten by dropping words. The pilot reads it at its next juncture.",
                       {"instruction": {"type": "string", "maxLength": _INSTRUCTION_LIMIT,
                                        "description": "The operator's sentence, in their words."}},
                       ["instruction"])},
)


def wake_on_load() -> None:
    """A process that just loaded the pilot owes it one look around: the juncture is marked
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
        if record.is_file() and not json.loads(record.read_text()).get("ended", True):
            return
        from cron.jobs import trigger_job
        trigger_job(ensure_juncture_job()["id"])
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
