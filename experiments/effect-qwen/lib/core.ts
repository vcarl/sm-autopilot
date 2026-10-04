// A fake SpaceMolt: an in-memory world and the play library's public surface over it, as Effects.
// Harness-only names (World, makeWorld, gameLayer) live here; effect.ts re-exports the pilot's surface.
import {Clock, Context, Data, Duration, Effect, Layer, Schema} from 'effect';

// ── the world ──────────────────────────────────────────────────────────────
export type Row = {readonly item_id: string; readonly quantity: number};
export type Poi = {id: string; system: string; type: string; base?: string; ore?: string};
export type Mission = {id: string; title: string; reward: number; deliver: Row; base: string};

export interface World {
  pois: Poi[];
  poi: string;
  docked: boolean;
  fuel: number; maxFuel: number; hull: number; maxHull: number; cargoCap: number;
  cargo: Row[];
  credits: number;
  battle: string | null;                  // the enemy holding the ship, or null
  wrecks: Record<string, Row[][]>;        // poi -> wrecks -> contents
  fauna: Record<string, string[]>;        // poi -> creatures
  market: Record<string, Record<string, number>>; // base -> item -> best_buy
  board: Record<string, Mission[]>;
  active: Mission[];
  maxMissions: number;
  busy: number;                           // goTo fails ServerBusy this many more times
  ambushAfterMines: number | null;        // pirates engage after this many mines
  hullCriticalOnFight: number | null;     // hunt fails HullCritical on this fight (1-based), leaving the battle on
  badBook: boolean;                       // readMarket answers garbage
  // records for assertions
  calls: string[];
  notes: string[];
  slept: number;
  mines: number;
}

export function makeWorld(over: Partial<World> = {}): World {
  return {
    pois: [
      {id: 'sol_station', system: 'sol', type: 'station', base: 'sol_base'},
      {id: 'sol_belt', system: 'sol', type: 'asteroid_belt', ore: 'iron_ore'},
      {id: 'sol_nebula', system: 'sol', type: 'nebula'},
      {id: 'sol_debris', system: 'sol', type: 'debris_field'},
      {id: 'kepler_station', system: 'kepler', type: 'station', base: 'kepler_base'},
      {id: 'kepler_belt', system: 'kepler', type: 'asteroid_belt', ore: 'copper_ore'},
    ],
    poi: 'sol_station', docked: true,
    fuel: 100, maxFuel: 100, hull: 100, maxHull: 100, cargoCap: 50,
    cargo: [], credits: 500, battle: null,
    wrecks: {sol_debris: [[{item_id: 'scrap', quantity: 20}, {item_id: 'circuit_board', quantity: 2}]]},
    fauna: {sol_nebula: ['sift_ray', 'sift_ray', 'sift_ray']},
    market: {
      sol_base: {iron_ore: 8, copper_ore: 12, scrap: 5, circuit_board: 60, fuel_cell: 20},
      kepler_base: {iron_ore: 6, copper_ore: 20, scrap: 4},
    },
    board: {sol_base: [
      {id: 'm1', title: 'Deliver 10 iron_ore', reward: 150, deliver: {item_id: 'iron_ore', quantity: 10}, base: 'sol_base'},
      {id: 'm2', title: 'Deliver 5 scrap', reward: 40, deliver: {item_id: 'scrap', quantity: 5}, base: 'sol_base'},
      {id: 'm3', title: 'Deliver 30 copper_ore to kepler', reward: 300, deliver: {item_id: 'copper_ore', quantity: 30}, base: 'kepler_base'},
      {id: 'm4', title: 'Deliver 1 circuit_board', reward: 100, deliver: {item_id: 'circuit_board', quantity: 1}, base: 'sol_base'},
    ], kepler_base: []},
    active: [], maxMissions: 5,
    busy: 0, ambushAfterMines: null, hullCriticalOnFight: null, badBook: false,
    calls: [], notes: [], slept: 0, mines: 0,
    ...over,
  };
}

// ── the service ────────────────────────────────────────────────────────────
export class Game extends Context.Tag('Game')<Game, {readonly world: World}>() {}

/** A clock whose sleep costs no wall time; it only counts. Schedules and Effect.sleep use it. */
function virtualClock(world: World): Clock.Clock {
  let now = Date.now();
  return {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => now,
    currentTimeMillis: Effect.sync(() => now),
    unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (d: Duration.Duration) => Effect.sync(() => {const ms = Duration.toMillis(d); now += ms; world.slept += ms;}),
  } as Clock.Clock;
}

export const gameLayer = (world: World) =>
  Layer.merge(Layer.succeed(Game, {world}), Layer.setClock(virtualClock(world)));

