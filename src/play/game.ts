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
import {SpacemoltError,type Account} from '@spacemolt/lib';
import {Cause,Context,Data,Effect,Layer,Result} from 'effect';
import {replyLost} from '../command-boundary.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {ReplyLost,isGameError,refusal,type GameError} from './codes.ts';

export {Depleted,HoldFull,InBattle,Rejected,ReplyLost,isGameError,type GameError} from './codes.ts';

/** A Promise the seam lent us rejected: the raw error, before anything has judged it. Never
 * leaves a method that classifies it, except `refresh`, whose callers say it and go on. */
export class SeamFailed extends Data.TaggedError('SeamFailed')<{readonly cause:unknown}> {}

export const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** What the unconverted Promise callers expect of a failure: the raw error the lib threw (the
 * tag's `cause`), or the thrown value of a defect. They check `instanceof SpacemoltError`, `.code`
 * and `replyLost(error)`, so a tag would be a regression for them. */
export const rawError=(cause:Cause.Cause<unknown>):unknown=>{
  const error=Cause.squash(cause);
  return (isGameError(error)||error instanceof SeamFailed)&&error.cause!==undefined?error.cause:error;
};

/** `cause` to its tag. The only reader of `SpacemoltError`. Anything that is neither the lib's
 * refusal nor a lost reply is a bug, not a game outcome: it is rethrown, and an Effect that
 * throws inside `suspend` (or a `tryPromise` `catch`) makes it a defect. The raw error stays on
 * the tag as `cause`. */
export const classify=(action:string)=>(cause:unknown):GameError=>{
  if(replyLost(cause))return new ReplyLost({action,cause});
  if(cause instanceof SpacemoltError)return refusal({action,code:cause.code,message:cause.message,cause});
  throw cause;
};

/** A Promise body run as one game step: the lib's refusal or a lost reply is its tag, anything
 * else is a defect carrying the thrown value. For code still on `await` that wants the failure typed. */
export const attempt=<A>(label:string,body:()=>Promise<A>)=>Effect.tryPromise({try:body,catch:classify(label)});

/** The errors a dropped connection raises: the lib's own two, before its `reconnect:true`
 * has re-authenticated. Anything else is the game refusing, which is not retried. */
const DISCONNECTED=/WebSocket connection closed|No action_result/;
/** Commands whose end state the live world re-states, so re-issuing one after a lost
 * connection costs at most a repeat of a read (or one more mining tick, measured from
 * cargo). Everything else — sell, buy, accept, deposit — moves something once. */
const IDEMPOTENT=new Set(['mine','travel','jump','dock','undock','find_route','view','view_market','view_storage','status']);
const reissuable=(action:string)=>{const name=action.split('/')[1]??'';return name.startsWith('get_')||IDEMPOTENT.has(name);};
/** A command pending longer than this says so, and keeps saying so every this often. The
 * contract is a line from any long step at least every 2 minutes; 30s is well inside it. */
const WAITING_MS=30_000;

/** What the command path keeps for `progress()`: counted, when it last heard back, what is on
 * the wire now, and the last game tick any reply carried. The binding owns one. */
export interface Ledger {commands:number;lastCommandAt:number;pending:{action:string;since:number}|null;lastTick:number|undefined}
export const freshLedger=():Ledger=>({commands:0,lastCommandAt:0,pending:null,lastTick:undefined});

/** What a game reply says about the tick, narrowed with `in`: the lib types a reply as unknown here. */
export const field=(value:unknown,key:string):unknown=>typeof value==='object'&&value!==null&&key in value?Reflect.get(value,key):undefined;
const tickOf=(reply:unknown):unknown=>field(field(reply,'structuredContent'),'tick')??field(field(field(reply,'delta'),'details'),'tick')??field(reply,'tick');

/** The binding's Promise seams, as plain functions. Every one but `send` is optional: a test
 * world with only a `send` is a connection that never reconnects and has nothing to re-read. */
export interface Seam {
  /** The bridge's journalled command: one send, `tool/action`. */
  readonly send:ReadinessCommand;
  /** Wait for the lib's own reconnect to re-authenticate; false when it never comes. */
  readonly reconnected?:()=>Promise<boolean>;
  /** Force a reconnect in place; absent when the account cannot. */
  readonly reconnect?:Account['reconnectOnce'];
  readonly refresh?:ReadinessAccount['refresh'];
  /** A line to the stream and the journal. */
  readonly say?:(text:string)=>void;
  /** After every command, whatever it came to: burn cells, say a mood change. */
  readonly after?:()=>Promise<void>;
  readonly ledger?:Ledger;
}

export class Game extends Context.Service<Game,{
  /** One command, `tool/action`, as the bridge's command seam names it. */
  readonly command:(action:string,params?:Record<string,unknown>)=>Effect.Effect<unknown,GameError>;
  /** Re-read the account. A failure is the raw error, for a caller that says it and goes on. */
  readonly refresh:Effect.Effect<void,SeamFailed>;
}>()('Game') {}

export const GameLive=(seam:Seam)=>{
  const wire=seam.ledger??freshLedger(),say=seam.say??(()=>{});
  const seamed=<A>(attempt:()=>Promise<A>)=>Effect.tryPromise({try:attempt,catch:cause=>new SeamFailed({cause})});
  const refresh=seam.refresh;
  /** One command on the wire, with the waiting said out loud. A mine tick is 10s and a transit
   * is minutes, so silence is the only thing a pilot cannot tell apart from a wedged bridge. */
  const sent=(action:string,params:Record<string,unknown>)=>Effect.suspend(()=>{
    const since=Date.now();
    wire.pending={action,since};
    const ticker=setInterval(()=>say(
      `  ${action}: waiting ${Math.round((Date.now()-since)/1000)}s for the game (last tick ${wire.lastTick??'?'})`),WAITING_MS);
    ticker.unref?.();
    return seamed(()=>seam.send(action,params)).pipe(
      Effect.tap(reply=>Effect.sync(()=>{const seen=tickOf(reply);if(typeof seen==='number')wire.lastTick=seen;})),
      Effect.ensuring(Effect.sync(()=>{clearInterval(ticker);wire.lastCommandAt=Date.now();wire.pending=null;})));
  });
  /** The raw failure to its tag; a bug (neither refusal nor lost reply) dies with the thrown value. */
  const settle=(action:string,failed:SeamFailed)=>Effect.suspend(()=>Effect.fail(classify(action)(failed.cause)));
  const command=(action:string,params:Record<string,unknown>={})=>Effect.gen(function*() {
    wire.commands++;
    const first=yield* Effect.result(sent(action,params));
    if(Result.isSuccess(first))return first.success;
    const error=first.failure.cause;
    if(!DISCONNECTED.test(message(error)))return yield* first.failure;
    say(`  ${action}: ${message(error)}; waiting for the connection`);
    // A half-open socket is never *closed*, so the lib's own reconnect may never fire at all:
    // wait a minute for it, then force one in place — same Account, same listeners, fresh socket.
    const waitForIt=seam.reconnected;
    let back=waitForIt?yield* Effect.promise(()=>waitForIt()):false;
    if(!back&&seam.reconnect) {
      say(`  ${action}: no reconnect in 60s; forcing one`);
      const forced=yield* Effect.result(seamed(seam.reconnect));
      if(Result.isSuccess(forced))back=true;
      else say(`  ${action}: the forced reconnect failed (${message(forced.failure.cause)})`);
    }
    // The re-read may fail too; the failure below stands, so this one is only looked at, not kept.
    if(refresh)yield* Effect.result(seamed(refresh));
    if(!back)return yield* first.failure;
    if(!reissuable(action)) {
      say(`  ${action}: reconnected, but the command may have landed; not re-sent`);
      return yield* new ReplyLost({action,cause:new SpacemoltError('connection_closed',`${action}: outcome unknown, re-observe`)});
    }
    say(`  ${action}: reconnected; re-issued once`);
    return yield* sent(action,params);
  }).pipe(
    Effect.catchTag('SeamFailed',failed=>settle(action,failed)),
    Effect.ensuring(Effect.promise(async()=>{await seam.after?.();})));
  return Layer.succeed(Game,{command,refresh:refresh?seamed(refresh).pipe(Effect.asVoid):Effect.void});
};
