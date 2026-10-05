/** What the runtime lends the library and the pilot's own code: the account, the pilot
 * record, a journal line, the stop flag, an Outcome builder. Bound once per run by `run`
 * before the entrypoint is imported; there is exactly one pilot per process.
 *
 * Inside, the same module holds what the library needs and the pilot does not see: the
 * measuring `job()` wrapper, the step line, and the rules check helpers ask before starting work.
 * Everything a run keeps is its `Run` service, built by `bind()` beside its own `Game`; an Effect
 * asks for it by type, and the Promise surface reaches it through the binding.
 *
 * ponytail: the pilot's surface (`pilot()`, `stopped()`, `note()`, `account()`) is synchronous and
 * carries no context, so the binding itself is one module slot, not AsyncLocalStorage. One pilot
 * per bridge process today; a multi-account runtime is a second process per account (DESIGN.md "Fleet").
 */
import type { Account, SkillProgress } from '@spacemolt/lib';
import { Cause, Context, Effect, Layer, Schema } from 'effect';
import type { ReadinessAccount, ReadinessCommand } from '../readiness.ts';
import { type RunRecord } from '../run-record.ts';
import type { DockBlocked } from '../dock.ts';
import { TravelBlocked, type ArrivalUnresolved } from '../travel.ts';
import { Game, type GameError, type Ledger } from './game.ts';
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
    /** The bases a route call docked at, in order, from its detail's `stops` (tradeRun's): the
     * juncture groups earning laps by them (live 2026-10-01, kvothe: the loop that made +39.6k fell
     * out of view, and its stops lived only in `did` prose). */
    stops?: string[];
}
/** A question the program is paused on, as run.json and the tools carry it. */
export type Question = NonNullable<RunRecord['question']>;
/** A chat post that paused the run: who sent it, on which channel, the text, and when. */
export type ChatPause = NonNullable<Question['chat']>;
/** A chat post that paused the run, with the answer you gave when it did. */
export interface Heard {
    chat: ChatPause;
    answer: string;
}
/** What may pause a run: export it from `pilot/index.ts` as `export const interrupts = {…}`. A post
 * pauses the run when its channel is in `channels` (`['private']` when left out) and, when `from` is
 * given, its sender is in it (a name or a player id). No export, nothing interrupts. */
export declare const InterruptsRead: Schema.Struct<{
    readonly from: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly channels: Schema.optionalKey<Schema.$Array<Schema.Literals<readonly ["private", "local", "system", "faction"]>>>;
}>;
export type Interrupts = typeof InterruptsRead.Type;
interface Snapshot {
    at: number;
    credits: number;
    fuel: number;
    hull: number;
    cargo: Record<string, number>;
    xp: Record<string, number>;
}
declare const Run_base: Context.ServiceClass<Run, "Run", {
    readonly binding: Binding;
    /** Set by `stop()`; every library function checks it between commands. */
    stopFlag: boolean;
    /** Why the stop came when it was not the pilot's: the run's wall-clock cap (run.ts). */
    stopWhy?: string;
    readonly started: number;
    /** How many jobs deep the program is: 1 is a call `main()` made itself. */
    depth: number;
    /** What the command path keeps for `progress()`; `GameLive` writes it. */
    readonly wire: Ledger;
    last: {
        fn: string;
        step?: string;
    };
    /** Where the pilot's next `outcome()` measures from. */
    mark: Snapshot | null;
    /** The opening read of the job now running, so a helper inside it can say what it measured. */
    jobMark: Snapshot | null;
    calls: Call[];
    asking: {
        question: Question;
        resolve: (answer: string) => void;
        reject: (error: unknown) => void;
    } | null;
    /** The mood last said, so a crossing into or out of Tired is said once. */
    lastMood: Mood | undefined;
    /** How the last resupply ended short, if it did: `admit` lets the work go on either way. */
    short: "broke" | "stranded" | undefined;
    /** The runtime's own resupply is flying: its docks and arrivals do not start another. */
    resupplying: boolean;
    /** The system a resupply flew out of and reached no counter: not flown out of again this run. */
    strandedIn: string | undefined;
    /** Resupplies since the last top-level call closed: that call's `did` names them. */
    readonly resupplied: string[];
    burning: boolean;
    burnFailed: boolean;
    unwatch: (() => void) | undefined;
    /** The program's `interrupts` export, read as the run starts; null: nothing interrupts. */
    interrupts: Interrupts | null;
    /** Posts that matched it and have not paused the run yet, oldest first. */
    readonly chats: ChatPause[];
    /** Posts that paused the run and the answers given, until `heard()` hands them over. */
    readonly heard: Heard[];
    /** A stop withdrew a chat pause: the pilot call it paused inside throws `Stopped`, as a paused `ask()` does. */
    pauseStopped: boolean;
}>;
/** One run: everything `bind()` starts afresh, provided beside the binding's `Game`. */
export declare class Run extends Run_base {
}
export declare const runCalls: () => Call[];
/** The question the program is paused on, or null. */
export declare const pendingQuestion: () => Question | null;
/** Bind the runtime for one run: a fresh `Run`, and a `Game` over this binding's command. */
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
export declare function stop(why?: string): void;
/** Thrown from a travel checkpoint when the pilot asked to stop; the leg in flight finishes. */
export declare class Stopped extends TravelBlocked {
    readonly _tag = "Stopped";
    constructor();
}
/** The stop's own words: the pilot's, or the cap's. Live 2026-10-04 (kvothe 22:02Z): a run ended by
 * the 24-minute cap read "tradeRun stopped by the pilot", and the pilot never stopped it. */
