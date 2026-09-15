/** Minimal SpaceMolt bridge: `where`, `travel` and `dock`, one JSON request per stdin line. */
import {Account,fetchCatalog,httpBaseFromWs,type Catalog} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import type {Ctx} from './jobs/ctx.ts';
import {currentSystem,dock as dockHelper,stations,travel as travelHelper,
  where as whereHelper} from './jobs/helpers.ts';
import {buildMenu} from './menu.ts';
import type {Mood} from './mood-policy.ts';
import {reflectReport} from './reflect.ts';
import {REST_JOB,evaluateMenu,type CounterName,type Facts,type StanceName} from './rules-table.ts';
import {journalRun,readRun,type RunRecord} from './run-record.ts';
import {listScripts,prepareRun,runScript as defaultRunScript,
  type RunOutcome} from './script-runner.ts';
import {viewStorage} from './storage.ts';
import {quoteRecipe} from './quote-action.ts';
import {recipesReport} from './recipes-action.ts';

/** The one endpoint this runner talks to. The catalog is served over HTTP from the same
 * host the socket connects to, which is the only place that base URL is written down. */
export const GAME_WS_URL='wss://game.spacemolt.com/ws/v2';

export type Dispatch=(action:string,params?:Record<string,unknown>)=>Promise<unknown>;

/** What the runner set at the last rest. The agent never writes any of it: reflection asks
 * the runner to, and rest asks the runner to take it away. */
export interface Pilot {name?:string;objective?:string;objective_done?:boolean;goal?:string;
  stance?:StanceName;mood?:Mood;home?:string;permissions?:Facts['permissions']}
export interface ServeOptions {
  pilot?:()=>Pilot;
  /** How the runner puts the record back after rest. Without one this runner can read the
   * pilot but not end its shift, which is what rest says rather than pretending it worked. */
  setPilot?:(pilot:Pilot)=>void;
  runScript?:typeof defaultRunScript;
  /** Where the run record and the journal live. Without one the runner keeps the run
   * in memory alone, which is what a restart loses (N22). */
  runtime?:string;
  /** Where the scripts the dispatch tool may name live. Tests point it at their own. */
  scriptsDir?:URL;
  /** The reference catalog. One fetch per process, cached here; tests pass their own. */
  catalog?:()=>Promise<Catalog>;
}

/** The pilot record, or an empty one: a pilot with no record has no stance and no menu. */
export function readPilot(path:string):Pilot {
  if(!existsSync(path))return {};
  try {return JSON.parse(readFileSync(path,'utf8')) as Pilot;}
  catch(error){throw new Error(`Unreadable pilot record ${path}: ${error instanceof Error?error.message:String(error)}`);}
}

/** The runner's own write of the record: temp file then rename, so a reader never catches
 * half a pilot. Only rest and the operator's window reach this. */
export function writePilot(path:string,pilot:Pilot):void {
  const temp=`${path}.${process.pid}.tmp`;
  writeFileSync(temp,`${JSON.stringify(pilot,null,2)}\n`,{mode:0o600});
  renameSync(temp,path);
}

