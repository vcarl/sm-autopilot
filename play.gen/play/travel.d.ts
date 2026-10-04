/** Getting somewhere and docking. One function; the id decides what it does. */
import type { ActiveMissionInfo, FindRouteResponse, RouteStep, V2Location } from '@spacemolt/lib';
import { Effect } from 'effect';
import { TravelBlocked } from '../travel.ts';
import { Game } from './game.ts';
import type { Outcome } from './types.ts';
export interface Trip {
    /** The quote the trip was admitted on: `target_system`, `target_poi`, `estimated_fuel`,
     * `total_jumps`. A base id resolves to its POI here, which is the arrival check. */
    route: FindRouteResponse;
    /** Where the ship is now (`GameState['location']`). */
    location: V2Location;
    jumps: number;
    /** True when the trip ended docked at the base the id named, or at the one base in the system it named. */
    docked: boolean;
    /** The base the ship is docked at when the trip ends, or null: `did` then says why not. */
    docked_at: string | null;
}
/** A place the pilot can name: a system, a POI, or a base docked at one. */
export interface Place {
    id: string;
    name: string;
    what: 'system' | 'POI' | 'base';
}
/** The name the pilot wrote is no place: a refusal of the trip, not a failure of it. */
export declare class NotAPlace extends TravelBlocked {
    readonly _tag = "NotAPlace";
}
/** The system a guess names and the bases known to be in it: `node_alpha_station` names Node
 * Alpha, whatever word the pilot suffixed it with. Exactly one base there is what the guess
 * can only have meant, and `destination` flies to it; several (or none) keep the refusal, with
 * the bases named in it so the next script writes an id instead of another guess.
 *
 * `where` is the system the bases in `places` were listed from; a guess naming any other
 * system answers nothing. ponytail: that is the system the ship is in, because `get_map`
 * lists no POIs for a far one (see `scout`, orient.ts). Widen it when a read exists that
 * lists a far system's bases. */
export declare function systemBases(id: string, places: Place[], where?: string): {
    system: Place;
    bases: Place[];
} | undefined;
/** Where a nameable id lives, as the server answers it, and the id it turned out to be. A
 * base id answers with the POI it sits at (`target_poi`), which is what the arrival check
 * must wait for (report 01, fix 1).
 *
 * The server classifies a word it does not know as a system, so its "Target system not
 * found" says nothing about what was actually named. When it says that, the word is matched
 * against the systems on the map and the POIs and bases here: an exact match on an id or a
 * display name is what the pilot meant (names are what prose gives them), and the near
 * misses go in the refusal so the next script can correct itself. A name that is no place
 * fails with `NotAPlace`; any other refusal or a lost reply on `find_route` is its own tag. */
export declare const destinationEffect: (id: string) => Effect.Effect<{
    id: string;
    quote: FindRouteResponse;
}, import("./codes.ts").Rejected | import("./codes.ts").InBattle | import("./codes.ts").HoldFull | import("./codes.ts").Depleted | import("./codes.ts").ReplyLost | NotAPlace, Game>;
/** The quote alone, for callers that only want the fuel and jumps. */
export declare const routeEffect: (id: string) => Effect.Effect<FindRouteResponse, import("./codes.ts").Rejected | import("./codes.ts").InBattle | import("./codes.ts").HoldFull | import("./codes.ts").Depleted | import("./codes.ts").ReplyLost | NotAPlace, Game>;
/** The Promise twin of `routeEffect`: throws `NotAPlace` (a `TravelBlocked`) or the lib's raw error, as it always did. */
export declare function route(id: string): Promise<FindRouteResponse>;
/** A distress call this trip passes near enough to answer, and what including it costs. */
export interface Stop {
    id: string;
    title: string;
    system: string;
    extra: number;
    at: number;
}
/** Which distress calls the quoted route can answer on the way, given a `find_route` leg for
 * each candidate system that is not already on it. Pure, so the budget is testable. */
export declare function distressPlan(quote: Pick<FindRouteResponse, 'route' | 'total_jumps' | 'estimated_fuel' | 'fuel_per_jump' | 'fuel_available'>, missions: ActiveMissionInfo[], legs: Map<string, {
    route?: RouteStep[];
    total_jumps: number;
}>, reserve: number): Stop[];
/** Fly to a POI, a base, or a system, jumping as many times as the route needs, and dock
 * when the target is a base — or a system with exactly one base, whose base is the only place in
 * it a pilot can trade, service or read a market. A system with several bases (or none) ends
 * wherever the jump lands. The destination is always named: there is no default.
 *
 * Over `find_route` + `jump`/`travel` + `dock` it adds: base ids resolved to their POI before
 * the arrival wait, a fuel check that the tank covers the route, a refuel first when docked and short, and one
 * `partial` on stop instead of a wedged runner.
 *
 * On the way it answers active distress calls: a mission whose system is on the route, or at
 * most `DETOUR_JUMPS` off it while all detours together stay inside `DETOUR_SHARE` of the
 * route and the whole trip still ends above the mood's reserve, is flown through and claimed
 * with `complete_mission`. It never accepts a mission, and never detours under Tired.
 *
 * Idempotent: already there (and docked, if a base) sends nothing and is `done`. */
export declare function goTo(id: string): Promise<Outcome<Trip>>;
/** `goTo` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal or a lost reply on
 * a leg ends the trip naming the action and the code; a lost reply on a jump, travel or dock is never re-sent, and
 * the ship's place is re-read from the game. */
export declare const goToEffect: (id: string) => Effect.Effect<Outcome<Trip>, never, Game>;
