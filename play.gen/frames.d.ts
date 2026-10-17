/** Lines taken but not yet on disk, per file. A hung disk drops frames past this rather than grow the heap. */
export declare const FRAMES_QUEUE_BYTES: number;
export declare function scrubFrame(frame: unknown): unknown;
/** Everything taken so far has reached the file (or failed trying). */
export declare function flushFrames(): Promise<void>;
/** The `onSend`/`onReceive` options of an `Account`; `freighter` tags a freighter's frames. `cap` is for tests. */
export declare function frameTap(runtime: string, freighter?: string, cap?: number): {
    onSend: (frame: unknown) => void;
    onReceive: (frame: unknown) => void;
};
