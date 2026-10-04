/** What the runtime lends the library and the pilot's own code: the account, the pilot
 * record, a journal line, the stop flag, an Outcome builder. Bound once per run by `run`
 * before the entrypoint is imported; there is exactly one pilot per process.
 *
 * Inside, the same module holds what the library needs and the pilot does not see: the
 * command seam (journal + Tired imposition), the measuring `job()` wrapper, the step line,
 * and the rules check helpers ask before starting work.
 *
 * ponytail: a module singleton, not AsyncLocalStorage. One account per bridge process today;
 * a multi-account runtime is a second process per account (DESIGN.md "Fleet").
 */
import type {Account,SkillProgress} from '@spacemolt/lib';
import {Cause,Data,Effect,Exit,ManagedRuntime,Result} from 'effect';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {FUEL_CELL} from '../mining-inventory.ts';
import {journalRun,readRun,stampRun,writeRun,type RunRecord} from '../run-record.ts';
import type {DockBlocked} from '../dock.ts';
import {TravelBlocked,type ArrivalUnresolved} from '../travel.ts';
import {Depleted,Game,GameLive,HoldFull,InBattle,Rejected,ReplyLost,attempt,freshLedger,field,message,rawError,type GameError} from './game.ts';
import {resupply} from './service.ts';
import type {Outcome,Present,Row,Status,Want} from './types.ts';

export type Mood='Cautious'|'Focused'|'Opportunistic'|'Aggressive'|'Relaxed'|'Tired';
export type Stance='Prospector'|'Industrialist'|'Trader'|'Carrier'|'Hunter'|'Scout';

/** `pilot.json`, read fresh on every call, plus the mood derived from the ship. The pilot never
 * writes it: reflection sets goal and stance; the observer carries in the rest. */
export interface Pilot {
  name?:string;
  objective?:string;objective_done?:boolean;
  goal?:string;stance?:Stance;
  /** Derived, never stored: the stance's working mood, or Tired past its margins (`moodNow`). */
  mood?:Mood;
  /** Present only while the mood is Tired: the margin that made it so. */
  tired_by?:string;
  /** Standing bounds the human sets. Who to fight is not among them: combat targeting is
   * the pilot's judgement, kept honest by the hull floors and the walk-away fraction. */
  permissions?:{credit_reserve?:number;max_liability?:number};
  instruction?:{text:string;at:string};
}

export interface Binding {
  account:Account;
  command:ReadinessCommand;
  /** The record with its derived mood; the bridge derives it from the live ship on every call. */
  pilot:()=>Pilot;
  /** Where the journal lives. Without one nothing is journalled; lines still stream. */
  runtime?:string;
  /** Where a streamed line goes after the journal has it. */
  emit:(text:string)=>void;
  /** Told when the program pauses on `ask()`, so the request waiting on the run can answer. */
  onAsk?:(question:Question)=>void;
  /** A run's id, stamped on every journal line while it is bound. Absent for the menu's reads. */
  run_id?:string;
}

/** The binding, with its own `Game` runtime: commands through it take this binding's journalled
 * `command()` path (docs/EFFECT.md "The Promise ↔ Effect edge"). */
let bound:(Binding&{readonly game:ManagedRuntime.ManagedRuntime<Game,never>})|null=null;
/** How many jobs deep the program is: 1 is a call `main()` made itself. */
let depth=0;
let stopFlag=false,started=0;
/** What the command path keeps for `progress()`; `GameLive` writes it. */
const wire=freshLedger();
let last:{fn:string;step?:string}={fn:'pilot'};
let mark:Snapshot|null=null;
/** The opening read of the job now running, so a helper inside it can say what it measured. */
let jobMark:Snapshot|null=null;
let unwatch:(()=>void)|undefined;
/** Every top-level call `main()` made this run, as the menu reads a run: the function, its
 * first argument, how it ended and what it gained. ponytail: the first whitespace token of
 * the job's label stands in for "first argument"; it is the poi/id for every job that takes one. */
