/** Comments blanked, length preserved so line numbers still line up. */
export declare function blank(source: string): string;
export interface Verdict {
    ok: boolean;
    errors: string[];
}
/** Every specifier a source names, in every import spelling. */
export declare function specifiers(source: string): string[];
export declare function checkBoundary(source: string, path: string): Verdict;
/** The entry file and every sibling it reaches, each checked once. */
export declare function checkTree(entry: string): Verdict;
