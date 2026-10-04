import { Schema } from 'effect';
/** ponytail: the last 60 fights, whole. A night's hunting is twenty; sixty is three nights and
 * about 25 KB. Age out by tick instead the day a pilot fights more than that in a session. */
export declare const CAP = 60;
/** Fights below which every number here is an anecdote and the shape says so. */
export declare const THIN = 3;
/** A battle tick is ten seconds of real time (`play/combat/hunting.ts`'s `pace`).
 * ponytail: ages are wall-clock elapsed converted at this rate, not a server tick delta —
 * `account.currentTick` is only reachable inside the bridge, and neither the menu nor a
 * running job has it. `FightRecord.tick` stores the real tick for the day one of them does. */
export declare const TICK_MS = 10000;
/** Shots seen at one range band, one direction. `hits` is `battle_damage.hit_success`, which is
 * the only place accuracy is published at all. */
declare const Shots: Schema.Struct<{
    readonly shots: Schema.Number;
    readonly hits: Schema.Number;
}>;
export type Shots = typeof Shots.Type;
/** The live server publishes FIVE values in `battle_update.your_zone`, not the three this file
 * was written for: `outer`, `mid`, `inner`, `engaged`, and nothing at all. Measured on the kvothe
 * profile's `combat.json`: inner 168 shots, engaged 11, unknown 10, outer 12, mid 8.
 *
 * `engaged` folds into `inner` — it is the closest band, and keeping them apart starves both
 * samples of the shots that would make either one a rate. `unknown` does NOT fold: a tick whose
 * zone was never pushed is a shot we cannot place, and attributing it to the last known zone
 * would invent a band to make a sample look thicker, which is a lie about a measurement. It stays
 * visible as itself so the pilot can see how much of the record is unplaced. */
export declare const bandOf: (zone: string | undefined) => string;
/** One fight as memory keeps it: aggregates, never a transcript. */
declare const FightRecord: Schema.Struct<{
    /** The opponent as the frames name it — `battle_update.participants[].username`, which for
     * wildlife is its display name and is what `get_nearby` calls it too. The frames carry no
     * species id, so this is the key. */
    readonly opponent: Schema.String;
    /** The opponent's hull class when the frames named one. */
    readonly opponent_class: Schema.optionalKey<Schema.String>;
    /** OUR hull class in this fight. Win chance is species versus class, not species alone, so
     * both are recorded and neither is baked into the key. */
    readonly ship_class: Schema.optionalKey<Schema.String>;
    /** Battle ticks the fight lasted (`battle_ended.duration`). */
    readonly ticks: Schema.Number;
    /** Shots per range band, both directions: `at_us` is their accuracy against us, `at_them`
     * ours against them. A tick whose band was never pushed lands under `unknown`. */
    readonly by_range: Schema.$Record<Schema.String, Schema.Struct<{
        readonly at_us: Schema.Struct<{
            readonly shots: Schema.Number;
            readonly hits: Schema.Number;
        }>;
        readonly at_them: Schema.Struct<{
            readonly shots: Schema.Number;
            readonly hits: Schema.Number;
        }>;
    }>>;
    /** The server's own fight totals (`battle_ended.participants[]`), hull and shield together. */
    readonly dealt: Schema.Number;
    readonly taken: Schema.Number;
    /** The stances that were actually in force, in order, collapsed to the changes. */
    readonly stances: Schema.$Array<Schema.String>;
    /** Ticks observed in the `flee` stance. The retreat COMMAND is not in the push frames — the
     * command seam journals every `spacemolt_battle/retreat` — so this is the stance, not the ask. */
    readonly flee_ticks: Schema.Number;
    /** `victory` when our side won, `defeat` when we did not survive, and the server's own
     * `stalemate`/`mutual_destruction`/`interrupted` otherwise. */
    readonly ending: Schema.String;
    /** Our hull as a percentage of max, first tick to last: the fight's cost. */
    readonly hull_pct_from: Schema.optionalKey<Schema.Number>;
    readonly hull_pct_to: Schema.optionalKey<Schema.Number>;
    /** Global engine tick at close, and the wall clock the age is read from. */
    readonly tick: Schema.optionalKey<Schema.Number>;
    readonly at: Schema.String;
}>;
export type FightRecord = typeof FightRecord.Type;
/** Whatever is on disk, newest fight first, or nothing: a torn or absent file is no memory. */
export declare function readCombat(dir: string | undefined): FightRecord[];
/** Temp file then rename, as `remember()` and `writeAlerts` do: a torn write would price the
 * next fight on a lie. Newest first, oldest evicted past `CAP`. */