export interface Call {fn:string;arg:string;status:Status;did:string;
  /** The Outcome's own `why`, so the report of a call that did not end `done` carries the
   * reason (the suggested ids of a refused destination) and not only the `did`. */
  why?:string;
  credits:number;items:number;xp:number;cost:Outcome['cost'];
  /** Telemetry, journalled on run/ended: the whole of what the call gained, and when it ran. */
  gained?:Outcome['gained'];started_at?:string;seconds?:number}
let calls:Call[]=[];
export const runCalls=()=>calls;

/** A question the program is paused on, as run.json and the tools carry it. */
export type Question=NonNullable<RunRecord['question']>;
let asking:{question:Question;resolve:(answer:string)=>void;reject:(error:unknown)=>void}|null=null;
/** The question the program is paused on, or null. */
export const pendingQuestion=():Question|null=>asking?.question??null;
/** run.json carries the pending question, so the juncture gate (another process) can see it. */
function recordQuestion(question:Question|null):void {
  const runtime=bound?.runtime,record=runtime?readRun(runtime):null;
  if(!runtime||!record)return;
  if(question)record.question=question;else delete record.question;
  writeRun(runtime,record);
}

const need=()=>{if(!bound)throw new Error('the play runtime is not bound: only `run` may execute pilot code');return bound;};

/** Bind the runtime for one run. Resets the stop flag and the counters. */
export function bind(binding:Binding):void {
  const {account:live}=binding,once=live.reconnectOnce?.bind(live);
  bound={...binding,game:ManagedRuntime.make(GameLive({send:(action,params)=>need().command(action,params),
    reconnected,refresh:()=>live.refresh(),say:line,ledger:wire,
    after:async()=>{await burnCells();watchMood();},...once?{reconnect:once}:{}}))};
  stopFlag=false;asking=null;depth=0;started=Date.now();last={fn:'pilot'};calls=[];
  Object.assign(wire,freshLedger());burning=false;burnFailed=false;short=undefined;
  mark=snapshot();
  stampRun(binding.run_id?{run_id:binding.run_id}:null);
  lastMood=binding.pilot().mood;
  // A lib Account pushes state between commands (a tick, a fight); the fake in tests does not.
  unwatch=live.onStateChange?.(()=>{
    try {watchMood();}
    catch { // edge: a push from the lib's socket is not the place to fail
    }
  });
}
export function unbind():void {unwatch?.();unwatch=undefined;asking=null;void bound?.game.dispose();bound=null;stampRun(null);}
export const isBound=()=>bound!==null;

/** The pilot record as it is right now. Cheap; call it, do not cache it. */
export function pilot():Pilot {return need().pilot();}

/** The connected `@spacemolt/lib` Account: typed state (`account().ship: V2Ship`,
 * `.cargo: V2CargoItem[]`, `.location: V2Location`, `.credits`, `.skills`) and every game
 * command as `account().commands.<tool>.<action>()`. This IS the library; ours are the
 * conveniences for bulk actions, common failures and precondition checks. Mutations you send
 * yourself are journalled and margin-checked like any other, but they are NOT idempotent and
 * NOT rules-checked: read the reply before sending the same one again. */
export function account():Account {
  const live=need().account;
  return new Proxy(live,{get:(target,key)=>{
    if(key==='commands')return commandsProxy;
    const value=Reflect.get(target,key);
    return typeof value==='function'?value.bind(target):value;
  }});
}
// The lib binds a no-param action as `(requestId)`, so `commands.spacemolt_salvage.sell({id})`
// sent the params as the request id and timed out ("No response to mutation [object Object]").
// Every `commands.<tool>.<action>(params)` goes through `command()` instead: params are the payload.
const commandsProxy=new Proxy({},{get:(_,tool)=>new Proxy({},{get:(__,action)=>
  (params?:unknown)=>command(`${String(tool)}/${String(action)}`,isRecord(params)?params:{})})});
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;

/** Write one line to the journal and to the run's stream, under your own words. Use it to
 * say what you decided and why, so the record shows the reasoning, not only the moves. */
export function note(text:string):void {line(`✎ ${text}`);}

/** True once the pilot (or the observer) asked the run to stop. Every library function checks it
 * between commands and returns `partial`; a loop of your own should check it too. */
export function stopped():boolean {return stopFlag;}
/** Ask the run to stop. A program paused on `ask()` is not at a safe point, it is waiting: the
 * ask rejects with `Stopped` there and then, and the question is withdrawn. */
