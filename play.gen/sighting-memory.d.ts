import { Schema } from 'effect';
/** ponytail: the last 200 rows, which is roughly forty looks at five species each and about
 * 20 KB — a wider circuit than the 12 bases `play/market.ts` keeps books for. Age rows out by
 * tick instead the day a pilot sweeps more POIs than that in one session. */
export declare const CAP = 200;
/** A tick is ten seconds of real time, as in `combat-memory.ts`.
 * ponytail: ages are wall-clock elapsed converted at this rate, not a server tick delta —
 * `account.currentTick` is only reachable inside the bridge. `Sighting.tick` stores the real
 * tick for the day a caller has one. */
export declare const TICK_MS = 10000;
/** How long a sighting of live prey is still worth flying to. Thirty minutes at ten seconds a tick.
 * The game publishes no wander or respawn rate, so this started as a guess — but it now has one
 * real data point behind it, and the point is consistent with it: on 2026-09-25 a belt that had held
 * every one of the day's ten fights was empty on two visits four hours later, and the region's only
 * fauna had moved to a nebula. Presence decays over hours, so believing one for half an hour is
 * inside the evidence. Believing it too long only costs a wasted look, which is the cheap direction
 * to be wrong in. */
export declare const PRESENCE_STALE = 180;
/** How long an absence is trusted, deliberately shorter than `PRESENCE_STALE`: believing an
 * absence too long costs a POI that has prey being skipped forever, which is the expensive
 * direction. Also a guess. */
export declare const ABSENCE_STALE = 90;
/** One species at one POI at one look. `count` is how many were seen, `legal` how many were
 * engageable — neither `in_combat` nor `branded`, the two refusals `play/combat/hunting.ts`
 * spends a trip discovering. A row with no `species` is an empty look: nothing was there. */
declare const Sighting: Schema.Struct<{
    readonly poi_id: Schema.String;
    readonly species: Schema.optionalKey<Schema.String>;
    readonly count: Schema.Number;
    readonly legal: Schema.Number;
    readonly at: Schema.String;
    readonly tick: Schema.optionalKey<Schema.Number>;
}>;
export type Sighting = typeof Sighting.Type;
/** A whole look at one POI, which is the unit that gets written: a look supersedes everything
 * remembered about that POI, because a fresher answer about the same rock is the only answer.
 * An empty `seen` is the empty look.
 *
 * **`seen` must be complete.** It is every creature `get_nearby` listed at that POI, not a
 * filtered subset — there is no per-species query to make a partial look out of. `recall` leans
 * on this: a species missing from a look is a species that was not there, which is half of what
 * a look is worth. A caller that writes a filtered `seen` would turn that into a lie. */
export interface Look {
    poi_id: string;
    tick?: number;
    seen: {
        species: string;
        count: number;
        legal: number;
    }[];
}
/** Whatever is on disk, newest row first, or nothing: a torn or absent file is no memory. */
export declare function readSightings(dir: string | undefined): Sighting[];
/** Temp file then rename, as `writeFight` does: a torn write would send a pilot somewhere on a
 * lie. Rows for this POI are replaced, not appended to, and the oldest are evicted past `CAP`. */
export declare function writeLook(dir: string, look: Look, now?: () => Date): Sighting[];
/** Age in ticks, computed at read and never stored. Unlike `fightTicksOld`, an unparseable or
 * missing stamp reads as infinitely old rather than as 0: a fight record is sizing a risk the
 * pilot has already taken, but this memory decides where to GO, and an undateable row that
 * reads as fresh would send it there on nothing. Old is the safe direction here — a presence
 * that reads stale costs one look, an absence that reads fresh costs the POI. */
export declare const sightingTicksOld: (at: string, now: number) => number;
/** The three states memory can be in about a POI, as a discriminated union so the caller
 * branches on `state` and never parses prose: `seen` carries the counts and their age,
 * `stale` carries only an age (we looked, we no longer know), `unlooked` carries nothing. */
export type Recall = {
    poi_id: string;
    species?: string;
} & ({
    state: 'seen';
    count: number;
    legal: number;
    ticks_old: number;
} | {
    state: 'stale';
    ticks_old: number;
} | {
    state: 'unlooked';
});
/** What we remember about `species` at `poi_id`, and how old it is. A species-less row — an
 * empty look — answers for every species, since `get_nearby` lists all that are present. With
 * no species named, the whole newest look at that POI is summed. */
export declare function recall(rows: Sighting[], poi_id: string, species?: string, now?: number): Recall;
export {};