export declare const stopReason: () => string;
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
/** The chat posts that paused this run, each with the answer you gave, oldest first. Each is
 * handed over once: a second call returns only what paused the run since the first. */
export declare function heard(): Heard[];
/** The run's `interrupts` declaration, from the program's export (run.ts). */
export declare function listen(declared: Interrupts | null): void;
/** A chat post the bridge heard: queued to pause the run when its declaration names it. True when queued. */
export declare function hear(post: {
    channel: string;
    sender?: string | undefined;
    sender_id?: string | undefined;
    content: string;
    at: string;
}): boolean;
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
/** The Promise seam for an Effect that is not a pilot function — the pilot's own
 * `account().commands`, the bridge's menu: run through the binding's runtime, a failure thrown
 * as the raw error the lib raised, so `instanceof SpacemoltError` and `.code` still work.
 * Journalled by the bridge's command; counted, and a mood change it caused is said by the
 * layer's `after`. The one `run*` besides `edge`. */
export declare function onBinding<A, E>(effect: Effect.Effect<A, E, Game | Run>): Promise<A>;
/** The bound run as a layer, for an Effect run against a `Game` of its own rather than through `edge`
 * (a test on the TestClock). */
export declare const boundRun: () => Layer.Layer<Run, never, never>;
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
 * Tired is not a gate: at a call `main()` made itself the runtime resupplies first (`tiredCheck`),
 * as it does at every dock and arrival, and the work goes on whether or not that cleared it —
 * refusing the work (which earns the credits, or flies where a base may be learned) would strand the ship. */
export declare const admit: (fn: string) => Effect.Effect<string | null, never, Game | Run>;
/** `get_skills` answers a map keyed by skill id (live, C23 replay); some shapes nest it. */
export declare function skillMap(skills: unknown): Record<string, SkillProgress>;
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
export declare const jobEffect: <D, R extends Game | Run = Game | Run>(fn: string, args: string, body: Effect.Effect<Said<D>, GameError | TravelBlocked | ArrivalUnresolved | DockBlocked, R>) => Effect.Effect<Outcome<D>, never, Game | Run | R>;
/** The Promise a pilot function returns: `effect` run through the binding's runtime. A defect
 * outside any job is a `failed` Outcome and a `defect` line. */
export declare function edge<D>(effect: Effect.Effect<Outcome<D>, never, Game | Run>): Promise<Outcome<D>>;
/** An Outcome's detail when the job built one, `undefined` when it is `said`'s `{}`. An internal caller reads
 * a helper's detail through this: status alone does not tell, since a stop is `partial` and an escaped refusal `refused`. */
export declare function reached<Detail>(outcome: Outcome<Detail>): Detail | undefined;
/** A bug, not a game outcome: its stack goes to the journal. The stop is not one. */
export declare function defect(fn: string, cause: Cause.Cause<unknown>): void;
/** What has come aboard since the running job's opening read: the cargo diff a helper's own
 * `did` must be written from, rather than a tally it kept while the world moved. */
export declare function measured(): Row[];
/** `burn` for the run's own resupply, which may burn before it services. */
export declare const burnCells: Effect.Effect<void, never, Game | Run>;
export {};
