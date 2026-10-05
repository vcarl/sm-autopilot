/** Wrecks at the POI you are at: loot them into the hold. Also the recovery job after your
 * own death: ~70% of your modules and half your cargo sit in a wreck where you died. */
import type { EnrichedWreck, LootedItem, LootedModule, ShipCargoItem } from '@spacemolt/lib';
import { Effect } from 'effect';
import { Game, type GameError } from '../game.ts';
import type { Outcome } from '../types.ts';
export interface Salvaged {
    wrecks: EnrichedWreck[];
    looted: {
        wreck_id: string;
        items: LootedItem[];
        modules: LootedModule[];
    }[];
    /** Left behind for want of room, by wreck. */
    left: {
        wreck_id: string;
        cargo: EnrichedWreck['cargo'];
    }[];
    /** The wreck a tow line was attached to, when `tow` named one. */
    towed?: string;
}
/** Every wreck at this POI, as `salvage/wrecks` answers it; a row that does not read is dropped and said. */
export declare const wrecksHereEffect: () => Effect.Effect<EnrichedWreck[], GameError, Game>;
/** Why a row stayed in the wreck: the game's refusal (the error itself), or a condition of this side. */
type Reason = Exclude<GameError, {
    _tag: 'ReplyLost';
}> | 'hold full' | 'nothing that fits';
/** One wreck emptied into the hold: modules first (they take a slot each and are the value),
 * then cargo, row by row, until the hold is full. The hold after each send is the evidence,
 * never the reply's claim — a `loot` reply over-states the quantity. What stayed in the wreck
 * carries its reason: the game's refusal as the error itself, or a local condition. A lost
 * reply ends it, and the loot is never re-sent. */
export declare const lootWreckEffect: (wreck: EnrichedWreck) => Effect.Effect<{
    items: LootedItem[];
    modules: LootedModule[];
    left: {
        row: ShipCargoItem;
        reason: Reason;
    }[];
    modulesLeft: {
        module: LootedModule;
        reason: Reason;
    }[];
    empty: boolean;
}, GameError, Game>;
/** `salvage` as an Effect, for `edge` and for converted callers; never in a barrel. A tow the game refuses or
 * a lost reply ends the flight, naming the action; a refused loot is said in the wreck's line and in `did`. */
export declare const salvageEffect: (opts?: {
    tow?: string;
}) => Effect.Effect<Outcome<Salvaged>, never, Game | import("../runtime.ts").Run>;
/** Loot every wreck here (`salvage/wrecks` then `salvage/loot`), modules first, then cargo,
 * until the hold is full. Your own wreck (`victim_id` is you) is looted first. `tow: '<wreck
 * id>'` attaches a tow line to that wreck instead of looting it — a tow costs the speed the
 * way home needs, so it is asked for by name and never chosen here; selling or scrapping the
 * tow is the market's, not this function's. Idempotent: no wreck, or nothing that fits, is
 * `done` with an empty list. Each wreck's line, and `did`, say what stayed behind and why: the hold
 * was full, the game refused (with its code), or the wreck was only a hull. Trains salvaging.
 * Costs nothing; a wreck in police-0 space is the risk `scout` reports. */
export declare function salvage(opts?: {
    tow?: string;
}): Promise<Outcome<Salvaged>>;
export {};
