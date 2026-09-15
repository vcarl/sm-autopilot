/** Minimal SpaceMolt bridge: `where`, `travel` and `dock`, one JSON request per stdin line. */
import {Account} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {runChain as defaultRunChain,type Chain,type ChainRecord} from './chain.ts';
import {journalChain,readChain,writeChain} from './chain-record.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {dockAt} from './dock.ts';
import {gatherJob,type GatherPlan} from './gather-job.ts';
import {miningInventory} from './mining-inventory.ts';
import {buildMenu} from './menu.ts';
import type {Mood} from './mood-policy.ts';
import {reflectReport} from './reflect.ts';
import {REST_JOB,evaluateMenu,type CounterName,type Facts,type StanceName} from './rules-table.ts';
import {viewStorage} from './storage.ts';
import {FuelRouteShortfall,travelTo} from './travel.ts';

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
  runChain?:typeof defaultRunChain;
  /** Where the chain record and the journal live. Without one the runner keeps the chain
   * in memory alone, which is what a restart loses (N22). */
  runtime?:string;
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
  const runner=options.runChain??defaultRunChain;
  const elapsed=(started:number)=>Math.round((Date.now()-started)/1000);
  // get_system answers `kind:'transit'` with no system while under way.
  const currentSystem=async()=>details(await command('spacemolt/get_system',{})).system as Record<string,any>|undefined;
  const stations=(system:Record<string,any>|undefined)=>(system?.pois??[]) as Record<string,any>[];
  const where=async()=>{
    await account.refresh();
    const {location,ship}=account.state;
    const system=await currentSystem();
    const rows=stations(system);
    const pois=rows.map(poi=>({id:poi.id,name:poi.name,type:poi.type}));
    // A station's base id is not the id of the POI it sits at: name the base itself.
    const base=rows.find(poi=>poi.base_id===location?.docked_at);
    return {
      system:{id:location?.system_id,name:system?.name},
      poi:{id:location?.poi_id,name:pois.find(poi=>poi.id===location?.poi_id)?.name},
      docked_at:location?.docked_at?{base_id:location.docked_at,name:base?.base_name??null}:null,
      in_transit:Boolean(location?.in_transit),
      ...(location?.in_transit?{destination:{system:location.transit_dest_system_id,poi:location.transit_dest_poi_id}}:{}),
      fuel:ship?.fuel,max_fuel:ship?.max_fuel,hull:ship?.hull,max_hull:ship?.max_hull,
      pois,
      // The systems a jump reaches from here, so a destination elsewhere is nameable.
      connections:(system?.connections??[]) as Record<string,any>[],
    };
  };
  const travel=async(poiId:string)=>{
    if(!poiId)throw new Error('travel requires a poi_id');
    await account.refresh();
    if(!account.state.location?.system_id)throw new Error('Current system is unknown; observe before travelling');
    const started=Date.now();
    // The destination names a POI; the server says which system holds it, so a POI in another
    // system is a route with jumps rather than a refusal.
    const route=details(await command('spacemolt/find_route',{id:poiId}));
    if(!route.found)return {arrived:false,reason:String(route.message??`No route to ${poiId}`),elapsed_s:elapsed(started)};
    try {
      // maxJumps null: the mood's fuel reserve bounds the trip, not a jump count.
      const {location}=await travelTo(account,command,{system_id:String(route.target_system),poi_id:poiId},
        {mood:'Cautious',maxJumps:null});
      return {arrived:true,location:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null},
        fuel:account.state.ship?.fuel,elapsed_s:elapsed(started)};
    } catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      if(error instanceof FuelRouteShortfall) {
        const {actualFuel,requiredFuel,shortfall}=error.evidence;
        return {arrived:false,reason,fuel:actualFuel,required_fuel:requiredFuel,shortfall,elapsed_s:elapsed(started)};
      }
      return {arrived:false,reason,elapsed_s:elapsed(started)};
    }
  };
  /** Where the trip starts and ends, resolved from live state so the model names only a site. */
  const gatherPlan=async(params:Record<string,unknown>):Promise<GatherPlan>=>{
    const sitePoi=String(params.poi_id??'');
    if(!sitePoi)throw new Error('gather requires a poi_id: the mining site to work');
    await account.refresh();
    // The server says which system holds each end of the trip. Home is where the ore is
    // stowed, not a limit on where it is mined: a site one jump out is a route, not a refusal.
    const route=async(id:string)=>{
      const answer=details(await command('spacemolt/find_route',{id}));
      if(!answer.found)throw new Error(String(answer.message??`No route to ${id}`));
      return answer;
    };
    const site=await route(sitePoi);
    const homeBase=String(params.base_id??account.state.location?.docked_at??pilot().home??'');
    if(!homeBase)throw new Error('gather needs a base_id to stow at: pass one or set a home');
    const home=await route(homeBase);
    // The hold the pilot already has is its own — cabins, fitted spares — and the plan says
    // so, because a job resumed after a restart never saw the departure that proved it.
    return {home:{system_id:String(home.target_system),poi_id:String(home.target_poi),base_id:homeBase},
      site:{system_id:String(site.target_system),poi_id:sitePoi},mood:pilot().mood??'Cautious',
      keep:Array.isArray(params.keep)?params.keep.map(String):Object.keys(miningInventory(account.state))};
  };
  /** One trip out and back: the job owns the steps, this reports the one outcome. */
  const gather=async(params:Record<string,unknown>)=>{
    const plan=await gatherPlan(params);
    const started=Date.now();
    try {
      const result=await gatherJob(account,command,plan);
      return {outcome:result.outcome,steps:result.steps,yield:result.yield,
        sold:result.settled?.sold??[],held:result.settled?.held??[],
        credits:account.state.player?.credits,fuel:account.state.ship?.fuel,
        elapsed_s:elapsed(started),...result.reason===undefined?{}:{reason:result.reason}};
    } catch(error) {
      return {outcome:'failed',reason:error instanceof Error?error.message:String(error),
        elapsed_s:elapsed(started)};
    }
  };
  const dock=async(baseId?:string)=>{
    try {
      const {docked_at,already_docked}=await dockAt(account,command,baseId);
      return {docked:true,docked_at,already_docked};
    } catch(error){return {docked:false,reason:error instanceof Error?error.message:String(error)};}
  };
  /** The facts the rules table reads, assembled from live state and the pilot record.
   * Board, threats and obligations stay empty until reads for them exist; the menu's own
   * refusals then say what is missing, which is the honest answer. */
  const factsNow=async(who:Pilot):Promise<Facts>=>{
    if(!who.mood)throw new Error('The pilot record names no mood; the runner sets stance and mood at rest');
    await account.refresh();
    const {location,ship,player}=account.state;
    const rows=stations(await currentSystem());
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

  // One chain at a time: the runner's own work, which outlives the conversation that asked
  // for it (N5) and, written down, the runner process too (N22). `running` is the chain in
  // flight; `last` is what the next juncture reads, from memory or from the record on disk.
  const runtime=options.runtime;
  const stored=()=>runtime?readChain(runtime):null;
  let running:{chain_id:string}|null=null,record:ChainRecord|undefined,last:Record<string,unknown>|null=null;
  // Chain ids stay unique across restarts: a resumed chain-1 must not be followed by another.
  let counter=Number(stored()?.chain_id?.split('-')[1])||0;
  const progress=()=>({kind:record?.kind,length:record?.length,position:record?.position,ended:record?.ended});
  const busy=()=>({chain_id:running!.chain_id,record:progress()});
  /** Every progress callback, so a runner that dies between two jobs is found mid-chain. */
  const remember=(chain_id:string,step:ChainRecord)=>{
    record=step;
    if(runtime)writeChain(runtime,{...step,chain_id});
  };
  /** The chain ended: the record closes, the journal gets its one line, `last` is set. */
  const conclude=(chain_id:string,outcome:Record<string,unknown>)=>{
    last={chain_id,...outcome};
    if(runtime) {
      writeChain(runtime,{kind:record?.kind??'once',jobs:record?.jobs??[],length:record?.length??0,
        position:record?.position??0,ended:true,chain_id,outcome});
      // A move the world made gets its own line: a reader of the journal should find it
      // without digging it out of a chain outcome (S45, C13).
      if(outcome.moved)journalChain(runtime,{chain_id,...outcome.moved as Record<string,unknown>},'unsolicited_move');
      journalChain(runtime,{chain_id,...outcome});
    }
    running=null;
  };
  /** What the next juncture reads: this runner's own chain, or the one before it left. */
  const lastOutcome=()=>{
    if(last)return last;
    const kept=stored();
    return kept?.outcome?{chain_id:kept.chain_id,...kept.outcome}:null;
  };
  const watch=(chain_id:string,inFlight:Promise<Awaited<ReturnType<typeof defaultRunChain>>>)=>{
    void inFlight.then(
      outcome=>conclude(chain_id,{outcome:outcome.outcome,juncture:outcome.juncture,jobs:outcome.jobs,
        ...outcome.moved?{moved:outcome.moved}:{}}),
      error=>conclude(chain_id,{outcome:'failed',
        juncture:{reason:error instanceof Error?error.message:String(error)}}),
    );
  };

  const chainFrom=async(params:Record<string,unknown>):Promise<Chain>=>{
    const name=String(params.job??'gather');
    if(name!=='gather')throw new Error(`Unknown job: ${name}. This runner knows: gather`);
    const jobs=[{job:'gather' as const,params:await gatherPlan(params)}];
    const repeat=params.repeat===undefined?1:Number(params.repeat);
    if(!Number.isInteger(repeat)||repeat<1)throw new Error('repeat must be a whole number of jobs, at least one');
    return repeat===1?{kind:'once',jobs}:{kind:'loop',jobs,length:repeat};
  };
  /** Start a chain and come straight back: the conversation ends, the chain does not. */
  const startJob=async(params:Record<string,unknown>)=>{
    if(running)return {accepted:false,reason:'a chain is already running; the runner raises the juncture when it ends',...busy()};
    const chain=await chainFrom(params);
    const chain_id=`chain-${++counter}`;
    record=undefined;
    // runChain reports the record before its first await, so a chain that started has one.
    const inFlight=runner(account,command,chain,{onProgress:step=>remember(chain_id,step)});
    if(!record)await inFlight; // it never started: surface the refusal to the caller
    running={chain_id};
    watch(chain_id,inFlight);
    return {accepted:true,chain_id,record:progress()};
  };
  /** What the runner does about the work it was doing when it died (N22).
   *
   * Not a re-run: the job that was in flight resumes from the step the live world implies,
   * so nothing whose effect is already visible is sent again, and a world that matches no
   * step of it ends the chain blocked with the definition kept for the next juncture. */
  const resume=async()=>{
    const kept=stored();
    if(!kept||kept.ended)return {resumed:false,last:lastOutcome()};
    if(running)return {resumed:false,reason:'a chain is already running',...busy()};
    const {chain_id,kind,jobs,length,position}=kept;
    running={chain_id};
    record={kind,jobs,length,position,ended:false};
    // A chain killed after its last job still resumes into it: every step's end state
    // already holds, so it closes done without sending anything.
    const resumeAt=Math.min(Math.max(position,0),length-1);
    watch(chain_id,runner(account,command,{kind,jobs,...kind==='loop'?{length}:{}} as Chain,
      {onProgress:step=>remember(chain_id,step),resumeAt}));
    return {resumed:true,chain_id,record:progress()};
  };
  const menu=async()=>{
    if(running)return {busy:true,...busy()};
    const who=pilot();
    // No stance is no shift: what a resting pilot is consulted about is not a menu of work
    // but the reflection the next shift is chosen from (N7). A running chain still wins:
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
      reason:'a chain is running; rest at the juncture the runner raises when it ends',...busy()};
    const who=pilot();
    const facts=await factsNow(who);
    const verdict=evaluateMenu(facts).find(row=>row.job===REST_JOB);
    if(!verdict?.admissible)
      return {rested:false,reason:verdict?.reason??'rest is not admissible here'};
    if(!options.setPilot)return {rested:false,reason:'this runner cannot write the pilot record'};
    const {stance,mood,goal,...kept}=who;
    options.setPilot(kept);
    const cleared={home:facts.place.base_id,...stance?{stance}:{},...mood?{mood}:{},...goal?{goal}:{}};
    if(runtime)journalChain(runtime,cleared,'rest');
    return {rested:true,shift_ended:true,at_rest:true,cleared,
      serviced:facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull};
  };
  /** What a resting pilot reflects on. Read-only: it chooses nothing and writes nothing. */
  const reflect=async()=>reflectReport(account,command,pilot(),runtime);

  // Later capabilities (service, more jobs) slot in here; the transport never changes.
  const actions:Record<string,(params:Record<string,unknown>)=>Promise<unknown>>={
    where,
    rest,
    reflect,
    travel:params=>travel(String(params.poi_id??'')),
    dock:params=>dock(params.base_id===undefined?undefined:String(params.base_id)),
    gather,
    storage:params=>viewStorage(command,params.station_id===undefined?undefined:String(params.station_id)),
    menu,
    job:startJob,
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
  const account=new Account({url:'wss://game.spacemolt.com/ws/v2',reconnect:true,credentials});
  // Stdin EOF, SIGTERM and SIGINT all say the same thing: the gateway that owns this bridge is
  // gone. A chain in flight is abandoned rather than awaited — its last progress record is
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
