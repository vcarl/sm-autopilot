# Founder stance (deferred research)

Parked research for a "Founder" stance (factions + stations), so nobody redoes it. Developer-only,
not pilot-facing. **(V)** verified against the lib, catalog, or live logs; **(I)** inference.

Status: deferred. On 2026-10-07 the maintainer chose renting first (facility book, shared play lib,
branch `feat/facility-book`). Nothing here is built.

## Why (live pilot, 2026-09-26..10-07)

- ~563 "You must be in a faction" refusals (`submit_trade_intel`, `query_trade_intel`,
  `query_intel`), every run. Nothing tells the pilot that joining or creating a faction is the fix. (V)
- Crafting/weapon objectives stalled 9 days on facility-only recipes. The pilot browsed 63 buildable
  facility types and built none. (V)
- Zero of ~25 objectives were about ownership. Only Trader made money (270k to 631k). (V)

## Proposed shape (I)

One stance, "Founder", for faction plus station: a station needs a faction, so one stance, not two.

Touch points to add a stance:

| File | Where |
|------|-------|
| `src/rules-table.ts` | :5-14 (`StanceName`, `STANCES` initial_moods) |
| `play.gen/rules-table.d.ts` | regenerate |
| `juncture.py` | :43-45 (`STANCES` mirror), :82-84 (`STANCE_FOLDER`) |
| `__init__.py` | `spacemolt_reflect` enum (~:512-532) |
| `README.md` | :14-15 |
| `AGENTS.md` | :126-129 |
| `tests/test_spacemolt_skills.py` | :63-66 |
| `tests/test_spacemolt_juncture.py` | stance list |

- Gap: no test pins the Python `STANCES` to the TS table.
- New `src/play/founder/README.md`.
- Minimal helpers only: `ownership()` (one read: faction, treasury, owned facilities/stations, rent
  due, tax) and maybe `rentOut(facility, price)` (`set_access` public + `set_output_price`).
  Everything else goes raw via `account().commands`.
- Wall-to-path notes (hints, not gates) at: the faction-intel refusal, dock "Access denied", a
  shipyard owned by another faction.
- Shared play README gets a short "Owning things" ladder.

## Game capability map

Source: `node_modules/@spacemolt/lib` (`COMMANDS.md`, `dist/generated/openapi/types.gen.d.ts`).

### Factions

| Command | Verbs / notes | |
|---------|---------------|-|
| `spacemolt_faction` (COMMANDS.md:229-260) | `create({id: 2-4 char tag, text: unique name})`, invite/join/accept_invite/decline_invite/get_invites/withdraw_invite/kick/leave, list/info, diplomacy (propose_ally/accept_ally/remove_ally/declare_war/propose_peace/accept_peace/set_enemy/remove_enemy), list_missions/cancel_mission (escrowed rewards), tax_estimate/prepay_tax, garages, rooms/visit_room/delete_room, delete_role | V |
| `spacemolt_faction_admin` (:262-271) | create_role/edit_role/promote (recruit, member, officer, leader)/edit (description, charter, colours, ally_facility_access, ally_fuel_access, ally_intel_opt_out)/post_mission/write_room | V |
| `spacemolt_faction_commerce` (:273-278) | create_buy_order/create_sell_order on the faction's behalf, bulk `orders[]` | V |

- Tax (`FactionTaxEstimateResponse`): weekly corporate income tax; `rate_bps`, gross, owed,
  deductible expenses, loss carryforward, prepaid. (V)
- Storage/treasury: `spacemolt_storage` deposit/withdraw/view with `target: 'faction'` or
  `'faction:TAG'`, credits. Whether treasury withdrawal needs a role: unverified.

### Stations (all under `spacemolt_facility`, COMMANDS.md:179-194)

- `base_cost()` returns `eligible_here`, `founding_fee`, `max_per_faction`, `reason`,
  `requirements`, `station_core_item` (types ~962-968). The only authoritative gate; run it at the
  target POI. (V)
- `found_station({name, public_access?})` in lawless space. (V)
- `deploy_outpost({name})` / `dismantle_outpost` (Outpost Kit). (I)
- Faction membership likely required to found. (I)

Station admin (`StationConfigResponse`, read via `station_info`) (V): set_public,
allow/remove_player, allow/remove_faction, ban/unban, `set_service_access({service, access:
public|allies|faction})`, `set_build_policy({allow_outsiders})`, set_market_fee, set_refuel_price,
set_repair_price, set_auto_buy_fuel, set_name/set_description.

Income: market fee bps, refuel/repair prices, outsider facility rent. Observed: repair 105cr for 21
hull at a player station (`docs/GAMEPLAY.md:127-134`).

### Facility costs (`catalog.json`) (V)

| Facility | Cost |
|----------|------|
| crew_bunk | 10k + 20 steel_plate |
| workshop_toolkit | 25k |
| faction_desk | 100k |
| intel_terminal | 150k |
| faction_lockbox | 200k |
| faction_mission_board | 300k |
| faction_ship_garage | 600k |
| faction_warehouse | 750k |
| faction_fuel_bunker | 800k |
| faction_depot | 4M |
| faction_stronghold | 15M |
| faction_shipyard_complex | 100M |
| production facilities | ~113k to 12.7M |

Rent is per cycle (100 ticks, about 17 min); arrears lead to repossession after `grace_cycles`.
Build materials come from the station store, not the hold.

### Facility owner verbs not wrapped (V)

upgrade/upgrades/repair/dismantle/transfer/browse_for_sale/buy_listing/`list_for_sale({price,
faction?})`/ranch_status/ranch_set_cull/faction_build/faction_upgrade/`buy_ship_license({ship_class})`
(pays from faction credits; `royalty_percent`).

### Runtime discovery

`get_guide({id})` ids: miner, trader, pirate-hunter, boarding, explorer, base-builder, drones, fuel,
crafting. The pilot never called base-builder; its content is not in the lib. (V)

### Unknowns to probe live (read-only) before building

- `faction/create` cost and prerequisites
- `base_cost` numbers at a lawless POI
- base-builder guide content
- role permission keys

## Other findings worth keeping

- Nested READMEs are never registered as skills (`skills_register.py` globs `src/play/*/README.md`).
  The fleet README is registered but no stance loads it; open question whether it becomes Trader's
  stage or its own stance. (V)
- `docs/VISION.md` says rest clears the stance; `AGENTS.md:417-418` says shift state is gone. Stale
  line. (V)
- The faction-ledger explanation is duplicated across the play/, trading/, and fleet/ READMEs. (V)
