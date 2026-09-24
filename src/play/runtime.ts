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
import type {Account,SkillProgress,V2CargoItem,V2Location,V2Ship} from '@spacemolt/lib';
import {resolveFuelReserve,resolveWalkAway} from '../mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {journalRun} from '../run-record.ts';
import {TravelBlocked} from '../travel.ts';
import type {Outcome,Present,Row,Status,Want} from './types.ts';

export type Mood='Cautious'|'Focused'|'Opportunistic'|'Aggressive'|'Relaxed'|'Tired';
export type Stance='Prospector'|'Industrialist'|'Trader'|'Carrier'|'Hunter'|'Scout';

/** `pilot.json`, read fresh on every call. The pilot never writes it: reflection sets goal,
 * stance and mood; the runtime imposes and clears Tired; the operator sets the rest. */
export interface Pilot {
  name?:string;
  objective?:string;objective_done?:boolean;
  goal?:string;stance?:Stance;mood?:Mood;
  /** The mood Tired replaced, restored when resupply clears Tired. Runtime-owned. */
  mood_before_tired?:Mood;
  /** Set by the operator from outside: a Tired that resupply does not clear. Rest does. */
  tired_forced?:boolean;
  /** A base id (`V2Player['home_base']` is the game's own; this is the operator's choice). */
  home?:string;
  /** Standing bounds the operator sets. Who to fight is not among them: combat targeting is
   * the pilot's judgement, kept honest by the hull floors and the walk-away fraction. */
  permissions?:{credit_reserve?:number;max_liability?:number;no_go?:string[]};
  instruction?:{text:string;at:string};
}

export interface Binding {
  account:ReadinessAccount;
  command:ReadinessCommand;
  pilot:()=>Pilot;
  setPilot:(pilot:Pilot)=>void;
  /** Where the journal lives. Without one nothing is journalled; lines still stream. */
  runtime?:string;
  /** Where a streamed line goes after the journal has it. */
  emit:(text:string)=>void;
}

let bound:Binding|null=null;
let stopFlag=false,commands=0,started=0;
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
  credits:number;items:number;xp:number;cost:Outcome['cost']}
let calls:Call[]=[];
export const runCalls=()=>calls;

const need=()=>{if(!bound)throw new Error('the play runtime is not bound: only `run` may execute pilot code');return bound;};

/** Bind the runtime for one run. Resets the stop flag and the counters. */
export function bind(binding:Binding):void {
  bound=binding;stopFlag=false;commands=0;started=Date.now();last={fn:'pilot'};calls=[];
  lastCommandAt=0;pending=null;lastTick=undefined;
  mark=snapshot();
  // A lib Account pushes state between commands (a tick, a fight); the fake in tests does not.
  const live=binding.account as unknown as {onStateChange?:(fn:()=>void)=>()=>void};
  unwatch=typeof live.onStateChange==='function'?live.onStateChange(()=>{try {imposeTired();} catch {/* a push is not the place to fail */}}):undefined;
}
export function unbind():void {unwatch?.();unwatch=undefined;bound=null;}
export const isBound=()=>bound!==null;

/** The pilot record as it is right now. Cheap; call it, do not cache it. */
export function pilot():Pilot {return need().pilot();}

/** The connected `@spacemolt/lib` Account: typed state (`account().ship: V2Ship`,
 * `.cargo: V2CargoItem[]`, `.location: V2Location`, `.credits`, `.skills`) and every game
 * command as `account().commands.<tool>.<action>()`. This IS the library; ours are the
 * conveniences for bulk actions, common failures and precondition checks. Mutations you send
 * yourself are journalled and margin-checked like any other, but they are NOT idempotent and
 * NOT rules-checked: read the reply before sending the same one again. */
export function account():Account {return need().account as unknown as Account;}

/** Write one line to the journal and to the run's stream, under your own words. Use it to
 * say what you decided and why, so the record shows the reasoning, not only the moves. */
export function note(text:string):void {line(text);}

/** True once the pilot (or operator) asked the run to stop. Every library function checks it
 * between commands and returns `partial`; a loop of your own should check it too. */
