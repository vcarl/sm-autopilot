"""Hermes plugin: look around a SpaceMolt system, fly, dock, and run one gather job.

Three toolsets, because a tool name is global and belongs to exactly one of them:
``spacemolt`` is the job tools a juncture flies with, ``spacemolt_observe`` the reads every
client of the runner may make, and ``spacemolt_operator`` the operator's own window tools:
direction, and the script-is-running read the chat window asks for while a juncture already
has the answer in its context. A chat window carries observe + operator and never a job tool
(N19); a cron fire carries spacemolt + observe and never sets its own objective.
"""
from __future__ import annotations

import json
from collections import deque
from typing import Any, Mapping

from pathlib import Path

from .juncture import (JOB_MOODS, JOURNAL_FILE, JUNCTURE_PLATFORM, STANCES, ensure_juncture_job,
                       journal_event, juncture_context, read_pilot, write_pilot)
from .service import available, call, close_bridge, runtime_dir
from .skills_register import register_skills

_JOURNAL_DEFAULT, _JOURNAL_CAP, _RESULT_CHARS = 10, 50, 120

#: The scripts the runner ships, mirrored from ``src/scripts/`` the way STANCES is mirrored
#: from the rules table: a tool schema cannot read TypeScript, and a schema built by asking a
#: live bridge at plugin load would spawn one for every session. The bridge's ``scripts``
#: action is the runtime source of truth — it validates every dispatch against the script's
#: own schema, and a refusal comes back carrying the same list.
SCRIPTS = {
    "gather": "poi_id (the mining site), optional base_id (where the take is stowed)",
    "gather-until": "poi_id, item_id, quantity and max_runs: gather trip after trip until "
                    "the home store holds that much of that item, or the cap is reached; "
                    "optional base_id",
    "stock-up": "poi_id, targets (a list of {item_id, quantity}) and max_runs: gather at "
                "one site until the store holds each target in turn; optional base_id",
    "stow": "no parameters: deposit the hold into the store at the base you are docked at, "
            "which is what frees hold for the next gather; optional items (item ids) and "
            "base_id (must be the base you are docked at)",
}
SCRIPT_HELP = "The scripts and what each one takes:\n" + "\n".join(
    f"- {name}: {takes}" for name, takes in SCRIPTS.items())