// ── errors ─────────────────────────────────────────────────────────────────
export class InBattle extends Data.TaggedError('InBattle')<{readonly enemy: string}> {}
export class NotDocked extends Data.TaggedError('NotDocked')<{readonly poi: string; readonly bases: readonly string[]}> {}
export class HoldFull extends Data.TaggedError('HoldFull')<{readonly used: number; readonly capacity: number}> {}
export class NoWreck extends Data.TaggedError('NoWreck')<{readonly poi: string}> {}
export class UnknownPlace extends Data.TaggedError('UnknownPlace')<{readonly id: string; readonly nearest: readonly string[]}> {}
export class NoFuel extends Data.TaggedError('NoFuel')<{readonly need: number; readonly have: number}> {}
export class ServerBusy extends Data.TaggedError('ServerBusy')<{readonly retryAfterMs: number}> {}
export class NotAtBelt extends Data.TaggedError('NotAtBelt')<{readonly poi: string}> {}
export class NoBuyer extends Data.TaggedError('NoBuyer')<{readonly items: readonly string[]}> {}
export class NothingHere extends Data.TaggedError('NothingHere')<{readonly poi: string}> {}
export class HullCritical extends Data.TaggedError('HullCritical')<{readonly hull: number}> {}
export class NoSlots extends Data.TaggedError('NoSlots')<{readonly active: number; readonly max: number}> {}
export class UnknownMission extends Data.TaggedError('UnknownMission')<{readonly id: string}> {}
export class NothingCompletable extends Data.TaggedError('NothingCompletable')<{readonly base: string}> {}

export type GameError = InBattle | NotDocked | HoldFull | NoWreck | UnknownPlace | NoFuel | ServerBusy
  | NotAtBelt | NoBuyer | NothingHere | HullCritical | NoSlots | UnknownMission | NothingCompletable;

// ── schemas ────────────────────────────────────────────────────────────────
export const RowSchema = Schema.Struct({item_id: Schema.String, quantity: Schema.Number});
export const Present = Schema.Struct({
  poi: Schema.String, system: Schema.String, docked_at: Schema.NullOr(Schema.String),
  fuel: Schema.Number, max_fuel: Schema.Number, hull: Schema.Number, max_hull: Schema.Number,
  cargo: Schema.Array(RowSchema), cargo_used: Schema.Number, cargo_capacity: Schema.Number,
  credits: Schema.Number, in_battle: Schema.Boolean,
});
export type Present = typeof Present.Type;
/** One row of the raw market book: prices arrive as strings. */
export const MarketRow = Schema.Struct({item_id: Schema.String, best_buy: Schema.NumberFromString, best_sell: Schema.NumberFromString});
export const MarketBook = Schema.Struct({base: Schema.String, rows: Schema.Array(MarketRow)});
export type MarketBook = typeof MarketBook.Type;

export type Quote = {readonly item_id: string; readonly best_buy: number; readonly held: number};
export type Scouted = {readonly system: string; readonly pois: readonly {readonly id: string; readonly type: string; readonly base: string | null}[]};
export type Arrived = {readonly poi: string; readonly docked_at: string | null; readonly fuel_used: number};
export type Sold = {readonly total: number; readonly fills: readonly {readonly item_id: string; readonly quantity: number; readonly earned: number}[]; readonly short: readonly string[]};
export type Salvaged = {readonly looted: readonly Row[]; readonly left: readonly Row[]};
export type Hunted = {readonly fights: readonly {readonly target: string; readonly won: boolean}[]; readonly ended: 'done' | 'hull'};
export type Completed = {readonly completed: readonly Mission[]; readonly credits: number};

// ── internals ──────────────────────────────────────────────────────────────
const W = Effect.map(Game, g => g.world);
const used = (w: World) => w.cargo.reduce((n, r) => n + r.quantity, 0);
const add = (w: World, item_id: string, quantity: number) => {
  const r = w.cargo.find(c => c.item_id === item_id);
  w.cargo = r ? w.cargo.map(c => c === r ? {item_id, quantity: c.quantity + quantity} : c) : [...w.cargo, {item_id, quantity}];
};
const take = (w: World, item_id: string, quantity: number) => {
  w.cargo = w.cargo.map(c => c.item_id === item_id ? {item_id, quantity: c.quantity - quantity} : c).filter(c => c.quantity > 0);
};
const here = (w: World) => w.pois.find(p => p.id === w.poi)!;
const dockedBase = (w: World) => (w.docked ? here(w).base ?? null : null);
const call = (w: World, name: string) => { if (w.calls.push(name) > 300) throw new Error('runaway: over 300 calls'); };
const needDock = (w: World) => {
  const b = dockedBase(w);
  return b ? Effect.succeed(b) : Effect.fail(new NotDocked({poi: w.poi, bases: w.pois.filter(p => p.system === here(w).system && p.base).map(p => p.base!)}));
};
const noBattle = (w: World) => (w.battle ? Effect.fail(new InBattle({enemy: w.battle})) : Effect.void);