export function stop():void {
  stopFlag=true;
  const waiting=asking;
  if(!waiting)return;
  asking=null;
  recordQuestion(null);
  line(`question withdrawn by stop: ${waiting.question.question}`);
  waiting.reject(new Stopped());
}

/** Thrown from a travel checkpoint when the pilot asked to stop; the leg in flight finishes. */
export class Stopped extends TravelBlocked {readonly _tag='Stopped';constructor(){super('stopped by pilot');}}
export const checkStop=()=>{if(stopFlag)throw new Stopped();};

/** Pause the program and put a question to the model that is running it; resolves to its
 * answer, which is always one of `choices` when they are given. It waits until the answer
 * comes, or rejects with `Stopped` when the run is stopped — by a person, or by the run's
 * wall-clock cap (run.ts).
 * A model call takes minutes, so ask at a strategic fork, never once per tick. */
export function ask(asked:{question:string;choices?:string[]}):Promise<string> {
  need();
  if(stopFlag)return Promise.reject(new Stopped());
  const text=String(asked?.question??'').trim();
  const choices=asked?.choices;
  const refused=!text?'ask needs a question'
    :asking?'ask: a question is already pending; await one before asking the next'
    :choices!==undefined&&(!Array.isArray(choices)||!choices.length||choices.some(c=>typeof c!=='string'||!c.trim()))
      ?'ask: choices must be a non-empty list of non-empty strings'
    :null;
  if(refused)return Promise.reject(new Error(refused));
  const question:Question={question:text,...choices?{choices:[...choices]}:{},
    asked_at:new Date().toISOString()};
  return new Promise<string>((resolve,reject)=>{
    asking={question,resolve,reject};
    recordQuestion(question);
    line(`? ${text}${choices?`  [${choices.join(' | ')}]`:''}`);
    need().onAsk?.(question);
  });
}

/** Resume the paused program with `text`. The caller has already held it to the choices. */
export function answer(text:string):void {
  const waiting=asking;
  if(!waiting)throw new Error('no question is pending');
  asking=null;
  recordQuestion(null);
  line(`answered: ${text}`);
  waiting.resolve(text);
}

/** Build an Outcome for a function of your own. You supply the sentence, the status and the
 * detail; the runtime fills `fn`, `cost`, `gained` and `now` from what it measured since the
 * run started or since your last `outcome()` call, whichever is later. Return it from your
 * helper so it composes like ours. */
export function outcome<Detail=Record<string,unknown>>(did:string,status:Status='done',detail?:Detail,why?:string):Outcome<Detail> {
  const before=mark??snapshot();
  const built=finish('pilot',before,{status,did,...why===undefined?{}:{why},detail:orEmpty(detail)});
  mark=snapshot();
  return built;
}

/** The rows a pilot asked for, normalised: `quantity` omitted means all of it, carried on as
 * `Infinity`. A non-finite quantity is a typo, not a way to say "all", and is refused here so
 * every row-taking function refuses it the same way. */
export function wanted(rows:Want[]):{rows:Row[]}|{refused:string} {
  const bad=rows.find(row=>row.quantity!==undefined&&!Number.isFinite(Number(row.quantity)));
  if(bad)return {refused:`${bad.item_id}: quantity ${bad.quantity} is not a finite number; omit quantity to mean all of it`};
  return {rows:rows.map(row=>({item_id:String(row.item_id),quantity:row.quantity===undefined?Infinity:Number(row.quantity)}))
    .filter(row=>row.item_id&&row.quantity>0)};
}

// ---- internal: the seam, the measurement, the lines ----------------------------------

/** Wait for the lib's own reconnect to re-authenticate this account, up to `ms`. False when
 * the account has no reconnect listener (a test fake) or the wait ran out. */
function reconnected(ms=60_000):Promise<boolean> {
  const {account:live}=need(),listen=live.onReconnected?.bind(live);
  if(typeof listen!=='function')return Promise.resolve(false);
  return new Promise(resolve=>{
    let off:(()=>void)|undefined;
    const timer=setTimeout(()=>{off?.();resolve(false);},ms);
    timer.unref?.();
    off=listen(()=>{clearTimeout(timer);off?.();resolve(true);});
  });
}

