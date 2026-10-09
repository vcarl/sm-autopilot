/** The SpaceMolt bridge: one JSON request per stdin line, one JSON reply per line, and
 * `{"id","event":"line","text"}` lines streamed while a `run` proceeds. Requests are
 * handled concurrently, so `stop` and `status` answer while a run is in flight. */
import {Account} from '@spacemolt/lib';
import {Cause,Effect,Exit,Result,Schema} from 'effect';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {markAlertsDelivered,pendingAlerts,recordAlert} from './alerts.ts';
import {chatJournal,noteUnread} from './chat.ts';
import {foldBattleDamage,foldBattleEnded,foldBattleUpdate} from './combat-memory.ts';
import {battleEnded,battleNowEffect,battleStirred} from './travel.ts';
import {controllerLock} from './controller-lock.ts';
import {GAME_WS_URL,readCredentials} from './credentials.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {moodNow,resolveWalkAway} from './mood-policy.ts';
import {STANCES,stanceMood} from './rules-table.ts';
import {bootJournal,journalCommand,journalConnection,journalRun,readRun} from './run-record.ts';
import {startHeartbeat} from './heartbeat.ts';
import {flushJournalDrain,startJournalDrain} from './journal-webhook.ts';
import {check as checkPilot,runPilot as defaultRunPilot,type RunResult} from './run.ts';
import {runQuery} from './query.ts';
import {recordMenu,renderContext} from './context.ts';
import {menuEffect,renderMenu,threatsHere} from './play/menu.ts';
import {fleetBrief,resumeFreighters,stopFreighters} from './play/freighter/host.ts';
import {attempt,isGameError,message} from './play/game.ts';
import {learnNames,nameIds,readNames} from './play/places.ts';
import {answer as answerQuestion,bind,isBound,onBinding,pendingQuestion,present,progress,skillMap,stop as stopRun,unbind,
  type Pilot as Flying} from './play/runtime.ts';

/** `attach` is how a request takes the run's stream: the loop routes streamed lines to the
 * request that last called it, which is whichever request is now waiting on the run. */
export type Dispatch=(action:string,params?:unknown,attach?:()=>void)=>Promise<unknown>;

/** A request from `service.py`, decoded once where it enters: the action, and the params it reads. */
const Juncture=Schema.Struct({juncture_id:Schema.optionalKey(Schema.NullOr(Schema.String)),at:Schema.optionalKey(Schema.NullOr(Schema.String))});
export const Request=Schema.Union([
  Schema.Struct({action:Schema.Literal('run'),params:Schema.optionalKey(Schema.Struct({juncture:Schema.optionalKey(Schema.NullOr(Juncture))}))}),
  Schema.Struct({action:Schema.Literal('query'),params:Schema.optionalKey(Schema.Struct({juncture:Schema.optionalKey(Schema.NullOr(Juncture))}))}),
  Schema.Struct({action:Schema.Literal('answer'),params:Schema.optionalKey(Schema.Struct({answer:Schema.optionalKey(Schema.String)}))}),
  Schema.Struct({action:Schema.Literal('pilot'),params:Schema.optionalKey(Schema.Struct({set:Schema.optionalKey(Schema.Record(Schema.String,Schema.Unknown))}))}),
  // `stop` carries a `reason`, which only the request's journal line reads.
  Schema.Struct({action:Schema.Literals(['check','stop','status','menu','context']),params:Schema.optionalKey(Schema.Unknown)}),
]);
const decodeRequest=Schema.decodeUnknownResult(Request);
/** One stdin line: the id the reply carries, and the request it names. */
const decodeLine=Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({id:Schema.optionalKey(Schema.String),
  action:Schema.String,params:Schema.optionalKey(Schema.Unknown)})));
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;
const field=(row:unknown,key:string):unknown=>isRecord(row)?row[key]:undefined;

/** The actions whose answer is an outcome: a journal line keeps its shape, trimmed. */
const OUTCOME_ACTIONS=new Set(['run','query','answer','status','pilot','menu','context','stop','check']);
const OUTCOME_KEYS=new Set(['accepted','reason','status','record','running',
  'busy','objective','objective_done','stance','mood','errors','stopping',
  'ok','fn','did','sha','step','commands','elapsed_s','started','stagnation','rest',
  'paused','reattached','question','withdrawn','sent','code','lost','why','query_id','refused','error','menu_error',
  // A reflection's skill rows, which are small and are the one thing a later reflection cannot
  // read any other way: they are what "raise this by two levels" is judged against, and without
  // them in the record every reflection sees only the level it happens to be looking at.
  'skills']);

/** ponytail: at most 5 menu moves reach the request line, 100 characters each, and the rest is a
 * `+N more` marker; the menu offers 4. The `juncture` line keeps each move whole, facts and all. */
export const MENU_ROWS=5,MENU_CHARS=100;
/** One menu list as the journal keeps it: the short form of each row, capped both ways. */
const menuRows=(list:readonly unknown[],short:(row:unknown)=>string):string[]=>{
  const kept=list.slice(0,MENU_ROWS).map(row=>{const line=short(row);
    return line.length>MENU_CHARS?`${line.slice(0,MENU_CHARS-1)}…`:line;});
  return list.length>MENU_ROWS?[...kept,`+${list.length-MENU_ROWS} more`]:kept;
};

