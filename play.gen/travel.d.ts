import type { GameState } from '@spacemolt/lib';
import { Effect } from 'effect';
import type { ReadinessAccount, ReadinessCommand } from './readiness.ts';
import { Game, type GameError } from './play/game.ts';
import { type Reconciliation } from './reconcile.ts';
export declare class TravelBlocked extends Error {
    readonly _tag: string;
}
export interface FuelRouteEvidence {
    kind: 'available_fuel' | 'capacity';
    actualFuel: number;
    quotedCost: number;
    /** The quoted route cost: admission keeps no reserve on top (the reserve is where Tired begins). */
    requiredFuel: number;
    /** Required minus available fuel; capacityShortfall measures tank infeasibility separately. */
    shortfall: number;
    capacityShortfall?: number;
    destination: TravelDestination;
    observed: {
        ship: GameState['ship'];
        location: GameState['location'];
    };
    quoteOrigin: NonNullable<GameState['location']>;
}
export declare class FuelRouteShortfall extends TravelBlocked {
    readonly evidence: FuelRouteEvidence;
    constructor(evidence: FuelRouteEvidence);
}
/** The game did not confirm where the ship is: a world condition (a timeout, an unsolicited move, a
 * ship or place that changed under the move), never a bug, so it is a failure, not a defect. */
export declare class ArrivalUnresolved extends Error {
    readonly _tag = "ArrivalUnresolved";
    /** Set when the reconciling read below showed the world moved the ship (S41, C13). */
    moved?: Reconciliation;
}
/** The server's own refusal when a battle owns the ship: `in_battle`. The move is refused and
 * never retreated from here. Breaking off is a combat decision with consequences, and this
 * codebase leaves combat to the pilot (the reason the `may_attack` permission was deleted);
 * a mover that quietly fled a fight would be making that call for it. What the mover owes the
 * pilot instead is a refusal that names the battle and the call that ends it. */
export declare class InBattle extends TravelBlocked {
    constructor(detail: string);
}
export declare const battleEnded: () => void;
/** Whether a battle holds the ship, in the one line a pilot has to read before anything else.
 * On 2026-09-25 a pilot woke at hull 3/80 inside a battle left over from the previous shift and
 * died a second after its first move, because nothing it read said it was in a fight. A refusal
 * from `battle/status` IS "no battle"; anything else is a fight, and the ship cannot travel,
 * jump or undock until it ends.
 *
 * It lives here, beside `battleHolds`, because this is the module that owns whether a battle
 * holds the ship: an authoritative read is the best answer there is, so it sets the flag the
 * refused-move memory below is built on rather than becoming a second copy of it. A lost reply
 * is no answer either, so it reads as no battle too; a defect (a bug) is not swallowed. */
export interface BattleNow {
    opponent: string;
    tick: number;
}
export declare const battleNowEffect: () => Effect.Effect<{
    opponent: string;
    tick: number;
} | undefined, never, Game>;
/** The Promise twin of `battleNowEffect`, for callers not yet converted. */
export declare function battleNow(send: ReadinessCommand): Promise<BattleNow | undefined>;
export interface TravelDestination {
    system_id: string;
    poi_id?: string;
    base_id?: string;
}
/** A leg is admitted when the tank covers its quoted route, and nothing more. The mood's fuel
 * reserve is not a travel margin: it is the line under which the runtime imposes Tired
 * (`crossed` in play/runtime.ts), and Tired's own rules send the pilot to service. A margin
 * added here kept fuel above that line forever, so Tired never fired and a pilot with 26 fuel
 * was refused a 4-fuel trip for want of Focused's 24 (operator's decision, 2026-09-26). */
export interface TravelOptions {
    maxJumps?: number | null;
    checkpoint?: (settled?: boolean) => Promise<void>;
    beforeMove?: () => Promise<void>;
    refuel?: (minimum: number) => Promise<void>;
    /** `refuel` as an Effect, for an Effect caller: it wins over `refuel` when both are given. */
    refuelWith?: (minimum: number) => Effect.Effect<void, never, Game>;
    onJump?: () => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    maxWaitMs?: number;
    pollMs?: number;
    liveReadMs?: number;
}
/** Account.refresh always queries get_status. A cargo/hull push must never postpone it. */
export declare function waitForArrival(account: ReadinessAccount, predicate: (state: GameState) => boolean, options?: TravelOptions): Promise<void>;
/** A Promise step of travel's: the lib's refusal or a lost reply is its tag, travel's own refusals thrown from
 * it (a pilot stop is a `TravelBlocked`, an unconfirmed arrival `ArrivalUnresolved`) are failures as they are,
 * and anything else is a defect. */
export declare const travelStep: <A>(label: string, body: () => Promise<A>) => Effect.Effect<A, GameError | TravelBlocked | ArrivalUnresolved, never>;
/** One shared movement path; policy, spending and command ownership stay with the caller. Every game
 * command goes through `Game`, so a refusal is a tag: `InBattle` ends in travel's own `InBattle`, any
 * other refusal or lost reply fails with its tag, and a lost reply is never re-sent. Travel's own
 * refusals (`TravelBlocked`, `FuelRouteShortfall`, `InBattle`) and the dock's `DockBlocked` are failures,
 * so a caller that wants them reads the error channel; the unconverted Promise callers still branch on
 * `instanceof` through `rawError`. `ArrivalUnresolved` and `Stopped` (thrown from a checkpoint) cross from
 * the Promise seams through `travelStep`, so they are failures too; anything else a hook throws is a defect. */
export declare const travelToEffect: (account: ReadinessAccount, destination: TravelDestination, options: TravelOptions) => Effect.Effect<{
    jumps: number;
    location: import("@spacemolt/lib").V2Location | undefined;
}, GameError | TravelBlocked | ArrivalUnresolved, Game>;
/** The Promise twin of `travelToEffect`, for callers not yet converted: a failure exit throws the
 * raw error, so a refusal reaches them as the lib's `SpacemoltError` and travel's own classes as
 * themselves. */
export declare function travelTo(account: ReadinessAccount, command: ReadinessCommand, destination: TravelDestination, options?: TravelOptions): Promise<{
    jumps: number;
    location: import("@spacemolt/lib").V2Location | undefined;
}>;