/** Every game command a helper sends: `Game.command` (game.ts) through the binding's runtime,
 * its failure handed back as the raw error. Journalled by the bridge's command; counted, and a
 * mood change it caused is said by the layer's `after`.
 *
 * A connection that drops mid-command is not the trip ending: the lib reconnects and
 * re-authenticates by itself, so the layer waits for that, re-reads the world, and re-issues the
 * command exactly once when it is one the live world can restate. A mutation that may have
 * landed is never re-sent — it fails with "outcome unknown, re-observe" instead.
 *
 * A `run*` besides `edge` (the others are marked `// bridge:`), and the
 * string seam: U31 deletes it with the callers that still `await command(...)`. */
export async function command(action:string,params:Record<string,unknown>={}):Promise<unknown> {
  const exit=await viaGame(Effect.gen(function*() {return yield* (yield* Game).command(action,params);}));
  if(Exit.isSuccess(exit))return exit.value;
  throw rawError(exit.cause);
}
export const acct=():ReadinessAccount=>need().account;
export const runtimeDir=()=>need().runtime;

/** One streamed line: journalled first, then sent. */
export function line(text:string,extra:Record<string,unknown>={}):void {
  const b=need();
  if(b.runtime)journalRun(b.runtime,{text,fn:last.fn,...last.step?{step:last.step}:{},...extra},'line');
  b.emit(text);
}
/** A sub-step inside a helper: an indented line, and the step `status` reports. */
export function step(text:string):void {last.step=text.split(' ')[0]??'';line(`  ${text}`);}

/** Where the run has got to, and — the difference between "waiting on the game" and "the
 * bridge is stuck" — when it last heard back and what is on the wire right now. */
export const progress=()=>({fn:last.fn,step:last.step,commands:wire.commands,elapsed_s:Math.round((Date.now()-started)/1000),
  ...wire.lastCommandAt?{last_command_at:new Date(wire.lastCommandAt).toISOString()}:{},
  ...wire.pending?{pending:{action:wire.pending.action,since_s:Math.round((Date.now()-wire.pending.since)/1000)}}:{}});

/** The rules between one helper and the next: a mood that may not start work. Helpers that
 * begin something (a gather, a buy, a mission) ask before sending; reads and the safe legs
 * (service, stow, sell, going to a base) do not.
 *
 * Tired is not advice: at a call `main()` made itself, the runtime resupplies first (`resupply`)
 * and the work goes on: cleared, or journalled when it could not be. Inside another helper it
 * only refuses — flying off mid-trade would leave the outer helper at the wrong counter — and the
 * resupply waits for the next top-level call or the run's end. */
export async function admit(fn:string):Promise<string|null> {
  if(pilot().mood==='Tired'&&depth===1){const out=await resupply();short=out==='cleared'?undefined:out;}
  const {mood,tired_by}=pilot();
  // Tired is only the resupply guarantee: when resupply could not keep it, refusing the work
  // (which earns the credits, or flies where a base may be learned) would strand the ship.
  if(mood==='Tired'&&short) {
    line(`${fn}: Tired (${tired_by}), ${short==='broke'?'resupply unaffordable: working to pay for it':'resupply found no base: working on'}`);
    return null;
  }
  if(mood==='Tired')return `${fn} not started: Tired (${tired_by??'a margin crossed'}) and the runtime's resupply did not clear it`;
  if(mood==='Relaxed')return `${fn} not started: Relaxed may not initiate a job`;
  return null;
}