/** One response as the journal keeps it: whether the thing happened, never the prose or the
 * bodies of a read.
 *
 * `menu` and `context` are the actions whose arrays are kept rather than counted: their reply IS
 * the pilot's whole view of the world, and `moves:1` says nothing about which move was offered.
 * Every other action's arrays — storage views, market rows, mission lists — stay counts. The
 * context's text is never kept here: the `juncture` line holds it. */
export function journalResult(action:string,result:unknown):unknown {
  if(!isRecord(result)||!OUTCOME_ACTIONS.has(action))return result;
  const kept:Record<string,unknown>={};
  for(const key of Object.keys(result))if(OUTCOME_KEYS.has(key))kept[key]=result[key];
  if(isRecord(result.last))kept.last={status:result.last.status,did:result.last.did};
  const {moves}=result;
  if(Array.isArray(moves))kept.moves=action==='menu'||action==='context'?menuRows(moves,row=>String(field(row,'call')??'')):moves.length;
  return kept;
}

/** The pushes worth keeping. `@spacemolt/lib` emits every frame the socket carries whether
 * anything registered or not, and the runner discarded all 85 kinds; these are the ones a
 * pilot waking at the next juncture, or a human reading the drain, would want. The
 * journal is the record and the volume measurement; the decision-shaped subset is buffered
 * into `alerts.json` as well, which is what the wake actually reads.
 *
 * `action_result`, `action_error` and `reconnected` are deliberately absent — the lib's own
 * correlator consumes them and the command seam already journals the reply. */
export const PUSH_TYPES=['battle_alert','battle_ended','battle_update','battle_damage',
  'player_died','facility_rent_warning',
  'facility_reclaimed','base_destroyed','base_raid_update','mining_yield','crafting_update',
  'skill_level_up','ok','fleet'] as const;

/** The two combat frames that are folded into `combat.json` and never journalled: a battle
 * pushes one `battle_update` a tick and a `battle_damage` per shot, and `gameplay.jsonl` is
 * already 36 MB. `battle_update` is the only frame carrying the range band, the stance in
 * force and our hull class; `battle_damage` is the only one carrying `hit_success`, which is
 * the whole of measured accuracy. `battle_started`, `battle_joined` and `battle_left` are
 * deliberately absent: `started` carries no tick and nothing the per-tick `update` does not
 * carry anyway, and `joined`/`left` carry only a name and a reason — no number any metric
 * needs, and `battle_ended.participants[].survived` already says who lived. */
const FOLD_ONLY=new Set(['battle_update','battle_damage']);

/** The collapse key per buffered alert type — the group the pilot loses real property in
 * while it sleeps. The facility frames collapse on the base; a death collapses on the wreck it
 * left, so three ships lost in a shift are three items rather than one. `player_died` carries
 * no `base_id` at all, which is why this is a key per type rather than one field. */
const ALERT_KEY:Record<string,(body:Record<string,unknown>)=>string|undefined>={
  facility_rent_warning:body=>typeof body.base_id==='string'?`base:${body.base_id}`:undefined,
  facility_reclaimed:body=>typeof body.base_id==='string'?`base:${body.base_id}`:undefined,
  base_destroyed:body=>typeof body.base_id==='string'?`base:${body.base_id}`:undefined,
  player_died:body=>`wreck:${body.wreck_id??body.ship_lost??'ship'}`};

/** `ok` pushes that echo a command this pilot itself sent: the command seam journalled it
 * already, so a second line would double-count the same act. */
const OWN_PUSH=new Set(['travel','jump','dock','arrived','jumped','pathfinder_arrival',
  'pathfinder_jump','pathfinder_redirect','attack','espionage']);
/** `ok` pushes that moved the ship without the pilot asking for it: a fleet leader towing it,
 * the mobile station it was docked at jumping, the server docking it so a command could run,
 * an emergency stabilizer firing. None of these is an action the client can send, which is
 * what makes the attribution safe — no timing heuristic is involved. */
const MOVED_BY_OTHERS=new Set(['fleet_travel','fleet_jump','fleet_dock','fleet_undock',
  'mobile_capital_transit','passenger_stranded','auto_dock','auto_undock',
  'emergency_warp_stabilizer_activated']);
/** Broadcast to every connected player, so it says nothing about this pilot. */
const PUSH_NOISE=new Set(['new_forum_post']);
/** ponytail: 20 journal lines a minute per push channel, the rest dropped on the floor. A
 * battle, a base raid or a mining run can push several frames a tick, and neither
 * `gameplay.jsonl` nor the webhook drain has a ceiling of its own. Raise it, or window per
 * action rather than per channel, if a real shift proves it too tight. */
export const PUSH_PER_MINUTE=20;

/** A push as the journal keeps it: the scalars it named, strings clipped, never a nested
 * body. The same discipline as `journalCommand` — one push must not be able to append a
 * kilobyte of frame to the journal. */
