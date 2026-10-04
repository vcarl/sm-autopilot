/** Wrecks at the POI you are at: loot them into the hold. Also the recovery job after your
 * own death: ~70% of your modules and half your cargo sit in a wreck where you died. */
import type { EnrichedWreck, LootedItem, LootedModule, ShipCargoItem } from '@spacemolt/lib';
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
/** Every wreck at this POI, as `salvage/wrecks` answers it. */
export declare function wrecksHere(): Promise<EnrichedWreck[]>;
/** One wreck emptied into the hold: modules first (they take a slot each and are the value),
 * then cargo, row by row, until the hold is full. The hold after each send is the evidence,
 * never the reply's claim — a `loot` reply over-states the quantity. */
export declare function lootWreck(wreck: EnrichedWreck): Promise<{
    items: LootedItem[];
    modules: LootedModule[];
    left: ShipCargoItem[];
}>;
/** Loot every wreck here (`salvage/wrecks` then `salvage/loot`), modules first, then cargo,
 * until the hold is full. Your own wreck (`victim_id` is you) is looted first. `tow: '<wreck
 * id>'` attaches a tow line to that wreck instead of looting it — a tow costs the speed the
 * way home needs, so it is asked for by name and never chosen here; selling or scrapping the
 * tow is the market's, not this function's. Idempotent: no wreck, or nothing that fits, is
 * `done` with an empty list. Trains salvaging. Costs nothing; a wreck in police-0 space is
 * the risk `scout` reports. */
export declare function salvage(opts?: {
    tow?: string;
}): Promise<Outcome<Salvaged>>;