interface Snapshot {at:number;credits:number;fuel:number;hull:number;cargo:Record<string,number>;xp:Record<string,number>}
function snapshot():Snapshot {
  const state=need().account.state;
  const cargo:Record<string,number>={};
  for(const row of state.cargo??[])cargo[row.item_id]=(cargo[row.item_id]??0)+row.quantity;
  const xp:Record<string,number>={};
  for(const [id,row] of Object.entries(skillMap(state.skills)))xp[id]=row.xp;
  return {at:Date.now(),credits:state.player?.credits??0,fuel:state.ship?.fuel??0,hull:state.ship?.hull??0,cargo,xp};
}
/** `get_skills` answers a map keyed by skill id (live, C23 replay); some shapes nest it. */
function skillMap(skills:unknown):Record<string,SkillProgress> {
  const raw=field(skills,'skills')??skills;
  return isRecord(raw)&&!Array.isArray(raw)?Object.fromEntries(Object.entries(raw).flatMap(([id,row])=>isProgress(row)?[[id,row] as const]:[])):{};
}
/** Every field of the lib's `SkillProgress`: a malformed row is now left out of the map, not passed through. */
const isProgress=(row:unknown):row is SkillProgress=>isRecord(row)&&typeof row.category==='string'&&typeof row.name==='string'
  &&typeof row.level==='number'&&typeof row.max_level==='number'&&typeof row.next_level_xp==='number'&&typeof row.xp==='number';

/** The ship, wallet, hold, place, skills and active missions as the account already holds them:
 * the run's `start_state`/`end_state`. Reads memory only. Storage is not in account state, so it
 * is not here — it would cost a `storage/view` per run.
 * ponytail: cargo and missions capped at 40 rows, as the storage and market reads are. */
export function stateSnapshot():Record<string,unknown> {
  const state=need().account.state,{ship,location}=state;
  const missions=state.missions?.active;
  return {credits:state.player?.credits??null,fuel:ship?.fuel??null,max_fuel:ship?.max_fuel??null,
    hull:ship?.hull??null,max_hull:ship?.max_hull??null,cargo_used:ship?.cargo_used??null,cargo_capacity:ship?.cargo_capacity??null,
    cargo:(state.cargo??[]).slice(0,40).map(row=>({item_id:row.item_id,quantity:row.quantity})),
    skills:Object.fromEntries(Object.entries(skillMap(state.skills)).map(([id,row])=>[id,{level:row.level,xp:row.xp}])),
    system:location?.system_id??null,poi:location?.poi_id??null,docked_at:location?.docked_at??null,
    ...Array.isArray(missions)?{missions:missions.slice(0,40).map(m=>({mission_id:m.mission_id,title:m.title,type:m.type,
      percent_complete:m.percent_complete,rewards:m.rewards}))}:{}};
}

export function present():Present {
  const state=need().account.state,who=pilot(),{ship,location}=state;
  /* ponytail: `Present` declares `ship` and `location` present (pilot surface, frozen by check 7), but a
   * pilot riding another's ship has no `ship` (V2GameState.riding), and present() runs in every Outcome,
   * which must not reject. Lift it when the surface may say `ship?:`/`location?:`. */
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return {ship:ship as Present['ship'],location:location as Present['location'], // cast: frozen surface (Present)
    cargo:state.cargo??[],
    credits:state.player?.credits??0,skills:skillMap(state.skills),mood:who.mood??'Cautious',
    ...who.mood==='Tired'?{tired_by:who.tired_by??''}:{}};
}

/** What a helper hands back; the wrapper measures the rest. */
export interface Said<Detail> {status:Status;did:string;why?:string;detail:Detail;next?:string[]}

function finish<Detail>(fn:string,before:Snapshot,part:Said<Detail>):Outcome<Detail> {
  const after=snapshot();
  const items:Row[]=[];
  for(const [item_id,quantity] of Object.entries(after.cargo))
    if(quantity>(before.cargo[item_id]??0))items.push({item_id,quantity:quantity-(before.cargo[item_id]??0)});
  const xp:Record<string,number>={};
  for(const [id,value] of Object.entries(after.xp))if(value>(before.xp[id]??0))xp[id]=value-(before.xp[id]??0);
  const credits=after.credits-before.credits;
  return {fn,status:part.status,did:part.did,...part.why===undefined?{}:{why:part.why},
    cost:{credits:Math.max(0,-credits),fuel:Math.max(0,before.fuel-after.fuel),hull:Math.max(0,before.hull-after.hull),
      minutes:Math.round((after.at-before.at)/6000)/10},
    gained:{credits:Math.max(0,credits),items,xp},
    now:present(),next:(part.next??[]).slice(0,3),detail:part.detail};
}

