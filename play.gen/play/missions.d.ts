/** The mission board at the base you are docked at. The cheapest credits and skill xp in the
 * intro stage: difficulty-1 missions map onto gather, hunt and goTo trips you were making
 * anyway, and pay 1,000–3,500 cr plus 20–50 xp. Max 5 active at once (`V2Missions.max_missions`). */
import type { AbandonMissionResponse, AcceptMissionResponse, ActiveMissionInfo, CompleteMissionResponse, MissionInfo, V2Missions } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game, type GameError } from './game.ts';
import type { Outcome } from './types.ts';
/** A board entry, with the 21 KB of dialog dropped and one line we compute for it. */
export type Offer = Omit<MissionInfo, 'dialog' | 'description'> & {
    /** What it wants, in one line from `objectives`: "20 aluminum_ore to frontier_station". */
    wants: string;
    /** Which library call would satisfy it: `gatherUntil`, `hunt`, `goTo`, `haul`, or none. */
    fits?: 'gatherUntil' | 'hunt' | 'goTo' | 'haul';
};
/** Active missions from the state section `get_active_missions` refreshes. */
export declare const activeEffect: () => Effect.Effect<V2Missions, GameError, Game>;
/** The Promise twin of `activeEffect`: throws the lib's raw error, as it always did. */
export declare function active(): Promise<V2Missions>;
/** Why this mission cannot be turned in from this dock, or undefined when it can — counting
 * a store withdrawal here as reachable, because `completeMissions` will make it. The three
 * ways a slot stays locked: the clock ran out, the goods are somewhere this trip is not, or
 * the pilot simply does not have them yet. */
export declare function stuck(m: ActiveMissionInfo): string | undefined;
/** An active mission with the two lines the board could not read off it: where its objectives
 * stand, and why it cannot be turned in here. */
export type Active = ActiveMissionInfo & {
    progress: string;
    stuck?: string;
};
/** The board here and your active missions, compact. Over `get_missions` +
 * `get_active_missions` it adds: dialog and description dropped, one `wants` line and a
 * `fits` guess per offer. Reads only. `next` names the offers that fit the intro loops. */
export declare const missionsEffect: () => Effect.Effect<Outcome<{
    board: Offer[];
    active: Active[];
    max: number;
    slots_free: number;
}>, never, Game>;
export declare function missions(): Promise<Outcome<{
    board: Offer[];
    active: Active[];
    max: number;
    slots_free: number;
}>>;
/** Accept one mission by `mission_id`. Over `accept_mission` it adds: refused when
 * `max_missions` are active, when a `provided_items` load will not fit the hold, when the
 * mission names a no-go system, or under Tired/Relaxed. Costs nothing. */
export declare const acceptMissionEffect: (id: string) => Effect.Effect<Outcome<AcceptMissionResponse>, never, Game>;
export declare function acceptMission(id: string): Promise<Outcome<AcceptMissionResponse>>;
/** Give up one active mission and free its slot. Over `abandon_mission` it adds: the
 * idempotent case (a mission seen active and now gone is `done`, nothing sent; an id this
 * account never had active is `refused`, so a placeholder cannot read as a success), and a refusal when
 * the mission could be turned in right here — the slot is about to free itself and pay for
 * it. Pass `{force:true}` to drop it anyway. Costs nothing but the mission. */
export declare const abandonMissionEffect: (id: string, opts?: {
    force?: boolean;
}) => Effect.Effect<Outcome<AbandonMissionResponse>, never, Game>;
export declare function abandonMission(id: string, opts?: {
    force?: boolean;
}): Promise<Outcome<AbandonMissionResponse>>;
/** Turn in every active mission that can be completed at this dock. Over `complete_mission`
 * it adds: the loop over the active list, a `withdraw` from the store here for a `deliver N
 * of item` objective the store can cover, and one line per mission saying what happened.
 * Never abandons: a mission it cannot finish is left in `remaining` with its `stuck` reason. */
export declare const completeMissionsEffect: () => Effect.Effect<Outcome<{
    completed: CompleteMissionResponse[];
    remaining: Active[];
}>, never, Game>;
export declare function completeMissions(): Promise<Outcome<{
    completed: CompleteMissionResponse[];
    remaining: Active[];
}>>;
