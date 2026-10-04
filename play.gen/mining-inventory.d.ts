import type { GameState } from '@spacemolt/lib';
/** Cargo rows can repeat an item; preserve their total when measuring new yield. */
export declare function miningInventory(state: GameState): Record<string, number>;
export declare function miningYield(before: Record<string, number>, after: Record<string, number>): Record<string, number>;
/** The fuel cell: the cargo item `refuel` burns in space (lib `RefuelRequest.id`: "fuel_cell,
 * fuel_cell_premium, fuel_cell_military. Auto-selects cheapest if omitted"). Only the base cell
 * is bought and kept. */
export declare const FUEL_CELL = "fuel_cell";
/** ponytail: one cargo unit a cell when no cell aboard carries its catalog `size`. Nothing recorded
 * shows it; `inspect({id:'fuel_cell'})` answers the catalog row, and a cell aboard says it outright. */
export declare const FUEL_CELL_SIZE = 1;
/** Cells kept aboard, as a share of the hold: bought up to TARGET, only once they fall under FLOOR. */
export declare const CELL_TARGET = 0.05, CELL_FLOOR = 0.01;
type Hold = {
    ship?: {
        cargo_capacity?: number;
    } | null;
    cargo?: {
        item_id: string;
        quantity: number;
        size?: number;
    }[] | null;
};
/** The cells aboard against the reserve the hold keeps: `target` whole cells (at least one, if one
 * fits), `due` when the cells aboard occupy under `CELL_FLOOR` of the hold. */
export declare function cellReserve(state: Hold): {
    held: number;
    target: number;
    size: number;
    due: boolean;
};
/** What the hold may part with: everything, less the cells the reserve keeps. Every sell, deposit
 * and settle reads this instead of `miningInventory`, so the reserve is never sold off or stowed. */
export declare function disposable(state: GameState): Record<string, number>;
export {};