const seconds=(ms:number)=>`${(ms/1000).toFixed(ms<10_000?1:0)}s`;

/** The measuring wrapper every exported function is defined through: snapshot, run, snapshot,
 * diff. Streams `▶ fn args` on entry and `✓/✗ fn status secs did` on return. A throw is folded
 * by `said`; nothing escapes as an exception. The body is a Promise, so its failure is classified
 * as a game step's is (`attempt`): a refusal or lost reply is a tag, any other throw a defect that
 * `said` words from the thrown value and that is not a journalled `defect`, as it never was. */
export const job=<Detail>(fn:string,args:string,body:()=>Promise<Said<Detail>>):Promise<Outcome<Detail>>=>
  edge(jobWith(fn,args,attempt(fn,body),false));

/** `job` for an Effect body: the same bookkeeping, every failure folded into the Outcome by
 * `said`. A defect is a `failed` Outcome too, as a throw is in `job`, and its stack goes to a
 * `defect` line. Never exported from a barrel. */
export const jobEffect=<D,R>(fn:string,args:string,body:Effect.Effect<Said<D>,GameError|TravelBlocked|ArrivalUnresolved|DockBlocked,R>)=>jobWith(fn,args,body,true);

const jobWith=<D,R>(fn:string,args:string,body:Effect.Effect<Said<D>,GameError|TravelBlocked|ArrivalUnresolved|DockBlocked,R>,journalDefects:boolean):Effect.Effect<Outcome<D>,never,R|Game>=>
  Effect.gen(function*() {
    const open=yield* opening(fn,args);
    const exit=yield* Effect.exit(body);
    if(Exit.isSuccess(exit))return yield* closing(open,exit.value,false);
    if(journalDefects)defect(fn,exit.cause);
    return yield* closing(open,said<D>(fn,Cause.squash(exit.cause)),true);
  });

/** The Promise a pilot function returns: `effect` run through the binding's runtime. A defect
 * outside any job is a `failed` Outcome and a `defect` line. */
export async function edge<D>(effect:Effect.Effect<Outcome<D>,never,Game>):Promise<Outcome<D>> {
  const b=need(),before=snapshot(),outer=last,outerMark=jobMark,outerDepth=depth;
  const exit=await b.game.runPromiseExit(effect);
  if(Exit.isSuccess(exit))return exit.value;
  // A die inside a job's own bookkeeping skipped its restore; the edge puts the stack back.
  const fn=last.fn;
  last=outer;jobMark=outerMark;depth=outerDepth;
  defect(fn,exit.cause);
  return finish(fn,before,said<D>(fn,Cause.squash(exit.cause)));
}
/** A `run*` besides `edge` (the others are marked `// bridge:`), for the Promise seams that still `await` a Game effect
 * (`command`, `burnCells`): U31 deletes the string seam and with it this. */
const viaGame=<A,E>(effect:Effect.Effect<A,E,Game>)=>need().game.runPromiseExit(effect);

/** The detail a pilot gave, or the empty object `outcome` has always put there.
 * ponytail: the pilot-surface signature promises a `Detail` that an omitted detail does not have, so this
 * cast says it does. It goes when the surface types an omitted detail (`detail?:`). */
// oxlint-disable-next-line typescript/consistent-type-assertions
function orEmpty<Detail>(detail:Detail|undefined):Detail {return detail??{} as Detail;} // cast: frozen surface (Outcome<Detail>)

const unsaid=new WeakSet<object>();
/** An Outcome's detail when the job built one, `undefined` when it is `said`'s `{}`. An internal caller reads
 * a helper's detail through this: status alone does not tell, since a stop is `partial` and an escaped refusal `refused`. */
export function reached<Detail>(outcome:Outcome<Detail>):Detail|undefined {
  const detail=outcome.detail;
  return typeof detail==='object'&&detail!==null&&unsaid.has(detail)?undefined:detail;
}

/** A failure in its own fields' words. Every definitive refusal tag is `refused`: the server
 * said no and nothing landed, whether or not its code has a tag of its own.
 * ponytail: the pilot-surface `Outcome<Detail>` promises a `Detail` that a failure does not have, so this
 * cast says it does (`{}`). It goes when the surface types a failure's detail. */
