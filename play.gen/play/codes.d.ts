/** `cause` is the error the lib threw, kept for the Promise seams (a pilot's own
 * `account().commands` rethrows it, so `instanceof SpacemoltError` and `.code` still work). */
type Refusal = {
    readonly action: string;
    readonly code: string;
    readonly message: string;
    readonly cause?: unknown;
};
declare const Rejected_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "Rejected";
} & Readonly<A>;
/** The server refused, definitively; nothing landed. `code` is the server's own. */
export declare class Rejected extends Rejected_base<Refusal> {
}
declare const InBattle_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InBattle";
} & Readonly<A>;
/** `in_battle`: 6 lines; travel.ts branches on it. */
export declare class InBattle extends InBattle_base<Refusal> {
}
declare const HoldFull_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "HoldFull";
} & Readonly<A>;
/** `cargo_full`: 10 lines; mine.ts branches on it. */
export declare class HoldFull extends HoldFull_base<Refusal> {
}
declare const Depleted_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "Depleted";
} & Readonly<A>;
/** `depleted`: 7 lines; mine.ts branches on it. */
export declare class Depleted extends Depleted_base<Refusal> {
}
declare const ReplyLost_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ReplyLost";
} & Readonly<A>;
/** The reply is gone, not the outcome. Re-observe; never re-send a mutation. */
export declare class ReplyLost extends ReplyLost_base<{
    readonly action: string;
    readonly cause: unknown;
}> {
}
export type GameError = Rejected | InBattle | HoldFull | Depleted | ReplyLost;
export declare const isGameError: (error: unknown) => error is GameError;
/** A definitive refusal by its code; a code not named here is `Rejected`. */
export declare const refusal: (fields: Refusal) => Exclude<GameError, ReplyLost>;
export {};
