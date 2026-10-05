/** What the runtime lends the library and the pilot's own code: the account, the pilot
 * record, a journal line, the stop flag, an Outcome builder. Bound once per run by `run`
 * before the entrypoint is imported; there is exactly one pilot per process.
 *
 * Inside, the same module holds what the library needs and the pilot does not see: the
 * measuring `job()` wrapper, the step line, and the rules check helpers ask before starting work.
 * Everything a run keeps is its `Run` service, built by `bind()` beside its own `Game`; an Effect
 * asks for it by type, and the Promise surface reaches it through the binding.
 *
 * ponytail: the pilot's surface (`pilot()`, `stopped()`, `note()`, `account()`) is synchronous and
 * carries no context, so the binding itself is one module slot, not AsyncLocalStorage. One pilot
 * per bridge process today; a multi-account runtime is a second process per account (DESIGN.md "Fleet").
 */
import type {Account,SkillProgress} from '@spacemolt/lib';
import {Cause,Context,Data,Effect,Exit,Layer,ManagedRuntime,Result,Schema} from 'effect';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {FUEL_CELL} from '../mining-inventory.ts';
import {journalRun,readRun,stampRun,writeRun,type RunRecord} from '../run-record.ts';
import type {DockBlocked} from '../dock.ts';
import {TravelBlocked,type ArrivalUnresolved} from '../travel.ts';
import {Depleted,Game,GameLive,HoldFull,InBattle,Rejected,ReplyLost,attempt,freshLedger,field,message,rawError,type GameError,type Ledger} from './game.ts';
import {tiredCheck} from './service.ts';
import type {Outcome,Present,Row,Status,Want} from './types.ts';
import {noteStore,readStores,storedTotals} from './world.ts';

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

/** Every top-level call `main()` made this run, as the menu reads a run: the function, its
 * first argument, how it ended and what it gained. ponytail: the first whitespace token of
 * the job's label stands in for "first argument"; it is the poi/id for every job that takes one. */
export interface Call {fn:string;arg:string;
  /** The call as the program wrote it, literal arguments and all, for the jobs that keep it (tradeRun, sell): what
   * the menu offers again. */
  call?:string;status:Status;did:string;
  /** The Outcome's own `why`, so the report of a call that did not end `done` carries the
   * reason (the suggested ids of a refused destination) and not only the `did`. */
  why?:string;
  credits:number;items:number;xp:number;cost:Outcome['cost'];
  /** Telemetry, journalled on run/ended: the whole of what the call gained, and when it ran. */
  gained?:Outcome['gained'];started_at?:string;seconds?:number;
  /** The bases a route call docked at, in order, from its detail's `stops` (tradeRun's): the
   * juncture groups earning laps by them (live 2026-10-01, kvothe: the loop that made +39.6k fell
   * out of view, and its stops lived only in `did` prose). */
  stops?:string[]}

/** A question the program is paused on, as run.json and the tools carry it. */
export type Question=NonNullable<RunRecord['question']>;
/** A chat post that paused the flight: who sent it, on which channel, the text, and when. */
export type ChatPause=NonNullable<Question['chat']>;
/** A chat post that paused the flight, with the answer you gave when it did. */
export interface Heard {chat:ChatPause;answer:string}

/** What may pause a flight: export it from `pilot/index.ts` as `export const interrupts = {…}`. A post
 * pauses the flight when its channel is in `channels` (`['private']` when left out) and, when `from` is
 * given, its sender is in it (a name or a player id). No export, nothing interrupts. */
export const InterruptsRead=Schema.Struct({from:Schema.optionalKey(Schema.Array(Schema.String)),
  channels:Schema.optionalKey(Schema.Array(Schema.Literals(['private','local','system','faction'])))});
export type Interrupts=typeof InterruptsRead.Type;

interface Snapshot {at:number;credits:number;fuel:number;hull:number;cargo:Record<string,number>;xp:Record<string,number>}