/** Pure dispatch over an account + command pair, so tests never connect. */
export function serve(account:ReadinessAccount,command:ReadinessCommand,options:ServeOptions={}):Dispatch {
  const pilot=options.pilot??(()=>({} as Pilot));
  const runner=options.runScript??defaultRunScript;
  const message=(error:unknown)=>error instanceof Error?error.message:String(error);
  // The reads and the short moves are the same helpers a script is given, so the operator's
  // window and a running script cannot answer the same question two different ways.
  const readCtx=():Ctx=>({account,command,mood:pilot().mood??'Cautious',
    permissions:pilot().permissions??{},jobs:[],keep:[],
    ...pilot().home===undefined?{}:{home:pilot().home as string},
    ...options.runtime===undefined?{}:{runtime:options.runtime},
    check:async()=>{},progress:()=>{},resuming:()=>false});
  const where=()=>whereHelper(readCtx());
  const travel=(poiId:string)=>travelHelper(readCtx(),poiId);
  const dock=(baseId?:string)=>dockHelper(readCtx(),baseId);
  /** The facts the rules table reads, assembled from live state and the pilot record.
   * Board, threats and obligations stay empty until reads for them exist; the menu's own
   * refusals then say what is missing, which is the honest answer. */
  const factsNow=async(who:Pilot):Promise<Facts>=>{
    if(!who.mood)throw new Error('The pilot record names no mood; the runner sets stance and mood at rest');
    await account.refresh();
    const {location,ship,player}=account.state;
    const rows=stations(await currentSystem(command));
    const docked=location?.docked_at??null;
    const counters:CounterName[]=[];
    let service_prices:{fuel?:number;hull?:number}|undefined;
    if(docked) {
      const base=details(await command('spacemolt/get_base',{}));
      const fuel=base.fuel_price_all_in,hull=base.base?.repair_price_per_hull;
      service_prices={...Number.isFinite(fuel)?{fuel}:{},...Number.isFinite(hull)?{hull}:{}};
      // ponytail: the counters a base read proves. Per-counter discovery waits for the
      // counter reads (S38); until then an unproved counter is left off rather than guessed.
      if(service_prices.fuel!==undefined||service_prices.hull!==undefined)counters.push('Services');
      // What a full hold can become here, named from the same read: a deposit it will take,
      // a bench it can be worked at. `place.workshop` stays unset — whether a recipe is
      // quotable is J7's question, not this one.
      const services=(Array.isArray(base.services)?base.services:[]).map(String);
      if(services.includes('storage'))counters.push('Storage');
      if(services.includes('crafting'))counters.push('Workshop / recipes');
    }
    // travelTo quotes a route by SYSTEM, so this one quote is the very number the script
    // will apply to any POI in this system (R5).
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

  // One run at a time: the runner's own work, which outlives the conversation that asked
  // for it (N5) and, written down, the runner process too (N22). `running` is the script in
  // flight; `last` is what the next juncture reads, from memory or from the record on disk.
  // The run has no id: it is the script it runs and the moment it started.
  const runtime=options.runtime;
  const stored=()=>runtime?readRun(runtime):null;
  let running:{script:string}|null=null,record:RunRecord|undefined,flight:Promise<unknown>|null=null,
    last:Record<string,unknown>|null=null;
  const progress=()=>({script:record?.script,started:record?.started,last_job:record?.last_job,
    last_step:record?.last_step,ended:record?.ended});
  const busy=()=>({script:running!.script,record:progress()});
  /** The run ended: `last` is what the next juncture reads. The runner wrote the record and
   * the journal lines itself, because it is the one thing that knows the run is over. */
  const conclude=(outcome:Record<string,unknown>)=>{last=outcome;running=null;flight=null;};
  /** What the next juncture reads: this runner's own run, or the one before it left. */
  const lastOutcome=()=>last??stored()?.outcome??null;
  const facts=async():Promise<Facts|null>=>{
    const who=pilot();
    return who.mood?await factsNow(who):null;
  };
  /** Start a run and come straight back: the conversation ends, the run does not.
   *
   * The script is loaded and its parameters checked before anything is started, so a script
   * that does not exist, will not pass the lint, or was named with the wrong parameters is a
   * refusal the caller reads — never a job half begun. */
  const startRun=async(params:Record<string,unknown>)=>{
    if(running)return {accepted:false,
      reason:'a script is already running; the runner raises the juncture when it ends',...busy()};
    const script=String(params.script??'');
    const args=(params.params??{}) as Record<string,unknown>;
    await prepareRun(script,args,options.scriptsDir);
    const who=pilot();
    const started=new Date().toISOString();
    running={script};
    record={script,params:args,started,keep:[],ended:false};
    flight=runner({account,command,script,params:args,facts,started,
      mood:who.mood??'Cautious',permissions:who.permissions??{},
      ...who.home===undefined?{}:{home:who.home},
      ...runtime===undefined?{}:{runtime},
      ...options.scriptsDir===undefined?{}:{scriptsDir:options.scriptsDir},
      onProgress:step=>{record=step;}});
    watch(script,flight as Promise<RunOutcome>);
    return {accepted:true,script,record:progress()};
  };
  const watch=(script:string,inFlight:Promise<RunOutcome>)=>{
    void inFlight.then(outcome=>conclude({...outcome}),
      error=>conclude({script,outcome:'failed',reason:message(error),jobs:[]}));
  };
  /** What the runner does about the work it was doing when it died (N22).
   *
   * The script is re-run from the top. Every job is named for an end state and sends nothing
   * when that state already holds, so nothing whose effect is already visible happens twice;
   * the job that was in flight re-enters at the step the live world implies, and a world
   * that matches no step of it ends the run blocked with the record kept. */
  const resume=async()=>{
    const kept=stored();
    if(!kept||kept.ended)return {resumed:false,last:lastOutcome()};
    if(running)return {resumed:false,reason:'a script is already running',...busy()};
    const who=pilot();
    running={script:kept.script};
    record=kept;
    flight=runner({account,command,script:kept.script,params:kept.params,facts,
      started:kept.started,resume:kept,mood:who.mood??'Cautious',permissions:who.permissions??{},
      ...who.home===undefined?{}:{home:who.home},
      ...runtime===undefined?{}:{runtime},
      ...options.scriptsDir===undefined?{}:{scriptsDir:options.scriptsDir},
      onProgress:step=>{record=step;}});
    watch(kept.script,flight as Promise<RunOutcome>);
    return {resumed:true,script:kept.script,record:progress()};
  };
  /** One trip out and back, waited for: the direct tool is the operator's, not a juncture's,
   * and it answers with the outcome rather than leaving the window to poll for it. */
  const gather=async(params:Record<string,unknown>)=>{
    const args:Record<string,unknown>={};
    if(params.poi_id!==undefined)args.poi_id=String(params.poi_id);
    if(params.base_id!==undefined)args.base_id=String(params.base_id);
    if(Array.isArray(params.keep))args.keep=params.keep.map(String);
    const begun=await startRun({script:'gather',params:args});
    if(!begun.accepted)return begun;
    await flight?.catch(()=>{});
    return lastOutcome();
  };

  const menu=async()=>{
    if(running)return {busy:true,...busy()};
    const who=pilot();
    // No stance is no shift: what a resting pilot is consulted about is not a menu of work
    // but the reflection the next shift is chosen from (N7). A running script still wins:
    // the pilot is at work whatever the record says.
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
        // What the hold holds and what this base can do with it: a full hold has somewhere
        // to go only if one of these is true, and the pilot cannot see that from a count.
        hold:(account.state.cargo??[]).map(row=>({item_id:String(row.item_id),quantity:row.quantity})),
        storage:(facts.place.counters??[]).includes('Storage'),
        workshop:(facts.place.counters??[]).includes('Workshop / recipes')},
      ...buildMenu(facts),last:lastOutcome(),
    };
  };

  /** Rest: the one act that ends a shift (N6), and the only thing that touches the stance.
   *
   * Docking, refuelling, repairing and unloading do none of this, at home or anywhere else
   * (N10). The admissibility is the menu's own rest rule, so what the agent was offered is
   * what the runner accepts (R5). Mood does not gate it and Tired does not survive it: the
   * record comes out with no stance, no mood and no goal, so the next reflection starts
   * from nothing imposed.
   */
  const rest=async()=>{
    if(running)return {rested:false,
      reason:'a script is running; rest at the juncture the runner raises when it ends',...busy()};
    const who=pilot();
    const facts=await factsNow(who);
    const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
    if(!verdict?.admissible)
      return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
    if(!options.setPilot)return {rested:false,reason:'this runner cannot write the pilot record'};
    const {stance,mood,goal,...kept}=who;
    options.setPilot(kept);
    const cleared={home:facts.place.base_id,...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
    if(runtime)journalRun(runtime,cleared,'rest');
    return {rested:true,shift_ended:true,at_rest:true,cleared,
      serviced:facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull};
  };
  /** What a resting pilot reflects on. Read-only: it chooses nothing and writes nothing. */
  const reflect=async()=>reflectReport(account,command,pilot(),runtime);

  // The catalog changes only on a server release, and it is multiple MB: one fetch, kept for
  // the life of this process. A fetch that fails is reported by the action, never thrown past
  // it — a bench read that cannot reach the catalog is still a read of where the ore is.
  const fetcher=options.catalog??(()=>fetchCatalog(httpBaseFromWs(GAME_WS_URL)));
  let catalog:Promise<Catalog>|undefined;
  const loadCatalog=()=>(catalog??=fetcher().catch(error=>{catalog=undefined;throw error;}));

  // Later capabilities (service, more jobs) slot in here; the transport never changes.
  const actions:Record<string,(params:Record<string,unknown>)=>Promise<unknown>>={
    where,
    rest,
    reflect,
    travel:params=>travel(String(params.poi_id??'')),
    dock:params=>dock(params.base_id===undefined?undefined:String(params.base_id)),
    gather,
    storage:params=>viewStorage(command,params.station_id===undefined?undefined:String(params.station_id)),
    recipes:params=>recipesReport(account,command,loadCatalog,{
      ...params.search===undefined?{}:{search:String(params.search)},
      ...params.base_id===undefined?{}:{base_id:String(params.base_id)}}),
    quote:params=>quoteRecipe(account,command,{recipe_id:String(params.recipe_id??''),
      ...params.quantity===undefined?{}:{quantity:Number(params.quantity)}}),
    menu,
    run:startRun,
    scripts:async()=>listScripts(options.scriptsDir),
    resume,
    status:async()=>running?{running:true,...busy()}:{running:false,last:lastOutcome()},
  };
  return async(action,params={})=>{
    if(!Object.hasOwn(actions,action))throw new Error(`Unknown action: ${action}`);
    return actions[action]!(params);
  };
}

