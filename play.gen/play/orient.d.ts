/** Looking around. Reads only; nothing here spends a tick or a credit. */
import type { ActiveMissionInfo, CarrierProfile, GetNearbyResponse, GetWrecksResponse, ListShipsResponse, MapSystemInfo, ResourceInfo, StorageLocation, SystemConnection, SystemInfo, SystemPoi, TaxEstimateResponse } from '@spacemolt/lib';
import { Effect } from 'effect';
import { type BattleNow } from '../travel.ts';
import { Game } from './game.ts';
import { type Pilot } from './runtime.ts';
import type { Outcome, Present } from './types.ts';
export interface Orientation {
    present: Present;
    /** Every base holding something of yours, from anywhere (`storage/view.locations`). */
    storage: StorageLocation[];
    /** Ships you own and where they are parked (`ship/list_ships`). */
    ships: ListShipsResponse['ships'];
    /** Your active missions (`get_active_missions`). */
    active_missions: ActiveMissionInfo[];
    /** What accrues behind your back: the tax estimate and the carrier record with its debt. */
    owes: {
        tax?: TaxEstimateResponse;
        carrier?: CarrierProfile;
        bounty: number;
    };
    pilot: Pilot;
    /** The battle holding the ship right now, or absent when none is. Read first and said first:
     * nothing else in an orientation matters while a fight is on. */
    battle?: BattleNow;
    /** Reads that failed this time, by name. Never guessed. */
    missing: string[];
}
/** Refresh the whole world model in one call: where you are, what you have, what you owe,
 * what you own elsewhere, your skills, your missions, and the pilot record. Over the seven
 * reads it adds: one call, each reply cut to what a decision needs, and `next` naming the
 * most obvious gap ("hold is full", "tax due 16 cr"). Returns `done` always. */
export declare function orient(): Promise<Outcome<Orientation>>;
/** `orient` as an Effect, for `edge` and for converted callers; never in a barrel. */
export declare const orientEffect: () => Effect.Effect<Outcome<Orientation>, never, Game | import("./runtime.ts").Run>;
export interface ScoutReport {
    /** The live `get_system` answer when you are in it; the map entry when you are not. Either way
     * `id` and `name` are there (the map's own key is `system_id`). */
    system: (SystemInfo | MapSystemInfo) & {
        id: string;
        name: string;
    };
    /** Every POI: type, base id and services if it has a station. */
    pois: SystemPoi[];
    /** Resources at the POI you are standing at, from `location.resources`. Absent elsewhere:
     * the report is then guesswork until you go there. */
    resources: Record<string, ResourceInfo[]>;
    /** Systems one jump away, each with the fuel `find_route` quotes for it, and whether you have
     * been there (absent when the map could not be read). */
    connections: (SystemConnection & {
        fuel: number;
        visited?: boolean;
    })[];
    /** Only for the POI you are standing at. */
    here?: {
        nearby: GetNearbyResponse;
        wrecks: GetWrecksResponse;
        police: number;
    };
}
/** What is at a place, without flying there: the POIs of a named system (or this one), what
 * each one is, which have stations, and what is nearby right now if the system is the one
 * you are in. `target` is a system id, a POI id, or a base id; default the current system.
 * A far system answers from `get_map`, which lists no POIs (`system.visited` says whether
 * you have been). Over `get_system`/`get_map`/`get_nearby`/`salvage/wrecks`/`find_route` it
 * adds: the id resolved through `find_route`, one call, and `next` naming belts and stations
 * as ids you can paste into `gatherUntil` and `goTo`. Reads only. */
export declare function scout(target?: string): Promise<Outcome<ScoutReport>>;
/** `scout` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal of the
 * route to the target ends the flight, naming the action and the code; a refused quote, nearby or wreck
 * read only leaves its part of the report empty. */
export declare const scoutEffect: (target?: string) => Effect.Effect<Outcome<ScoutReport>, never, Game | import("./runtime.ts").Run>;