/** One run: everything `bind()` starts afresh, provided beside the binding's `Game`. */
export class Run extends Context.Service<Run,{
  readonly binding:Binding;
  /** Set by `stop()`; every library function checks it between commands. */
  stopFlag:boolean;
  /** Why the stop came when it was not the pilot's: the flight's cap of about 25 minutes (run.ts). */
  stopWhy?:string;
  readonly started:number;
  /** How many jobs deep the program is: 1 is a call `main()` made itself. */
  depth:number;
  /** What the command path keeps for `progress()`; `GameLive` writes it. */
  readonly wire:Ledger;
  last:{fn:string;step?:string};
  /** Where the pilot's next `outcome()` measures from. */
  mark:Snapshot|null;
  /** The opening read of the job now running, so a helper inside it can say what it measured. */
  jobMark:Snapshot|null;
  calls:Call[];
  asking:{question:Question;resolve:(answer:string)=>void;reject:(error:unknown)=>void}|null;
  /** The mood last said, so a crossing into or out of Tired is said once. */
  lastMood:Mood|undefined;
  /** How the last resupply ended short, if it did: `admit` lets the work go on either way. */
  short:'broke'|'stranded'|undefined;
  /** The runtime's own resupply is flying: its docks and arrivals do not start another. */
  resupplying:boolean;
  /** The system a resupply flew out of and reached no counter: not flown out of again this flight. */
  strandedIn:string|undefined;
  /** Resupplies since the last top-level call closed: that call's `did` names them. */
  readonly resupplied:string[];
  burning:boolean;burnFailed:boolean;
  unwatch:(()=>void)|undefined;
  /** The program's `interrupts` export, read as the flight starts; null: nothing interrupts. */
  interrupts:Interrupts|null;
  /** Posts that matched it and have not paused the flight yet, oldest first. */
  readonly chats:ChatPause[];
  /** Posts that paused the flight and the answers given, until `heard()` hands them over. */
  readonly heard:Heard[];
  /** A stop withdrew a chat pause: the pilot call it paused inside throws `Stopped`, as a paused `ask()` does. */
  pauseStopped:boolean;
}>()('Run') {}
type RunState=Context.Service.Shape<typeof Run>;
type GameShape=Context.Service.Shape<typeof Game>;

/** The run bound now, with its own runtime: commands through it take this binding's journalled
 * `command` (docs/EFFECT.md "The Promise ↔ Effect edge").
 * ponytail: one slot, because the sync helpers (`stopped()`, `pilot()`, `note()`, `step()`) carry no context
 * to find their run by; two bindings may never overlap, so the bridge takes it in turn (`exclusive`), and
 * `unbind` disposes the runtime, interrupting any job still in it. Lift it with AsyncLocalStorage or a
 * surface whose helpers are handed their run, when one process must hold two bindings at once. */
let current:{readonly run:RunState;readonly game:ManagedRuntime.ManagedRuntime<Game|Run,never>}|null=null;

const need=()=>{if(!current)throw new Error('no flight is under way: pilot code works only inside a flight');return current;};
const state=()=>need().run;

export const runCalls=()=>state().calls;
/** The question the program is paused on, or null. */
export const pendingQuestion=():Question|null=>current?.run.asking?.question??null;
/** run.json carries the pending question, so the juncture gate (another process) can see it. */
function recordQuestion(run:RunState,question:Question|null):void {
  const runtime=run.binding.runtime,record=runtime?readRun(runtime):null;
  if(!runtime||!record)return;
  if(question)record.question=question;else delete record.question;
  writeRun(runtime,record);
}

/** Bind the runtime for one run: a fresh `Run`, and a `Game` over this binding's command. */
export function bind(binding:Binding):void {
  const {account:live}=binding,once=live.reconnectOnce?.bind(live);
  const run:RunState={binding,stopFlag:false,started:Date.now(),depth:0,wire:freshLedger(),last:{fn:'pilot'},
    mark:null,jobMark:null,calls:[],asking:null,lastMood:undefined,short:undefined,resupplying:false,strandedIn:undefined,resupplied:[],burning:false,burnFailed:false,unwatch:undefined,
    interrupts:null,chats:[],heard:[],pauseStopped:false};
  // Every landed reply that says what the stores hold is kept (world.ts): the one writer of the `stores` table.
  const send:ReadinessCommand=async(action,params)=>{
    const reply=await binding.command(action,params);
    await noteStore(binding.runtime,live.state.location?.docked_at??undefined,action,params,reply,station=>binding.command('spacemolt_storage/view',{station_id:station}));
    return reply;
  };
  const game=GameLive({send,reconnected:()=>reconnected(live),refresh:()=>live.refresh(),say:text=>say(run,text),
    ledger:run.wire,after:served=>burn(run,served).pipe(Effect.andThen(Effect.sync(()=>watchMood(run))),Effect.andThen(pauseOnChat(run))),...once?{reconnect:once}:{}});
  current={run,game:ManagedRuntime.make(Layer.merge(game,Layer.succeed(Run,run)))};
  run.mark=snapshot(run);
  stampRun(binding.run_id?{run_id:binding.run_id}:null);
  run.lastMood=binding.pilot().mood;
  // A lib Account pushes state between commands (a tick, a fight); the fake in tests does not.
  run.unwatch=live.onStateChange?.(()=>{
    try {watchMood(run);}
    catch { // edge: a push from the lib's socket is not the place to fail
    }
  });
}
export function unbind():void {
  const was=current;
  current=null;
  if(was){was.run.unwatch?.();was.run.unwatch=undefined;was.run.asking=null;void was.game.dispose();}
  stampRun(null);
}
export const isBound=()=>current!==null;

