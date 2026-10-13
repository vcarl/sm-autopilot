import type { FaintSignature, SurveyedPoi } from '@spacemolt/lib';
import { Effect, Schema } from 'effect';
import { Game, type GameError } from '../game.ts';
import type { Outcome } from '../types.ts';
/** What this runtime saw standing in a system: its police level and security status (`get_system`
 * answers them only from inside, and `get_map` carries neither), the pirates `get_nearby` counted
 * at the arrival point, and when. Kept in `systems.json`, one row per system, the newest look wins. */
declare const SystemSeen: Schema.Struct<{
    readonly police: Schema.optionalKey<Schema.Number>;
    readonly security: Schema.optionalKey<Schema.String>;
    readonly pirates: Schema.optionalKey<Schema.Number>;
    readonly at: Schema.String;
}>;
/** An interface, so the pilot-facing `Near.seen` keeps its name; its members are the schema's. */
export interface SystemSeen extends Schema.Schema.Type<typeof SystemSeen> {
}
export declare function readSeen(dir: string | undefined): Record<string, SystemSeen>;
export declare function markSeen(dir: string, system_id: string, row: SystemSeen): void;
/** One system as the walk reaches it: the map's own facts, and what this runtime saw there. */
export interface Near {
    system_id: string;
    name: string;
    jumps: number;
    visited: boolean;
    empire?: string;
    stronghold?: boolean;
    online?: number;
    seen?: SystemSeen;
}
/** What the walk reads of a map row: the spec's own fields, picked, with the spec's requiredness. */
declare const MapRow: Schema.Struct<{
    readonly name: Schema.String;
    readonly online: Schema.Number;
    readonly empire: Schema.optionalKey<Schema.String>;
    readonly system_id: Schema.String;
    readonly connections: Schema.$Array<Schema.String>;
    readonly is_stronghold: Schema.optionalKey<Schema.Boolean>;
    readonly poi_count: Schema.Number;
    readonly visited: Schema.Boolean;
}>;
type MapRow = typeof MapRow.Type;
/** The rows of a `get_map` reply that decode; a reply with no map, or a row that is not one, adds nothing. */
export declare const mapOf: (reply: unknown) => MapRow[];
/** Jumps from `here` to every system within `max`, one breadth-first walk over the map's links. */
export declare function jumpsFrom(map: readonly MapRow[], here: string, max?: number): Map<string, number>;
/** Every other system within `max` jumps, nearest first, with the facts the map and memory hold. */
export declare function around(map: readonly MapRow[], here: string, max?: number, seen?: Record<string, SystemSeen>): Near[];
/** A system's facts as one clause, for the pilot to weigh: nothing here judges safe or unsafe.
 * The map publishes no police level, so for a system never stood in the empire is the only law
 * there is to name; police and pirates appear once this runtime has seen them.
 * ponytail: the faction intel map (`query_intel`, read by `candidates`) carries `police_level` for
 * systems never stood in; fold it into `seen` when a pilot's faction has mapped its region. */
export declare function nearFacts(row: Near, now?: number): string;
export interface Explored {
    /** Each system flown to, in order, with what `scout()` read on arrival. */
    visited: {
        system_id: string;
        name: string;
        jumps: number;
        police?: number;
        security?: string;
        pirates?: number;
        stations: string[];
        belts: string[];
        pois: number;
        survey?: string;
    }[];
    /** Unvisited systems still within `jumps` after the last hop, nearest first. */
    unvisited: Near[];
    ended: 'done' | 'none' | 'refused' | 'tired';
}
/** Visit up to `systems` (default 2) unvisited systems, each the nearest one left within `jumps`
 * (default 3) of where the ship now is, and `scout()` each on arrival: its stations, belts, police
 * level and security status, and the pirates at the arrival point, all in `detail.visited` and kept
 * in `systems.json` for the menu to name later. `survey:true` also sends `survey_system` in each
 * (scanning XP, hidden POIs). `avoid` is a list of system ids you will not go to or through: a
 * target whose route crosses one is skipped. Nothing else is skipped — the danger is yours to judge
 * from the facts, and the menu names them. Flies with `goTo`, so a hop the tank cannot cover is
 * refused and ends the circuit, and a hop that leaves you Tired ends it there. Does not come home:
 * `goTo` your base after. Trains exploration (first visits), navigation, piloting. */
export declare function exploreNearby(opts?: {
    systems?: number;
    jumps?: number;
    survey?: boolean;
    avoid?: string[];
}): Promise<Outcome<Explored>>;
/** `exploreNearby` as an Effect, for `edge` and for converted callers; never in a barrel. A survey
 * the game refuses or loses is said in `survey` and the visit goes on; every other failure ends the flight. */
export declare const exploreNearbyEffect: (opts?: {
    systems?: number;
    jumps?: number;
    survey?: boolean;
    avoid?: string[];
}) => Effect.Effect<Outcome<Explored>, never, Game | import("../runtime.ts").Run>;
/** What one `survey_system` read of the system you are in: the hidden POIs it revealed now and those
 * already revealed to you, the faint signatures it could not resolve, and what your fit brought to it. */
export interface Surveyed {
    system_id?: string;
    /** Revealed by this survey. A wormhole is one of these with a wormhole `type`: `goTo` the POI, and
     * `get_poi` there names its destination, expiry and a prediction hint. `resources` lists a deposit's ores. */
    newly_revealed: SurveyedPoi[];
    /** Hidden POIs this system had already revealed to you: travel to them as to any POI. */
    already_revealed: SurveyedPoi[];
    /** Something is there that this survey's power did not resolve: `hint`, `type`, `difficulty`. */
    faint_signatures: FaintSignature[];
    /** The direction-hint an anomaly gives, when the survey heard one. */
    anomaly_hint?: string;
    /** What your fitted gear brought to the survey; the game publishes no table of it, so this is how you learn it. */
    survey_power?: number;
    xp_gained: Record<string, number>;
    message?: string;
}
/** `survey_system` sent once and read leniently. A refusal or a lost reply is the caller's: a survey
 * is a mutation, so a lost one is not re-sent (live 2026-09-28 12:19Z: "No response to mutation"
 * after 15 s, the one survey a pilot has sent). */
export declare const surveySystem: Effect.Effect<Surveyed, GameError, Game>;
/** `survey` as an Effect, for `edge`; never in a barrel. Every refusal, a lost reply included, is said
 * with an empty survey in `detail`, so a program reading `detail.newly_revealed` never meets a missing list. */
export declare const surveyEffect: () => Effect.Effect<Outcome<Surveyed>, never, Game | import("../runtime.ts").Run>;
export {};
