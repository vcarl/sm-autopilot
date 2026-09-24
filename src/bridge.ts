/** The SpaceMolt bridge: one JSON request per stdin line, one JSON reply per line, and
 * `{"id","event":"line","text"}` lines streamed while a `run` proceeds. Requests are
 * handled concurrently, so `stop` and `status` answer while a run is in flight. */
import {Account} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {markAlertsDelivered,pendingAlerts,recordAlert} from './alerts.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {resolveWalkAway,type Mood} from './mood-policy.ts';
import {reflectReport} from './reflect.ts';
import {REST_JOB,evaluateMenu,type Facts,type StanceName} from './rules-table.ts';
import {journalCommand,journalRun,readRun,type RunRecord} from './run-record.ts';
import {startHeartbeat} from './heartbeat.ts';
import {flushJournalDrain,startJournalDrain} from './journal-webhook.ts';
import {check as checkPilot,runPilot as defaultRunPilot,type RunResult} from './run.ts';
import {factsNow,menu as buildMenu,renderMenu} from './play/menu.ts';
import {bind,isBound,present,progress,stop as stopRun,unbind} from './play/runtime.ts';

/** The one endpoint this runner talks to. */
export const GAME_WS_URL='wss://game.spacemolt.com/ws/v2';

export type Dispatch=(action:string,params?:Record<string,unknown>)=>Promise<unknown>;

/** The actions whose answer is an outcome: a journal line keeps its shape, trimmed. */
const OUTCOME_ACTIONS=new Set(['run','status','rest','reflect','menu','resume','stop','check']);
const OUTCOME_KEYS=new Set(['accepted','reason','status','record','running','rested','shift_ended','at_rest',
  'cleared','serviced','resumed','busy','objective','objective_done','stance','mood','errors','stopping',
  'ok','fn','did','sha','step','commands','elapsed_s','started','stagnation','rest']);

/** One response as the journal keeps it: whether the thing happened, never the prose or the
 * bodies of a read. */
export function journalResult(action:string,result:unknown):unknown {
  if(result===null||typeof result!=='object')return result;
  const body=result as Record<string,any>;
  if(!OUTCOME_ACTIONS.has(action))return result;
  const kept:Record<string,unknown>={};
  for(const key of Object.keys(body))if(OUTCOME_KEYS.has(key))kept[key]=body[key];
  if(body.last&&typeof body.last==='object')kept.last={status:body.last.status,did:body.last.did};
  for(const key of ['moves','not_now'])
    if(Array.isArray(body[key]))kept[key]=body[key].length;
  return kept;
}

/** The pushes worth keeping. `@spacemolt/lib` emits every frame the socket carries whether
 * anything registered or not, and the runner discarded all 85 kinds; these are the ones a
 * pilot waking at the next juncture, or an operator reading the drain, would want. The
 * journal is the record and the volume measurement; the decision-shaped subset is buffered
 * into `alerts.json` as well, which is what the wake actually reads.
 *
 * `action_result`, `action_error` and `reconnected` are deliberately absent — the lib's own
 * correlator consumes them and the command seam already journals the reply. */
export const PUSH_TYPES=['battle_alert','battle_ended','player_died','facility_rent_warning',
  'facility_reclaimed','base_destroyed','base_raid_update','mining_yield','crafting_update',
  'skill_level_up','ok','fleet'] as const;

/** The one group buffered into `alerts.json` as well as journalled: the pilot losing real
 * property while it sleeps. All three carry `base_id`, which is the collapse key. */
const ALERT_TYPES=new Set(['facility_rent_warning','facility_reclaimed','base_destroyed']);

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
  for(const [key,value] of Object.entries((payload??{}) as Record<string,unknown>))
    if(value!==null&&typeof value!=='object')
      kept[key]=typeof value==='string'?value.slice(0,60):value;
  return kept;
}

/** Register the allowlist on an account that outlives every run. Called once from `main()`,
 * never from `bind()`: a handler bound to a run is deaf between junctures, which is the
 * whole reason these frames were being lost. */
