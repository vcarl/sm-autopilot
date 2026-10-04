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
export interface DockRefusal {
    system_id?: string;
    message: string;
    at: string;
}
export declare const readDockRefusals: (runtime: string | undefined) => Record<string, DockRefusal>;
export declare function markDockRefused(runtime: string, base_id: string, row: DockRefusal): void;
export declare function clearDockRefused(runtime: string, base_id: string): void;
export declare const readNames: (runtime: string | undefined) => Record<string, string>;
/** Every id/name pair a reply carries: `base_id`/`base_name` and `poi_id`/`poi_name` anywhere in it,
 * `get_system`'s POI rows, `get_base`'s base, and `find_route`'s target POI. A routed base with no
 * name of its own yet is named for the POI it sits at (`find_route` says "travel to Hex Star"),
 * until a read that names the base itself replaces it. */
export declare function learnNames(runtime: string, action: string, params: Record<string, unknown> | undefined, reply: unknown): void;
/** An opaque id as the pilot reads it, `Name (id)`; the id stays whole so it can be passed back
 * to `goTo`. An id with no known name, or a readable one, is itself. */
export declare const placeName: (id: string, names: Record<string, string>) => string;
/** `placeName` over prose: every bare opaque id in `text` gains its name. An id in quotes is code
 * (`goTo('…')`, `{at:'…'}`) and is left alone, as is one whose name already stands beside it. */
export declare function nameIds(text: string, names: Record<string, string>): string;
