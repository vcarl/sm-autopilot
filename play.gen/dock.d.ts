import { Effect } from 'effect';
import { Game } from './play/game.ts';
import type { ReadinessAccount } from './readiness.ts';
import { type TravelOptions } from './travel.ts';
declare const DockBlocked_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "DockBlocked";
} & Readonly<A>;
/** `message` is what the pilot is told; `gather-job.ts` reads it and checks `instanceof`. */
export declare class DockBlocked extends DockBlocked_base<{
    readonly message: string;
}> {
}
export interface DockResult {
    docked: true;
    docked_at: string;
    already_docked: boolean;
}
/** One dock path. A lost reply is reconciled by a live read in either direction — never re-sent
 * blind, and never re-sent at all while the mutation is queued. The one re-send is of a dock a live
 * read showed did not land (dock is idempotent, and was re-observed first). `already_docked` has no
 * tag (no evidence, codes.ts): it is a `Rejected` read by its code. The re-read is the account's
 * own, not `Game.refresh`, so it adds no re-read of its own to a dropped connection the caller's
 * command path already handled. */
export declare const dockAtEffect: (account: ReadinessAccount, baseId?: string, options?: TravelOptions) => Effect.Effect<DockResult, import("./play/codes.ts").GameError | import("./travel.ts").TravelBlocked | import("./travel.ts").ArrivalUnresolved, Game>;
export {};
