#!/usr/bin/env python3
"""Slice the pilot's own bridge journal into the Unknown Edge fixtures (S46).

`slice_gameplay.py` reads the FIRST-attempt journal, whose every line is one raw
game command. The kvothe pilot's journal is the bridge's, and carries three more
line shapes:

  {at, request:{id,action,params}, response:{id,ok,result|error}}   the bridge protocol
  {at, id, ok, request, result, state}                              the ported runner
  {at, event:'chain'|'rest'|'reflection', ...}                      the bridge's own events

Raw game replies survive only inside a ported-runner result, under
`result.actions[]` as `{action, params, result}` — that is where a real
`get_base`, `storage/view`, `refuel`, `mine` or `find_route` comes from.

Reproduce (paths as of 2026-09-15):

  python3 spacemolt/proofs/fixtures/slice_bridge.py \
      ~/.hermes/profiles/kvothe/spacemolt/runtime/gameplay.jsonl \
      spacemolt/proofs/fixtures

Every entry is pinned by journal line number, so a re-run over the same journal
prefix reproduces the same bytes. Scrubbed exactly as c23-replay.json is: other
players' names and ids, the pilot's own id and username, and the human-readable
`result` text nothing in the bridge reads. Bulk nothing reads (station facility
lists, descriptions, market books, skill boards) is dropped so a fixture stays
reviewable in a diff.
"""
import copy
import json
import sys

PLAYER_ID = "177686d5f9eed52e8cabf6f907c03c61"

SCRUB = ("nearby_players", "online_players", "online_players_count",
         "online_players_truncated", "nearby_empire_npcs", "nearby_pirates",
         "nearby_prizes", "username", "player_id")
DROP = ("facilities", "stats", "construction", "life_support", "power",
        "condition", "description", "queue", "skills", "categories",
        "buy_orders", "sell_orders")


def scrub(node):
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key in SCRUB or key in DROP:
                continue
            if key == "result" and isinstance(value, str):
                continue
            if key in ("username", "player_id", "id") and value == PLAYER_ID:
                out[key] = "pilot"
                continue
            out[key] = scrub(value)
        return out
    if isinstance(node, list):
        return [scrub(item) for item in node]
    return node


def load(path):
    lines = {}
    for number, line in enumerate(open(path), 1):
        try:
            lines[number] = json.loads(line)
        except ValueError:
            continue
    return lines


