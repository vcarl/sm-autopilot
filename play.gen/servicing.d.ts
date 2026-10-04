import type { MarketListingItem } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game, type GameError } from './play/game.ts';
import type { ReadinessAccount } from './readiness.ts';
import { type Mood } from './mood-policy.ts';
export interface ServiceFuelQuote {
    observed_at: string;
    base_id: string;
    system_id: string;
    poi_id: string;
    ship_id: string;
    max_fuel: number;
    unit_price: number | null;
}
export interface ServiceOptions {
    mood: Mood;
    /** A standing permission (D11), independent of the mood. */
    creditReserve?: number;
    /** The runtime whose market memory the fuel-cell price is checked against and written to. */
    runtime?: string;
    /** False skips the fuel-cell top-up: a freighter's hold is its circuit's to plan. */
    cells?: boolean;
    /** False keeps this fill's prices off the pilot's next `trade` line: the quote is one per
     * bridge, and a freighter serviced in it is not the pilot (its trades carry no quote). */
    quotes?: boolean;
}
/** The fuel-cell top-up that follows a fill: cells aboard against the reserve, what was bought
 * for what, and `skipped` saying why nothing was when the reserve was due. */
export interface CellTopUp {
    held: number;
    target: number;
    bought: number;
    spent: number;
    skipped?: string;
}
export interface ServiceOutcome {
    satisfied: true;
    issued: string[];
    spent: number;
    fuel: number;
    hull: number;
    cells?: CellTopUp;
    /** Present when the wallet (or the margin) covered only part of the bill: what was not bought, and why. */
    short?: string[];
}
declare const ServiceBlocked_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ServiceBlocked";
} & Readonly<A>;
/** Carries the units still missing, so a caller can never mistake it for readiness. `message` is
 * what the pilot is told; `gather-job.ts` and the freighter read it and check `instanceof`. */
export declare class ServiceBlocked extends ServiceBlocked_base<{
    readonly blockers: readonly string[];
    readonly message: string;
}> {
}
declare const ServiceUnsafe_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ServiceUnsafe";
} & Readonly<A>;
/** The ship, wallet or dock was not what servicing needs, or changed under it: nothing more is spent. */
export declare class ServiceUnsafe extends ServiceUnsafe_base<{
    readonly message: string;
}> {
}
/** Servicing is script-owned: the mood resolves the spend margin and D3 resolves the
 * targets. The margin meters the repair only: fuel is resupply, and a mood never strands a ship,
 * so a refuel is bounded by the wallet and `creditReserve` alone. A serviced dock restores the full tank and full hull; the mood's retreat
 * fraction is the away-from-dock line, not a service target. The post-state is read
 * authoritatively and decides.
 *
 * Where the bill does not fit whole, it buys what fits: the refuel first (resupply), then the
 * repair if what is left above the reserve still covers it. What was not bought comes back in
 * `short`; only a counter where nothing fits fails with `ServiceBlocked`.
 *
 * A docked counter bills on credits and reports the charge afterwards, so a posted price is an
 * estimate and never a precondition: `fuel_price_all_in` and `repair_price_per_hull` are
 * owner-set on player stations ("Owner-set per-hull-point repair price (player station)",
 * `@spacemolt/lib` types.gen.d.ts), so an ordinary NPC counter posts nothing for the hull and
 * repairs to full anyway (proved live 2026-09-24: 59 → 80 hull for 105 credits at
 * sirius_observatory_station, whose `get_base` carries no `repair_price_per_hull`). Requiring
 * that field is what wedged a pilot in Tired for six hours.
 *
 * `creditReserve` is the standing bound and is never widened. It cannot be quoted exactly
 * before an unpriced service, so it is enforced twice: the posted estimate must leave it intact
 * beforehand, and the canonical charge is measured against it after each call — a breach stops
 * anything further being bought and names the reserve.
 *
 * A lost reply on the refuel or the repair is never re-sent: it fails with the tag, and the
 * caller's own re-read says what landed. */
export declare const serviceShipEffect: (account: ReadinessAccount, options: ServiceOptions) => Effect.Effect<ServiceOutcome, GameError | ServiceBlocked | ServiceUnsafe, Game>;
/** A live cell price over this multiple of the remembered median is not paid. */
export declare const CELL_PRICE_BOUND = 1.5;
/** One `view_market` row as the book memory keeps it. The live server omits spec fields, so a row is
 * built from what it carries (a missing number is 0, a missing list empty), never decoded whole. */
export declare const listing: (raw: unknown) => MarketListingItem[];
/** A refusal or lost reply in the words `skipped` and `why` carry. */
export declare const words: (error: GameError) => string;
export {};
