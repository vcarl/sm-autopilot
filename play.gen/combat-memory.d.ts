/** What a fight cost and what it bought, folded from the battle pushes as they arrive.
 *
 * The lib pushes `battle_update` every tick and `battle_damage` per shot; the runner listed
 * neither, so combat was played blind — three ships were lost on 2026-09-24 and nothing
 * recorded would have let anyone choose better. These frames are NOT journalled: a battle
 * pushes several a tick and `gameplay.jsonl` is already 36 MB, so they are folded here on
 * arrival into roughly a dozen numbers per fight, plus one short row per `battle_update`
 * (`FightRecord.rows`), and dropped.
 *
 * Like `markets.json`, this is memory the game does not publish: the server has no "how did I
 * do against this species last time" endpoint, so the only way to have the number is to have
 * kept it. Same discipline as `remember()` in `play/market.ts` — temp file then rename,
 * bounded by count, every entry tagged with its age.
 */
import type { BattleEndedParticipantInfo, BattleParticipantInfo, NotificationBattleDamage, NotificationBattleEnded, NotificationBattleUpdate } from '@spacemolt/lib';
import { Schema } from 'effect';
/** ponytail: the last ten fights per opponent class, so a rare quarry is not pushed out by common
 * ones. A record of ten is thin enough to stay recent and thick enough to show a worst case. */
export declare const PER_CLASS = 10;
/** ponytail: an overall ceiling of 120 fights. Pirate names can be per-individual, so retention by class
 * alone is unbounded; ~50 KB at this size. Age out by tick instead if a pilot outgrows it. */
export declare const CAP = 120;
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
/** ponytail: the last 200 rows of a fight; older ones are counted in `rows_dropped`, not kept.
 * A fight is about 25 ticks, so this only bites a stalled one; 60 fights at the cap is ~2 MB.
 * The end is kept over the start because the end is where the quarry leaves. */
export declare const ROW_CAP = 200;
/** One fight as memory keeps it: aggregates, plus the per-tick rows above. */
declare const FightRecord: Schema.Struct<{
    /** `battle_update.battle_id`, the join key to `gameplay.jsonl`. Absent on fights written before it was kept. */
    readonly battle_id: Schema.optionalKey<Schema.String>;
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
    /** `victory` when our side won, `defeat` when we did not survive (or lost an arena match), and the server's own
     * `stalemate`/`mutual_destruction`/`interrupted` otherwise. */
    readonly ending: Schema.String;
    /** Our hull as a percentage of max, first tick to last: the fight's cost. */
    readonly hull_pct_from: Schema.optionalKey<Schema.Number>;
    readonly hull_pct_to: Schema.optionalKey<Schema.Number>;
    /** Global engine tick at close, and the wall clock the age is read from. */
    readonly tick: Schema.optionalKey<Schema.Number>;
    readonly at: Schema.String;
    /** Each `battle_update`, oldest first, at most `ROW_CAP`; `rows_dropped` counts the older ones cut. */
    readonly rows: Schema.optionalKey<Schema.$Array<Schema.Struct<{
        readonly t: Schema.Number;
        readonly ms: Schema.Number;
        readonly z: Schema.optional<Schema.String>;
        readonly s: Schema.optional<Schema.String>;
        readonly o: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly n: Schema.optional<Schema.String>;
            readonly k: Schema.optional<Schema.String>;
            readonly z: Schema.optional<Schema.String>;
            readonly s: Schema.optional<Schema.String>;
            readonly h: Schema.optional<Schema.Number>;
            readonly sh: Schema.optional<Schema.Number>;
        }>>;
    }>>>;
    readonly rows_dropped: Schema.optionalKey<Schema.Number>;
    /** `player_id` → the first frame tick that combatant was seen in the `flee` stance. */
    readonly fled: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Number>>;
    /** An arena match: the challenge id it was fought for (a duel's own challenge id). Absent on every other fight. */
    readonly arena: Schema.optionalKey<Schema.String>;
    /** The arena's own score of it: `arena.status` wins/losses after against before — `neither` when both stood still. */
    readonly arena_result: Schema.optionalKey<Schema.String>;
}>;
export type FightRecord = typeof FightRecord.Type;
/** Whatever is on disk, newest fight first, or nothing: a torn or absent file is no memory. */
export declare function readCombat(dir: string | undefined): FightRecord[];
/** Temp file then rename, as `remember()` and `writeAlerts` do: a torn write would price the
 * next fight on a lie. Newest first, at most `PER_CLASS` per opponent, oldest evicted past `CAP`. */
