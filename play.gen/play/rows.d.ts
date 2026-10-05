import { Option, type Schema } from 'effect';
import { type GameError } from './game.ts';
import { OffSpec } from './storage.ts';
/** A value as a pilot writes it: single quotes, bare keys. */
export declare const literal: (value: unknown) => string;
/** The rows of a reply's list whose read fields decode, as the game sent them. A row that does not is left out and said in a
 * step; an absent or `null` list reads as none (the live server sends `null` for an empty collection). `name` is the row's id for that line. */
export declare const kept: (action: string, key: string, list: unknown, decode: (row: unknown) => Option.Option<unknown>, name: (row: unknown) => unknown) => unknown[];
/** A reply's number, or `undefined` when it is absent or not one. */
export declare const num: (body: unknown, key: string) => number | undefined;
/** The only place a refusal becomes a string: the action and the server's code. */
export declare const told: (error: Exclude<GameError, {
    _tag: "ReplyLost";
}>) => string;
/** A reply that did not decode, as the named `OffSpec` for that action. */
export declare const offSpec: (action: string) => (error: Schema.SchemaError) => OffSpec;
