/** The SpaceMolt bridge: one JSON request per stdin line, one JSON reply per line, and
 * `{"id","event":"line","text"}` lines streamed while a `run` proceeds. Requests are
 * handled concurrently, so `stop` and `status` answer while a run is in flight. */
import {Account} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {buildMenu} from './menu.ts';
import type {Mood} from './mood-policy.ts';
import {reflectReport} from './reflect.ts';
import {REST_JOB,evaluateMenu,type CounterName,type Facts,type StanceName} from './rules-table.ts';
import {journalCommand,journalRun,readRun,type RunRecord} from './run-record.ts';
import {startHeartbeat} from './heartbeat.ts';
import {flushJournalDrain,startJournalDrain} from './journal-webhook.ts';
import {check as checkPilot,runPilot as defaultRunPilot,type RunResult} from './run.ts';
import {isBound,progress,stop as stopRun} from './play/runtime.ts';

/** The one endpoint this runner talks to. */
export const GAME_WS_URL='wss://game.spacemolt.com/ws/v2';

export type Dispatch=(action:string,params?:Record<string,unknown>)=>Promise<unknown>;

/** The actions whose answer is an outcome: a journal line keeps its shape, trimmed. */
const OUTCOME_ACTIONS=new Set(['run','status','rest','reflect','menu','resume','stop','check']);
const OUTCOME_KEYS=new Set(['accepted','reason','status','record','running','rested','shift_ended','at_rest',
  'cleared','serviced','resumed','busy','objective','objective_done','home','stance','mood','errors','stopping',
  'ok','fn','did','sha','step','commands','elapsed_s','started']);

/** One response as the journal keeps it: whether the thing happened, never the prose or the
 * bodies of a read. */
export function journalResult(action:string,result:unknown):unknown {
  if(result===null||typeof result!=='object')return result;
  const body=result as Record<string,any>;
  if(!OUTCOME_ACTIONS.has(action))return result;
  const kept:Record<string,unknown>={};
  for(const key of Object.keys(body))if(OUTCOME_KEYS.has(key))kept[key]=body[key];
  if(body.last&&typeof body.last==='object')kept.last={status:body.last.status,did:body.last.did};
  for(const key of ['options','unavailable','stagnation'])
    if(Array.isArray(body[key]))kept[key]=body[key].length;
  return kept;
}

/** What the runner set at the last rest. The agent never writes any of it: reflection asks
 * the runner to, and rest asks the runner to take it away. */
