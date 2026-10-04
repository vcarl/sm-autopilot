/** One ring of bases: its stops in order, read from whichever rotation sorts first, so every
 * rotation of a ring is one key. The same key `routes()` ranks one row per. */
export declare const ring: (stops: readonly {
    at: string;
}[]) => string;
export declare function readDrained(runtime: string): Record<string, number>;
export declare function markDrained(runtime: string, key: string, tick: number): void;
