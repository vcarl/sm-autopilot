/** A chat line, not a paragraph. Long reasons are cut rather than wrapped. */
export declare const LINE_CHARS = 160;
type Entry = Record<string, unknown>;
/** One journal entry as one line, or null when it is not worth one. */
export declare function renderLine(entry: Entry | null | undefined): string | null;
/** The journal's last `limit` lines as a person reads them, newest last: the query's `shipLog()`. Read well
 * past the limit, since most entries render to nothing. */
export declare const journalTail: (runtime: string, limit: number) => string[];
export {};
