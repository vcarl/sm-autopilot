import { Schema } from 'effect';
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
/** A chat post that paused the run (the program declared `interrupts`): who, where, what, when. */
export declare const ChatPause: Schema.Struct<{
    readonly from: Schema.String;
    readonly channel: Schema.String;
    readonly text: Schema.String;
    readonly at: Schema.String;
    /** The sender's player id, which a private reply is addressed to. */
    readonly sender_id: Schema.optionalKey<Schema.String>;
}>;
export declare const RunRecord: Schema.Struct<{
    readonly script: Schema.NonEmptyString;
    /** The sha of the program that ran; the text is kept at `programs/<sha>.ts`. */
    readonly source: Schema.optionalKey<Schema.String>;
    readonly params: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Unknown>>;
    /** The run's identity: no counter, no ids to keep unique across restarts. */
    readonly started: Schema.NonEmptyString;
    /** When the context this run was written from was rendered. An instruction given after it
     * was never seen, so this run does not consume it (`pendingInstruction` in context.ts). */
    readonly juncture_at: Schema.optionalKey<Schema.String>;
    readonly last_job: Schema.mutableKey<Schema.optionalKey<Schema.String>>;
    readonly last_step: Schema.optionalKey<Schema.String>;
    readonly ended: Schema.mutableKey<Schema.Boolean>;
    /** Present exactly when the run ended: the same shape the juncture reads as `last`. */
    readonly outcome: Schema.mutableKey<Schema.optionalKey<Schema.$Record<Schema.String, Schema.Unknown>>>;
    /** Present while the program is paused on `ask()`: what the juncture gate wakes the pilot for. */
    readonly question: Schema.mutableKey<Schema.optionalKey<Schema.Struct<{
        readonly question: Schema.String;
        readonly choices: Schema.optionalKey<Schema.mutable<Schema.$Array<Schema.String>>>;
        readonly asked_at: Schema.String;
        readonly chat: Schema.optionalKey<Schema.Struct<{
            readonly from: Schema.String;
            readonly channel: Schema.String;
            readonly text: Schema.String;
            readonly at: Schema.String;
            /** The sender's player id, which a private reply is addressed to. */
            readonly sender_id: Schema.optionalKey<Schema.String>;
        }>>;
    }>>>;
}>;
export type RunRecord = typeof RunRecord.Type;
/** One gameplay.jsonl line: `at` and `event` when the writer stamped them (the old
 * request/response pairs carry no `event`), every other key as written. */
export declare const JournalLine: Schema.StructWithRest<Schema.Struct<{
    readonly at: Schema.optionalKey<Schema.String>;
    readonly event: Schema.optionalKey<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
export type JournalLine = typeof JournalLine.Type;
/** Temp file then rename: a torn write would tell a restarting bridge a lie about the pilot. */
export declare function writeRun(runtime: string, record: RunRecord): void;
/** No record, or one too broken to name a script, is the same answer: nothing to resume. */
export declare function readRun(runtime: string): RunRecord | null;
/** The last error line the previous bridge wrote to its stderr log: the one the gateway rotated
 * aside at this boot (`bridge.stderr.<UTC stamp>.log`, newest), then the live log, which a
 * playtest appends to without rotating.
 *
 * ponytail: an appended log spans every boot, so its last error may be an older bridge's; read
 * from the last boot marker if that ever misleads. */
export declare function lastBridgeError(runtime: string): string | undefined;
/** A record a dead bridge left un-ended, closed as `interrupted` and journalled, with the dead
 * bridge's last error as `why` when its log has one; null when there was none. Called at boot,
 * after the controller lock is held, so no live bridge owns the run. */
export declare function closeInterrupted(runtime: string): RunRecord | null;
/** The tail of the journal as data: what the pilot has actually done, for the readers that need
 * history rather than the present (reflection, the menu, the rendered window). Walks from the
 * current file back through the rotated ones until it has `limit` entries, so a fresh boot's
 * nearly empty journal does not cost them their past.
 *
 * ponytail: each file is read whole and the tail kept. Rest happens once an evening, so a
 * few MB costs nothing; seek from the end if a journal ever outgrows that. */
export declare function readJournal(runtime: string, limit?: number, name?: string): JournalLine[];
/** A bridge's boot, in the journal: a non-empty `gameplay.jsonl` is renamed to
 * `gameplay.<UTC stamp>.jsonl`, then the interrupted-run close and the `boot` line (naming the
 * rotated file as `rotated_from`, so the chain walks back) open the fresh one. Called once the
 * controller lock is held, so no live bridge is writing the file being moved. Python writers
 * open the journal by name per line, so they follow the rename.
 *
 * ponytail: rotated journals are kept forever, for post hoc analysis; no pruning. Add it here
 * (drop the oldest of `journalFiles`) if disk becomes a concern. */
export declare function bootJournal(runtime: string, now?: Date): RunRecord | null;
/** Add a reader; null removes them all. Returns the remover for the one added. */
export declare function watchJournal(fn: ((entry: Record<string, unknown>) => void) | null): () => void;
export declare function stampRun(keys: Record<string, unknown> | null): void;
export declare const withStamp: <T>(keys: Record<string, unknown>, body: () => T) => T;
/** The run's own lines in the pilot's journal, beside the request/response pairs. The
 * runner's other self-made changes take the same line under their own event name (S45). */
export declare function journalRun(runtime: string, entry: Record<string, unknown>, event?: string, file?: string): void;
/** What one game command was, in the space a line can afford: the tool and action, the ids
 * and quantities it named, whether it took, and one sentence off the reply. Never the reply
 * body — a `get_system` answer is kilobytes and the journal is read by a human. */
export declare function journalCommand(runtime: string, action: string, params: Record<string, unknown> | undefined, ok: boolean, reply: unknown, { freighter, ms }?: {
    freighter?: string;
    ms?: number;
}): void;
/** The socket's own life on the journal: each reconnect attempt, its success, a connection lost for
 * good, and each rate-limited resend the lib sleeps before — what a command's `ms` cannot say. */
export declare function journalConnection(runtime: string, account: {
    onReconnecting(fn: (attempt: number) => void): unknown;
    onReconnected(fn: () => void): unknown;
    onDisconnected(fn: (error: {
        code?: number;
        reason?: string;
        message: string;
    }) => void): unknown;
    onRateLimited(fn: (info: {
        command: string;
        attempt: number;
        delayMs: number;
    }) => void): unknown;
}, freighter?: string): void;
export declare function quoteNext(action: string, id: unknown, quote: Record<string, unknown>): void;
