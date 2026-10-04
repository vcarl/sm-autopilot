/** The `Game` service: the one connection, every game failure classified once (docs/EFFECT.md
 * §Services, §Errors). `replyLost` (command-boundary.ts) is the one definition of a lost reply:
 * the lib's `ConnectionClosedError`, a pending command, or an uncertain code. Never exported from
 * a barrel: the pilot never sees Effect.
 *
 * The command path lives here, once: the count, the waiting ticker, the send, the wait for the
 * lib's reconnect, the forced one, the single re-issue of a read, and what runs after. The binding
 * (runtime.ts) lends the Promise seams as plain functions; `tryPromise` is only ever written here.
 *
 * ponytail: `GameLive` sends through the lib's `send` seam, not the typed facade, so the
 * existing fake account (which has only `send`) runs under it; `bind()` hands it the binding's
 * journalled command as that `send`. Typed, decoded domain methods come with the units. */
import { type Account } from '@spacemolt/lib';
import { Cause, Context, Effect, Layer } from 'effect';
import type { ReadinessAccount, ReadinessCommand } from '../readiness.ts';
import { type GameError } from './codes.ts';
export { Depleted, HoldFull, InBattle, Rejected, ReplyLost, isGameError, type GameError } from './codes.ts';
declare const SeamFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => Cause.YieldableError & {
    readonly _tag: "SeamFailed";
} & Readonly<A>;
/** A Promise the seam lent us rejected: the raw error, before anything has judged it. Never
 * leaves a method that classifies it, except `refresh`, whose callers say it and go on. */
export declare class SeamFailed extends SeamFailed_base<{
    readonly cause: unknown;
}> {
}
export declare const message: (error: unknown) => string;
/** What the unconverted Promise callers expect of a failure: the raw error the lib threw (the
 * tag's `cause`), or the thrown value of a defect. They check `instanceof SpacemoltError`, `.code`
 * and `replyLost(error)`, so a tag would be a regression for them. */
export declare const rawError: (cause: Cause.Cause<unknown>) => unknown;
/** `cause` to its tag. The only reader of `SpacemoltError`. Anything that is neither the lib's
 * refusal nor a lost reply is a bug, not a game outcome: it is rethrown, and an Effect that
 * throws inside `suspend` (or a `tryPromise` `catch`) makes it a defect. The raw error stays on
 * the tag as `cause`. */
export declare const classify: (action: string) => (cause: unknown) => GameError;
/** A Promise body run as one game step: the lib's refusal or a lost reply is its tag, anything
 * else is a defect carrying the thrown value. For code still on `await` that wants the failure typed. */
export declare const attempt: <A>(label: string, body: () => Promise<A>) => Effect.Effect<A, GameError, never>;
/** What the command path keeps for `progress()`: counted, when it last heard back, what is on
 * the wire now, and the last game tick any reply carried. The binding owns one. */
export interface Ledger {
    commands: number;
    lastCommandAt: number;
    pending: {
        action: string;
        since: number;
    } | null;
    lastTick: number | undefined;
}
export declare const freshLedger: () => Ledger;
/** What a game reply says about the tick, narrowed with `in`: the lib types a reply as unknown here. */
export declare const field: (value: unknown, key: string) => unknown;
/** The binding's Promise seams, as plain functions. Every one but `send` is optional: a test
 * world with only a `send` is a connection that never reconnects and has nothing to re-read. */
export interface Seam {
    /** The bridge's journalled command: one send, `tool/action`. */
    readonly send: ReadinessCommand;
    /** Wait for the lib's own reconnect to re-authenticate; false when it never comes. */
    readonly reconnected?: () => Promise<boolean>;
    /** Force a reconnect in place; absent when the account cannot. */
    readonly reconnect?: Account['reconnectOnce'];
    readonly refresh?: ReadinessAccount['refresh'];
    /** A line to the stream and the journal. */
    readonly say?: (text: string) => void;
    /** After every command, whatever it came to: burn cells, say a mood change. */
    readonly after?: () => Promise<void>;
    readonly ledger?: Ledger;
}
declare const Game_base: Context.ServiceClass<Game, "Game", {
    /** One command, `tool/action`, as the bridge's command seam names it. */
    readonly command: (action: string, params?: Record<string, unknown>) => Effect.Effect<unknown, GameError>;
    /** Re-read the account. A failure is the raw error, for a caller that says it and goes on. */
    readonly refresh: Effect.Effect<void, SeamFailed>;
}>;
export declare class Game extends Game_base {
}
export declare const GameLive: (seam: Seam) => Layer.Layer<Game, never, never>;
