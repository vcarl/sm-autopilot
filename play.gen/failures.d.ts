/** How many distinct failures the context shows, and how many the file keeps: more than are shown, so a
 * repeat pushed off the shown few keeps its count when it comes back (live kvothe: `dock` "Access
 * denied" 82 times, counted 3 with five kept). */
export declare const FAILURES = 5, KEPT = 50;
export interface Failure {
    key: string;
    command: string;
    text: string;
    first_at: string;
    last_at: string;
    count: number;
}
type Row = Record<string, unknown>;
interface Seen {
    name: string;
    command: string;
    text: string;
    gist?: string;
}
/** The runtime's own sends, not the pilot's acts: travel's battle probe (4,000 "No active battle"
 * lines live), hunting's stance changes (a fight already over), the trade-intel submit, and the trade
 * ledger and intel map reads `spreads()`, `routes()`, scouting and freighters make on their own. */
export declare const NOT_THE_PILOTS: Set<string>;
/** The text with what makes one occurrence differ from the next taken out: quoted strings, then any
 * token holding a digit (numbers, uuids, hex ids, `r1549`). */
export declare const normalize: (text: string) => string;
/** The failures one journal line records, each its command's name, the command, and what was said. */
export declare function failuresOf(e: Row): Seen[];
/** One failure folded in: a repeat of a kept one counts and takes its latest words; a new one goes
 * first and the oldest falls off. */
export declare function foldFailure(kept: readonly Failure[], seen: Seen, at: string): Failure[];
export declare function readFailures(runtime: string): Failure[];
/** Fold one journal line's failures into the file; a line with none reads nothing. */
export declare function noteFailures(runtime: string, entry: Row): void;
export declare const watchFailures: (runtime: string) => () => void;
export {};
