/** Files a station's book to the faction's trade ledger (`submit_trade_intel`), so every pilot and
 * freighter in the faction reads it back as a far book through `query_trade_intel`. The pilot's
 * `book()` and a freighter's stop both call it on every market read; nobody calls it by hand. */
import type { MarketListingItem } from '@spacemolt/lib';
import { Effect } from 'effect';
import type { ReadinessCommand } from './readiness.ts';
import { Game } from './play/game.ts';
/** Whether the account's player is in a faction, read off the state the account already holds.
 * Every faction intel call — filing a book, reading the trade ledger, reading the intel map — is
 * made only when this holds: without a faction the game refuses each one (live 2026-09-28: 152
 * refused filings in nine hours). `say` hears once per process that they are skipped. */
export declare function inFaction(account: object, say?: (text: string) => void): boolean;
/** ponytail: the rows of one station report, as JSON, are kept under this many bytes. Live, a
 * 542-row book (~55 KB) filed and a 716-row one (~73 KB) dropped the connection every time, and a
 * second filing for a base replaces the first, so the book cannot be split. The ceiling is the
 * server's, not measured closer than that; raise it if a bigger book ever files whole. */
export declare const FILE_BYTES = 50000;
/** The rows worth filing, most tradeable first (a bid and an ask, then by the value on the book),
 * cut to fit `FILE_BYTES`. */
export declare function fileRows(items: readonly MarketListingItem[]): {
    item_id: string;
    best_buy: number;
    best_sell: number;
    buy_volume: number;
    sell_volume: number;
}[];
/** File `items` as `base_id`'s book at `tick`, once. A game refusal or a lost reply costs that base
 * this tick only — the next base, or the next tick, files again — and `say` hears once per account
 * per process why one failed. A defect (a bug) is not caught: it goes up. */
export declare const fileIntelEffect: (account: object, base_id: string, items: readonly MarketListingItem[], tick: number, say?: (text: string) => void) => Effect.Effect<void, never, Game>;
/** The Promise twin of `fileIntelEffect`, for callers not yet converted. A failure exit throws the
 * raw error, as `command()` does. */
export declare function fileIntel(account: object, command: ReadinessCommand, base_id: string, items: readonly MarketListingItem[], tick: number, say?: (text: string) => void): Promise<void>;
