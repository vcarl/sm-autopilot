export declare function readPlaces(runtime: string): Record<string, string>;
/** Write `file` in `dir` as JSON, temp file then rename, so a reader never sees half of it. A
 * failed write is dropped: everything kept this way is only looked up or seen again. */
export declare function keepJson(dir: string, file: string, value: unknown): void;
/** A no-op when the place is already kept or either id is empty. */
export declare function markPlace(runtime: string, base_id: string, system_id: string): void;
export declare const readMobile: (runtime: string) => Set<string>;
export declare const markMobile: (runtime: string, base_id: string) => void;
export declare const readExplored: (runtime: string) => Set<string>;
export declare const markExplored: (runtime: string, system_id: string) => void;
