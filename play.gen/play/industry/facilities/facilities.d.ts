/** Owning production. Not a separate specialty: the stage the Industry career grows into once
 * a bench's margins are proven, so the pilot who already stands at the counter keeps the fee
 * instead of paying it. A build grants corporation_management xp once, and a facility bills rent
 * every cycle (100 ticks, ~17 min) from your wallet, everywhere it stands, whether or not you
 * are there to see it.
 */
import { Effect } from 'effect';
import type { FacilityTypeSummary, OwnedFacilityEntry } from '@spacemolt/lib';
import { Game } from '../../game.ts';
import type { Outcome } from '../../types.ts';
/** The owned entry beside the one number the game does not compute: how many cycles the
 * wallet covers at the TOTAL rent across every facility you own, everywhere — not this one's
 * rent alone, because the wallet that pays it is the same wallet for all of them. */
export type Owned = OwnedFacilityEntry & {
    runway_cycles: number;
};
/** A facility at this station worth queuing a job at: yours, or public with a fee. `id` is
 * what the owner verbs below and a bench's `at` option take. */
export interface Rentable {
    id: string;
    type: string;
    name: string;
    recipe_id?: string;
    labour?: number;
    fee_per_run?: number;
    public: boolean;
}
type Facilities = {
    owned: Owned[];
    here: Rentable[];
    buildable: FacilityTypeSummary[];
};
/** Your facilities everywhere, what is rentable at this station, and what you could build
 * here. Reads only (`facility/owned`, `facility/list`, `facility/types` for the production and
 * personal categories) — never `job_list`, which fails for a facility you are not docked at.
 * Each read is independent: one the game refuses, loses or answers off-spec does not fail the
 * others, and `did` says which (a bug still does).
 * `next` warns when the rent runway is under the game's own grace period. */
export declare function facilities(): Promise<Outcome<Facilities>>;
/** `facilities` as an Effect, for `edge` and for converted callers; never in a barrel. A read the
 * game refuses or loses, or whose reply is not the spec's, is named in `failed` and the others go on. */
export declare const facilitiesEffect: () => Effect.Effect<Outcome<{
    owned: Owned[];
    here: Rentable[];
    buildable: FacilityTypeSummary[];
}>, never, Game>;
export interface Built {
    facility_id: string;
    rent_per_cycle: number;
    ready_tick?: number;
}
/** Build a facility of `type` at this station: quarters first if the game asks for them, then
 * a workshop of your own. Owned already here → `done`, nothing sent. Refused, naming the
 * shortfall, when this station's store is short a build material or the price would breach
 * `credit_reserve`. Costs the build price at commit; construction pauses rent until it
 * completes; the build grants corporation_management xp once. */
export declare function buildFacility(type: string): Promise<Outcome<Built>>;
/** `buildFacility` as an Effect, for `edge` and for converted callers; never in a barrel. The
 * build command's own refusal or lost reply is a `failed` Outcome naming it; the reads before and
 * after it end the run as they always have. A build reply without its id is found in owned() by type. */
export declare const buildFacilityEffect: (type: string) => Effect.Effect<Outcome<{
    facility_id: string;
    rent_per_cycle: number;
}>, never, Game>;
export {};