function said<Detail>(fn:string,error:unknown):Said<Detail> {
  const none={};
  unsaid.add(none);
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const detail=none as Detail; // cast: frozen surface (Outcome<Detail>)
  if(error instanceof Stopped)return {status:'partial',did:`${fn} stopped by the pilot`,why:error.message,detail};
  if(error instanceof ReplyLost)return {status:'failed',did:`${fn} broke`,why:`reply lost on ${error.action}; state re-read`,detail};
  if(error instanceof Rejected||error instanceof InBattle||error instanceof HoldFull||error instanceof Depleted)
    return {status:'refused',did:`${fn} refused by the game`,why:`${error.action}: ${error.code} — ${error.message}`,detail};
  return {status:'failed',did:`${fn} broke`,why:message(error),detail};
}

/** A bug, not a game outcome: its stack goes to the journal. The stop is not one. */
function defect(fn:string,cause:Cause.Cause<unknown>):void {
  const runtime=bound?.runtime;
  if(!runtime||!Cause.hasDies(cause)||Cause.squash(cause) instanceof Stopped)return;
  journalRun(runtime,{fn,why:message(Cause.squash(cause)),stack:Cause.pretty(cause)},'defect');
}

type Opened={fn:string;args:string;before:Snapshot;outer:typeof last;outerMark:Snapshot|null};
/** The ▶ line and the opening read. A read that fails is said, and the cached state measures. */
const opening=(fn:string,args:string)=>Effect.gen(function*() {
  const outer=last,outerMark=jobMark;
  last={fn};depth++;
  line(`▶ ${fn}${args?` ${args}`:''}`);
  const read=yield* Effect.result((yield* Game).refresh);
  const before=snapshot();
  if(Result.isFailure(read))line(`  ${fn}: the opening read failed (${message(read.failure.cause)}); measuring from cached state`);
  jobMark=before;
  return {fn,args,before,outer,outerMark};
});
/** The closing read, the measurement, the ✓/✗ line and the `calls` push. */
const closing=<Detail>({fn,args,before,outer,outerMark}:Opened,part:Said<Detail>,threw:boolean)=>Effect.gen(function*() {
  // The closing read may fail; the cached state stands, so it is only looked at.
  yield* Effect.result((yield* Game).refresh);
  const built=finish(fn,before,part);
  // A did the wrapper wrote knows nothing of what happened; the measurement does.
  if(threw)built.did=`${built.did}, ${witness(built)}`;
  line(`${built.status==='done'?'✓':'✗'} ${fn}  ${built.status}  ${seconds(Date.now()-before.at)}  ${built.did}${built.why?`: ${built.why}`:''}`);
  if(outer.fn==='pilot')calls.push({fn,arg:args.split(' ')[0]??'',status:built.status,did:built.did,
    ...built.why===undefined?{}:{why:built.why},
    credits:built.gained.credits,cost:built.cost,
    items:built.gained.items.reduce((n,row)=>n+row.quantity,0),xp:Object.values(built.gained.xp).reduce((n,x)=>n+x,0),
    gained:built.gained,started_at:new Date(before.at).toISOString(),seconds:Math.round((Date.now()-before.at)/100)/10});
  last=outer;jobMark=outerMark;depth--;
  return built;
});

/** What the measurement says happened, for a `did` that would otherwise claim nothing did:
 * the gains, the hold, and where the ship ended up. */
function witness(built:Outcome<unknown>):string {
  const {items,credits}=built.gained,{ship,location}=built.now;
  const where=location?.docked_at??location?.poi_id??'?';
  return [credits?`+${credits} cr`:'',items.length?`gained ${items.map(row=>`${row.quantity} ${row.item_id}`).join(', ')}`:'nothing gained',
    ship?`hold ${ship.cargo_used}/${ship.cargo_capacity}`:'',`at ${where}`].filter(Boolean).join(', ');
}

/** What has come aboard since the running job's opening read: the cargo diff a helper's own
 * `did` must be written from, rather than a tally it kept while the world moved. */