export function stopped():boolean {return stopFlag;}
export function stop():void {stopFlag=true;}

/** Thrown from a travel checkpoint when the pilot asked to stop; the leg in flight finishes. */
export class Stopped extends TravelBlocked {constructor(){super('stopped by pilot');}}
export const checkStop=()=>{if(stopFlag)throw new Stopped();};

/** Build an Outcome for a function of your own. You supply the sentence, the status and the
 * detail; the runtime fills `fn`, `cost`, `gained` and `now` from what it measured since the
 * run started or since your last `outcome()` call, whichever is later. Return it from your
 * helper so it composes like ours. */
export function outcome<Detail=Record<string,unknown>>(did:string,status:Status='done',detail?:Detail,why?:string):Outcome<Detail> {
  const before=mark??snapshot();
  const built=finish('pilot',before,{status,did,...why===undefined?{}:{why},detail:(detail??{}) as Detail});
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

/** The errors a dropped connection raises: the lib's own two, before its `reconnect:true`
 * has re-authenticated. Anything else is the game refusing, which is not retried. */
const DISCONNECTED=/WebSocket connection closed|No action_result/;
/** Commands whose end state the live world re-states, so re-issuing one after a lost
 * connection costs at most a repeat of a read (or one more mining tick, measured from
 * cargo). Everything else — sell, buy, accept, deposit — moves something once. */
const IDEMPOTENT=new Set(['mine','travel','jump','dock','undock','find_route','view','view_market','view_storage','status']);
const reissuable=(action:string)=>{const name=action.split('/')[1]??'';return name.startsWith('get_')||IDEMPOTENT.has(name);};

/** Wait for the lib's own reconnect to re-authenticate this account, up to `ms`. False when
 * the account has no reconnect listener (a test fake) or the wait ran out. */
function reconnected(ms=60_000):Promise<boolean> {
  const live=need().account as unknown as {onReconnected?:(fn:()=>void)=>()=>void};
  const listen=live.onReconnected?.bind(live);
  if(typeof listen!=='function')return Promise.resolve(false);
  return new Promise(resolve=>{
    let off:(()=>void)|undefined;
    const timer=setTimeout(()=>{off?.();resolve(false);},ms);
    timer.unref?.();
    off=listen(()=>{clearTimeout(timer);off?.();resolve(true);});
  });
}

/** Every game command a helper sends. Journalled by the bridge's command; counted and
 * Tired-checked here.
 *
 * A connection that drops mid-command is not the trip ending: the lib reconnects and
 * re-authenticates by itself, so this waits for that, re-reads the world, and re-issues the
 * command exactly once when it is one the live world can restate. A mutation that may have
 * landed is never re-sent — it fails with "outcome unknown, re-observe" instead. */
export async function command(action:string,params:Record<string,unknown>={}):Promise<unknown> {
  const b=need();
  commands++;
  try {return await sent(action,params);}
  catch(error) {
    if(!DISCONNECTED.test(message(error)))throw error;
    line(`  ${action}: ${message(error)}; waiting for the connection`);
    // A half-open socket is never *closed*, so the lib's own reconnect may never fire at all:
    // wait a minute for it, then force one in place — same Account, same listeners, fresh socket.
    let back=await reconnected();
    if(!back) {
      const live=b.account as unknown as {reconnectOnce?:()=>Promise<void>};
      if(typeof live.reconnectOnce==='function') {
        line(`  ${action}: no reconnect in 60s; forcing one`);
        try {await live.reconnectOnce();back=true;}
        catch(failed){line(`  ${action}: the forced reconnect failed (${message(failed)})`);}
      }
    }
    try {await b.account.refresh();} catch {/* the re-read may fail too; the throw below stands */}
    if(!back)throw error;
    if(!reissuable(action)) {
      line(`  ${action}: reconnected, but the command may have landed; not re-sent`);
      throw new Error(`${action}: outcome unknown, re-observe`);
    }
    line(`  ${action}: reconnected; re-issued once`);
    return await sent(action,params);
  }
  finally {imposeTired();}
}

/** A command pending longer than this says so, and keeps saying so every this often. The
 * contract is a line from any long step at least every 2 minutes; 30s is well inside it. */
const WAITING_MS=30_000;
let lastCommandAt=0,pending:{action:string;since:number}|null=null,lastTick:number|undefined;

/** One command on the wire, with the waiting said out loud. A mine tick is 10s and a transit
 * is minutes, so silence is the only thing a pilot cannot tell apart from a wedged bridge. */
async function sent(action:string,params:Record<string,unknown>):Promise<unknown> {
  const b=need(),since=Date.now();
  pending={action,since};
  const ticker=setInterval(()=>line(
    `  ${action}: waiting ${Math.round((Date.now()-since)/1000)}s for the game (last tick ${lastTick??'?'})`),WAITING_MS);
  ticker.unref?.();
  try {
    const reply=await b.command(action,params);
    const tick=(reply as {structuredContent?:{tick?:unknown};delta?:{details?:{tick?:unknown}};tick?:unknown});
    const seen=tick?.structuredContent?.tick??tick?.delta?.details?.tick??tick?.tick;
    if(typeof seen==='number')lastTick=seen;
    return reply;
  }
  finally {clearInterval(ticker);lastCommandAt=Date.now();pending=null;}
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
export function step(text:string):void {last.step=text.split(' ')[0];line(`  ${text}`);}

/** Where the run has got to, and — the difference between "waiting on the game" and "the
 * bridge is stuck" — when it last heard back and what is on the wire right now. */
export const progress=()=>({fn:last.fn,step:last.step,commands,elapsed_s:Math.round((Date.now()-started)/1000),
  ...lastCommandAt?{last_command_at:new Date(lastCommandAt).toISOString()}:{},
  ...pending?{pending:{action:pending.action,since_s:Math.round((Date.now()-pending.since)/1000)}}:{}});

/** The rules between one helper and the next: a mood that may not start work. Helpers that
 * begin something (a gather, a buy, a mission) ask before sending; reads and the safe legs
 * (service, stow, sell, going to a base) do not. */
export function admit(fn:string):string|null {
  const mood=pilot().mood;
  if(!mood)return `${fn} not started: the pilot record names no mood; reflect at rest first`;
  if(mood==='Tired')return `${fn} not started: Tired — service here or goTo a base and service there`;
  if(mood==='Relaxed')return `${fn} not started: Relaxed may not initiate a job; a job mood chosen at reflection admits it`;
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
  const raw=(skills as any)?.skills??skills;
  return raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,SkillProgress>:{};
}

export function present():Present {
  const state=need().account.state,who=pilot();
  return {ship:state.ship as V2Ship,location:state.location as V2Location,cargo:(state.cargo??[]) as V2CargoItem[],
    credits:state.player?.credits??0,skills:skillMap(state.skills),mood:who.mood??'Cautious',
    ...who.mood==='Tired'?{tired_by:tiredBy}:{}};
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

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const seconds=(ms:number)=>`${(ms/1000).toFixed(ms<10_000?1:0)}s`;

/** The measuring wrapper every exported function is defined through: snapshot, run, snapshot,
 * diff. Streams `▶ fn args` on entry and `✓/✗ fn status secs did` on return. A throw is a
 * `failed` Outcome, a `Stopped` a `partial` one; nothing escapes as an exception. */
export async function job<Detail>(fn:string,args:string,body:()=>Promise<Said<Detail>>):Promise<Outcome<Detail>> {
  const outer=last,outerMark=jobMark;
  last={fn};
  line(`▶ ${fn}${args?` ${args}`:''}`);
  let before:Snapshot;
  try {await acct().refresh();before=snapshot();}
  catch(error){before=snapshot();line(`  ${fn}: the opening read failed (${message(error)}); measuring from cached state`);}
  jobMark=before;
  let part:Said<Detail>,threw=false;
  try {part=await body();}
  catch(error) {
    threw=true;
    part=error instanceof Stopped
      ?{status:'partial',did:`${fn} stopped by the pilot`,why:message(error),detail:{} as Detail}
      :{status:'failed',did:`${fn} broke`,why:message(error),detail:{} as Detail};
  }
  try {await acct().refresh();} catch {/* the closing read failed; the cached state stands */}
  const built=finish(fn,before,part);
  // A did the wrapper wrote knows nothing of what happened; the measurement does.
  if(threw)built.did=`${built.did}, ${witness(built)}`;
  line(`${built.status==='done'?'✓':'✗'} ${fn}  ${built.status}  ${seconds(Date.now()-before.at)}  ${built.did}${built.why?`: ${built.why}`:''}`);
  if(outer.fn==='pilot')calls.push({fn,arg:args.split(' ')[0]??'',status:built.status,did:built.did,
    ...built.why===undefined?{}:{why:built.why},
    credits:built.gained.credits,cost:built.cost,
    items:built.gained.items.reduce((n,row)=>n+row.quantity,0),xp:Object.values(built.gained.xp).reduce((n,x)=>n+x,0)});
  last=outer;jobMark=outerMark;
  return built;
}

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

// ---- Tired: imposed and cleared by the runtime, never by a helper -----------------------

let tiredBy='';
/** The margin the mood crosses, if any: fuel under the reserve, hull under the walk-away
 * line, credits under the reserve. ponytail: the route home is not quoted here (that is a
 * find_route per check); the mood's reserve in units stands in for it. Ammunition waits for hunt.
 *
 * ponytail: the fuel line is a flat reserve, not a route. Ceiling: a pilot four jumps from the
 * nearest serviced station is inside a 30 unit reserve and cannot reach anything, while one
 * docked at a station is Tired over a tank it could fill in one command — the reserve is a proxy
 * for the trip home, and it is wrong in both directions the further the two diverge. Upgrade
 * (the one good idea the deleted `fuel-transition.ts` held): quote `find_route` to the nearest
 * serviced station and draw the line at that cost plus the mood's reserve, so a serviced dock
 * owes a full tank and anywhere else owes the route to one. It costs a `find_route` per station
 * per check, which is why it is not here: take it when the station list is a read the runtime
 * already has. */
function crossed(mood:Mood):string|null {
  const {ship,player}=need().account.state,who=pilot();
  if(!ship)return null;
  if(ship.fuel<resolveFuelReserve(mood))return `fuel ${ship.fuel} under the ${mood} reserve ${resolveFuelReserve(mood)}`;
  const line=Math.floor(resolveWalkAway(mood)*ship.max_hull);
  if(ship.hull<line)return `hull ${ship.hull}/${ship.max_hull} under the ${mood} walk-away line ${line}`;
  const reserve=who.permissions?.credit_reserve??0;
  if((player?.credits??0)<reserve)return `credits ${player?.credits??0} under the reserve ${reserve}`;
  return null;
}

/** After every command and state push: cross a margin and Tired is imposed; back inside the
 * prior mood's margins (resupplied, anywhere) and it is cleared. The operator's forced Tired
 * is not cleared here; rest clears everything. */
export function imposeTired():void {
  const b=need(),who=b.pilot();
  if(!who.mood)return;
  if(who.mood!=='Tired') {
    const why=crossed(who.mood);
    if(!why)return;
    tiredBy=why;
    b.setPilot({...who,mood:'Tired',mood_before_tired:who.mood});
    if(b.runtime)journalRun(b.runtime,{rule:why,mood_before:who.mood},'tired');
    line(`tired: ${why}; finishing the safe leg, then service`);
    return;
  }
  if(who.tired_forced||!who.mood_before_tired)return;
  if(crossed(who.mood_before_tired))return;
  const {mood_before_tired,...rest}=who;
  b.setPilot({...rest,mood:mood_before_tired});
  tiredBy='';
  if(b.runtime)journalRun(b.runtime,{mood:mood_before_tired},'tired_cleared');
  line(`tired cleared: back inside the ${mood_before_tired} margins`);
}
