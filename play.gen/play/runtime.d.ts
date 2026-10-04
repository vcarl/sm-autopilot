/** What the runtime lends the library and the pilot's own code: the account, the pilot
 * record, a journal line, the stop flag, an Outcome builder. Bound once per run by `run`
 * before the entrypoint is imported; there is exactly one pilot per process.
 *
 * Inside, the same module holds what the library needs and the pilot does not see: the
 * command seam (journal + Tired imposition), the measuring `job()` wrapper, the step line,
 * and the rules check helpers ask before starting work.
 *
 * ponytail: a module singleton, not AsyncLocalStorage. One account per bridge process today;
 * a multi-account runtime is a second process per account (DESIGN.md "Fleet").
 */
import type { Account } from '@spacemolt/lib';
import { Effect } from 'effect';
import type { ReadinessAccount, ReadinessCommand } from '../readiness.ts';
import { type RunRecord } from '../run-record.ts';
import { TravelBlocked } from '../travel.ts';
import { Game, type GameError } from './game.ts';
import type { Outcome, Present, Row, Status, Want } from './types.ts';
export type Mood = 'Cautious' | 'Focused' | 'Opportunistic' | 'Aggressive' | 'Relaxed' | 'Tired';
export type Stance = 'Prospector' | 'Industrialist' | 'Trader' | 'Carrier' | 'Hunter' | 'Scout';
/** `pilot.json`, read fresh on every call, plus the mood derived from the ship. The pilot never
 * writes it: reflection sets goal and stance; the observer carries in the rest. */
export interface Pilot {
    name?: string;
    objective?: string;
    objective_done?: boolean;
    goal?: string;
    stance?: Stance;
    /** Derived, never stored: the stance's working mood, or Tired past its margins (`moodNow`). */
    mood?: Mood;
    /** Present only while the mood is Tired: the margin that made it so. */
    tired_by?: string;
    /** Standing bounds the human sets. Who to fight is not among them: combat targeting is
     * the pilot's judgement, kept honest by the hull floors and the walk-away fraction. */
    permissions?: {
        credit_reserve?: number;
        max_liability?: number;
    };
    instruction?: {
        text: string;
        at: string;
    };
}
export interface Binding {
    account: Account;
    command: ReadinessCommand;
    /** The record with its derived mood; the bridge derives it from the live ship on every call. */
    pilot: () => Pilot;
    /** Where the journal lives. Without one nothing is journalled; lines still stream. */
    runtime?: string;
    /** Where a streamed line goes after the journal has it. */
    emit: (text: string) => void;
    /** Told when the program pauses on `ask()`, so the request waiting on the run can answer. */
    onAsk?: (question: Question) => void;
    /** A run's id, stamped on every journal line while it is bound. Absent for the menu's reads. */
    run_id?: string;
}
/** Every top-level call `main()` made this run, as the menu reads a run: the function, its
 * first argument, how it ended and what it gained. ponytail: the first whitespace token of
 * the job's label stands in for "first argument"; it is the poi/id for every job that takes one. */
export interface Call {
    fn: string;
    arg: string;
    status: Status;
    did: string;
    /** The Outcome's own `why`, so the report of a call that did not end `done` carries the
     * reason (the suggested ids of a refused destination) and not only the `did`. */
    why?: string;
    credits: number;
    items: number;
    xp: number;
    cost: Outcome['cost'];
    /** Telemetry, journalled on run/ended: the whole of what the call gained, and when it ran. */
    gained?: Outcome['gained'];
    started_at?: string;
    seconds?: number;
}
export declare const runCalls: () => Call[];
/** A question the program is paused on, as run.json and the tools carry it. */
export type Question = NonNullable<RunRecord['question']>;
/** The question the program is paused on, or null. */
export declare const pendingQuestion: () => Question | null;
/** Bind the runtime for one run. Resets the stop flag and the counters. */
export declare function bind(binding: Binding): void;
export declare function unbind(): void;
export declare const isBound: () => boolean;
/** The pilot record as it is right now. Cheap; call it, do not cache it. */
export declare function pilot(): Pilot;
/** The connected `@spacemolt/lib` Account: typed state (`account().ship: V2Ship`,
 * `.cargo: V2CargoItem[]`, `.location: V2Location`, `.credits`, `.skills`) and every game
 * command as `account().commands.<tool>.<action>()`. This IS the library; ours are the
 * conveniences for bulk actions, common failures and precondition checks. Mutations you send
 * yourself are journalled and margin-checked like any other, but they are NOT idempotent and
 * NOT rules-checked: read the reply before sending the same one again. */
export declare function account(): Account;
/** Write one line to the journal and to the run's stream, under your own words. Use it to
 * say what you decided and why, so the record shows the reasoning, not only the moves. */
export declare function note(text: string): void;
/** True once the pilot (or the observer) asked the run to stop. Every library function checks it
 * between commands and returns `partial`; a loop of your own should check it too. */
export declare function stopped(): boolean;
/** Ask the run to stop. A program paused on `ask()` is not at a safe point, it is waiting: the
 * ask rejects with `Stopped` there and then, and the question is withdrawn. */
export declare function stop(): void;
/** Thrown from a travel checkpoint when the pilot asked to stop; the leg in flight finishes. */
export declare class Stopped extends TravelBlocked {
    readonly _tag = "Stopped";
    constructor();
}
export declare const checkStop: () => void;
/** Pause the program and put a question to the model that is running it; resolves to its
 * answer, which is always one of `choices` when they are given. It waits until the answer
 * comes, or rejects with `Stopped` when the run is stopped — by a person, or by the run's
 * wall-clock cap (run.ts).
 * A model call takes minutes, so ask at a strategic fork, never once per tick. */