export interface Pilot {name?:string;objective?:string;objective_done?:boolean;goal?:string;
  stance?:StanceName;mood?:Mood;mood_before_tired?:Mood;tired_forced?:boolean;home?:string;
  permissions?:Facts['permissions']&{max_spend?:number;no_go?:string[]};instruction?:{text:string;at:string}}
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
  /** The facts the rules table reads, assembled from live state and the pilot record. */
  const factsNow=async(who:Pilot):Promise<Facts>=>{
    if(!who.mood)throw new Error('The pilot record names no mood; the runner sets stance and mood at rest');
    await account.refresh();
    const {location,ship,player}=account.state;
    const system=details(await command('spacemolt/get_system',{})).system as Record<string,any>|undefined;
    const rows=(system?.pois??[]) as Record<string,any>[];
    const docked=location?.docked_at??null;
    const counters:CounterName[]=[];
    let service_prices:{fuel?:number;hull?:number}|undefined;
    if(docked) {
      const base=details(await command('spacemolt/get_base',{}));
      const fuel=base.fuel_price_all_in,hull=base.base?.repair_price_per_hull;
      service_prices={...Number.isFinite(fuel)?{fuel}:{},...Number.isFinite(hull)?{hull}:{}};
      if(service_prices.fuel!==undefined||service_prices.hull!==undefined)counters.push('Services');
      const services=(Array.isArray(base.services)?base.services:[]).map(String);
      if(services.includes('storage'))counters.push('Storage');
      if(services.includes('crafting'))counters.push('Workshop / recipes');
    }
    let quoted=NaN;
    if(location?.system_id&&!location.in_transit)
      quoted=Number(details(await command('spacemolt/find_route',{id:location.system_id})).estimated_fuel);
    const sites=Number.isFinite(quoted)?rows.filter(poi=>poi.id!==location?.poi_id).map(poi=>({
      poi_id:String(poi.id),quoted_fuel:quoted,
      ...poi.type==='asteroid_belt'?{resource:String(poi.type)}:{},
      ...poi.base_id?{serviced_base:true}:{}})):[];
    return {
      ...who.stance?{stance:who.stance}:{},
      mood:who.mood,
      place:{kind:docked?'base':location?.poi_id?'poi':'space',...docked?{base_id:docked}:{},
        ...docked&&who.home===docked?{is_home:true}:{},counters,
        ...service_prices?{service_prices}:{},sites},
      holdings:{fuel:ship?.fuel as number,max_fuel:ship?.max_fuel as number,
        hull:ship?.hull as number,max_hull:ship?.max_hull as number,
        cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits??0,
        inputs:Array.isArray(account.state.cargo)?[...new Set(account.state.cargo.map(row=>String(row.item_id)))]:[]},
      obligations:{},permissions:who.permissions??{},observed:{},
    };
  };

  if(runtime) {startJournalDrain();startHeartbeat(runtime);}
  const stored=()=>runtime?readRun(runtime):null;
  let running:{started:string}|null=null,last:Record<string,unknown>|null=null;
  const busy=()=>({running:true as const,...running!,...isBound()?progress():{},
    fuel:account.state.ship?.fuel,hull:account.state.ship?.hull,credits:account.state.player?.credits});
  /** The last run as a reader of `status` gets it: what was done, why, and the report. The
   * whole Outcome — ship, location, nearby players, every skill — stays in `run.json` and
   * the journal; a pilot reading this through a tool call is paying for every line of it. */
  const brief=(result:RunResult):Record<string,unknown>=>({...result.sha?{sha:result.sha}:{},
    started:result.started,ended:true,status:result.status,did:result.reason,
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

  const menu=async()=>{
    if(running)return {busy:true,...busy()};
    const who=pilot();
    if(!who.stance||!who.mood)return reflect();
    const facts=await factsNow(who);
    const {location,ship,player}=account.state;
    return {
      ...who.stance?{stance:who.stance}:{},mood:facts.mood,
      ...who.objective?{objective:who.objective}:{},
      present:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null,
        in_transit:Boolean(location?.in_transit),fuel:ship?.fuel,max_fuel:ship?.max_fuel,
        hull:ship?.hull,max_hull:ship?.max_hull,
        cargo_free:facts.holdings.cargo_free,credits:player?.credits,
        hold:(account.state.cargo??[]).map(row=>({item_id:String(row.item_id),quantity:row.quantity})),
        storage:(facts.place.counters??[]).includes('Storage'),
        workshop:(facts.place.counters??[]).includes('Workshop / recipes')},
      ...buildMenu(facts),last:lastOutcome(),
    };
  };

  /** Rest: the one act that ends a shift (N6), and the only thing that touches the stance.
   * The admissibility is the menu's own rest rule (R5). Tired does not survive it. */
  const rest=async()=>{
    if(running)return {rested:false,reason:'a run is in flight; rest when it ends',...busy()};
    const who=pilot();
    const facts=await factsNow(who);
    const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
    if(!verdict?.admissible)return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
    if(!options.setPilot)return {rested:false,reason:'this runner cannot write the pilot record'};
    const {stance,mood,goal,mood_before_tired:_m,tired_forced:_t,...kept}=who;
    options.setPilot(kept);
    const cleared={home:facts.place.base_id,...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
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
  const account=new Account({url:GAME_WS_URL,reconnect:true,credentials});
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
