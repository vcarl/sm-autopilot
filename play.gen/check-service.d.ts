/** `tsc --noEmit --pretty false -p tsconfig`'s output lines, from the warm service. Throws when
 * the service does; the caller falls back to the CLI. */
export declare function warmCheck(tsconfig: string): string[];