export function pushScalars(payload:unknown):Record<string,unknown> {
  const kept:Record<string,unknown>={};
  for(const [key,value] of Object.entries(isRecord(payload)?payload:{}))
    if(value!==null&&typeof value!=='object')
      kept[key]=typeof value==='string'?value.slice(0,60):value;
  return kept;
}

/** Register the allowlist on an account that outlives every run. Called once from `main()`,
 * never from `bind()`: a handler bound to a run is deaf between junctures, which is the
 * whole reason these frames were being lost. */
export function pushJournal(account:{on:(type:string,handler:(payload:Record<string,unknown>)=>void)=>unknown;
  player?:{id?:string}|undefined;currentTick?:number},
  runtime:string,now:()=>number=Date.now):void {
  const seen=new Map<string,{minute:number;n:number}>();
  const spare=(channel:string):boolean=>{
    const minute=Math.floor(now()/60_000),kept=seen.get(channel);
    if(!kept||kept.minute!==minute) {seen.set(channel,{minute,n:1});return true;}
    kept.n+=1;
    return kept.n<=PUSH_PER_MINUTE;
  };
  // A frame of the ship's own battle: a status read may no longer answer "no battle" from memory.
  for(const type of ['battle_started','battle_joined'])account.on(type,battleStirred);
  for(const type of PUSH_TYPES)account.on(type,(payload:Record<string,unknown>)=>{
    if(type==='battle_update'||type==='battle_damage')battleStirred();
    const body:Record<string,unknown>=payload??{};
    // Most `ok` variants key on `action`, seven on `type`; a variant with neither is the
    // wildlife kill notice, which the pilot's own hunt step already reports.
    // The two frames that end a battle, wherever the run has got to: the mover's `in_battle`
    // refusal stands until one of them arrives (or a confirmed `disengage` clears it), so a
    // battle that ends between junctures does not leave the ship refusing to move.
    if(type==='battle_ended'||type==='player_died')battleEnded();
    // Its own event, ahead of the rate cap: a death is the one push an analysis cannot lose.
    if(type==='player_died')journalRun(runtime,pushScalars(body),'death');
    // The combat fold, before the rate cap and before the journal: losing shots to a 20-a-minute
    // ceiling would bias measured accuracy silently, which is worse than not measuring it.
    if(type==='battle_update')foldBattleUpdate(body);
    if(type==='battle_damage')foldBattleDamage(body,account.player?.id);
    if(type==='battle_ended')foldBattleEnded(runtime,body,account.player?.id,account.currentTick);
    if(FOLD_ONLY.has(type))return;
    const cause=type==='ok'?String(body.action??body.type??''):'';
    if(type==='ok'&&(!cause||OWN_PUSH.has(cause)||PUSH_NOISE.has(cause)))return;
    const scalars=pushScalars(body);
    // Buffered before the rate cap, never after: the cap protects the journal and the Discord
    // drain from a chatty group, and losing a repossession notice to it would be the one
    // failure this whole path exists to prevent. Collapse by key is its bound instead.
    const key=ALERT_KEY[type]?.(body);
    if(key)recordAlert(runtime,type,key,scalars);
    if(!spare(type))return;
    if(MOVED_BY_OTHERS.has(cause))
      journalRun(runtime,{cause,
        evidence:Object.entries(scalars).map(([key,value])=>`${key}=${value}`).join(' ')},'unsolicited_move');
    else journalRun(runtime,{push:type,...scalars},'push');
  });
}

/** Facts at the moment an objective was set: the wallet, each skill's level, the hull and the
 * place. Live 2026-09-30 (kvothe): objective "train an offensive skill" was met (tactics 4→5) while
 * the pilot kept saying no skill rose; it had nothing to compare against. */
const ObjectiveStart=Schema.Struct({at:Schema.String,credits:Schema.optionalKey(Schema.Number),
  skills:Schema.Record(Schema.String,Schema.Number),ship_class:Schema.optionalKey(Schema.String),place:Schema.optionalKey(Schema.String)});
export type ObjectiveStart=typeof ObjectiveStart.Type;
/** `pilot.json` as stored. The bridge is its only writer (the `pilot` request); the mood is never
 * in it — it is derived from the ship on every read (`flying`). A key it does not name — a stored
 * mood from an older runner included — is dropped on read and never written. */
const PilotRecord=Schema.Struct({name:Schema.optionalKey(Schema.String),objective:Schema.optionalKey(Schema.String),
  objective_done:Schema.optionalKey(Schema.Boolean),objective_completed:Schema.optionalKey(Schema.String),
  /** Where the ship stood when this objective was set, for the juncture's deltas. */
  objective_start:Schema.optionalKey(ObjectiveStart),
  goal:Schema.optionalKey(Schema.String),
  /** When the goal was last set (ISO), so the juncture can show its age. Written beside it here. */
  goal_at:Schema.optionalKey(Schema.String),
  /** The pilot's own checklist toward the objective: short lines, set whole by reflect. */
  steps:Schema.optionalKey(Schema.Array(Schema.String)),
  /** What the pilot found out about how the game works that the docs do not say, set whole by
   * reflect. About the game, not the task: a new objective leaves them standing. */
  beliefs:Schema.optionalKey(Schema.Array(Schema.String)),
  stance:Schema.optionalKey(Schema.Literals(STANCES.map(stance=>stance.name))),
  permissions:Schema.optionalKey(Schema.Struct({max_liability:Schema.optionalKey(Schema.Number),credit_reserve:Schema.optionalKey(Schema.Number)})),
  instruction:Schema.optionalKey(Schema.Struct({text:Schema.String,at:Schema.String}))});