export function measured():Row[] {
  const before=jobMark;
  if(!before)return [];
  const after=snapshot();
  return Object.entries(after.cargo).filter(([id,quantity])=>quantity>(before.cargo[id]??0))
    .map(([item_id,quantity])=>({item_id,quantity:quantity-(before.cargo[item_id]??0)}))
    .sort((a,b)=>a.item_id<b.item_id?-1:1);
}

// ---- Tired: derived from the ship, said here when it changes ----------------------------

let lastMood:Mood|undefined;
/** After every command and state push: when the derived mood crossed into or out of Tired, the
 * journal and the stream say so. Nothing is written to the record — the mood is the facts.
 * A fuel crossing the cells aboard can clear is not said: `burnCells` clears it first. */
export function watchMood():void {
  const b=need(),who=b.pilot(),was=lastMood;
  if(burning||canBurn())return;
  lastMood=who.mood;
  if(!was||who.mood===was)return;
  if(who.mood==='Tired') {
    if(b.runtime)journalRun(b.runtime,{rule:who.tired_by,mood_before:was},'tired');
    line(`tired: ${who.tired_by}; the runtime resupplies at the next call or the run's end`);
  } else if(was==='Tired') {
    if(b.runtime)journalRun(b.runtime,{mood:who.mood},'tired_cleared');
    line(`tired cleared: back inside the ${who.mood} margins`);
  }
}

// ---- fuel cells: the reserve aboard, burned before Tired is declared --------------------

/** How the last resupply ended short, if it did: `admit` lets the work go on either way. */
let short:'broke'|'stranded'|undefined;
let burning=false,burnFailed=false;
const cellsHeld=()=>(need().account.state.cargo??[]).filter(row=>row.item_id===FUEL_CELL).reduce((n,row)=>n+row.quantity,0);
/** Tired on fuel, away from a counter, with a cell aboard. Docked, the counter is the refill:
 * a docked `refuel` draws the station's fuel for credits, not the cells (lib RefuelParams). */
function canBurn():boolean {
  const b=need(),who=b.pilot(),state=b.account.state;
  return !burnFailed&&who.mood==='Tired'&&!!who.tired_by?.startsWith('fuel')&&!state.location?.docked_at&&cellsHeld()>0;
}

/** The refuel that left the cell count where it was. */
class NoCell extends Data.TaggedError('NoCell')<{readonly message:string}> {}

/** Burn the fuel cells aboard (`refuel({id:'fuel_cell',quantity:1})`, one at a time) until the tank
 * is back over the reserve or the cells run out. Runs after every command, so no path strands
 * with cells in the hold. A burn that fails is journalled and not tried again this run: Tired is
 * then declared and resupply takes over. Never throws.
 * ponytail: `Effect.exit` over the loop folds a defect into the `why`, as the old catch-everything did, so a
 * burn can never strand a command. Narrow it to the typed failures once no fake throws a bare Error. */
const burn=Effect.gen(function*() {
  if(burning||!canBurn())return;
  const b=need(),game=yield* Game,fuel=()=>b.account.state.ship?.fuel??0;
  const fuel_before=fuel(),held=cellsHeld();
  burning=true;
  const exit=yield* Effect.exit(Effect.gen(function*() {
    while(canBurn()) {
      const left=cellsHeld();
      yield* game.command('spacemolt/refuel',{id:FUEL_CELL,quantity:1});
      yield* game.refresh;
      if(cellsHeld()>=left)return yield* new NoCell({message:'the refuel took no cell'});
    }
  })).pipe(Effect.ensuring(Effect.sync(()=>{burning=false;})));
  const why=Exit.isFailure(exit)?message(rawError(exit.cause)):undefined;
  if(Exit.isFailure(exit))burnFailed=true;
  const entry={burned:held-cellsHeld(),fuel_before,fuel_after:fuel(),cells_left:cellsHeld(),...why?{why}:{}};
  if(b.runtime)journalRun(b.runtime,entry,'fuel_cell');
  line(`fuel cells: burned ${entry.burned}, fuel ${fuel_before} → ${entry.fuel_after}, ${entry.cells_left} left${why?`; the burn failed: ${why}`:''}`);
});
export async function burnCells():Promise<void> {
  const exit=await viaGame(burn);
  if(Exit.isFailure(exit))throw Cause.squash(exit.cause);
}