// ── the surface ────────────────────────────────────────────────────────────
export const orient = (): Effect.Effect<Present, never, Game> => Effect.map(W, w => {
  call(w, 'orient');
  return {poi: w.poi, system: here(w).system, docked_at: dockedBase(w), fuel: w.fuel, max_fuel: w.maxFuel,
    hull: w.hull, max_hull: w.maxHull, cargo: w.cargo.map(r => ({...r})), cargo_used: used(w),
    cargo_capacity: w.cargoCap, credits: w.credits, in_battle: w.battle !== null};
});

export const scout = (system?: string): Effect.Effect<Scouted, UnknownPlace, Game> => Effect.flatMap(W, w => {
  call(w, 'scout');
  const sys = system ?? here(w).system;
  const pois = w.pois.filter(p => p.system === sys);
  if (!pois.length) return Effect.fail(new UnknownPlace({id: sys, nearest: [...new Set(w.pois.map(p => p.system))]}));
  return Effect.succeed({system: sys, pois: pois.map(p => ({id: p.id, type: p.type, base: p.base ?? null}))});
});

export const goTo = (id: string): Effect.Effect<Arrived, InBattle | UnknownPlace | NoFuel | ServerBusy, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, `goTo:${id}`);
  yield* noBattle(w);
  if (w.busy > 0) { w.busy--; return yield* Effect.fail(new ServerBusy({retryAfterMs: 1000})); }
  const dest = w.pois.find(p => p.id === id || p.base === id) ?? w.pois.find(p => p.system === id && p.base);
  if (!dest) return yield* Effect.fail(new UnknownPlace({id, nearest: w.pois.map(p => p.id).slice(0, 3)}));
  const need = dest.id === w.poi ? 0 : dest.system === here(w).system ? 5 : 15;
  if (w.fuel < need) return yield* Effect.fail(new NoFuel({need, have: w.fuel}));
  w.fuel -= need; w.poi = dest.id; w.docked = Boolean(dest.base);
  return {poi: dest.id, docked_at: dest.base ?? null, fuel_used: need};
}));

export const mine = (): Effect.Effect<Row, InBattle | NotAtBelt | HoldFull, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'mine');
  yield* noBattle(w);
  const p = here(w);
  if (!p.ore) return yield* Effect.fail(new NotAtBelt({poi: p.id}));
  const room = w.cargoCap - used(w);
  if (room <= 0) return yield* Effect.fail(new HoldFull({used: used(w), capacity: w.cargoCap}));
  w.mines++;
  if (w.ambushAfterMines !== null && w.mines > w.ambushAfterMines) {
    w.ambushAfterMines = null; w.battle = 'pirate_raider';
    return yield* Effect.fail(new InBattle({enemy: 'pirate_raider'}));
  }
  const q = Math.min(10, room);
  add(w, p.ore, q);
  return {item_id: p.ore, quantity: q};
}));

export const sell = (rows: readonly {readonly item_id: string; readonly quantity?: number}[]): Effect.Effect<Sold, InBattle | NotDocked | NoBuyer, Game> =>
  Effect.flatMap(W, w => Effect.gen(function* () {
    call(w, 'sell');
    yield* noBattle(w);
    const base = yield* needDock(w);
    const fills: {item_id: string; quantity: number; earned: number}[] = [];
    const short: string[] = [];
    for (const r of rows) {
      const held = w.cargo.find(c => c.item_id === r.item_id)?.quantity ?? 0;
      const price = w.market[base]?.[r.item_id];
      const q = Math.min(held, r.quantity ?? held);
      if (!price) { short.push(r.item_id); continue; }
      if (q <= 0) continue;
      take(w, r.item_id, q); w.credits += q * price;
      fills.push({item_id: r.item_id, quantity: q, earned: q * price});
    }
    if (!fills.length && short.length) return yield* Effect.fail(new NoBuyer({items: short}));
    return {total: fills.reduce((n, f) => n + f.earned, 0), fills, short};
  }));

export const service = (): Effect.Effect<{readonly fuel: number; readonly hull: number; readonly cost: number}, NotDocked, Game> =>
  Effect.flatMap(W, w => Effect.gen(function* () {
    call(w, 'service');
    yield* needDock(w);
    const cost = (w.maxFuel - w.fuel) + 2 * (w.maxHull - w.hull);
    w.fuel = w.maxFuel; w.hull = w.maxHull; w.credits -= cost;
    return {fuel: w.fuel, hull: w.hull, cost};
  }));

export const prices = (): Effect.Effect<readonly Quote[], NotDocked, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'prices');
  const base = yield* needDock(w);
  return Object.entries(w.market[base] ?? {}).map(([item_id, best_buy]) =>
    ({item_id, best_buy, held: w.cargo.find(c => c.item_id === item_id)?.quantity ?? 0}));
}));

