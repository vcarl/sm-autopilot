import { type Binding } from './play/runtime.ts';
import type { Outcome } from './play/types.ts';
/** How long a stopped script has to honour the stop before it is left behind. */
export declare const STOP_GRACE_MS: number;
/** What fighting a battle still live at the flight's end may take. */
export declare const CLOSE_MS: number;
/** The pilot's directory, ready to typecheck and run: `pilot/index.ts` (from the example on
 * first use), `node_modules/play` and `node_modules/@spacemolt` linked so the bare specifiers
 * resolve for tsc and for node alike, and the tsconfig tsc is pointed at.
 *
 * ponytail: symlinks, which Windows grants only a privileged process. The bridge runs on
 * macOS and Linux; copy the day that changes. */
export declare function pilotHome(runtime: string, name?: 'pilot' | 'query'): {
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
export declare function check(runtime: string, { warm, name }?: {
    warm?: boolean;
    name?: 'pilot' | 'query';
}): Promise<Check>;
export interface RunDeps extends Omit<Binding, 'runtime'> {
    runtime: string;
    /** How long a stopped script has to honour the stop (`STOP_GRACE_MS`); tests shorten it. */
    graceMs?: number;
    /** The allowance for a battle still live at the flight's end (`CLOSE_MS`); tests shorten it. */
    closeMs?: number;
    /** The juncture that asked for this run (`runtime/juncture.json` as the Python handler read it). */
    juncture?: {
        readonly juncture_id?: string | null;
        readonly at?: string | null;
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
    /** The script ignored a stop and was left behind; the bridge must exit so it cannot send
     * another command. */
    abandoned?: boolean;
}
/** The pilot's program as it was checked, kept by sha beside the file it overwrote, so a reader
 * of the journal can see exactly what a run or a refusal was about. */
export declare function keepProgram(runtime: string, entry: string, sha: string): void;
/** The first frame of the pilot's own file in a thrown error's stack, as `pilot/index.ts:<line>`:
 * where in the program it broke, which the message alone never says. Empty when no frame is the pilot's. */
export declare function pilotFrame(error: unknown): string;
/** Validate, bind, import fresh, run `main()`, report. Every exit path journals the end,
 * writes the record and unbinds the runtime. */
export declare function runPilot(deps: RunDeps): Promise<RunResult>;
/** Where the plugin's own play library is, for a caller that wants to read it. */
export declare const playDir: () => string;
