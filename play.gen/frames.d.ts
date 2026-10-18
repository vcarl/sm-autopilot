/** `runtime/frames.jsonl`: every frame the game sends us and every frame we send it, one JSON line
 * each, for offline replay. Not read by the pilot or the runtime. Rotated at boot with the journal
 * (`bootJournal`).
 *
 * ponytail: rotation only at boot, no size roll, so a bridge that stays up for days grows one file.
 * Add a size check in `enqueue` (rotate when the file passes a few hundred MB) if that happens. */
import type { AccountOptions } from '@spacemolt/lib';
/** Lines taken but not yet on disk, per file. A hung disk drops frames past this rather than grow the heap. */
export declare const FRAMES_QUEUE_BYTES: number;
export declare function scrubFrame(frame: unknown): unknown;
/** Everything taken so far has reached the file (or failed trying). */
export declare function flushFrames(): Promise<void>;
/** The `onSend`/`onReceive` options of an `Account`; `freighter` tags a freighter's frames. `cap` is for tests. */
export declare function frameTap(runtime: string, freighter?: string, cap?: number): Required<Pick<AccountOptions, 'onSend' | 'onReceive'>>;
