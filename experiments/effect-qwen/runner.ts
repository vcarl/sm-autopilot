// node runner.ts <effect|promise> <script.ts> <task id> <scenario index>
// Runs one pilot script against one scenario and prints {pass, why, result, world} as JSON.
import {pathToFileURL} from 'node:url';
import {Cause, Effect, Exit, Option} from 'effect';
import {gameLayer, makeWorld} from './lib/core.ts';
import {setWorld} from './lib/promise.ts';
import {setWorld as setResultWorld} from './lib/result.ts';
import {tasks} from './tasks.ts';
import type {Result} from './tasks.ts';

const [variant, script, taskId, idx] = process.argv.slice(2);
const task = tasks.find(t => t.id === taskId)!;
const scenario = task.scenarios[Number(idx)];
const world = makeWorld(structuredClone(scenario.world));

// Real timers cost no wall time either: a script's own setTimeout sleep counts as game time.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms && ms > 0) world.slept += ms;
  return realSetTimeout(fn, 0, ...rest);
}) as typeof setTimeout;

const tagOf = (e: unknown) => (typeof e === 'object' && e !== null && '_tag' in e ? String((e as {_tag: unknown})._tag) : undefined);
let result: Result;
try {
  const mod = await import(pathToFileURL(script).href);
  if (variant === 'effect') {
    const main = mod.default;
    if (!Effect.isEffect(main)) throw new Error(`default export is ${typeof main}, not an Effect`);
    const exit = await Effect.runPromiseExit((main as Effect.Effect<unknown, unknown, never>).pipe(Effect.provide(gameLayer(world))));
    if (Exit.isSuccess(exit)) result = {ok: true, value: exit.value};
    else {
      const f = Cause.failureOption(exit.cause);
      result = Option.isSome(f) ? {ok: false, tag: tagOf(f.value) ?? 'untagged', message: String(f.value)}
        : {ok: false, tag: 'defect', message: Cause.pretty(exit.cause).slice(0, 400)};
    }
  } else {
    if (variant === 'result') setResultWorld(world); else setWorld(world);
    const main = mod.default;
    if (typeof main !== 'function') throw new Error(`default export is ${typeof main}, not a function`);
    try { result = {ok: true, value: await main()}; }
    catch (e) { result = {ok: false, tag: tagOf(e) ?? 'untagged', message: String(e).slice(0, 400)}; }
  }
} catch (e) {
  result = {ok: false, tag: 'load', message: String(e).slice(0, 400)};
}
let why: string | null;
try { why = scenario.check(world, result); } catch (e) { why = `check threw: ${e}`; }
const {pois, board, market, ...rest} = world;
console.log(JSON.stringify({pass: why === null, why, result: {...result, value: JSON.stringify(result.value)?.slice(0, 200)}, world: rest}));