/** Ends the bridge's own process once its owner is gone: SIGTERM, SIGINT, and stdin ending all
 * say the same thing, and more than one may fire, so this is idempotent. `account.close()` is
 * started but never awaited — a real, connected `Account` can leave it unresolved for the life
 * of the process — so a bounded grace timer forces the exit if closing does not finish first,
 * and exit fires immediately the moment it does. */
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
  const journal=(entry:Record<string,unknown>)=>
    appendFileSync(`${runtime}/gameplay.jsonl`,`${JSON.stringify({at:new Date().toISOString(),...entry})}\n`,{mode:0o600});
  // A crash leaves the lock only while its holder lives: an operator inspects the pilot before
  // a second LIVE controller runs, but a dead holder's lock is taken over rather than wedging.
  const unlock=controllerLock(`${runtime}/controller-${createHash('sha256').update(username).digest('hex').slice(0,16)}.lock`);
  process.on('exit',unlock); // every exit path releases it, uncaught errors included
  const account=new Account({url:GAME_WS_URL,reconnect:true,credentials});
  // Stdin EOF, SIGTERM and SIGINT all say the same thing: the gateway that owns this bridge is
  // gone. A run in flight is abandoned rather than awaited — its last progress record is
  // already journalled. `stopped` also stops the request loop from taking on new work once
  // shutdown has started.
  let stopped=false;
  const shutdown=createShutdown(account);
  const triggerShutdown=()=>{stopped=true;shutdown();};
  process.on('SIGTERM',triggerShutdown);
  process.on('SIGINT',triggerShutdown);
  // The for-await loop below ends on stdin EOF too, but a pipe that stays open without ever
  // emitting readline's own 'close' must not be the only way out.
  process.stdin.on('end',triggerShutdown);
  process.stdin.on('close',triggerShutdown);
  await account.connect();
  await account.authenticate(credentials());
  // The lib applies each result's state delta; travelTo re-reads authoritatively at every gate.
  const command:ReadinessCommand=(action,params)=>{
    const [tool,name]=action.split('/');
    return account.send(tool!,name!,params);
  };
  // The runner writes the pilot record beside the runtime directory; the agent never does.
  const pilotFile=resolve(runtime,'..','pilot.json');
  const dispatch=serve(account,command,
    {pilot:()=>readPilot(pilotFile),setPilot:next=>writePilot(pilotFile,next),runtime});
  // Whatever this runner's predecessor was doing, it is this runner's work now (N22).
  const resumed=await dispatch('resume',{});
  console.log(JSON.stringify({event:'ready',resumed}));
  for await(const line of createInterface({input:process.stdin,terminal:false})) {
    if(stopped)break;
    if(!line.trim())continue;
    let request:{id?:string;action:string;params?:Record<string,unknown>}|undefined;
    let response:Record<string,unknown>;
    try {
      request=JSON.parse(line);
      response={id:request?.id,ok:true,result:await dispatch(request!.action,request!.params??{})};
    } catch(error) {
      response={id:request?.id,ok:false,error:error instanceof Error?error.message:String(error)};
    }
    journal({request,response});
    console.log(JSON.stringify(response));
  }
  triggerShutdown();
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