/** The pilot record as it is right now. Cheap; call it, do not cache it. */
export function pilot():Pilot {return state().binding.pilot();}

/** The connected `@spacemolt/lib` Account: typed state (`account().ship: V2Ship`,
 * `.cargo: V2CargoItem[]`, `.location: V2Location`, `.credits`, `.skills`) and every game
 * command as `account().commands.<tool>.<action>()`. This IS the library; ours are the
 * conveniences for bulk actions, common failures and precondition checks. Mutations you send
 * yourself are journalled and margin-checked like any other, but they are NOT idempotent and
 * NOT rules-checked: read the reply before sending the same one again. */
export function account():Account {
  const live=state().binding.account;
  return new Proxy(live,{get:(target,key)=>{
    if(key==='commands')return commandsProxy;
    const value=Reflect.get(target,key);
    return typeof value==='function'?value.bind(target):value;
  }});
}
// The lib binds a no-param action as `(requestId)`, so `commands.spacemolt_salvage.sell({id})`
// sent the params as the request id and timed out ("No response to mutation [object Object]").
// Every `commands.<tool>.<action>(params)` is `Game.command` instead: params are the payload.
const commandsProxy=new Proxy({},{get:(_,tool)=>new Proxy({},{get:(__,action)=>
  (params?:unknown)=>onBinding(Effect.gen(function*() {
    return yield* (yield* Game).command(`${String(tool)}/${String(action)}`,isRecord(params)?params:{});
  }))})});
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;

/** Write one line to the journal and to the flight's stream, under your own words. Use it to
 * say what you decided and why, so the record shows the reasoning, not only the moves. */
export function note(text:string):void {line(`✎ ${text}`);}

/** True once the pilot (or the observer) asked the flight to stop. Every library function checks it
 * between commands and returns `partial`; a loop of your own should check it too. */
// Nothing bound is a run that has closed: a program still flying (abandoned at the cap) must stop.
export function stopped():boolean {return current?.run.stopFlag??true;}
/** Ask the flight to stop. A program paused on `ask()` is not at a safe point, it is waiting: the
 * ask rejects with `Stopped` there and then, and the question is withdrawn. */
export function stop(why?:string):void {
  const run=current?.run;
  if(!run)return;
  run.stopFlag=true;
  if(why)run.stopWhy=why;
  const waiting=run.asking;
  if(!waiting)return;
  run.asking=null;
  recordQuestion(run,null);
  say(run,`question withdrawn by stop: ${waiting.question.question}`);
  waiting.reject(new Stopped());
}

/** Thrown from a travel checkpoint when the pilot asked to stop; the leg in flight finishes. */
export class Stopped extends TravelBlocked {readonly _tag='Stopped';constructor(){super(stopReason());}}
const PILOT_STOP='stopped on order';
/** The stop's own words: the pilot's, or the cap's. Live 2026-10-04 (kvothe 22:02Z): a run ended by
 * the 24-minute cap read "tradeRun stopped by the pilot", and the pilot never stopped it. */
export const stopReason=()=>current?.run.stopWhy?`stopped: ${current.run.stopWhy}`:PILOT_STOP;
export const checkStop=()=>{if(stopped())throw new Stopped();};

/** Pause the program and put a question to the model that is running it; resolves to its
 * answer, which is always one of `choices` when they are given. It waits until the answer
 * comes, or rejects with `Stopped` when the flight is stopped — by a person, or by the flight computer's
 * cap of about 25 minutes (run.ts).
 * A model call takes minutes, so ask at a strategic fork, never once per tick. */
