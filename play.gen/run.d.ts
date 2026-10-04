import { type Binding } from './play/runtime.ts';
import type { Outcome } from './play/types.ts';
/** 24 minutes, then the stop flag; 2 more for the script to honour it. Both inside the 30 of
 * `service.REQUEST_TIMEOUT`, leaving room for the battle check and the record after. */
export declare const RUN_CAP_MS: number, RUN_GRACE_MS: number;
/** The pilot's directory, ready to typecheck and run: `pilot/index.ts` (from the example on
 * first use), `node_modules/play` and `node_modules/@spacemolt` linked so the bare specifiers
 * resolve for tsc and for node alike, and the tsconfig tsc is pointed at.
 *
 * ponytail: symlinks, which Windows grants only a privileged process. The bridge runs on
 * macOS and Linux; copy the day that changes. */
export declare function pilotHome(runtime: string): {
    dir: string;
    entry: string;
    tsconfig: string;
};
export interface Check {
    ok: boolean;
    entry: string;
    sha: string;
    errors: string[];
}
/** The three gates over `pilot/index.ts` and every sibling it imports. Any failure is the
 * run's whole answer; nothing is executed. */
export declare function check(runtime: string, { warm }?: {
    warm?: boolean;
}): Promise<Check>;
export interface RunDeps extends Omit<Binding, 'runtime'> {
    runtime: string;
    /** The wall-clock cap and the grace after it; tests shorten them. */
    capMs?: number;
    graceMs?: number;
    /** The juncture that asked for this run (`runtime/juncture.json` as the Python handler read it). */
    juncture?: {
        juncture_id?: string;
        at?: string;
    };
}
/** What a run answers with: the sentence, the reason and the rendered report — never the
 * Outcome itself, which is kilobytes of ship, location and skills. That stays in `run.json`
 * and the journal, where a reader who wants it can go and look. */
export interface RunResult {
    accepted: boolean;
    status?: Outcome['status'];
    /** The Outcome's `did`. */
    reason?: string;
    why?: string;
    /** The rendered report of the returned Outcome. */
    prose?: string;
    errors?: string[];
    /** The sha of `pilot/index.ts` as it ran. */
    sha?: string;
    started: string;
    ended_at?: string;
    commands?: number;
    /** The script ignored the stop at the cap and was left behind; the bridge must exit so it
     * cannot send another command. */
    abandoned?: boolean;
}
/** Validate, bind, import fresh, run `main()`, report. Every exit path journals the end,
 * writes the record and unbinds the runtime. */
export declare function runPilot(deps: RunDeps): Promise<RunResult>;
/** Where the plugin's own play library is, for a caller that wants to read it. */
export declare const playDir: () => string;
