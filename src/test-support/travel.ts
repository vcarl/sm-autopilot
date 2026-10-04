import {Clock,Duration,Effect} from 'effect';
import {GameLive,rawError} from '../play/game.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {travelToEffect,type TravelDestination,type TravelOptions} from '../travel.ts';

/** A test world's clock: `now` is its time, and `sleep` is a poll's pause, which the world may
 * use to move the ship. The arrival wait reads time only from the `Clock`. */
export interface WorldTime {now?:()=>number;sleep?:(ms:number)=>Promise<void>}
export const worldClock=({now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}:WorldTime):Clock.Clock=>({
  currentTimeMillisUnsafe:now,currentTimeMillis:Effect.sync(now),
  currentTimeNanosUnsafe:()=>BigInt(Math.round(now()))*1_000_000n,currentTimeNanos:Effect.sync(()=>BigInt(Math.round(now()))*1_000_000n),
  monotonicTimeNanosUnsafe:()=>BigInt(Math.round(now()))*1_000_000n,monotonicTimeNanos:Effect.sync(()=>BigInt(Math.round(now()))*1_000_000n),
  sleep:duration=>Effect.promise(()=>sleep(Duration.toMillis(duration))),
});
/** Run `effect` on the world's clock. */
export const onWorldClock=<A,E,R>(effect:Effect.Effect<A,E,R>,time:WorldTime)=>effect.pipe(Effect.provideService(Clock.Clock,worldClock(time)));

/** `travelToEffect` on its own `Game` over `command`, as the tests have always driven travel: a
 * failure throws the raw error (the lib's own on a refusal, travel's classes as themselves). */
export async function travelTo(account:ReadinessAccount,command:ReadinessCommand,destination:TravelDestination,options:TravelOptions&WorldTime={}) {
  const {now,sleep,...rest}=options;
  const exit=await Effect.runPromiseExit(onWorldClock(travelToEffect(account,destination,rest),{...now?{now}:{},...sleep?{sleep}:{}})
    .pipe(Effect.provide(GameLive({send:command}))));
  if(exit._tag==='Failure')throw rawError(exit.cause);
  return exit.value;
}