_FLIGHT_PROMPT = (
    "SpaceMolt: you fly one live ship. When asked where the ship is, call spacemolt_where "
    "and report its answer. Report only what tool results say.\n"
    "Travel takes poi ids and docking takes base ids; both come from spacemolt_where.\n"
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


def _travel(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    poi_id = str((arguments or {}).get("poi_id") or "")
    return json.dumps(call("travel", {"poi_id": poi_id}), separators=(",", ":"))


def _dock(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    base_id = str((arguments or {}).get("base_id") or "")
    return json.dumps(call("dock", {"base_id": base_id} if base_id else {}), separators=(",", ":"))


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


def _gather(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    args = arguments or {}
    params: dict[str, Any] = {"poi_id": str(args.get("poi_id") or "")}
    base_id = str(args.get("base_id") or "")
    if base_id:
        params["base_id"] = base_id
    keep = args.get("keep") or []
    if keep:
        params["keep"] = [str(item) for item in keep]
    return json.dumps(call("gather", params), separators=(",", ":"))


def _dispatch(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """Start one script in the runner.

    The script owns its own parameters, so a script that will not take these says why and
    this answers with the scripts there are and what each one asks for — one turn to correct,
    rather than a guess repeated.
    """
    args = arguments or {}
    params = {"script": str(args.get("script") or ""), "params": args.get("params") or {}}
    try:
        return json.dumps(call("run", params), separators=(",", ":"))
    except Exception as error:  # the runner refuses before anything reaches the game
        return json.dumps({"accepted": False, "reason": str(error),
                           "scripts": call("scripts")}, separators=(",", ":"))


def _status(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    return json.dumps(call("status"), separators=(",", ":"))


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


def _journal_row(line: str) -> dict[str, Any]:
    """One journal line as a window reads it: when, what was asked, whether it took, and the
    gist. The line is written by another process, so a torn last line says so rather than raising."""
    try:
        entry = json.loads(line)
    except ValueError:
        return {"at": None, "action": None, "ok": False, "result": "unreadable journal line"}
    response = entry.get("response") or {}
    ok = bool(response.get("ok"))
    payload = response.get("result") if ok else response.get("error")
    text = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"), sort_keys=True)
    return {"at": entry.get("at"), "action": (entry.get("request") or {}).get("action"),
            "ok": ok, "result": text[:_RESULT_CHARS]}


def _journal(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    """The tail of the journal, compacted — the account of past work a decision needs (N15).

    ponytail: every bridge request is journalled, reads included, so a quiet shift's tail is
    mostly ``where``. Filter by action here once the bridge journals jobs apart from reads.
    """
    asked = (arguments or {}).get("limit")
    limit = max(1, min(int(asked) if asked else _JOURNAL_DEFAULT, _JOURNAL_CAP))
    path = runtime_dir() / JOURNAL_FILE
    if not path.is_file():
        return json.dumps([], separators=(",", ":"))
    with path.open(encoding="utf-8", errors="replace") as journal:
        lines = deque(journal, maxlen=limit)  # bounded: a long shift is never read whole
    return json.dumps([_journal_row(line) for line in lines if line.strip()], separators=(",", ":"))


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
                "wildlife, max_liability, credit_reserve.")
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


TOOL_DEFINITIONS = (
    {"name": "spacemolt_where", "toolset": "spacemolt_observe", "handler": _where,
     "description": "Read the ship's live location, fuel, hull, the POIs of this system and the systems it connects to.",
     "schema": _schema("spacemolt_where",
                       "Read the ship's live location, fuel, hull, the points of interest in this system, "
                       "and connections: the systems a jump reaches from here.",
                       {}, [])},
    {"name": "spacemolt_travel", "toolset": "spacemolt", "handler": _travel,
     "description": "Fly to a point of interest in this system or another, jumping as the route needs.",
     "schema": _schema("spacemolt_travel",
                       "Fly to a point of interest in this system or another, undocking and jumping as "
                       "the route needs. The fuel reserve the mood keeps back bounds how far the trip goes. "
                       "Takes real game time: wait for the result. One call per move. "
                       "Returns the arrival confirmed by a live read.",
                       {"poi_id": {"type": "string",
                                   "description": "A poi id spacemolt_where listed."}},
                       ["poi_id"])},
    {"name": "spacemolt_dock", "toolset": "spacemolt", "handler": _dock,
     "description": "Dock at the station the ship is at.",
     "schema": _schema("spacemolt_dock",
                       "Dock at the station the ship is at; already being docked there is success, "
                       "not an error. Returns the dock confirmed by a live read.",
                       {"base_id": {"type": "string",
                                    "description": "Optional: the base id spacemolt_where reported in docked_at, "
                                                   "to refuse a dock at any other station."}},
                       [])},
    {"name": "spacemolt_gather", "toolset": "spacemolt", "handler": _gather,
     "description": "Mine a belt until the hold is full, stow the yield at the home base and service; "
                    "the site may be in this system or another.",
     "schema": _schema("spacemolt_gather",
                       "Run one gather job dock to dock: fly to a MINING poi — an asteroid belt or "
                       "field, in this system or another — mine until the hold is full, return, dock, "
                       "stow the yield into storage and service the ship. Home is where the ore ends "
                       "up, not a limit on where it is mined. Dispatch this when cargo_free is above zero. With a full hold, stow or "
                       "craft first. Takes real game time; returns one outcome verified against live "
                       "state.",
                       {"poi_id": {"type": "string",
                                   "description": "The mining site to work: an asteroid belt or field, "
                                                  "in this system or another."},
                        "base_id": {"type": "string",
                                    "description": "Optional: the base the yield is stowed at; defaults to "
                                                   "the base the ship is docked at now, then the pilot's home."},
                        "keep": {"type": "array", "items": {"type": "string"},
                                 "description": "Optional: item ids that must never be sold."}},
                       ["poi_id"])},
    {"name": "spacemolt_dispatch", "toolset": "spacemolt", "handler": _dispatch,
     "description": "Start one script in the runner and return at once.",
     "schema": _schema("spacemolt_dispatch",
                       "Start the option you chose. The script runs on in the runner after this "
                       "conversation ends, so this returns immediately. After this call, say what "
                       "you started and end the turn. The runner raises the next juncture when the "
                       "script ends. Refused while another script runs.\n"
                       + SCRIPT_HELP,
                       {"script": {"type": "string", "enum": list(SCRIPTS),
                                   "description": "The script to run."},
                        "params": {"type": "object",
                                   "description": "What that script asks for, named above."}},
                       ["script", "params"])},
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
     "description": "Quote one recipe: the exact bill, the output and this base's buy price for it.",
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
                       "The tail of the pilot's journal, newest last: when, what was asked of the "
                       "game, whether it took, and the gist of the answer. This is the account of "
                       "past work — never claim progress it does not show.",
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
                                            "wildlife": {"type": "boolean",
                                                         "description": "May the pilot attack wildlife."},
                                            "max_liability": {"type": "number",
                                                              "description": "Most the pilot may owe on one "
                                                                             "freight or passenger job."},
                                            "credit_reserve": {"type": "number",
                                                               "description": "Credits kept back for fuel "
                                                                              "and repair, never spent."}}}},
                       [])},
)


def register(ctx) -> None:
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
