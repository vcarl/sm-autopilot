/** Never steal a lock from a LIVE controller: a human must first inspect the pilot.
 *  A lock whose holder is gone is not a lock — a killed bridge must not wedge every successor. */
export declare function controllerLock(path: string): () => void;
