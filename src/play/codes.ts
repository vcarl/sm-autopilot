/** The game's error codes this repo names, grown only from evidence (docs/EFFECT-MIGRATION.md
 * "Error tags (P0.6)"). A code gets its own tag only when the journal has seen it AND a caller
 * branches on it; every other definitive refusal is `Rejected` with the raw code. Counts are
 * failed `command` lines from `node scripts/observed-codes.ts`, 2026-10-01 (2701 failed, 1257 coded).
 * No tag for `already_docked` (dock.ts branches on it, never observed), `hold_full` or the
 * unobserved depletion codes (mine.ts branches on them, never observed): they stay `Rejected`. */
import {Data} from 'effect';

/** `cause` is the error the lib threw, kept for the Promise seams (a pilot's own
 * `account().commands` rethrows it, so `instanceof SpacemoltError` and `.code` still work). */
type Refusal = {readonly action: string; readonly code: string; readonly message: string; readonly cause?: unknown};

/** The server refused, definitively; nothing landed. `code` is the server's own. */
export class Rejected extends Data.TaggedError('Rejected')<Refusal> {}
/** `in_battle`: 6 lines; travel.ts branches on it. */
export class InBattle extends Data.TaggedError('InBattle')<Refusal> {}
/** `cargo_full`: 10 lines; mine.ts branches on it. */
export class HoldFull extends Data.TaggedError('HoldFull')<Refusal> {}
/** `depleted`: 7 lines; mine.ts branches on it. */
export class Depleted extends Data.TaggedError('Depleted')<Refusal> {}
/** The reply is gone, not the outcome. Re-observe; never re-send a mutation. */
export class ReplyLost extends Data.TaggedError('ReplyLost')<{readonly action: string; readonly cause: unknown}> {}

export type GameError = Rejected | InBattle | HoldFull | Depleted | ReplyLost;

export const isGameError = (error: unknown): error is GameError =>
  error instanceof Rejected || error instanceof InBattle || error instanceof HoldFull || error instanceof Depleted || error instanceof ReplyLost;

/** A definitive refusal by its code; a code not named here is `Rejected`. */
export const refusal = (fields: Refusal): Exclude<GameError, ReplyLost> => {
  switch (fields.code) {
    case 'in_battle': return new InBattle(fields);
    case 'cargo_full': return new HoldFull(fields);
    case 'depleted': return new Depleted(fields);
    default: return new Rejected(fields);
  }
};