export function ask(asked:{question:string;choices?:string[]}):Promise<string> {
  const run=state();
  if(run.stopFlag)return Promise.reject(new Stopped());
  const text=String(asked?.question??'').trim();
  const choices=asked?.choices;
  const refused=!text?'ask needs a question'
    :run.asking?'ask: a question is already pending; await one before asking the next'
    :choices!==undefined&&(!Array.isArray(choices)||!choices.length||choices.some(c=>typeof c!=='string'||!c.trim()))
      ?'ask: choices must be a non-empty list of non-empty strings'
    :null;
  if(refused)return Promise.reject(new Error(refused));
  const question:Question={question:text,...choices?{choices:[...choices]}:{},
    asked_at:new Date().toISOString()};
  return new Promise<string>((resolve,reject)=>{
    run.asking={question,resolve,reject};
    recordQuestion(run,question);
    say(run,`? ${text}${choices?`  [${choices.join(' | ')}]`:''}`);
    run.binding.onAsk?.(question);
  });
}

/** The chat posts that paused this flight, each with the answer you gave, oldest first. Each is
 * handed over once: a second call returns only what paused the flight since the first. */
export function heard():Heard[] {return state().heard.splice(0);}

/** The flight's `interrupts` declaration, from the program's export (run.ts). */
export function listen(declared:Interrupts|null):void {
  const run=state();
  run.interrupts=declared;
  // Null once the program has returned: the runtime's own closing commands (resupply, a battle broken
  // off) are not the program's, and a post then is the juncture's to show, not a pause.
  if(!declared)run.chats.splice(0);
}

/** A chat post the bridge heard: queued to pause the flight when its declaration names it. True when queued. */
export function hear(post:{channel:string;sender?:string|undefined;sender_id?:string|undefined;content:string;at:string}):boolean {
  const run=current?.run,want=run?.interrupts;
  if(!run||!want)return false;
  const names=[post.sender,post.sender_id].flatMap(name=>name?[name.toLowerCase()]:[]);
  // Private only unless wider channels are listed: a busy or hostile public channel cannot stall a run
  // that asked only to be reachable.
  if(!(want.channels??['private']).some(channel=>channel===post.channel))return false;
  if(want.from&&!want.from.some(name=>names.includes(name.toLowerCase())))return false;
  run.chats.push({from:post.sender??post.sender_id??'unknown',channel:post.channel,text:post.content,at:post.at,
    ...post.sender_id===undefined?{}:{sender_id:post.sender_id}});
  return true;
}

/** After a command, never inside one: each queued post pauses the flight as `ask()` does, one at a time,
 * until it is answered (kept for `heard()`) or the run is stopped (the stop flag ends the work). */
const pauseOnChat=(run:RunState)=>Effect.gen(function*() {
  for(let chat=run.chats[0];chat&&!run.stopFlag&&!run.asking;chat=run.chats[0]) {
    run.chats.shift();
    const post=chat;
    yield* Effect.promise(()=>new Promise<void>(resume=>{
      const question:Question={question:`${post.channel} message from ${JSON.stringify(post.from)}`,chat:post,asked_at:new Date().toISOString()};
      run.asking={question,resolve:answer=>{run.heard.push({chat:post,answer});resume();},reject:()=>{run.pauseStopped=true;resume();}};
      recordQuestion(run,question);
      say(run,`? paused for a ${post.channel} message from ${JSON.stringify(post.from)}`);
      run.binding.onAsk?.(question);
    }));
  }
});

/** Resume the paused program with `text`. The caller has already held it to the choices. */
export function answer(text:string):void {
  const run=current?.run,waiting=run?.asking;
  if(!run||!waiting)throw new Error('no question is pending');
  run.asking=null;
  recordQuestion(run,null);
  say(run,`answered: ${text}`);
  waiting.resolve(text);
}

/** Build an Outcome for a function of your own. You supply the sentence, the status and the
 * detail; the runtime fills `fn`, `cost`, `gained` and `now` from what it measured since the
 * flight started or since your last `outcome()` call, whichever is later. Return it from your
 * helper so it composes like ours. */
