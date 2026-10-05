/** Hunting: wildlife anywhere (legal everywhere), pirates in low-police space. The only loops
 * that train weapons, gunnery, tactics, and — by being hit — shields and armor. */
import type { CreatureInfo, EnrichedWreck, GetBattleStatusResponse, PirateInfo } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game } from '../game.ts';
import type { Outcome, Row } from '../types.ts';
import { type CombatStats } from '../../combat-memory.ts';
/** Re-exported so a pilot naming the type in its own helper can reach it through `play`. */
export type { CombatStats } from '../../combat-memory.ts';
export interface Fight {
    target: CreatureInfo | PirateInfo;
    /** The last `battle/status` read before the battle ended. */
    last_status?: GetBattleStatusResponse;
    outcome: 'down' | 'escaped' | 'broke off' | 'unresolved';
    /** What the loop saw, when the outcome needs it: the quarry running is the case that has one. */
    why?: string;
    hull_before: number;
    hull_after: number;
    /** The wreck it left and what was looted from it. */
    wreck?: EnrichedWreck;
    loot: Row[];
}
/** One place the search looked at, in the order it was tried. `saw` counts the prey asked for
 * (every creature, when no species was named, or when `strict` is false — a named species is a
 * preference there, not a filter) and `legal` how many of those were engageable under the rules
 * actually applied (species-restricted only under `strict`); `flew` says whether reaching it
 * cost a trip. A stop with `saw: 0` is the useful half of a search — it is the fact that stops
 * the same rock being paid for twice. */
export interface Looked {
    poi_id: string;
    saw: number;
    legal: number;
    flew: boolean;
}
export interface Hunted {
    /** Where the hunt ended up: the POI it fought at, or the last one it looked at. */
    poi_id: string;
    fights: Fight[];
    /** Every place looked at, in order. One entry for a hunt that stood still. */
    looked: Looked[];
    /** Why the loop ended: `asked` fights done, nothing at the one place looked, nothing at any
     * of several, a tank that cannot cover the next hop, hull line, hold full, tired. */
    ended: 'asked' | 'nothing here' | 'nothing found' | 'fuel' | 'hull' | 'hold full' | 'stopped' | 'tired';
}
/** The stances a decision may ask for. `board` is deliberately absent: it needs marines and
 * suppresses our own weapons, so it is a boarding party's call, not a tactical one, and a
 * callback that asks for it should not compile. Percentages are in `README.md`. */
export type CombatStance = 'fire' | 'evade' | 'brace' | 'flee';
/** What the callback sees on one battle tick: a snapshot read from that tick's own
 * `battle/status`, never a handle on the fight. Every field is measured this tick except
 * `stats`, which is what memory remembers of earlier fights with this opponent. */
export interface TickView {
    /** The battle's own round counter as the server reports it (`GetBattleStatusResponse
     * .tick_duration`, "Ticks the battle has been running") — not the ten-second game tick.
     *
     * **Do not use it to tell rounds apart.** Live it stalls for minutes and has been observed going
     * backwards: 0,1,2,1,1,1,1,1,2 across nine successive polls of one continuous fight, while the
     * quarry's hull fell 100→20. This callback is invoked once per poll, and the poll is the round;
     * the number is passed through for reporting, not for control flow. If you need to count rounds,
     * count your own invocations. */
    tick: number;
    /** Our hull now, and the hull this ship has when whole. */
    hull: number;
    max_hull: number;
    /** Our shield, percent of max. 0 when the status did not publish one. */
    shield_pct: number;
    /** The quarry's display name, and its hull as a fraction of max (0..1). */
    opponent: string;
    opponent_hull: number;
    /** The range band between the two ships: `inner`, `mid` or `outer` on the live server.
     * Range is what accuracy is measured against, which is why `closeIn`/`backOff` matter. */
    range: string;
    /** Distance to the quarry and the reach of our longest weapon, in the game's own units. */
    distance: number;
    reach: number;
    /** Hull lost since the previous tick — and, on the first tick, since the fight opened. */
    damage_taken: number;
    /** The stance the loop last set, or undefined before it has set one. */
    stance?: CombatStance;
    /** The mood's walk-away hull. No decision can cross it: see `README.md`. */
    floor: number;
    /** What memory knows about fighting this opponent, or undefined the first time it is met.
     * `thin` is true while the sample is under three fights, and then every number is an
     * anecdote rather than a measurement. */
    stats?: CombatStats;
}
/** What the callback asks for. Everything is optional and returning `undefined` means "no
 * change" — which is how a pilot deciding every third tick is written without the library
 * baking in a cadence. The server takes one mutation a tick, so at most one field is acted on,
 * in the order below, and the journal says what was asked against what happened. */