export type Pilot=typeof PilotRecord.Type;
const decodePilot=Schema.decodeUnknownResult(PilotRecord);
const decodeJson=Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
export function objectiveStart(state:ReadinessAccount['state']):ObjectiveStart {
  const {ship,location,player}=state,place=location?.docked_at??location?.poi_id??location?.system_id;
  return {at:new Date().toISOString(),...player?.credits===undefined?{}:{credits:player.credits},
    skills:Object.fromEntries(Object.entries(skillMap(state.skills)).map(([id,row])=>[id,row.level])),
    ...ship?.class_id?{ship_class:ship.class_id}:{},...place?{place}:{}};
}

/** The record as the play runtime reads it: the stored fields and the mood the ship is in now. */
export function flying(record:Pilot,state:ReadinessAccount['state']):Flying {
  return {...record,...moodNow(stanceMood(record.stance),state.ship)};
}
export interface ServeOptions {
  pilot?:()=>Pilot;
  /** The one writer of `pilot.json`. */
  setPilot?:(pilot:Pilot)=>void;
  runPilot?:typeof defaultRunPilot;
  /** Where the run record, the journal and the pilot's files live. */
  runtime?:string;
  /** Where a streamed line goes; the request loop routes it to the request that started the run. */
  emit?:(text:string)=>void;
  /** Told when a run was cut off at the wall-clock cap with its script still running. */
  onAbandoned?:()=>void;
}

/** Each field of `row` that decodes, the keys it clears (null), and why each other field was dropped:
 * one bad field never costs the rest. A key the record does not name decodes to nothing. */
function pilotFields(row:unknown):{record:Pilot;cleared:string[];dropped:Record<string,string>} {
  let record:Pilot={};
  const cleared:string[]=[],dropped:Record<string,string>={};
  for(const [key,value] of Object.entries(isRecord(row)?row:{})) {
    if(value===null){cleared.push(key);continue;}
    const one=decodePilot({[key]:value});
    if(Result.isFailure(one))dropped[key]=one.failure.message;else record={...record,...one.success};
  }
  return {record,cleared,dropped};
}

/** A reply as the pilot reads it: the prose of a run's report (and of `status`'s last one) names
 * each opaque base or POI id it carries (`nameIds`). Applied at stdout, after the request line is
 * journalled, so the journal keeps every id raw. */
export function forPilot(result:unknown,names:Record<string,string>):unknown {
  const named=prose(result,names);
  return isRecord(named)&&'last' in named?{...named,last:prose(named.last,names)}:named;
}
const prose=(row:unknown,names:Record<string,string>):unknown=>{
  if(!isRecord(row)||Array.isArray(row))return row;
  const named:Record<string,unknown>={...row};
  for(const key of ['did','why','prose']){const text=named[key];if(typeof text==='string')named[key]=nameIds(text,names);}
  return named;
};

/** The record with each field that does not decode dropped and named to `onDropped`, never refused
 * whole: on main an unknown stance flew as no stance, and a hand edit must not ground the pilot.
 * Only a file that is not JSON at all is unreadable. */
export function readPilot(path:string,onDropped?:(dropped:Record<string,string>)=>void):Pilot {
  if(!existsSync(path))return {};
  const read=decodeJson(readFileSync(path,'utf8'));
  if(Result.isFailure(read))throw new Error(`Unreadable pilot record ${path}: ${read.failure.message}`);
  const {record,dropped}=pilotFields(read.success);
  if(Object.keys(dropped).length)onDropped?.(dropped);
  return record;
}

/** Temp file then rename, so a reader never catches half a pilot. */
export function writePilot(path:string,pilot:Pilot):void {
  const temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,`${JSON.stringify(pilot,null,2)}\n`,{mode:0o600});
  renameSync(temp,path);
}