export declare function writeFight(dir: string, fight: FightRecord, replace?: boolean): void;
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
     * damage moved the hull 2 percentage points. Never compare it against the danger line. */
    dealt_per_tick: number;
    taken_per_tick: number;
    /** Hull percentage points lost in an average fight with this opponent — the number the
     * danger line decision turns on, since the line is a fraction of max hull.
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
export interface RecentRecord {
    opponent: string;
    fights: number;
    won: number;
    stalemate: number;
    lost: number;
    avg_hull_lost?: number | undefined;
    worst_hull_lost?: number | undefined;
    thin: boolean;
}
/** The last `PER_CLASS` fights against `opponent` (`fights` is newest first, as `readCombat` returns it), or
 * undefined when never met. Arena fights count like any other: a duel costs the same hull. `lost` is defeat
 * or mutual destruction, `won` a victory, anything else a stalemate. */
export declare function recentRecord(fights: FightRecord[], opponent: string): RecentRecord | undefined;
/** Whether our hull, less the worst loss on record, stays above the danger line; undefined when no loss was read. */
export declare const covers: (rec: RecentRecord | undefined, ship: {
    hull: number;
    max_hull: number;
}) => boolean | undefined;
/** The recent record as one juncture clause. */
export declare function recordLine(rec: RecentRecord | undefined, covered: boolean | undefined): string;
/** One terse line for a juncture, where the choice to engage is actually made. It is prompt
 * budget, so: the record, what a fight costs the hull, the damage race, their accuracy by band,
 * and the age. A thin sample says "1 fight" rather than "0%", because that is what it is.
 *
 * Every number here names its unit. The damage figures say `shield+hull` because that is what
 * they sum, and the hull figure is given separately in percentage points — a pilot that read the
 * damage total as hull would break off many times too early, and the danger line it is
 * deciding against is measured in hull. */
export declare function combatLine(stats: CombatStats): string;
/** A battle push as the fold takes it: the lib's fields, any of them absent, as a live frame or a test's may leave them. */
type Pushed<T, Row> = Partial<Omit<T, 'participants'>> & {
    participants?: readonly Partial<Row>[];
};
export type BattleUpdatePush = Pushed<NotificationBattleUpdate, BattleParticipantInfo>;
export type BattleEndedPush = Pushed<NotificationBattleEnded, BattleEndedParticipantInfo>;
export type BattleDamagePush = Partial<NotificationBattleDamage>;
/** `battle_update`: the tick, the band, the stance in force, and who is on the other side. `me` is
 * our `player_id`: in a fleet battle the first row on our side may be an ally's, so ours is found by
 * id, and only the other side's rows are kept per tick (an ally fleeing is not the quarry leaving). */
export declare function foldBattleUpdate(payload: BattleUpdatePush, me?: string): void;
/** `battle_damage`: one shot. `hit_success` is the accuracy measurement, and the shot is credited to
 * the band in force when this frame arrived — the frame carries no band of its own and the tick
 * number cannot stand in for one (see `Live.by_range`). */
export declare function foldBattleDamage(payload: BattleDamagePush, me: string | undefined): void;
/** `battle_ended`: close the fold and write it. The server's own participant totals win over
 * the summed shot frames — a dropped frame would understate them, and these cannot be. */
export declare function foldBattleEnded(dir: string, payload: BattleEndedPush, me: string | undefined, tick?: number, now?: () => Date): FightRecord | undefined;
/** An arena match, closed by the play side. No `battle_ended` push has been logged for an arena battle (kvothe,
 * 2026-10-09..13: 13 matches, none in `combat.json`), so the fold `battle_update` opened is closed here with what the
 * match's own reads gave: our row's damage totals, the polls, and `arena.status`'s win/loss delta. A record a push did
 * write for this battle is marked in place; with no fold and no record, one is written from those numbers alone. */
export declare function foldArenaEnded(dir: string | undefined, match: {
    battle_id: string;
    challenge_id: string;
    opponent: string;
    result: 'win' | 'loss' | 'neither';
    dealt?: number | undefined;
    taken?: number | undefined;
    ticks: number;
}, now?: () => Date): FightRecord | undefined;
/** Drop the fold in flight. Used by the tests; a real battle ends with `battle_ended`. */
export declare const resetCombatFold: () => void;
export {};
