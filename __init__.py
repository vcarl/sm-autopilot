"""Hermes plugin: look around a SpaceMolt system, fly to a point of interest, and dock."""
from __future__ import annotations

import json
from typing import Any

from .service import available, call, close_bridge

_PROMPT = (
    "SpaceMolt: you fly one live ship. spacemolt_where reads the ship's authoritative "
    "position, fuel, hull and the points of interest in the current system; spacemolt_travel "
    "flies to one of those poi ids, undocking first if needed; spacemolt_dock docks at the "
    "station the ship is at, and a dock the ship already has is a satisfied dock, not an error. "
    "Travel is real game time and a "
    "call can take a minute or more — wait for it, never retry a pending one. Report only what "
    "the tool result says, and use a poi id that spacemolt_where listed. Whenever asked where the "
    "ship is, call spacemolt_where first; never answer position from memory."
)


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


TOOL_DEFINITIONS = (
    {"name": "spacemolt_where", "toolset": "spacemolt", "handler": _where,
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
                                    "description": "Optional: the base id spacemolt_where reported as docked_at, "
                                                   "to refuse a dock at any other station."}},
                       [])},
)


def register(ctx) -> None:
    for definition in TOOL_DEFINITIONS:
        ctx.register_tool(**definition, check_fn=available,
                          requires_env=["SPACEMOLT_CREDENTIALS_FILE"], emoji="🚀")
    ctx.register_system_prompt_section("spacemolt.flight", _PROMPT, position="after_memory", max_chars=800)
    ctx.on_unload(close_bridge)