export declare function ask(asked: {
    question: string;
    choices?: string[];
}): Promise<string>;
/** Resume the paused program with `text`. The caller has already held it to the choices. */
export declare function answer(text: string): void;
/** Build an Outcome for a function of your own. You supply the sentence, the status and the
 * detail; the runtime fills `fn`, `cost`, `gained` and `now` from what it measured since the
 * run started or since your last `outcome()` call, whichever is later. Return it from your
 * helper so it composes like ours. */
export declare function outcome<Detail = Record<string, unknown>>(did: string, status?: Status, detail?: Detail, why?: string): Outcome<Detail>;
/** The rows a pilot asked for, normalised: `quantity` omitted means all of it, carried on as
 * `Infinity`. A non-finite quantity is a typo, not a way to say "all", and is refused here so
 * every row-taking function refuses it the same way. */
export declare function wanted(rows: Want[]): {
    rows: Row[];
} | {
    refused: string;
};
/** Every game command a helper sends: `Game.command` (game.ts) through the binding's runtime,
 * its failure handed back as the raw error. Journalled by the bridge's command; counted, and a
 * mood change it caused is said by the layer's `after`.
 *
 * A connection that drops mid-command is not the trip ending: the lib reconnects and
 * re-authenticates by itself, so the layer waits for that, re-reads the world, and re-issues the
 * command exactly once when it is one the live world can restate. A mutation that may have
 * landed is never re-sent — it fails with "outcome unknown, re-observe" instead.
 *
 * A `run*` besides `edge` (the others are marked `// bridge:`), and the
 * string seam: U31 deletes it with the callers that still `await command(...)`. */
export declare function command(action: string, params?: Record<string, unknown>): Promise<unknown>;
export declare const acct: () => ReadinessAccount;
export declare const runtimeDir: () => string | undefined;
/** One streamed line: journalled first, then sent. */
export declare function line(text: string, extra?: Record<string, unknown>): void;
/** A sub-step inside a helper: an indented line, and the step `status` reports. */
export declare function step(text: string): void;
/** Where the run has got to, and — the difference between "waiting on the game" and "the
 * bridge is stuck" — when it last heard back and what is on the wire right now. */
export declare const progress: () => {
    pending?: {
        action: string;
        since_s: number;
    };
    last_command_at?: string;
    fn: string;
    step: string | undefined;
    commands: number;
    elapsed_s: number;
};
/** The rules between one helper and the next: a mood that may not start work. Helpers that
 * begin something (a gather, a buy, a mission) ask before sending; reads and the safe legs
 * (service, stow, sell, going to a base) do not.
 *
 * Tired is not advice: at a call `main()` made itself, the runtime resupplies first (`resupply`)
 * and the work goes on: cleared, or journalled when it could not be. Inside another helper it
 * only refuses — flying off mid-trade would leave the outer helper at the wrong counter — and the
 * resupply waits for the next top-level call or the run's end. */
export declare function admit(fn: string): Promise<string | null>;
/** The ship, wallet, hold, place, skills and active missions as the account already holds them:
 * the run's `start_state`/`end_state`. Reads memory only. Storage is not in account state, so it
 * is not here — it would cost a `storage/view` per run.
 * ponytail: cargo and missions capped at 40 rows, as the storage and market reads are. */
export declare function stateSnapshot(): Record<string, unknown>;
export declare function present(): Present;
/** What a helper hands back; the wrapper measures the rest. */
export interface Said<Detail> {
    status: Status;
    did: string;
    why?: string;
    detail: Detail;
    next?: string[];
}
/** The measuring wrapper every exported function is defined through: snapshot, run, snapshot,
 * diff. Streams `▶ fn args` on entry and `✓/✗ fn status secs did` on return. A throw is folded
 * by `said`; nothing escapes as an exception. The body is a Promise, so its failure is classified
 * as a game step's is (`attempt`): a refusal or lost reply is a tag, any other throw a defect that
 * `said` words from the thrown value and that is not a journalled `defect`, as it never was. */
export declare const job: <Detail>(fn: string, args: string, body: () => Promise<Said<Detail>>) => Promise<Outcome<Detail>>;
/** `job` for an Effect body: the same bookkeeping, every failure folded into the Outcome by
 * `said`. A defect is a `failed` Outcome too, as a throw is in `job`, and its stack goes to a
 * `defect` line. Never exported from a barrel. */
export declare const jobEffect: <D, R>(fn: string, args: string, body: Effect.Effect<Said<D>, GameError | Stopped, R>) => Effect.Effect<Outcome<D>, never, Game | R>;
/** The Promise a pilot function returns: `effect` run through the binding's runtime. A defect
 * outside any job is a `failed` Outcome and a `defect` line. */
export declare function edge<D>(effect: Effect.Effect<Outcome<D>, never, Game>): Promise<Outcome<D>>;
/** What has come aboard since the running job's opening read: the cargo diff a helper's own
 * `did` must be written from, rather than a tally it kept while the world moved. */
export declare function measured(): Row[];
/** After every command and state push: when the derived mood crossed into or out of Tired, the
 * journal and the stream say so. Nothing is written to the record — the mood is the facts.
 * A fuel crossing the cells aboard can clear is not said: `burnCells` clears it first. */
export declare function watchMood(): void;
export declare function burnCells(): Promise<void>;
