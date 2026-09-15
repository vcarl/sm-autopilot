#!/usr/bin/env python3
"""Slice spacemolt/runtime/gameplay.jsonl into the C23 replay fixture (S46).

The journal holds three line shapes and only one of them is a response:
  {event:'requested', request}                      -> the send, no outcome
  {request, id?, ok:true, result, state}            -> the response
  {event:'error', request, ok:false, error, code,   -> the separate error shape
   outcome_unknown, fatal, action_completed, state}
Only the second is sliced; the third is counted so an error is never mistaken
for a reply. Repeated commands (mine) keep their order so the harness can index
by call number.
"""
import json, sys, copy

SRC = sys.argv[1]
OUT = sys.argv[2]

PLAYER_ID = "177686d5f9eed52e8cabf6f907c03c61"


# Scrubbed: other players' names and ids. Dropped: bulk no consumer in the
# bridge reads, so the fixture stays small enough to review in a diff.
SCRUB = ("nearby_players", "online_players", "online_players_count",
         "online_players_truncated", "username", "player_id")
DROP = ("facilities", "stats", "construction", "life_support", "power",
        "condition", "description", "queue")


def scrub(node):
    """Other players' names and ids never belong in a checked-in fixture; the
    human-readable `result` text is dropped because nothing reads it."""
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in SCRUB or k in DROP:
                continue
            if k == "result" and isinstance(v, str):
                continue
            if k in ("username", "player_id", "id") and v == PLAYER_ID:
                out[k] = "pilot"
                continue
            if k == "username":
                out[k] = "player"
                continue
            out[k] = scrub(v)
        return out
    if isinstance(node, list):
        return [scrub(x) for x in node]
    return node


lines = open(SRC).readlines()
shapes = {"requested": 0, "response": 0, "error": 0}
entries = []
for n, line in enumerate(lines, 1):
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("event") == "requested":
        shapes["requested"] += 1
        continue
    if e.get("event") == "error":
        shapes["error"] += 1
        continue
    if "result" not in e:
        continue
    shapes["response"] += 1
    entries.append((n, e))
sys.stderr.write(f"line shapes: {shapes}\n")

by_line = {n: e for n, e in entries}


def at(n):
    return copy.deepcopy(by_line[n])


def inventory(cargo):
    totals = {}
    for row in cargo or []:
        totals[row["item_id"]] = totals.get(row["item_id"], 0) + row["quantity"]
    return totals


# --- the slice: one docked shift at First Step, the belt next door ------------
SEED = 495          # dock at first_step_memorial_station, fuel 113/120, hold 20/125
MODULES = 511       # the same ship's fitted modules (the seed's state omits them)
SYSTEM = 489        # get_system for first_step, with the belt and the station
ROUTE = 1961        # find_route inside first_step: 0 jumps, travel to the POI
BASE = 3235         # get_base at first_step_memorial_station
UNDOCK = 281
TRAVEL = 543        # travel to colony_debris_field
DOCK = 495
MINE = [545, 560]
STORAGE = 275       # storage view at first_step_memorial_station
DEPOSIT = 1982
REFUEL = 537        # refuel at first_step_memorial_station: 7 units for 21cr
SKILLS = 451
SHIPPING = 345

seed = at(SEED)
state = scrub(seed["state"])
ship = state["ship"]
cargo = state["cargo"]
location = state["location"]
credits = state["credits"]
modules = scrub(at(MODULES)["state"]["modules"])

# What one travel to the belt cost, read off the recorded pair, not assumed.
before_travel = at(TRAVEL - 2)["state"]["ship"]["fuel"]
after_travel = at(TRAVEL)["result"]["delta"]["ship"]["fuel"]
travel_fuel = before_travel - after_travel

# What one mine cycle put in the hold, measured between the recorded reads.
mine_before = inventory(at(MINE[0] - 2)["state"]["cargo"])
mine_after = inventory(at(MINE[0])["result"]["delta"]["cargo"])
mine_gain = sorted(
    ({"item_id": k, "quantity": v - mine_before.get(k, 0)}
     for k, v in mine_after.items() if v - mine_before.get(k, 0) > 0),
    key=lambda row: row["item_id"])

def mined(n):
    """A mine reply, minus the skills board it also carries: nothing in the job
    reads it and it doubles the fixture."""
    reply = scrub(at(n)["result"])
    reply.get("delta", {}).pop("skills", None)
    return reply


base_details = at(BASE)["result"]["structuredContent"]
refuel_details = at(REFUEL)["result"]["delta"]["details"]
fuel_price = base_details["fuel_price_all_in"]

fixture = {
    "note": (
        "Sliced from runtime/gameplay.jsonl (106 MB, untracked) by "
        "proofs/fixtures/slice_gameplay.py. Real request/response pairs from live play at "
        "First Step, 2026-09-08. Other players' names and ids and the "
        "human-readable `result` text are scrubbed; nothing in the bridge "
        "reads either. A reply's own delta is left as recorded, so the mine "
        "replies claim a different session's hold — the job's numbers may only "
        "come from authoritative reads."),
    "source": {
        "file": "spacemolt/runtime/gameplay.jsonl",
        "line_shapes": shapes,
        "lines": {"state": SEED, "modules": MODULES, "get_system": SYSTEM,
                  "find_route": ROUTE, "get_base": BASE, "undock": UNDOCK,
                  "travel": TRAVEL, "dock": DOCK, "mine": MINE,
                  "storage_view": STORAGE, "deposit": DEPOSIT, "refuel": REFUEL,
                  "get_skills": SKILLS, "shipping_profile": SHIPPING},
    },
    "state": {"ship": ship, "cargo": cargo, "location": location,
              "credits": credits, "modules": modules},
    "observed": {
        "home_base_id": "first_step_memorial_station",
        "home_poi_id": "first_step_memorial_station",
        "site_poi_id": "colony_debris_field",
        "system_id": "first_step",
        "travel_fuel": travel_fuel,
        "mine_gain": mine_gain,
        "fuel_price_all_in": fuel_price,
        "refuel_units": refuel_details["fuel"],
        "refuel_cost": refuel_details["cost"],
    },
    "responses": {
        "spacemolt/get_system": [scrub(at(SYSTEM)["result"])],
        "spacemolt/find_route": [scrub(at(ROUTE)["result"])],
        "spacemolt/get_base": [scrub(at(BASE)["result"])],
        "spacemolt/undock": [scrub(at(UNDOCK)["result"])],
        "spacemolt/travel": [scrub(at(TRAVEL)["result"])],
        "spacemolt/dock": [scrub(at(DOCK)["result"])],
        "spacemolt/mine": [mined(n) for n in MINE],
        "spacemolt_storage/view": [scrub(at(STORAGE)["result"])],
        "spacemolt_storage/deposit": [scrub(at(DEPOSIT)["result"])],
        "spacemolt/refuel": [scrub(at(REFUEL)["result"])],
        "spacemolt/get_skills": [scrub(at(SKILLS)["result"])],
        "spacemolt_shipping/profile": [scrub(at(SHIPPING)["result"])],
    },
}

with open(OUT, "w") as f:
    json.dump(fixture, f, indent=1, sort_keys=True)
    f.write("\n")
sys.stderr.write(f"wrote {OUT}\n")