export declare function writeFight(dir: string, fight: FightRecord): void;
/** The three metrics the record exists to answer, for one opponent. Every number carries the
 * sample it rests on, because an estimate from one fight is an anecdote and must read as one. */
export interface CombatStats {
    opponent: string;
    /** Fights folded in, and the age of the newest and oldest, in ticks. */
    fights: number;
    won: number;
    newest_ticks_old: number;
    oldest_ticks_old: number;
    /** Our hull classes across those fights. Two classes is two different questions answered as one. */
    ship_classes: string[];
    /** Average damage per battle tick, ours out and theirs in. **Shield and hull together** —
     * `battle_damage` publishes `shield_hit` and `hull_hit` and this is their sum, which on the live
     * server is overwhelmingly shield. Read as hull it is wildly alarming: a 25-tick fight taking 39
     * damage moved the hull 2 percentage points. Never compare it against the walk-away line. */
    dealt_per_tick: number;
    taken_per_tick: number;
    /** Hull percentage points lost in an average fight with this opponent — the number the
     * walk-away decision actually turns on, since the mood's line is a fraction of max hull.
     * `undefined` when no fight recorded a hull reading at both ends. */
    hull_pct_lost?: number;
    /** Measured accuracy by range band, 0..1, each with the shots it rests on. A band with no
     * shots is absent rather than 0 — nothing was measured there. */
    accuracy: Record<string, {
        at_us?: number | undefined;
        at_us_shots: number;
        at_them?: number | undefined;
        at_them_shots: number;
    }>;
    /** Wins over fights, present only once there are `THIN` fights to divide. Below that the
     * caller has `won` and `fights` and no rate is offered, because none would be one. */
    win_chance?: number;
    /** True while the sample is under `THIN`: every number above is an anecdote. */
    thin: boolean;
}
/** Age in ticks, computed at read and never stored. An entry written before ages were tagged,
 * or with an unparseable stamp, reads as 0 — "as fresh as this call" is the reading that makes
 * a pilot distrust nothing it should trust; the fight count is what bounds the confidence. */
export declare const fightTicksOld: (at: string, now: number) => number;
/** What memory knows about fighting this opponent, or undefined when it has never met one. */
export declare function statsFor(fights: FightRecord[], opponent: string, now?: number): CombatStats | undefined;
/** One terse line for a juncture, where the choice to engage is actually made. It is prompt
 * budget, so: the record, what a fight costs the hull, the damage race, their accuracy by band,
 * and the age. A thin sample says "1 fight" rather than "0%", because that is what it is.
 *
 * Every number here names its unit. The damage figures say `shield+hull` because that is what
 * they sum, and the hull figure is given separately in percentage points — a pilot that read the
 * damage total as hull would break off many times too early, and the walk-away line it is
 * deciding against is measured in hull. */
export declare function combatLine(stats: CombatStats): string;
/** `battle_update`: the tick, the band, the stance in force, and who is on the other side. */
export declare function foldBattleUpdate(payload: Record<string, unknown>): void;
/** `battle_damage`: one shot. `hit_success` is the accuracy measurement, and the shot is credited to
 * the band in force when this frame arrived — the frame carries no band of its own and the tick
 * number cannot stand in for one (see `Live.by_range`). */
export declare function foldBattleDamage(payload: Record<string, unknown>, me: string | undefined): void;
/** `battle_ended`: close the fold and write it. The server's own participant totals win over
 * the summed shot frames — a dropped frame would understate them, and these cannot be. */
export declare function foldBattleEnded(dir: string, payload: Record<string, unknown>, me: string | undefined, tick?: number, now?: () => Date): FightRecord | undefined;
/** Drop the fold in flight. Used by the tests; a real battle ends with `battle_ended`. */
export declare const resetCombatFold: () => void;
export {};
