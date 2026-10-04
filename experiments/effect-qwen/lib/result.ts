// The Result facade over the same Effects: every function returns a Promise that always resolves, with
// `{ok: true, value}` or `{ok: false, error}` where `error` is typed as that function's own error union.
// The errors stay in the types (like Effect) and the control flow stays async/await (like today).
import {Effect, Either, Schema} from 'effect';
import * as core from './core.ts';
import type {World} from './core.ts';
import {BadData, setWorld as setPromiseWorld} from './promise.ts';

export type Result<A, E> = {readonly ok: true; readonly value: A} | {readonly ok: false; readonly error: E};

let current: World | null = null;
/** Harness-only: the world the next calls act on. */
export const setWorld = (w: World) => { current = w; setPromiseWorld(w); };

const lift = <Args extends unknown[], A, E>(f: (...a: Args) => Effect.Effect<A, E, core.Game>) =>
  (...a: Args): Promise<Result<A, E>> => {
    if (!current) throw new Error('no world');
    return Effect.runPromise(Effect.either(f(...a)).pipe(Effect.provide(core.gameLayer(current))))
      .then((e): Result<A, E> => (Either.isLeft(e) ? {ok: false, error: e.left} : {ok: true, value: e.right}));
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
export const sleep = (ms: number): Promise<void> => { if (current) current.slept += ms; return Promise.resolve(); };

/** The value, or throw the error: the program fails with it. */
export function unwrap<A, E>(r: Result<A, E>): A {
  if (r.ok) return r.value;
  throw r.error;
}

/** Decode a raw value with one of the exported schemas. */
export function decode<A, I>(schema: Schema.Schema<A, I>, raw: unknown): Result<A, BadData> {
  const r = Schema.decodeUnknownEither(schema)(raw);
  return Either.isLeft(r) ? {ok: false, error: new BadData({message: String(r.left.message)})} : {ok: true, value: r.right};
}

export {BadData};
export {
  InBattle, NotDocked, HoldFull, NoWreck, UnknownPlace, NoFuel, ServerBusy, NotAtBelt, NoBuyer,
  NothingHere, HullCritical, NoSlots, UnknownMission, NothingCompletable, MarketBook, MarketRow,
} from './core.ts';
export type {GameError, Row, Mission, Quote, Scouted, Arrived, Sold, Salvaged, Hunted, Completed, Present} from './core.ts';