export interface TickDecision {
    /** The stance to hold from this tick on. */
    stance?: CombatStance;
    /** A range maneuver, not an exit. `closeIn` is `battle/advance` and shortens the range;
     * `backOff` is `battle/retreat`, which the server answers "Retreating from the enemy." and
     * which opens the range while the battle carries on. Leaving is `disengage`, below. */
    move?: 'closeIn' | 'backOff';
    /** Focus fire on this participant id. */
    focus?: string;
    /** Break off: `stance flee` until the battle ends, bracing if the flee cannot get away. The
     * only exit there is — `backOff` above opens the range and leaves the ship in the fight. */
    disengage?: true;
}
/** ponytail: one tick and one ceiling, not a config system. A battle tick is ten seconds of
 * real time, the server takes one mutation per tick and throttles reads, so the loop reads
 * once and acts once a tick; five minutes is a fight that is not going to end. `pace` is a
 * knob only because the tests cannot sit through real ticks. */
export declare const pace: {
    tickMs: number;
};
export declare const FIGHT_CEILING_MS: number;
/** Break off, and see it through. `spacemolt_battle/retreat` is a RANGE maneuver, not an exit:
 * it sits beside `advance` in `BattleResponse.action`, the live server answers "Retreating from
 * the enemy." and the battle carries on. Re-issuing it waits for an end it cannot bring — on
 * 2026-09-25 that was one "breaking off" and fourteen "the battle has not ended yet" in ninety
 * seconds, and on 2026-09-24 the same shape lost the ship from hull 61 to 29.
 *
 * The exit is `stance flee`: 0% dealt, 100% taken, and it auto-retreats to escape. Two facts
 * bound it. Flee takes four times `brace`'s damage, and the escape can fail outright — an
 * equal or faster opponent kites the flee movement — so an unbounded flee against a faster
 * enemy is the worst cell in the stance table. And battles end on their own, every observed
 * one at 5–22 ticks. So the flee gets `FLEE_TICKS` ticks to work, and when it has not, the
 * fight is waited out under `brace` (0% dealt, 25% taken, shields regen 2×) instead, which is
 * a quarter of the damage for the same wait. A stance holds until it is changed, so each is
 * sent once rather than re-issued.
 *
 * The stop flag is deliberately not checked: a pilot asking to stop does not mean abandoning
 * the ship in a fight.
 *
 * True when the battle ended. False when the bound ran out with the battle still on, or with its
 * status never read (lost or unreadable replies are not its end), which is the one state a pilot
 * must be told about, because nothing will move the ship until it ends. */
export declare const FLEE_TICKS = 3;
/** `disengage` as an Effect, for `disengage` below and for `engage`; never in a barrel. A stance the game refuses is sent
 * again next tick, since nothing landed; one whose reply is lost is not, since it may have, and the status read decides.
 * `over` is the battle read ended; at the bound, `on` is it read still going and `unknown` is its status never read. */