/** The raw market book, as the server sends it: unknown until decoded with MarketBook. */
export const readMarket = (): Effect.Effect<unknown, NotDocked, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'readMarket');
  const base = yield* needDock(w);
  if (w.badBook) return {base, rows: [{item_id: 'iron_ore', best_buy: 'n/a', best_sell: null}]};
  return {base, rows: Object.entries(w.market[base] ?? {}).map(([item_id, p]) => ({item_id, best_buy: String(p), best_sell: String(p + 2)}))};
}));

export const salvage = (): Effect.Effect<Salvaged, InBattle | NoWreck | HoldFull, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'salvage');
  yield* noBattle(w);
  const wrecks = w.wrecks[w.poi] ?? [];
  if (!wrecks.length) return yield* Effect.fail(new NoWreck({poi: w.poi}));
  if (used(w) >= w.cargoCap) return yield* Effect.fail(new HoldFull({used: used(w), capacity: w.cargoCap}));
  const looted: Row[] = [], left: Row[] = [];
  const remaining: Row[][] = [];
  for (const wreck of wrecks) {
    const rest: Row[] = [];
    for (const r of wreck) {
      const q = Math.min(r.quantity, w.cargoCap - used(w));
      if (q > 0) { add(w, r.item_id, q); looted.push({item_id: r.item_id, quantity: q}); }
      if (q < r.quantity) { rest.push({item_id: r.item_id, quantity: r.quantity - q}); left.push(rest[rest.length - 1]); }
    }
    if (rest.length) remaining.push(rest);
  }
  w.wrecks[w.poi] = remaining;
  return {looted, left};
}));

export const hunt = (opts: {readonly fights?: number} = {}): Effect.Effect<Hunted, NothingHere | HullCritical, Game> =>
  Effect.flatMap(W, w => Effect.gen(function* () {
    call(w, 'hunt');
    const fights: {target: string; won: boolean}[] = [];
    const n = opts.fights ?? 1;
    for (let i = 1; i <= n; i++) {
      const prey = w.battle ?? (w.fauna[w.poi] ?? [])[0];
      if (!prey) {
        if (!fights.length) return yield* Effect.fail(new NothingHere({poi: w.poi}));
        break;
      }
      w.battle = prey;
      w.hull -= 15;
      if (w.hullCriticalOnFight === i) return yield* Effect.fail(new HullCritical({hull: w.hull}));
      w.fauna[w.poi] = (w.fauna[w.poi] ?? []).slice(1);
      w.battle = null;
      (w.wrecks[w.poi] ??= []).push([{item_id: `${prey}_hide`, quantity: 3}]);
      fights.push({target: prey, won: true});
      if (w.hull < 30) return {fights, ended: 'hull' as const};
    }
    return {fights, ended: 'done' as const};
  }));

export const disengage = (): Effect.Effect<boolean, never, Game> => Effect.map(W, w => {
  call(w, 'disengage');
  if (!w.battle) return false;
  w.battle = null; w.hull -= 5;
  return true;
});

export const missions = (): Effect.Effect<readonly Mission[], NotDocked, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'missions');
  const base = yield* needDock(w);
  return (w.board[base] ?? []).filter(m => !w.active.some(a => a.id === m.id));
}));

export const acceptMission = (id: string): Effect.Effect<Mission, NotDocked | NoSlots | UnknownMission, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, `accept:${id}`);
  const base = yield* needDock(w);
  const m = (w.board[base] ?? []).find(x => x.id === id);
  if (!m) return yield* Effect.fail(new UnknownMission({id}));
  if (w.active.some(a => a.id === id)) return m;
  if (w.active.length >= w.maxMissions) return yield* Effect.fail(new NoSlots({active: w.active.length, max: w.maxMissions}));
  w.active.push(m);
  return m;
}));

export const completeMissions = (): Effect.Effect<Completed, NotDocked | NothingCompletable, Game> => Effect.flatMap(W, w => Effect.gen(function* () {
  call(w, 'completeMissions');
  const base = yield* needDock(w);
  const done = w.active.filter(m => m.base === base && (w.cargo.find(c => c.item_id === m.deliver.item_id)?.quantity ?? 0) >= m.deliver.quantity);
  if (!done.length) return yield* Effect.fail(new NothingCompletable({base}));
  let credits = 0;
  for (const m of done) { take(w, m.deliver.item_id, m.deliver.quantity); w.credits += m.reward; credits += m.reward; }
  w.active = w.active.filter(m => !done.includes(m));
  return {completed: done, credits};
}));

export const note = (text: string): Effect.Effect<void, never, Game> => Effect.map(W, w => { w.notes.push(String(text)); });