/** Pure dispatch over an account + command pair, so tests never connect. */
export function serve(account:Account,command:ReadinessCommand,options:ServeOptions={}):Dispatch {
  const record=options.pilot??(():Pilot=>({}));
  const pilot=()=>flying(record(),account.state);
  const runner=options.runPilot??defaultRunPilot;
  const runtime=options.runtime;
  if(runtime) {startJournalDrain();startHeartbeat(runtime);}
  const kept=()=>runtime?readRun(runtime):null;
  let running:{started:string}|null=null,last:Record<string,unknown>|null=null;
  /** The run in flight while a request is following it, and how an `ask()` wakes that request. */
  let flight:Promise<Record<string,unknown>>|null=null,asked:(()=>void)|null=null;
  /** The play runtime has one binding slot: a menu and a run take it in turn, never under each other.
   * U31 verify: a run that bound while a menu's read was out was unbound by the menu's `finally`. */
  let slot:Promise<unknown>=Promise.resolve();
  const exclusive=<T>(work:()=>Promise<T>):Promise<T>=>{const next=slot.then(work);slot=next.catch(()=>{});return next;};
  const busy=(flight:{started:string})=>{const question=pendingQuestion();
    return {running:true as const,...flight,...isBound()?progress():{},...question?{question}:{},
      fuel:account.state.ship?.fuel,hull:account.state.ship?.hull,credits:account.state.player?.credits};};
  /** The last run as a reader of `status` gets it: what was done, why, and the report. The
   * whole Outcome — ship, location, nearby players, every skill — stays in `run.json` and
   * the journal; a pilot reading this through a tool call is paying for every line of it. */
  const brief=(result:RunResult):Record<string,unknown>=>({...result.sha?{sha:result.sha}:{},
    started:result.started,ended:true,...result.ended_at?{ended_at:result.ended_at}:{},status:result.status,did:result.reason,
    ...result.why?{why:result.why}:{},prose:result.prose,commands:result.commands});
  const lastOutcome=()=>{if(last)return last;const run=kept();return run?.ended?{...run.outcome}:null;};

  /** The pause as a waiting request answers it: the question, and that the run is still on. */
  const paused=()=>{const question=pendingQuestion();
    return running&&question?{accepted:true,paused:true,question,started:running.started}:null;};
  /** Wait on the run in flight until it ends or its program asks a question, whichever is first.
   * A question already pending is answered at once. */
  const follow=async():Promise<Record<string,unknown>>=>{
    const now=paused();
    if(now||!flight)return now??{accepted:false,reason:'no flight is under way'};
    const question=new Promise<Record<string,unknown>>(wake=>{asked=()=>{const pause=paused();if(pause)wake(pause);};});
    try {return await Promise.race([flight,question]);} finally {asked=null;}
  };
  /** Run `pilot/index.ts`: validate, execute, stream, and answer with the report when it ends,
   * or early with the question when the program asks one. Called again while the program is
   * paused, it starts nothing and hands the question back: that is how a later session picks
   * up a question the one that started the run left unanswered. */
  const run=async(juncture:typeof Juncture.Type|null|undefined,attach?:()=>void)=>{
    if(!runtime)throw new Error('the flight computer has no program directory');
    if(running) {
      const now=paused();
      if(now) {attach?.();return {...now,reattached:true};}
      // Kept: a second run would overwrite the program still flying.
      return {accepted:false,reason:'a flight is already under way',...busy(running)};
    }
    running={started:new Date().toISOString()};
    attach?.();
    flight=(async()=>{
      try {
        const result=await exclusive(()=>runner({account,command,pilot,runtime,
          emit:options.emit??(()=>{}),onAsk:()=>asked?.(),
          ...juncture?{juncture}:{}}));
        if(!result.accepted)return {...result};
        last=brief(result);
        if(result.abandoned)options.onAbandoned?.();
        return {accepted:true,...last,...result.abandoned?{abandoned:true}:{}};
      } finally {running=null;flight=null;}
    })();
    // Nobody may be following when it ends (it paused, and was then stopped from elsewhere):
    // a rejection with no reader would take the whole bridge down.
    flight.catch(()=>{});
    return follow();
  };
  /** Resume the paused program with the answer, then wait on the run exactly as `run` does. */
  const answer=async(text:string,attach?:()=>void)=>{
    const question=running?pendingQuestion():null;
    if(!question)return {accepted:false,reason:'no question is pending',
      ...running?busy(running):{running:false,last:lastOutcome()}};
    const given=text.trim();
    const picked=question.choices
      ?question.choices.find(choice=>choice.trim().toLowerCase()===given.toLowerCase())
      :given||undefined;
    if(picked===undefined)return {accepted:false,
      reason:question.choices?`${JSON.stringify(given)} is not one of the choices`:'an answer is required',question};
    attach?.();
    answerQuestion(picked);
    return follow();
  };

  /** The menu from where the ship stands (DESIGN §4): the present, the moves with the call
   * each is taken with, what is not on it and why, and how the last run ended. The play
   * runtime is bound for the reads and released after; a run in flight answers `busy`. */
  const menu=async()=>{
    if(running)return {busy:true,...busy(running)};
    return exclusive(menuBound);
  };
  const menuBound=async()=>{
    bind({account,command,pilot,...runtime?{runtime}:{},emit:()=>{}});
    try {
      // The menu's reads and the battle read, through the binding's runtime like a run's.
      const {built,fight}=await onBinding(Effect.gen(function*() {
        return {built:yield* menuEffect(runtime),fight:yield* battleNowEffect()};
      }));
      const {location,ship,player,modules}=account.state;
      // Read after the reads, never before: they refreshed the ship the mood is derived from.
      const who=pilot();
      // Handed over and stamped delivered in the same breath: this handler is the single
      // reader and the single writer, in one process, so once-only needs no lock and none of
      // the read-modify-write race the instruction's `_deliver` carries.
      const waiting=runtime?pendingAlerts(runtime):[];
      if(runtime)markAlertsDelivered(runtime,waiting);
      const threats=threatsHere(location,location?.docked_at??null);
      return {
        // First key, first fact: the juncture renders it ahead of everything else.
        ...fight?{battle:fight}:{},
        now:new Date().toISOString(),
        ...who.stance?{stance:who.stance}:{},mood:who.mood,...who.tired_by?{tired_by:who.tired_by}:{},
        ...who.goal?{goal:who.goal,...record().goal_at?{goal_at:record().goal_at}:{}}:{},
        ...record().steps?.length?{steps:record().steps}:{},
        ...record().beliefs?.length?{beliefs:record().beliefs}:{},
        ...who.permissions?{permissions:who.permissions}:{},
        ...who.objective?{objective:who.objective}:{},
        ...who.instruction?{instruction:who.instruction}:{},
        ...threats.length?{threats}:{},
        present:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null,
          in_transit:Boolean(location?.in_transit),ship_class:ship?.class_id,fuel:ship?.fuel,max_fuel:ship?.max_fuel,
          hull:ship?.hull,max_hull:ship?.max_hull,
          cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits,
          hold:(account.state.cargo??[]).map(row=>({item_id:String(row.item_id),quantity:row.quantity})),
          weapons:(modules??[]).filter(row=>row.slot==='weapon')
            .map(row=>({id:row.type_id,...row.current_ammo!==undefined?{loaded:row.current_ammo}:{}})),
          // The hull this mood breaks off a fight at, as `moodNow` computes it: the juncture
          // cannot reach the D2 table (the stance's working mood, so Tired does not move it), and a pilot left to guess the line guesses it low.
          ...ship?.max_hull===undefined?{}:{walk_away:Math.floor(resolveWalkAway(stanceMood(who.stance))*ship.max_hull)}},
        ...built,text:renderMenu(built),...runtime?{names:readNames(runtime)}:{},...runtime?fleetBrief(runtime):{},last:lastOutcome(),
        ...waiting.length?{alerts:waiting.map(({type,key,at,first_at,n,body})=>({type,key,at,first_at,n,body}))}:{},
      };
    } finally {unbind();}
  };

  /** The juncture context (context.ts): the menu rendered, with the moves it offered and whether a
   * run flies, for Python's `juncture` line. */
  const context=async()=>{
    let built:Record<string,unknown>,menu_error:string|undefined;
    try {built=await menu();}
    catch(error) {
      // Live 2026-10-02 (kvothe): 20 fires lost the whole section to a failed menu read ("WebSocket
      // connection closed", "No response to spacemolt/get_status within 15000ms"). Those fires flew
      // blind of the objective and the instruction, and wrote no juncture, so their runs carried the
      // previous juncture's id (09-30 16:32Z). The record and the journal need no game: render them,
      // and say the game was not read.
      menu_error=error instanceof Error?`${error.name}: ${error.message}`:String(error);
      let kept:Pilot={};
      try {kept=record();} catch {/* an unreadable record is a pilot with none, as a fresh one */}
      built=recordMenu(kept,runtime);
    }
    return {text:renderContext(built,runtime),busy:Boolean(built.busy),moves:Array.isArray(built.moves)?built.moves:[],
      ...menu_error?{menu_error}:{}};
  };

  /** Set fields of `pilot.json`; a null removes one. The only writer of the record: Python's
   * reflect and direct send this rather than editing the file, so nothing races a read-modify-write.
   * A cleared field shows in the `pilot` journal line's `prev` like any other. */
  const setRecord=async(patch:{readonly [key:string]:unknown}={})=>{
    const write=options.setPilot;
    if(!write)throw new Error('the flight computer cannot write the pilot record');
    const prev:Record<string,unknown>={...record()};
    // A field that does not decode is left as it was and named in the answer, never a refusal of
    // the whole write: the objective or instruction beside a bad stance still lands.
    const {record:valid,cleared,dropped}=pilotFields(patch);
    const set:Record<string,unknown>={...valid,...Object.fromEntries(cleared.map(key=>[key,null]))};
    // A new objective retires the plan made for the old one: the goal, its steps and the stance (which
    // picks the career skill a juncture carries) go with it, unless this same write sets them.
    // The beliefs stay: they are about the game, not the objective.
    // The same text again is not new; retiring the objective (null) leaves the plan standing.
    if(typeof set.objective==='string'&&set.objective!==prev.objective) {
      for(const key of ['goal','steps','stance'])if(!(key in set)&&key in prev)set[key]=null;
      // The start facts, read fresh where the game answers and from memory where it does not: a refresh
      // that fails is journalled, never a refusal of the write (the request handler is the edge).
      const fresh=await Effect.runPromiseExit(attempt('refresh',()=>account.refresh()));
      if(Exit.isFailure(fresh)&&runtime) {
        const error=Cause.squash(fresh.cause);
        if(isGameError(error))journalRun(runtime,{message:`objective_start read from memory: the refresh failed (${error._tag==='ReplyLost'?'reply lost':`${error.code}: ${error.message}`})`},'log');
        else journalRun(runtime,{fn:'pilot',why:message(error),stack:Cause.pretty(fresh.cause)},'defect');
      }
      set.objective_start=objectiveStart(account.state);
    }
    // The goal carries when it was set; a cleared goal clears it. Stamped here, the record's one writer.
    if('goal' in set)set.goal_at=set.goal===null?null:new Date().toISOString();
    // A retired objective takes its start with it.
    if(set.objective===null&&'objective_start' in prev)set.objective_start=null;
    const next:Record<string,unknown>={...prev};
    for(const [key,value] of Object.entries(set))if(value===null)delete next[key];else next[key]=value;
    const decoded=decodePilot(next);
    // edge: every value in `next` was decoded already; a failure here is a bug, not a pilot's input
    if(Result.isFailure(decoded))throw new Error(`pilot record not written: ${decoded.failure.message}`);
    write(decoded.success);
    const written=record();
    const named=Object.keys(dropped).length?{dropped}:{};
    if(runtime)journalRun(runtime,{set:Object.keys(set),
      prev:Object.fromEntries(Object.keys(set).map(key=>[key,prev[key]??null])),record:written,...named},'pilot');
    return {record:written,...named};
  };

  const stop=async(attach?:()=>void)=>{
    if(!running)return {stopping:false,reason:'no flight is under way'};
    const withdrawn=pendingQuestion();
    stopRun();
    if(!withdrawn)return {stopping:true,...busy(running)};
    // Paused, nobody is waiting on the run: the stop does, and hands back its report, so the
    // one who stopped it is holding the outcome rather than a promise of one.
    attach?.();
    return {...await follow(),stopping:true,withdrawn};
  };

  // A request that does not decode is refused here, by name, and nothing runs: the loop answers it.
  return async(action,params={},attach)=>{
    const decoded=decodeRequest({action,params});
    if(Result.isFailure(decoded))throw new Error(`Unknown or malformed request ${JSON.stringify(action)}: ${decoded.failure.message}`);
    const request=decoded.success;
    switch(request.action) {
      case 'run':return run(request.params?.juncture,attach);
      // Beside the run, whatever it is doing: a query reads, on a binding of its own (query.ts).
      case 'query': {
        if(!runtime)throw new Error('This runner has no runtime directory to run a query from');
        const juncture=request.params?.juncture;
        return runQuery({account,command,pilot,runtime,...juncture?{juncture}:{}});
      }
      case 'answer':return answer(request.params?.answer??'',attach);
      case 'check': {
        if(!runtime)throw new Error('the flight computer has no program directory');
        const gate=await checkPilot(runtime);
        return {ok:gate.ok,entry:gate.entry,sha:gate.sha,errors:gate.errors};
      }
      case 'stop':return stop(attach);
      case 'status':return running?busy(running):{running:false,last:lastOutcome()};
      case 'pilot':return setRecord(request.params?.set);
      case 'menu':return menu();
      case 'context':return context();
    }
  };
}