export function pushJournal(account:{on:(type:string,handler:(payload:Record<string,unknown>)=>void)=>unknown},
  runtime:string,now:()=>number=Date.now):void {
  const seen=new Map<string,{minute:number;n:number}>();
  const spare=(channel:string):boolean=>{
    const minute=Math.floor(now()/60_000),kept=seen.get(channel);
    if(!kept||kept.minute!==minute) {seen.set(channel,{minute,n:1});return true;}
    kept.n+=1;
    return kept.n<=PUSH_PER_MINUTE;
  };
  for(const type of PUSH_TYPES)account.on(type,(payload:Record<string,unknown>)=>{
    const body=(payload??{}) as Record<string,unknown>;
    // Most `ok` variants key on `action`, seven on `type`; a variant with neither is the
    // wildlife kill notice, which the pilot's own hunt step already reports.
    const cause=type==='ok'?String(body.action??body.type??''):'';
    if(type==='ok'&&(!cause||OWN_PUSH.has(cause)||PUSH_NOISE.has(cause)))return;
    const scalars=pushScalars(body);
    // Buffered before the rate cap, never after: the cap protects the journal and the Discord
    // drain from a chatty group, and losing a repossession notice to it would be the one
    // failure this whole path exists to prevent. Collapse by key is its bound instead.
    if(ALERT_TYPES.has(type)&&typeof body.base_id==='string')
      recordAlert(runtime,type,`base:${body.base_id}`,scalars);
    if(!spare(type))return;
    if(MOVED_BY_OTHERS.has(cause))
      journalRun(runtime,{cause,
        evidence:Object.entries(scalars).map(([key,value])=>`${key}=${value}`).join(' ')},'unsolicited_move');
    else journalRun(runtime,{push:type,...scalars},'push');
  });
}

/** What the runner set at the last rest. The agent never writes any of it: reflection asks
 * the runner to, and rest asks the runner to take it away. */
export interface Pilot {name?:string;objective?:string;objective_done?:boolean;goal?:string;
  stance?:StanceName;mood?:Mood;mood_before_tired?:Mood;tired_forced?:boolean;
  permissions?:Facts['permissions'];instruction?:{text:string;at:string}}
export interface ServeOptions {
  pilot?:()=>Pilot;
  /** How the runner puts the record back after rest and when Tired is imposed. */
  setPilot?:(pilot:Pilot)=>void;
  runPilot?:typeof defaultRunPilot;
  /** Where the run record, the journal and the pilot's files live. */
  runtime?:string;
  /** Where a streamed line goes; the request loop routes it to the request that started the run. */
  emit?:(text:string)=>void;
}

export function readPilot(path:string):Pilot {
  if(!existsSync(path))return {};
  try {return JSON.parse(readFileSync(path,'utf8')) as Pilot;}
  catch(error){throw new Error(`Unreadable pilot record ${path}: ${error instanceof Error?error.message:String(error)}`);}
}

/** Temp file then rename, so a reader never catches half a pilot. */
export function writePilot(path:string,pilot:Pilot):void {
  const temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,`${JSON.stringify(pilot,null,2)}\n`,{mode:0o600});
  renameSync(temp,path);
}

