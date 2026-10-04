/** The hangar: modules on the ship you fly, and the next hull. */
import type { CommissionQuoteResponse, InsurancePolicy, ShipClass, ShipListing, V2Module, V2Ship } from '@spacemolt/lib';
import { Effect, Schema } from 'effect';
import { Game, type GameError } from './game.ts';
import type { Outcome } from './types.ts';
export interface Fit {
    installed: string[];
    removed: string[];
    /** The fitted modules after the change. */
    modules: V2Module[];
    /** The grid after the change: `cpu_used/cpu_capacity`, `power_used/power_capacity`. */
    ship: Pick<V2Ship, 'cpu_used' | 'cpu_capacity' | 'power_used' | 'power_capacity' | 'utility_slots' | 'weapon_slots' | 'defense_slots'>;
    /** Module ids that would not fit and why. */
    short: {
        id: string;
        why: string;
    }[];
}
/** The grid a change is measured against: the hull, the modules on it, and the draw so far.
 * A simulated remove takes a module off this copy, which is how the slot a later install
 * needs is known to be free before anything is sent. */
export interface Bench {
    ship: V2Ship | undefined;
    fitted: V2Module[];
    cpu: number;
    power: number;
}
/** The bench as the ship stands right now. */
export declare function bench(): Bench;
/** The slot kind a module takes and its grid draw: all `refit` and `buy` need to know of it. */
declare const ModuleSpec: Schema.Struct<{
    readonly name: Schema.String;
    readonly type: Schema.String;
    readonly slot: Schema.String;
    readonly size: Schema.Number;
    readonly cpu_usage: Schema.Number;
    readonly power_usage: Schema.Number;
}>;
export type ModuleSpec = typeof ModuleSpec.Type;
/** What the catalog says fitting this module costs: the slot kind it takes and its grid
 * draw (`spacemolt/inspect`, which answers `kind: 'module'` only for a module). `null` for
 * anything that is not a module, which is how `buy` tells ore from a cargo expander.
 * `undefined` when the answer was there but not readable: said in a step, and not the same as
 * "not a module". */
export declare const moduleSpecEffect: (typeId: string) => Effect.Effect<{
    readonly name: string;
    readonly type: string;
    readonly slot: string;
    readonly size: number;
    readonly cpu_usage: number;
    readonly power_usage: number;
} | null | undefined, GameError, Game>;
export declare const moduleSpec: (typeId: string) => Promise<ModuleSpec | null>;
/** Why one more module of this spec would not fit the bench, naming the fix; `null` when it
 * fits. The one check `refit` and `buy` share: a module that could not be fitted is refused
 * at the counter, not discovered after 2,080 cr have left the wallet. */
export declare function whyNotFit(spec: ModuleSpec, at: Bench): string | null;
/** The grid line every refit ends with, and `buy` suggests. */
export declare function room(ship: V2Ship | undefined): string;
/** Install and/or remove modules while docked. Ids are `module_id`s or `type_id`s from the
 * hold or this base's store (a stored module is withdrawn first). Removes go before
 * installs, because a remove is what frees the slot. Every install is checked against the
 * slot count, the CPU and the power the change leaves BEFORE anything is sent, so an
 * unfittable one is `refused` with the exact reason and the fix and the ship untouched.
 * An id that is a fitted `module_id`, or names nothing fitted to remove, is `done` with
 * nothing sent; a `type_id` you already fly one of is a second copy, and the grid decides
 * whether there is room for it. Removed modules go to
 * the hold, or the store when the hold is full. Costs nothing. Fitting to 90%+
 * `power_used/power_capacity` trains engineering passively; `next` says how far under the
 * grid you are. */
export declare function refit(change: {
    install?: string[];
    remove?: string[];
}): Promise<Outcome<Fit>>;
/** `refit` as an Effect, for `edge` and for converted callers; never in a barrel. A mutation the
 * game refuses or loses ends the run, naming the action and the code; none is ever re-sent. */
export declare const refitEffect: (change: {
    install?: string[];
    remove?: string[];
}) => Effect.Effect<Outcome<Fit>, never, Game>;
/** A player listing or a yard commission, each beside the class it is and one line on how
 * it compares with the hull you fly ("cargo +110, speed -1, minimum_crew 1"). */
export type ForSale = {
    kind: 'listing';
    listing: ShipListing;
    class: ShipClass;
    versus: string;
} | {
    kind: 'commission';
    quote: CommissionQuoteResponse;
    class: ShipClass;
    versus: string;
};
export declare const catalogClassEffect: (id: string) => Effect.Effect<ShipClass | undefined, import("./codes.ts").Rejected | import("./codes.ts").InBattle | import("./codes.ts").HoldFull | import("./codes.ts").Depleted | import("./codes.ts").ReplyLost, Game>;
export declare const catalogClass: (id: string) => Promise<ShipClass | undefined>;
/** Hulls for sale within a budget, here or at a named base: `ship/browse_ships` listings and
 * `ship/commission_quote` for the classes this yard can build (the ones a listing names,
 * plus `classId` when you pass one — the lib has no way to enumerate a yard's catalogue).
 * Budget defaults to credits minus `permissions.credit_reserve`. Sorted by
 * `cargo_capacity`, then price, because cargo multiplies every loop. Reads only. Flags crew
 * traps: a class whose `minimum_crew` exceeds your crew capacity is listed with a warning in
 * `versus`, not hidden. */
export declare function shipsForSale(opts?: {
    budget?: number;
    baseId?: string;
    classId?: string;
}): Promise<Outcome<{
    for_sale: ForSale[];
}>>;
/** `shipsForSale` as an Effect, for `edge` and for converted callers; never in a barrel. */
export declare const shipsForSaleEffect: (opts?: {
    budget?: number;
    baseId?: string;
    classId?: string;
}) => Effect.Effect<Outcome<{
    for_sale: ForSale[];
}>, never, Game>;
export interface Purchase {
    /** The hull you now fly, when the switch happened; otherwise the one you still fly. */
    ship: V2Ship;
    price: number;
    switched: boolean;
    /** The previous hull's id and where it is parked. */
    previous: {
        ship_id: string;
        base_id: string;
    };
    policy?: InsurancePolicy;
}
/** Buy a listed hull (`listing_id`) or commission a class (`class_id` with `commission:true`)
 * and, with `switchTo` and a shipyard here, switch to it. Refused before anything is sent
 * when the price takes the wallet under `permissions.credit_reserve`, with the numbers. A commission that stalls in `sourcing` is
 * `partial` with `materials_to_source` named. Done when `list_ships` shows the new hull.
 * Costs the price; trains nothing. `next` says what is left to do on the new hull. */
export declare function buyShip(id: string, opts?: {
    commission?: boolean;
    switchTo?: boolean;
}): Promise<Outcome<Purchase>>;
/** `buyShip` as an Effect, for `edge` and for converted callers; never in a barrel. A mutation the
 * game refuses or loses ends the run, naming the action and the code; none is ever re-sent. */
export declare const buyShipEffect: (id: string, opts?: {
    commission?: boolean;
    switchTo?: boolean;
}) => Effect.Effect<Outcome<{
    ship: V2Ship;
    price: number;
    switched: boolean;
    previous: {
        ship_id: string;
        base_id: string;
    };
}>, never, Game>;
export {};