/** One stdin line to its reply, journalled. The line is decoded once, here; one that does not
 * decode is answered with what is wrong with it, and nothing runs. Never throws, so one bad
 * request never ends the loop, and nothing is replayed. */
export async function answerLine(dispatch:Dispatch,line:string,stream:(id:string|undefined)=>void,
  runtime:string):Promise<Record<string,unknown>> {
  const read=decodeLine(line);
  if(Result.isFailure(read)) {
    const response={ok:false,error:`Unreadable request: ${read.failure.message}`};
    journalRun(runtime,{line:line.slice(0,200),response},'request');
    return response;
  }
  const request=read.success,{id}=request;
  const response:Record<string,unknown>=await dispatch(request.action,request.params,()=>stream(id)).then(
    result=>({id,ok:true,result}),
    (error:unknown)=>({id,ok:false,error:error instanceof Error?error.message:String(error)}));
  journalRun(runtime,{request,
    response:{...response,...'result' in response?{result:journalResult(request.action,response.result)}:{}}},'request');
  return response;
}

/** Ends the bridge's own process once its owner is gone: SIGTERM, SIGINT, and stdin ending all
 * say the same thing, and more than one may fire, so this is idempotent. */
export function createShutdown(account:{close:()=>unknown},
  deps:{exit?:(code:number)=>void;schedule?:typeof setTimeout;graceMs?:number}={}) {
  const exit=deps.exit??((code:number)=>process.exit(code));
  const schedule=deps.schedule??setTimeout;
  const graceMs=deps.graceMs??2000;
  let started=false,finished=false;
  const finish=()=>{if(finished)return;finished=true;exit(0);};
  return ()=>{
    if(started)return;
    started=true;
    schedule(finish,graceMs);
    try {Promise.resolve(account.close()).then(finish,finish);}
    catch {finish();} // edge: never connected, so close throws before it can settle
  };
}