/** Pure dispatch over an account + command pair, so tests never connect. */
export function serve(account:ReadinessAccount,command:ReadinessCommand,options:ServeOptions={}):Dispatch {
  const pilot=options.pilot??(()=>({} as Pilot));
  const runner=options.runPilot??defaultRunPilot;
  const runtime=options.runtime;
  if(runtime) {startJournalDrain();startHeartbeat(runtime);}
  const stored=()=>runtime?readRun(runtime):null;
  let running:{started:string}|null=null,last:Record<string,unknown>|null=null;
  const busy=()=>({running:true as const,...running!,...isBound()?progress():{},
    fuel:account.state.ship?.fuel,hull:account.state.ship?.hull,credits:account.state.player?.credits});
  /** The last run as a reader of `status` gets it: what was done, why, and the report. The
   * whole Outcome — ship, location, nearby players, every skill — stays in `run.json` and
   * the journal; a pilot reading this through a tool call is paying for every line of it. */
  const brief=(result:RunResult):Record<string,unknown>=>({...result.sha?{sha:result.sha}:{},
    started:result.started,ended:true,...result.ended_at?{ended_at:result.ended_at}:{},status:result.status,did:result.reason,
    ...result.why?{why:result.why}:{},prose:result.prose,commands:result.commands});
  const lastOutcome=()=>last??(stored()?.ended?{...stored()!.outcome as Record<string,unknown>}:null);

  /** Run `pilot/index.ts`: validate, execute, stream, and answer with the report when it ends. */
  const run=async(_params:Record<string,unknown>,resume?:RunRecord)=>{
    if(!runtime)throw new Error('This runner has no runtime directory to run a pilot from');
    if(running)return {accepted:false,reason:'a run is already in flight; stop it or wait for status.running to clear',...busy()};
    const started=resume?.started??new Date().toISOString();
    running={started};
    try {
      const result=await runner({account,command,pilot,setPilot:options.setPilot??(()=>{}),runtime,
        emit:options.emit??(()=>{}),...resume?{resume}:{}});
      if(!result.accepted)return result;
      last=brief(result);
      return {accepted:true,...last};
    } finally {running=null;}
  };
  const resume=async()=>{
    if(!runtime)return {resumed:false,last:null};
    const kept=stored();
    if(!kept||kept.ended)return {resumed:false,last:lastOutcome()};
    if(running)return {resumed:false,reason:'a run is already in flight',...busy()};
    // Re-run from the top: every helper is named for an end state and re-enters from the
    // live world, so nothing already done happens twice.
    void run({},kept).catch(()=>{});
    return {resumed:true,started:kept.started};
  };

  /** The menu from where the ship stands (DESIGN §4): the present, the moves with the call
   * each is taken with, what is not on it and why, and how the last run ended. The play
   * runtime is bound for the reads and released after; a run in flight answers `busy`. */
  const menu=async()=>{
    if(running)return {busy:true,...busy()};
    // At rest the stance and the mood are cleared, but the menu is never empty (VISION): the
    // moves are computed all the same, under the resting default mood, and what reflect would
    // set is named beside them rather than in place of them. The reader stays live: the reads
    // below push state, every push runs `imposeTired`, and a frozen copy clears the same Tired
    // on every push and then reports a mood the pilot no longer has (playtest 2026-09-22).
    const flying=():Pilot=>{const now=pilot();return now.mood?now:{...now,mood:'Cautious'};};
    bind({account,command,pilot:flying,setPilot:options.setPilot??(()=>{}),...runtime?{runtime}:{},emit:()=>{}});
    try {
      const built=await buildMenu(runtime);
      const {location,ship,player,modules}=account.state;
      // Read back after the reads, never before: Tired may have been imposed or cleared in them.
      const who=pilot();
      // Handed over and stamped delivered in the same breath: this handler is the single
      // reader and the single writer, in one process, so once-only needs no lock and none of
      // the read-modify-write race the instruction's `_deliver` carries.
      const waiting=runtime?pendingAlerts(runtime):[];
      if(runtime)markAlertsDelivered(runtime,waiting);
      const absent=(['goal','stance','mood'] as const).filter(key=>!who[key]);
      const resting=!who.stance||!who.mood;
      return {
        now:new Date().toISOString(),
        ...who.stance?{stance:who.stance}:{},...who.mood?{mood:who.mood}:{},
        ...who.goal?{goal:who.goal}:{},
        ...who.permissions?{permissions:who.permissions}:{},
        ...resting?{rest:{at_rest:true,absent,
          set_by:'reflect names the goal, then the stance and the mood that fit it'}}:{},
        ...who.objective?{objective:who.objective}:{},
        present:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null,
          in_transit:Boolean(location?.in_transit),fuel:ship?.fuel,max_fuel:ship?.max_fuel,
          hull:ship?.hull,max_hull:ship?.max_hull,
          cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits,
          hold:(account.state.cargo??[]).map(row=>({item_id:String(row.item_id),quantity:row.quantity})),
          weapons:(modules??[]).filter(row=>row.slot==='weapon')
            .map(row=>({id:row.type_id,...row.current_ammo!==undefined?{loaded:row.current_ammo}:{}})),
          skills:Object.fromEntries(Object.entries(present().skills).map(([id,row])=>[id,row.level])),
          // The hull this mood breaks off a fight at, as `imposeTired` computes it: the juncture
          // cannot reach the D2 table, and a pilot left to guess the line guesses it low.
          ...ship?.max_hull===undefined?{}:{walk_away:Math.floor(resolveWalkAway(who.mood??'Cautious')*ship.max_hull)}},
        ...built,text:renderMenu(built),last:lastOutcome(),
        ...waiting.length?{alerts:waiting.map(({type,key,at,first_at,n,body})=>({type,key,at,first_at,n,body}))}:{},
      };
    } finally {unbind();}
  };

  /** Rest: the one act that ends a shift (N6), and the only thing that touches the stance.
   * The admissibility is the menu's own rest rule (R5). Tired does not survive it. */
  const rest=async()=>{
    if(running)return {rested:false,reason:'a run is in flight; rest when it ends',...busy()};
    const who=pilot();
    const facts=await factsNow(account,command,who,runtime);
    const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
    if(!verdict?.admissible)return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
    if(!options.setPilot)return {rested:false,reason:'this runner cannot write the pilot record'};
    const {stance,mood,goal,mood_before_tired:_m,tired_forced:_t,...kept}=who;
    options.setPilot(kept);
    const cleared={...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
    if(runtime)journalRun(runtime,cleared,'rest');
    return {rested:true,shift_ended:true,at_rest:true,cleared,
      serviced:facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull};
  };
  const reflect=async()=>reflectReport(account,command,pilot(),runtime);

  const actions:Record<string,(params:Record<string,unknown>)=>Promise<unknown>>={
    run,
    check:async()=>{
      if(!runtime)throw new Error('This runner has no runtime directory');
      const gate=await checkPilot(runtime);
      return {ok:gate.ok,entry:gate.entry,sha:gate.sha,errors:gate.errors};
    },
    stop:async()=>{
      if(!running)return {stopping:false,reason:'nothing is running'};
      stopRun();
      return {stopping:true,...busy()};
    },
    status:async()=>running?busy():{running:false,last:lastOutcome()},
    rest,
    reflect,
    resume,
    menu,
  };
  return async(action,params={})=>{
    if(!Object.hasOwn(actions,action))throw new Error(`Unknown action: ${action}`);
    return actions[action]!(params);
  };
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
    catch {finish();} // never connected
  };
}

