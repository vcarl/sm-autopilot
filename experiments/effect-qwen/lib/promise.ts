// The Promise facade over the same Effects: every function returns a Promise that resolves with the
// value or rejects with one of the tagged errors (an object with `_tag`). No Effect in the pilot's view.
import {Data, Effect, Either, Schema} from 'effect';
import * as core from './core.ts';
import type {GameError, World} from './core.ts';

let current: World | null = null;
/** Harness-only: the world the next calls act on. */
export const setWorld = (w: World) => { current = w; };

const lift = <Args extends unknown[], A, E>(f: (...a: Args) => Effect.Effect<A, E, core.Game>) =>
  (...a: Args): Promise<A> => {
    if (!current) throw new Error('no world');
    return Effect.runPromise(Effect.either(f(...a)).pipe(Effect.provide(core.gameLayer(current))))
      .then(e => (Either.isLeft(e) ? Promise.reject(e.left) : e.right));
  };

export const orient = lift(core.orient);
export const scout = lift(core.scout);
export const goTo = lift(core.goTo);
export const mine = lift(core.mine);
export const sell = lift(core.sell);
export const service = lift(core.service);
export const prices = lift(core.prices);
export const readMarket = lift(core.readMarket);
export const salvage = lift(core.salvage);
export const hunt = lift(core.hunt);
export const disengage = lift(core.disengage);
export const missions = lift(core.missions);
export const acceptMission = lift(core.acceptMission);
export const completeMissions = lift(core.completeMissions);
export const note = (text: string): void => { current?.notes.push(String(text)); };
/** Wait, in game time. */
export const sleep = (ms: number): Promise<void> => { if (current) current.slept += ms; return Promise.resolve(); };

export class BadData extends Data.TaggedError('BadData')<{readonly message: string}> {}
/** Decode a raw value with one of the exported schemas; throws BadData when it does not fit. */
export function decode<A, I>(schema: Schema.Schema<A, I>, raw: unknown): A {
  const r = Schema.decodeUnknownEither(schema)(raw);
  if (Either.isLeft(r)) throw new BadData({message: String(r.left.message)});
  return r.right;
}

export type AnyError = GameError | BadData;
/** Narrow a caught value to one tagged error. */
export function isError<T extends AnyError['_tag']>(e: unknown, tag: T): e is Extract<AnyError, {_tag: T}> {
  return typeof e === 'object' && e !== null && '_tag' in e && (e as {_tag: unknown})._tag === tag;
}

/** The `_tag` of a caught value, or 'Error' for anything that is not a game error. */
export function tagOf(e: unknown): string {
  return typeof e === 'object' && e !== null && '_tag' in e && typeof e._tag === 'string' ? e._tag : 'Error';
}

export {
  InBattle, NotDocked, HoldFull, NoWreck, UnknownPlace, NoFuel, ServerBusy, NotAtBelt, NoBuyer,
  NothingHere, HullCritical, NoSlots, UnknownMission, NothingCompletable, MarketBook, MarketRow,
} from './core.ts';
export type {GameError, Row, Mission, Quote, Scouted, Arrived, Sold, Salvaged, Hunted, Completed, Present} from './core.ts';