async function main() {
  const credentialPath=process.env.SPACEMOLT_CREDENTIALS_FILE;
  if(!credentialPath)throw new Error('SPACEMOLT_CREDENTIALS_FILE must name a credentials file');
  const {username,password}=readCredentials(credentialPath);
  const credentials=()=>({kind:'login' as const,username,password});
  const runtime=process.env.SPACEMOLT_RUNTIME_DIR??fileURLToPath(new URL('../runtime/',import.meta.url));
  mkdirSync(runtime,{recursive:true});
  const unlock=controllerLock(`${runtime}/controller-${createHash('sha256').update(username).digest('hex').slice(0,16)}.lock`);
  process.on('exit',unlock);
  // Rotate the journal before anything else in this process writes it, then open the fresh one
  // with the boot line. A run a dead bridge left un-ended is closed there, never re-run: the next
  // juncture reads it as interrupted and decides for itself. The lock above means no live bridge
  // owns it.
  const interrupted=bootJournal(runtime);
  // The lib bounds a mutation in two phases: the ack by `queryTimeoutMs` (15s default, kept),
  // then the outcome by `mutationTimeoutMs` for jump/travel (600s default, kept — a transit
  // legitimately spans many ticks) and by `fastMutationTimeoutMs` for everything else. `mine`
  // is in "everything else" and settles on the tick it was queued on, so the lib's 180s default
  // is 18 ticks of silence before a dead socket shows. 60s is 6 ticks: slack enough for a slow
  // tick or a rate-limited resend, and inside the minute a waiting pilot can still use.
  const account=new Account({url:GAME_WS_URL,reconnect:true,credentials,fastMutationTimeoutMs:60_000});
  let stopped=false;
  const shutdown=createShutdown({close:async()=>{
    stopFreighters();
    await flushJournalDrain().catch(()=>{});
    return account.close();
  }});
  const triggerShutdown=()=>{stopped=true;shutdown();};
  process.on('SIGTERM',triggerShutdown);
  process.on('SIGINT',triggerShutdown);
  process.stdin.on('end',triggerShutdown);
  process.stdin.on('close',triggerShutdown);
  await account.connect();
  await account.authenticate(credentials());
  // Every game command goes through here: journalled compactly, whether it took or not.
  const command:ReadinessCommand=async(action,params)=>{
    const [tool='',name='']=action.split('/');
    const since=Date.now();
    let reply:unknown;
    try {reply=await account.send(tool,name,params);}
    catch(error) { // edge: journalled and rethrown unchanged; `GameLive` classifies it
      journalCommand(runtime,action,params,false,error,{ms:Date.now()-since});
      throw error;
    }
    journalCommand(runtime,action,params,true,reply,{ms:Date.now()-since});
    noteUnread(runtime,reply);
    // After the journal line, outside the catch: a reply that landed is never journalled as failed.
    learnNames(runtime,action,params,reply);
    return reply;
  };
  // The pushes, on the one account that outlives every run and every juncture.
  pushJournal(account,runtime);
  chatJournal(account,runtime);
  journalConnection(runtime,account);
  // Frames sent while the socket was down are lost: the next battle read goes to the wire.
  account.onDisconnected(battleStirred);
  account.onReconnected(battleStirred);
  const pilotFile=resolve(runtime,'..','pilot.json');
  // A field dropped on read is journalled once per change, not on every read of the record.
  let droppedSeen='';
  const droppedOnRead=(dropped:Record<string,string>)=>{const seen=JSON.stringify(dropped);
    if(seen!==droppedSeen)journalRun(runtime,{fields:dropped},'pilot_dropped');droppedSeen=seen;};
  // The request whose run is in flight gets the stream.
  let streamTo:string|undefined;
  const emit=(text:string)=>console.log(JSON.stringify({id:streamTo,event:'line',text:nameIds(text,readNames(runtime))}));
  const dispatch=serve(account,command,
    {pilot:()=>readPilot(pilotFile,droppedOnRead),setPilot:next=>writePilot(pilotFile,next),runtime,emit,
      // A script cut off at the cap may still be running inside this process; ending the process
      // is the only way to be sure it sends nothing more. A second's grace lets the report be
      // sent; the next request starts a fresh bridge.
      onAbandoned:()=>{
        journalRun(runtime,{message:'exiting: a run was abandoned at the wall-clock cap'},'boot');
        setTimeout(triggerShutdown,1000).unref?.();
      }});
  // The freighters fly from this process, each on its own account; the pilot's run is not theirs.
  resumeFreighters(runtime);
  console.log(JSON.stringify({event:'ready',...interrupted?{interrupted:interrupted.outcome}:{}}));
  const handle=async(line:string)=>{
    const response=await answerLine(dispatch,line,id=>{streamTo=id;},runtime);
    // Ids named at stdout only: `answerLine` journalled the raw reply.
    console.log(JSON.stringify('result' in response?{...response,result:forPilot(response.result,readNames(runtime))}:response));
  };
  for await(const line of createInterface({input:process.stdin,terminal:false})) {
    if(stopped)break;
    if(!line.trim())continue;
    void handle(line);
  }
  triggerShutdown();
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