export declare const disengageEffect: (bound?: number) => Effect.Effect<"unknown" | "on" | "over", never, Game>;
export declare function disengage(bound?: number): Promise<boolean>;
/** Hunt a prey across a range of places to look. `look` is POI ids in the order to try them: at
 * each one the habitat is read, and the fight happens where the prey actually is. `poi` is the
 * one-place shorthand, and naming neither hunts where you stand. Up to `fights` fights (default
 * 1) in total across the whole search, against creatures (default) or pirates
 * (`target:'pirate'`), looting the wreck each kill leaves. Coming home, stowing and servicing
 * are `goTo`, `stow` and `service` — this function searches, fights and loots, nothing else.
 *
 * **Fauna is not knowable before arrival.** POI rows carry no fauna field and there is no
 * per-species query, so nothing can tell you which belt holds your prey before you are standing
 * in it. That is why this takes a list rather than a destination: being sent to one belt on a
 * guess is how a pilot spends a shift finding nothing. Every look is written to this runtime's
 * sighting memory, the empty ones included, so the next search starts from what was seen rather
 * than from the same guess — and a remembered look reports its own age, because stale fauna is
 * a lie (`sighting-memory.ts`).
 *
 * **The looking is bounded by fuel.** Before each hop the route is re-quoted and checked
 * against the tank, and the search ENDS rather than skipping on: a pilot that
 * cannot afford the next POI cannot afford the one after it either, and `ended:'fuel'` names the
 * place that stopped it. `goTo` enforces the same check itself — this check is what lets the
 * search stop cleanly and say where, instead of accumulating refusals.
 *
 * Nothing to hunt is `done`, never `refused`: the fact was learned and nothing was spent
 * fighting. One place looked at is `ended:'nothing here'`, several is `ended:'nothing found'`,
 * and `detail.looked` names each one and what was in it.
 *
 * `species` takes one id or a list — any of them counts as named. By default (`strict` unset or
 * false) a named species is a PREFERENCE: at each place, and again on every fight's fresh read,
 * a legal creature of a named species is fought if one is present, and the first legal creature
 * of any species otherwise — the same fallback an unnamed hunt already gives an active mission's
 * quarry. `strict:true` is today's stricter rule: only named species are fought, and everything
 * else here is declined with the same refusal text. Use `strict` only when a second species
 * would not do — a mission that counts kills of one species and nothing else. Left unset, a
 * species an active mission's own words name is preferred over the first legal one. Which
 * species was actually fought is on `fight.target.species`, so a fallback fight is never hidden.
 *
 * Refused before firing without a fitted weapon (`V2Module.type === 'weapon'`) holding
 * ammunition; an empty magazine whose rounds are in the hold is reloaded instead. Costs
 * ammunition and hull. Trains weapons, gunnery, tactics, and — by being hit — shields and
 * armor, plus xenobiology (creatures) or bounty_hunting (pirates). The mood's walk-away
 * fraction (Cautious 0.95 … Aggressive 0.80) breaks the fight off; a Tired imposed mid-fight
 * finishes the round, retreats, and returns `partial`.
 *
 * `onTick` is the pilot's own hand on the stance. It is called once a battle tick with a
 * `TickView` and returns a `TickDecision` or `undefined` for "no change" — synchronously,
 * because a tick is ten seconds and one model call is minutes, so the tactics have to be
 * authored in advance and carried out inside the fight. It issues no commands itself: `hunt` applies
 * one field a tick, validates it, and journals what was asked against what was sent. A callback
 * that throws is logged and the default loop carries on. The mood's walk-away line outranks it
 * always — a decision that would keep fighting under the line is refused and said so. */
export declare function hunt(opts?: {
    poi?: string;
    look?: string[];
    fights?: number;
    species?: string | string[];
    strict?: boolean;
    target?: 'creature' | 'pirate';
    onTick?: (view: TickView) => TickDecision | undefined;
}): Promise<Outcome<Hunted>>;
/** `hunt` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal or a lost reply on a
 * command ends the hunt naming the action and the code; a mutation whose reply is lost is never re-sent, and a
 * pilot stop is a partial hunt, not a defect. */
export declare const huntEffect: (opts?: {
    poi?: string;
    look?: string[];
    fights?: number;
    species?: string | string[];
    strict?: boolean;
    target?: "creature" | "pirate";
    onTick?: (view: TickView) => TickDecision | undefined;
}) => Effect.Effect<Outcome<Hunted>, never, Game | import("../runtime.ts").Run>;
