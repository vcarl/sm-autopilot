"""Hermes plugin: look around a SpaceMolt system, fly, dock, and run one gather job.

Three toolsets, because a tool name is global and belongs to exactly one of them:
``spacemolt`` is the job tools a juncture flies with, ``spacemolt_observe`` the reads every
client of the runner may make, and ``spacemolt_operator`` the one tool that sets direction.
A chat window carries observe + operator and never a job tool (N19); a cron fire carries
spacemolt + observe and never sets its own objective.
"""
from __future__ import annotations

import json
from collections import deque
from typing import Any, Mapping

from pathlib import Path

from .juncture import JUNCTURE_PLATFORM, juncture_context, read_pilot, write_pilot
from .service import available, call, close_bridge, runtime_dir
from .skills_register import register_skills

#: Where the bridge appends one line per request; the plugin only ever reads it.
JOURNAL_FILE = "gameplay.jsonl"
_JOURNAL_DEFAULT, _JOURNAL_CAP, _RESULT_CHARS = 10, 50, 120

_FLIGHT_PROMPT = (
    "SpaceMolt: you fly one live ship. spacemolt_where reads the ship's authoritative "
    "position, fuel, hull and the points of interest in the current system; spacemolt_travel "
    "flies to one of those poi ids, undocking first if needed; spacemolt_dock docks at the "
    "station the ship is at, and a dock the ship already has is a satisfied dock, not an error. "
    "spacemolt_gather runs one mining trip dock to dock: out, hold full, home, sold, serviced. "
    "At a juncture the present and the menu are already in front of you: spacemolt_dispatch "
    "starts one chain in the runner and returns at once, and spacemolt_status says whether "
    "one is still running. Travel is real game time and a "
    "call can take a minute or more — wait for it, never retry a pending one. Report only what "
    "the tool result says, and use a poi id that spacemolt_where listed. Whenever asked where the "
    "ship is, call spacemolt_where first; never answer position from memory."
)

_WINDOW_PROMPT = (
    "SpaceMolt: you are a window on a pilot the runner flies; this conversation never owns it. "
    "spacemolt_where reads the ship's live position, fuel and hull, spacemolt_status says "
    "whether a job is running right now, and spacemolt_journal returns the last few things the "
    "pilot actually did. Answer from those three and never from memory: what you report about "
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
    args = arguments or {}
    params: dict[str, Any] = {"job": str(args.get("job") or "gather"),
                              "poi_id": str(args.get("poi_id") or "")}
    for name in ("base_id", "home_poi_id"):
        if args.get(name):
            params[name] = str(args[name])
    if args.get("repeat"):
        params["repeat"] = args["repeat"]
    if args.get("keep"):
        params["keep"] = [str(item) for item in args["keep"]]
    return json.dumps(call("job", params), separators=(",", ":"))


def _status(arguments: dict[str, Any] | None = None, **_: Any) -> str:
    return json.dumps(call("status"), separators=(",", ":"))


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
    if permissions:
        # A bound this call does not name keeps the value it had: asking widens nothing else.
        record["permissions"] = {**(record.get("permissions") or {}), **permissions}
    write_pilot(record)
    return ("Direction recorded. The pilot takes it up at the next juncture, not now, and a job "
            "already under way runs to its outcome first. Standing now: "
            + json.dumps({"objective": record.get("objective"),
                          "permissions": record.get("permissions") or {}},
                         separators=(",", ":"), sort_keys=True))


TOOL_DEFINITIONS = (
    {"name": "spacemolt_where", "toolset": "spacemolt_observe", "handler": _where,
     "description": "Read the ship's live location, fuel, hull and the POIs of the current system.",
     "schema": _schema("spacemolt_where",
                       "Read the ship's live location, fuel, hull and the points of interest in the current system.",
                       {}, [])},
    {"name": "spacemolt_travel", "toolset": "spacemolt", "handler": _travel,
     "description": "Fly to a point of interest in the current system.",
     "schema": _schema("spacemolt_travel",
                       "Fly to a point of interest in the current system, undocking first if needed. "
                       "Takes real game time; returns the arrival confirmed by a live read.",
                       {"poi_id": {"type": "string", "description": "A poi id listed by spacemolt_where."}},
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
     "description": "Run one gather job: mine a poi until the hold is full and stow the ore at home; it never sells.",
     "schema": _schema("spacemolt_gather",
                       "Run one gather job dock to dock: fly to a mining poi, fill the hold, return, "
                       "dock, deposit the mined ore into storage (never sell) and service the ship. Takes real game time; returns one "
                       "outcome verified against live state.",
                       {"poi_id": {"type": "string",
                                   "description": "The mining poi id to work, as spacemolt_where listed it."},
                        "base_id": {"type": "string",
                                    "description": "Optional: the home base id to return to; defaults to the "
                                                   "base the ship is docked at now."},
                        "keep": {"type": "array", "items": {"type": "string"},
                                 "description": "Optional: item ids that must never be sold."}},
                       ["poi_id"])},
    {"name": "spacemolt_dispatch", "toolset": "spacemolt", "handler": _dispatch,
     "description": "Start one chain of jobs in the runner and return at once.",
     "schema": _schema("spacemolt_dispatch",
                       "Start the option you chose. The chain runs in the runner after this "
                       "conversation ends, so this returns immediately with a chain id and its "
                       "progress; never wait for it. Refused while another chain runs.",
                       {"job": {"type": "string", "enum": ["gather"],
                                "description": "The job to run; only 'gather' exists so far."},
                        "poi_id": {"type": "string",
                                   "description": "The site the job works, as the menu named it."},
                        "repeat": {"type": "integer", "minimum": 1,
                                   "description": "How many times to run the job back to back under "
                                                  "this one juncture. Defaults to once."},
                        "base_id": {"type": "string",
                                    "description": "Optional: the home base to return to; defaults to "
                                                   "the base the ship is docked at now."},
                        "keep": {"type": "array", "items": {"type": "string"},
                                 "description": "Optional: item ids that must never be sold."}},
                       ["poi_id"])},
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
    {"name": "spacemolt_status", "toolset": "spacemolt_observe", "handler": _status,
     "description": "Say whether a chain is still running, and what the last one did.",
     "schema": _schema("spacemolt_status",
                       "Report the running chain's progress, or the last chain's outcome when the "
                       "pilot is idle. Never poll this in a juncture; the runner raises the next "
                       "juncture when the chain ends.",
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