def main(src, out_dir):
    lines = load(src)

    def entry(number):
        return copy.deepcopy(lines[number])

    def pair(number):
        """One bridge request/response pair, stamped with its line and date."""
        raw = entry(number)
        request, response = raw.get("request"), raw.get("response")
        if response is None:  # the ported runner's own shape
            response = {key: raw[key] for key in ("ok", "result", "error") if key in raw}
        return {"line": number, "at": raw["at"],
                "request": scrub(request), "response": scrub(response)}

    def event(number):
        raw = entry(number)
        raw.pop("request", None)
        return {"line": number, **scrub(raw)}

    def game(number, index):
        """One raw game command recorded inside a ported-runner result."""
        raw = entry(number)["result"]["actions"][index]
        return {"line": number, "index": index, "at": entry(number)["at"],
                "action": raw["action"], "params": raw.get("params"),
                "result": scrub(raw["result"])}

    note = ("Sliced from ~/.hermes/profiles/kvothe/spacemolt/runtime/gameplay.jsonl "
            "(the live pilot's bridge journal, untracked) by "
            "proofs/fixtures/slice_bridge.py. Real request/response pairs; other "
            "players' names and ids, the pilot's own id, and the human-readable "
            "`result` text are scrubbed, and bulk nothing reads is dropped. "
            "`line` is the journal line each entry came from.")

    # --- (a1) Unknown Edge, game level: what the GAME returns -------------------
    # These come from the 2026-09-14 ported-runner jobs, the only lines that carry
    # raw game replies.
    unknown_edge_game = {
        "note": note,
        "source": {"dates": ["2026-09-14"],
                   "system": "unknown_edge",
                   "bases": ["unknown_edge_waystation", "frontier_station (POI mobile_capital)"]},
        "game": {
            "spacemolt/get_system": [game(114, 3)],
            "spacemolt/get_poi": [game(114, 13)],
            "spacemolt/get_base": [game(112, 19)],
            "spacemolt/find_route": [game(114, 46)],
            "spacemolt/undock": [game(114, 9)],
            "spacemolt/travel": [game(114, 11)],
            "spacemolt/mine": [game(114, 15)],
            "spacemolt/dock": [game(114, 49)],
            "spacemolt/refuel": [game(112, 20)],
            "spacemolt_shipping/active": [game(112, 0)],
        },
        "observed": {
            "get_base_has_no_repair_price": "structuredContent.base carries no repair "
                                            "price field of any name; only fuel_price, "
                                            "fuel_price_all_in and fuel_tax_per_unit are quoted",
            "get_base_services_is_a_flat_array_of_strings": True,
            "mine_reply_carries_no_details": "command/tick/delta{ship,cargo,location}; no "
                                             "delta.details and no structuredContent",
            "refuel_details": "delta.details {action,source,fuel,cost,market_cost,tax_amount}",
            # get_skills and shipping/profile live in c23-replay.json (2026-09-08).
            "absent_from_both_journals": ["spacemolt/repair", "spacemolt/get_tax_estimate",
                                          "spacemolt/set_home"],
        },
    }

    # --- (a2) Unknown Edge, bridge level: what the BRIDGE answers ---------------
    unknown_edge_bridge = {
        "note": note,
        "source": {"dates": ["2026-09-15"], "system": "unknown_edge"},
        "bridge": {
            # where: docked at the waystation, loose at the belt, docked at the base
            # whose id is not its POI's, and under way with no poi name.
            "where": [pair(148), pair(446), pair(392), pair(353)],
            "travel": [pair(150)],
            # dock: a clean dock, a refusal because already docked elsewhere, and a
            # refusal because the POI has no station at all.
            "dock": [pair(159), pair(157), pair(263)],
            # gather: a real take, a FULL hold (cargo_free 0, empty yield, nothing
            # sold or held), and a site id the game does not know.
            "gather": [pair(166), pair(321), pair(241)],
            "menu": [pair(444), pair(478)],
            "job": [pair(273), pair(287)],
            "status": [pair(171), pair(205), pair(443)],
            # The mine refusal, as the chain reports it: gather at a station POI.
            "chain": [event(336), event(441)],
        },
        "observed": {
            "belt_poi_id": "unknown_edge_mineral_fields",
            "waystation_base_id": "unknown_edge_waystation",
            "mobile_capital_poi_id": "mobile_capital",
            "mobile_capital_base_id": "frontier_station",
            "mine_docked_refusal": "cannot mine: docked at unknown_edge_waystation",
            "full_hold_gather": "outcome done, yield [], sold [], held [], cargo_free 0",
            "where_docked_at_shape": "an object {base_id,name} from 2026-09-15 ~11:09 on; "
                                     "earlier lines in the same journal answer a bare string",
        },
    }

    # --- (b) storage/view at several bases, and the locations index --------------
    storage = {
        "note": note,
        "source": {"dates": ["2026-09-14", "2026-09-15"]},
        "game": {"spacemolt_storage/view": [game(112, 11)]},
        "bridge": {
            # base_id "" is the undocked read: no base, no items, the index still whole.
            "storage": [pair(173), pair(181), pair(433),
                        pair(194), pair(195), pair(196), pair(197), pair(198), pair(199)],
        },
        "observed": {
            "undocked_base_id": "",
            "station_id_resolves_poi_to_base": "station_id mobile_capital answers base_id frontier_station",
            "locations_always_present": True,
            "ships_always_an_empty_array_live": True,
        },
    }

    # --- (d) the bridge's own events, and the pairs around rest ------------------
    events = {
        "note": note,
        "source": {"dates": ["2026-09-15"]},
        "bridge": {
            # Two refusals — away from home, and a serviceable ship — then three rests.
            "rest": [pair(268), pair(271), pair(319), pair(323), pair(340), pair(369)],
            "rest_event": [event(322), event(339), event(368)],
            "reflection_event": [event(324), event(341), event(371)],
            "chain_event": [event(258), event(289), event(399), event(455)],
            "job": [pair(169), pair(288)],
            "status": [pair(206), pair(290)],
            "menu_busy": [pair(333)],
        },
        "observed": {
            "rest_refusals": ["rest happens only at home; travel home to end the shift",
                              "refuel and repair first — full tank and hull quoted at N credits, "
                              "inside the <Mood> margin M"],
            "resume_never_called": "no resume request appears in the journal",
            "unsolicited_move_never_journalled": "no unsolicited_move event appears in the journal",
        },
    }

    for name, fixture in (("unknown-edge-game.json", unknown_edge_game),
                          ("unknown-edge-bridge.json", unknown_edge_bridge),
                          ("storage-views.json", storage),
                          ("bridge-events.json", events)):
        path = f"{out_dir}/{name}"
        with open(path, "w") as handle:
            json.dump(fixture, handle, indent=1, sort_keys=True)
            handle.write("\n")
        sys.stderr.write(f"wrote {path}\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