async function main() {
  const credentialPath=process.env.SPACEMOLT_CREDENTIALS_FILE;
  if(!credentialPath)throw new Error('SPACEMOLT_CREDENTIALS_FILE must name a credentials file');
  const text=readFileSync(credentialPath,'utf8');
  const username=text.match(/^Username: (.+)$/m)?.[1]?.trim();
  const password=text.match(/^Password: (.+)$/m)?.[1]?.trim();
  if(!username||!password)throw new Error('Missing Username or Password field in credentials file');
  const credentials=()=>({kind:'login' as const,username,password});
  const runtime=process.env.SPACEMOLT_RUNTIME_DIR??fileURLToPath(new URL('../runtime/',import.meta.url));
  mkdirSync(runtime,{recursive:true});
  const unlock=controllerLock(`${runtime}/controller-${createHash('sha256').update(username).digest('hex').slice(0,16)}.lock`);
  process.on('exit',unlock);
  // The lib bounds a mutation in two phases: the ack by `queryTimeoutMs` (15s default, kept),
  // then the outcome by `mutationTimeoutMs` for jump/travel (600s default, kept — a transit
  // legitimately spans many ticks) and by `fastMutationTimeoutMs` for everything else. `mine`
  // is in "everything else" and settles on the tick it was queued on, so the lib's 180s default
  // is 18 ticks of silence before a dead socket shows. 60s is 6 ticks: slack enough for a slow
  // tick or a rate-limited resend, and inside the minute a waiting pilot can still use.
  const account=new Account({url:GAME_WS_URL,reconnect:true,credentials,fastMutationTimeoutMs:60_000});
  let stopped=false;
  const shutdown=createShutdown({close:async()=>{
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
    const [tool,name]=action.split('/');
    try {
      const reply=await account.send(tool!,name!,params);
      journalCommand(runtime,action,params,true,reply);
      return reply;
    } catch(error) {
      journalCommand(runtime,action,params,false,error);
      throw error;
    }
  };
  // The pushes, on the one account that outlives every run and every juncture.
  pushJournal(account,runtime);
  const pilotFile=resolve(runtime,'..','pilot.json');
  // The request whose run is in flight gets the stream; a run started by resume has none.
  let streamTo:string|undefined;
  const emit=(text:string)=>console.log(JSON.stringify({id:streamTo,event:'line',text}));
  const dispatch=serve(account,command,
    {pilot:()=>readPilot(pilotFile),setPilot:next=>writePilot(pilotFile,next),runtime,emit});
  const resumed=await dispatch('resume',{});
  console.log(JSON.stringify({event:'ready',resumed}));
  const handle=async(line:string)=>{
    let request:{id?:string;action:string;params?:Record<string,unknown>}|undefined;
    let response:Record<string,unknown>;
    try {
      request=JSON.parse(line);
      if(request!.action==='run')streamTo=request!.id;
      response={id:request?.id,ok:true,result:await dispatch(request!.action,request!.params??{})};
    } catch(error) {
      response={id:request?.id,ok:false,error:error instanceof Error?error.message:String(error)};
    }
    journalRun(runtime,{request,
      response:{...response,...'result' in response
        ?{result:journalResult(String(request?.action??''),response.result)}:{}}},'request');
    console.log(JSON.stringify(response));
  };
  for await(const line of createInterface({input:process.stdin,terminal:false})) {
    if(stopped)break;
    if(!line.trim())continue;
    void handle(line);
  }
  triggerShutdown();
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
