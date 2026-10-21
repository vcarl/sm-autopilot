/** What fixes a refused call, from what we know without the server saying it: the call's own params, words the server
 * formats the same way every time, and our own reads. Few codes, each one the pilot repeated after the game named the
 * fix (kvothe's journal, 09-30..10-21, `command` refusals and their repeats of the same call and words). A fix is a
 * call: `first` sent before the refused call goes again, or `params` it goes again with. Prose is never parsed. */
import { Effect } from 'effect';
import { Game } from './game.ts';
import type { Run } from './runtime.ts';
import type { Outcome } from './types.ts';
/** The refused call: what was sent, and what the game said. */
export interface Refused {
    action: string;
    params: Record<string, unknown>;
    code: string;
    message: string;
}
/** `choice` is what the pilot reads, and says what it spends; `call` is the fix to paste. */
export interface Fix {
    id: string;
    choice: string;
    call: string;
    first?: Effect.Effect<Outcome<unknown>, never, Game | Run>;
    params?: Record<string, unknown>;
}
/** A raw command as the pilot writes it. */
export declare const rawCall: (action: string, params: Record<string, unknown>) => string;
/** The fixes for a refusal; none for a code not in the table, or for the runtime's own sends. */
export declare const fixesFor: (refused: Refused) => Effect.Effect<Fix[], never, Game | Run>;
