/** One read of storage: at the current base, or a named base without travelling there — the
 * game's own doc for `station_id` on `spacemolt_storage.view` says exactly that (it is
 * read-only and does not reach deposit/withdraw, which still require presence). Kept compact:
 * an item list capped, no per-ship detail, no gifts or messages — a menu fact, not a transcript. */
import { Effect } from 'effect';
import { Game } from './play/game.ts';
export interface StorageView {
    base_id: string;
    base_name?: string;
    items: {
        item_id: string;
        name?: string;
        quantity: number;
    }[];
    truncated?: number;
    ships: number;
    locations: {
        base_id: string;
        base_name: string;
        system_name: string;
        item_count: number;
        ship_count: number;
    }[];
}
/** A game reply's body: the structured content, a state delta's details, or the reply itself. */
export declare const replyBody: (reply: unknown) => unknown;
export declare const rows: (value: unknown) => unknown[];
export declare const viewStorageEffect: (stationId?: string) => Effect.Effect<StorageView, import("./play/codes.ts").GameError, Game>;