export function outcome<Detail=Record<string,unknown>>(did:string,status:Status='done',detail?:Detail,why?:string):Outcome<Detail> {
  const run=state(),before=run.mark??snapshot(run);
  const built=finish(run,'pilot',before,{status,did,...why===undefined?{}:{why},detail:orEmpty(detail)});
  run.mark=snapshot(run);
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
function reconnected(live:Account,ms=60_000):Promise<boolean> {
  const listen=live.onReconnected?.bind(live);
  if(typeof listen!=='function')return Promise.resolve(false);
  return new Promise(resolve=>{
    let off:(()=>void)|undefined;
    const timer=setTimeout(()=>{off?.();resolve(false);},ms);
    timer.unref?.();
    off=listen(()=>{clearTimeout(timer);off?.();resolve(true);});
  });
}

/** The Promise seam for an Effect that is not a pilot function — the pilot's own
 * `account().commands`, the bridge's menu: run through the binding's runtime, a failure thrown
 * as the raw error the lib raised, so `instanceof SpacemoltError` and `.code` still work.
 * Journalled by the bridge's command; counted, and a mood change it caused is said by the
 * layer's `after`. The one `run*` besides `edge`. */
export async function onBinding<A,E>(effect:Effect.Effect<A,E,Game|Run>):Promise<A> {
  const exit=await need().game.runPromiseExit(effect);
  if(Exit.isSuccess(exit))return exit.value;
  throw rawError(exit.cause);
}
/** The bound run as a layer, for an Effect run against a `Game` of its own rather than through `edge`
 * (a test on the TestClock). */
export const boundRun=()=>Layer.succeed(Run,state());
export const acct=():ReadinessAccount=>state().binding.account;
export const runtimeDir=()=>state().binding.runtime;

/** One streamed line: journalled first, then sent. */
export function line(text:string,extra:Record<string,unknown>={}):void {say(state(),text,extra);}
function say(run:RunState,text:string,extra:Record<string,unknown>={}):void {
  const {binding:b,last}=run;
  if(b.runtime)journalRun(b.runtime,{text,fn:last.fn,...last.step?{step:last.step}:{},...extra},'line');
  b.emit(text);
}
/** A sub-step inside a helper: an indented line, and the step `status` reports. */
export function step(text:string):void {const run=state();run.last.step=text.split(' ')[0]??'';say(run,`  ${text}`);}

/** Where the run has got to, and — the difference between "waiting on the game" and "the
 * bridge is stuck" — when it last heard back and what is on the wire right now. */
export const progress=()=>{
  const {last,wire,started}=state();
  return {fn:last.fn,step:last.step,commands:wire.commands,elapsed_s:Math.round((Date.now()-started)/1000),
    ...wire.lastCommandAt?{last_command_at:new Date(wire.lastCommandAt).toISOString()}:{},
    ...wire.pending?{pending:{action:wire.pending.action,since_s:Math.round((Date.now()-wire.pending.since)/1000)}}:{}};
};

/** The rules between one helper and the next: a mood that may not start work. Helpers that
 * begin something (a gather, a buy, a mission) ask before sending; reads and the safe legs
 * (service, stow, sell, going to a base) do not.
 *
 * Tired is not a gate: at a call `main()` made itself the runtime resupplies first (`tiredCheck`),
 * as it does at every dock and arrival, and the work goes on whether or not that cleared it —
 * refusing the work (which earns the credits, or flies where a base may be learned) would strand the ship. */
export const admit=(fn:string)=>Effect.gen(function*() {
  const run=yield* Run,who=()=>run.binding.pilot();
  if(run.depth===1)yield* tiredCheck('call');
  const {mood,tired_by}=who();
  if(mood==='Tired') {
    say(run,`${fn}: Tired (${tired_by}), ${run.short==='broke'?'resupply unaffordable: working to pay for it':run.short?'resupply found no base: working on':'working on: the flight computer resupplies at the next dock'}`);
    return null;
  }
  if(mood==='Relaxed')return `${fn} not started: Relaxed may not initiate a job`;
  return null;
});

/** `cargo` is the hold and the stores together: a unit stowed is still had, and one mined and stowed is gained.
 * Live 2026-10-04 (kvothe, runs de8842cf, 23534222, d356ecf9): gatherUntil stowed 344 units each and reported "nothing gained". */
function snapshot(run:RunState):Snapshot {
  const state=run.binding.account.state;
  const cargo:Record<string,number>=storedTotals(run.binding.runtime);
  for(const row of state.cargo??[])cargo[row.item_id]=(cargo[row.item_id]??0)+row.quantity;
  const xp:Record<string,number>={};
  for(const [id,row] of Object.entries(skillMap(state.skills)))xp[id]=row.xp;
  return {at:Date.now(),credits:state.player?.credits??0,fuel:state.ship?.fuel??0,hull:state.ship?.hull??0,cargo,xp};
}
/** `get_skills` answers a map keyed by skill id (live, C23 replay); some shapes nest it. */
export function skillMap(skills:unknown):Record<string,SkillProgress> {
  const raw=field(skills,'skills')??skills;
  return isRecord(raw)&&!Array.isArray(raw)?Object.fromEntries(Object.entries(raw).flatMap(([id,row])=>isProgress(row)?[[id,row] as const]:[])):{};
}
/** Every field of the lib's `SkillProgress`: a malformed row is now left out of the map, not passed through. */
const isProgress=(row:unknown):row is SkillProgress=>isRecord(row)&&typeof row.category==='string'&&typeof row.name==='string'
  &&typeof row.level==='number'&&typeof row.max_level==='number'&&typeof row.next_level_xp==='number'&&typeof row.xp==='number';

/** The ship, wallet, hold, stores, place, skills and active missions as the account and `world.db` already hold them:
 * the run's `start_state`/`end_state`. Reads memory only: `stores` is each base's store as last read or moved.
 * ponytail: cargo, missions and each base's store capped at 40 rows, as the storage and market reads are. */
const stores=()=>{
  const out:Record<string,Record<string,number>>={};
  for(const row of readStores(state().binding.runtime)){const base=out[row.base_id]??={};if(Object.keys(base).length<40)base[row.item_id]=row.quantity;}
  return out;
};
export function stateSnapshot():Record<string,unknown> {
  const state=acct().state,{ship,location}=state;
  const missions=state.missions?.active;
  return {credits:state.player?.credits??null,fuel:ship?.fuel??null,max_fuel:ship?.max_fuel??null,
    hull:ship?.hull??null,max_hull:ship?.max_hull??null,cargo_used:ship?.cargo_used??null,cargo_capacity:ship?.cargo_capacity??null,
    cargo:(state.cargo??[]).slice(0,40).map(row=>({item_id:row.item_id,quantity:row.quantity})),
    stores:stores(),
    skills:Object.fromEntries(Object.entries(skillMap(state.skills)).map(([id,row])=>[id,{level:row.level,xp:row.xp}])),
    system:location?.system_id??null,poi:location?.poi_id??null,docked_at:location?.docked_at??null,
    ...Array.isArray(missions)?{missions:missions.slice(0,40).map(m=>({mission_id:m.mission_id,title:m.title,type:m.type,
      percent_complete:m.percent_complete,rewards:m.rewards}))}:{}};
}

export function present():Present {return presentOf(state());}
function presentOf(run:RunState):Present {
  const state=run.binding.account.state,who=run.binding.pilot(),{ship,location}=state;
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

function finish<Detail>(run:RunState,fn:string,before:Snapshot,part:Said<Detail>):Outcome<Detail> {
  const after=snapshot(run);
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
    now:presentOf(run),next:(part.next??[]).slice(0,3),detail:part.detail};
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
export const jobEffect=<D,R extends Game|Run=Game|Run>(fn:string,args:string,body:Effect.Effect<Said<D>,GameError|TravelBlocked|ArrivalUnresolved|DockBlocked,R>,call?:string)=>jobWith(fn,args,body,true,call);

const jobWith=<D,R>(fn:string,args:string,body:Effect.Effect<Said<D>,GameError|TravelBlocked|ArrivalUnresolved|DockBlocked,R>,journalDefects:boolean,call?:string):Effect.Effect<Outcome<D>,never,R|Game|Run>=>
  Effect.gen(function*() {
    const run=yield* Run;
    const open={...yield* opening(run,fn,args),...call?{call}:{}};
    const exit=yield* Effect.exit(body);
    if(Exit.isSuccess(exit))return yield* closing(run,open,exit.value,false);
    if(journalDefects)journalDefect(run,fn,exit.cause);
    return yield* closing(run,open,said<D>(fn,Cause.squash(exit.cause)),true);
  });

/** The Promise a pilot function returns: `effect` run through the binding's runtime. A defect
 * outside any job is a `failed` Outcome and a `defect` line. */
export async function edge<D>(effect:Effect.Effect<Outcome<D>,never,Game|Run>):Promise<Outcome<D>> {
  const {run,game}=need(),before=snapshot(run),outer=run.last,outerMark=run.jobMark,outerDepth=run.depth;
  const exit=await game.runPromiseExit(effect);
  // The command the pause followed had finished and its call is in the ledger; the program learns of
  // the stop here, at its own await, never inside the command.
  if(run.pauseStopped) {run.pauseStopped=false;throw new Stopped();}
  if(Exit.isSuccess(exit))return exit.value;
  // A die inside a job's own bookkeeping skipped its restore; the edge puts the stack back.
  const fn=run.last.fn;
  run.last=outer;run.jobMark=outerMark;run.depth=outerDepth;
  journalDefect(run,fn,exit.cause);
  return finish(run,fn,before,said<D>(fn,Cause.squash(exit.cause)));
}

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
  if(error instanceof Stopped)return {status:'partial',did:`${fn} ${error.message}`,why:error.message,detail};
  if(error instanceof ReplyLost)return {status:'failed',did:`${fn} broke`,why:`reply lost on ${error.action}; state re-read`,detail};
  if(error instanceof Rejected||error instanceof InBattle||error instanceof HoldFull||error instanceof Depleted)
    return {status:'refused',did:`${fn} refused by the game`,why:`${error.action}: ${error.code} — ${error.message}`,detail};
  return {status:'failed',did:`${fn} broke`,why:message(error),detail};
}

/** A bug, not a game outcome: its stack goes to the journal. The stop is not one. */
export function defect(fn:string,cause:Cause.Cause<unknown>):void {if(current)journalDefect(current.run,fn,cause);}
function journalDefect(run:RunState,fn:string,cause:Cause.Cause<unknown>):void {
  const runtime=run.binding.runtime;
  if(!runtime||!Cause.hasDies(cause)||Cause.squash(cause) instanceof Stopped)return;
  journalRun(runtime,{fn,why:message(Cause.squash(cause)),stack:Cause.pretty(cause)},'defect');
}

type Opened={fn:string;args:string;call?:string;before:Snapshot;outer:RunState['last'];outerMark:Snapshot|null};
/** The ▶ line and the opening read. A read that fails is said, and the cached state measures. */
const opening=(run:RunState,fn:string,args:string)=>Effect.gen(function*() {
  const outer=run.last,outerMark=run.jobMark;
  run.last={fn};run.depth++;
  say(run,`▶ ${fn}${args?` ${args}`:''}`);
  const read=yield* Effect.result((yield* Game).refresh);
  const before=snapshot(run);
  if(Result.isFailure(read))say(run,`  ${fn}: the opening read failed (${message(read.failure.cause)}); measuring from cached state`);
  run.jobMark=before;
  return {fn,args,before,outer,outerMark};
});
/** A detail's `stops[].at` (tradeRun's), when it has a `stops` list: a raw fact for the run record. */
const stopsOf=(detail:unknown):{stops?:string[]}=>{
  const stops=field(detail,'stops');
  return Array.isArray(stops)?{stops:stops.flatMap(stop=>{const at=field(stop,'at');return typeof at==='string'?[at]:[];})}:{};
};
/** The closing read, the measurement, the ✓/✗ line and the `calls` push. */
const closing=<Detail>(run:RunState,{fn,args,call,before,outer,outerMark}:Opened,part:Said<Detail>,threw:boolean)=>Effect.gen(function*() {
  // The closing read may fail; the cached state stands, so it is only looked at.
  yield* Effect.result((yield* Game).refresh);
  const built=finish(run,fn,before,part);
  // A did the wrapper wrote knows nothing of what happened; the measurement does.
  if(threw)built.did=`${built.did}, ${witness(built)}`;
  if(outer.fn==='pilot'&&run.resupplied.length)built.did=`${built.did}; ${run.resupplied.splice(0).join('; ')}`;
  say(run,`${built.status==='done'?'✓':'✗'} ${fn}  ${built.status}  ${seconds(Date.now()-before.at)}  ${built.did}${built.why?`: ${built.why}`:''}`);
  if(outer.fn==='pilot')run.calls.push({fn,arg:args.split(' ')[0]??'',...call?{call}:{},status:built.status,did:built.did,
    ...built.why===undefined?{}:{why:built.why},
    credits:built.gained.credits,cost:built.cost,
    items:built.gained.items.reduce((n,row)=>n+row.quantity,0),xp:Object.values(built.gained.xp).reduce((n,x)=>n+x,0),
    gained:built.gained,started_at:new Date(before.at).toISOString(),seconds:Math.round((Date.now()-before.at)/100)/10,
    ...stopsOf(built.detail)});
  run.last=outer;run.jobMark=outerMark;run.depth--;
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
  const run=state(),before=run.jobMark;
  if(!before)return [];
  const after=snapshot(run);
  return Object.entries(after.cargo).filter(([id,quantity])=>quantity>(before.cargo[id]??0))
    .map(([item_id,quantity])=>({item_id,quantity:quantity-(before.cargo[item_id]??0)}))
    .sort((a,b)=>a.item_id<b.item_id?-1:1);
}

// ---- Tired: derived from the ship, said here when it changes ----------------------------

/** After every command and state push: when the derived mood crossed into or out of Tired, the
 * journal and the stream say so. Nothing is written to the record — the mood is the facts.
 * A fuel crossing the cells aboard can clear is not said: `burn` clears it first. */
function watchMood(run:RunState):void {
  const b=run.binding,who=b.pilot(),was=run.lastMood;
  if(run.burning||canBurn(run))return;
  run.lastMood=who.mood;
  if(!was||who.mood===was)return;
  if(who.mood==='Tired') {
    if(b.runtime)journalRun(b.runtime,{rule:who.tired_by,mood_before:was},'tired');
    say(run,`tired: ${who.tired_by}; the flight computer resupplies at the next dock, arrival or call, or the flight's end`);
  } else if(was==='Tired') {
    if(b.runtime)journalRun(b.runtime,{mood:who.mood},'tired_cleared');
    say(run,`tired cleared: back inside the ${who.mood} margins`);
  }
}

// ---- fuel cells: the reserve aboard, burned before Tired is declared --------------------

const cellsHeld=(run:RunState)=>(run.binding.account.state.cargo??[]).filter(row=>row.item_id===FUEL_CELL).reduce((n,row)=>n+row.quantity,0);
/** Tired on fuel, away from a counter, with a cell aboard. Docked, the counter is the refill:
 * a docked `refuel` draws the station's fuel for credits, not the cells (lib RefuelParams). */
function canBurn(run:RunState):boolean {
  const b=run.binding,who=b.pilot(),state=b.account.state;
  return !run.burnFailed&&who.mood==='Tired'&&!!who.tired_by?.startsWith('fuel')&&!state.location?.docked_at&&cellsHeld(run)>0;
}

/** The refuel that left the cell count where it was. */
class NoCell extends Data.TaggedError('NoCell')<{readonly message:string}> {}

/** Burn the fuel cells aboard (`refuel({id:'fuel_cell',quantity:1})`, one at a time) until the tank
 * is back over the reserve or the cells run out. Runs after every command, so no path strands
 * with cells in the hold. A burn that fails is journalled and not tried again this flight: Tired is
 * then declared and resupply takes over. Never fails.
 * ponytail: `Effect.exit` over the loop folds a defect into the `why`, as the old catch-everything did, so a
 * burn can never strand a command. Narrow it to the typed failures once no fake throws a bare Error. */
const burn=(run:RunState,game:GameShape)=>Effect.gen(function*() {
  if(run.burning||!canBurn(run))return;
  const b=run.binding,fuel=()=>b.account.state.ship?.fuel??0;
  const fuel_before=fuel(),held=cellsHeld(run);
  run.burning=true;
  const exit=yield* Effect.exit(Effect.gen(function*() {
    while(canBurn(run)) {
      const left=cellsHeld(run);
      yield* game.command('spacemolt/refuel',{id:FUEL_CELL,quantity:1});
      yield* game.refresh;
      if(cellsHeld(run)>=left)return yield* new NoCell({message:'the refuel took no cell'});
    }
  })).pipe(Effect.ensuring(Effect.sync(()=>{run.burning=false;})));
  const why=Exit.isFailure(exit)?message(rawError(exit.cause)):undefined;
  if(Exit.isFailure(exit))run.burnFailed=true;
  const entry={burned:held-cellsHeld(run),fuel_before,fuel_after:fuel(),cells_left:cellsHeld(run),...why?{why}:{}};
  if(b.runtime)journalRun(b.runtime,entry,'fuel_cell');
  say(run,`fuel cells: burned ${entry.burned}, fuel ${fuel_before} → ${entry.fuel_after}, ${entry.cells_left} left${why?`; the burn failed: ${why}`:''}`);
});
/** `burn` for the run's own resupply, which may burn before it services. */
export const burnCells=Effect.gen(function*() {yield* burn(yield* Run,yield* Game);});
