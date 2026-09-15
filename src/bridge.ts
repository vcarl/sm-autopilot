/** Minimal SpaceMolt bridge: `where`, `travel` and `dock`, one JSON request per stdin line. */
import {Account} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {runChain as defaultRunChain,type Chain,type ChainRecord} from './chain.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {dockAt} from './dock.ts';
import {gatherJob,type GatherPlan} from './gather-job.ts';
import {buildMenu} from './menu.ts';
import type {Mood} from './mood-policy.ts';
import type {CounterName,Facts,StanceName} from './rules-table.ts';
import {FuelRouteShortfall,travelTo} from './travel.ts';

export type Dispatch=(action:string,params?:Record<string,unknown>)=>Promise<unknown>;

/** What the runner set at the last rest. The agent never writes any of it. */
export interface Pilot {name?:string;objective?:string;stance?:StanceName;mood?:Mood;home?:string;
  permissions?:Facts['permissions']}
export interface ServeOptions {pilot?:()=>Pilot;runChain?:typeof defaultRunChain}

/** The pilot record, or an empty one: a pilot with no record has no stance and no menu. */
export function readPilot(path:string):Pilot {
  if(!existsSync(path))return {};
  try {return JSON.parse(readFileSync(path,'utf8')) as Pilot;}
  catch(error){throw new Error(`Unreadable pilot record ${path}: ${error instanceof Error?error.message:String(error)}`);}
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
    };
  };
  const travel=async(poiId:string)=>{
    if(!poiId)throw new Error('travel requires a poi_id from the current system');
    await account.refresh();
    const system=account.state.location?.system_id;
    if(!system)throw new Error('Current system is unknown; observe before travelling');
    const started=Date.now();
    try {
      const {location}=await travelTo(account,command,{system_id:system,poi_id:poiId},{mood:'Cautious'});
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
    if(!sitePoi)throw new Error('gather requires a poi_id from the current system');
    await account.refresh();
    const system_id=account.state.location?.system_id;
    if(!system_id)throw new Error('Current system is unknown; observe before gathering');
    const homePoi=params.home_poi_id===undefined?'':String(params.home_poi_id);
    const homeBase=params.base_id===undefined?String(account.state.location?.docked_at??''):String(params.base_id);
    const station=stations(await currentSystem())
      .find(poi=>homePoi?poi.id===homePoi:Boolean(homeBase)&&poi.base_id===homeBase);
    if(!station?.base_id)throw new Error('gather requires a home station in this system; pass its base_id or home_poi_id');
    return {home:{system_id,poi_id:String(station.id),base_id:String(station.base_id)},
      site:{system_id,poi_id:sitePoi},mood:pilot().mood??'Cautious',
      keep:Array.isArray(params.keep)?params.keep.map(String):[]};
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
    let counters:CounterName[]=[],service_prices:{fuel?:number;hull?:number}|undefined;
    if(docked) {
      const base=details(await command('spacemolt/get_base',{}));
      const fuel=base.fuel_price_all_in,hull=base.base?.repair_price_per_hull;
      service_prices={...Number.isFinite(fuel)?{fuel}:{},...Number.isFinite(hull)?{hull}:{}};
      // ponytail: the one counter a base read proves. Per-counter discovery waits for the
      // counter reads (S38); until then an unproved counter is left off rather than guessed.
      if(service_prices.fuel!==undefined||service_prices.hull!==undefined)counters=['Services'];
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
  // for it (N5). `running` is the chain in flight; `last` is what the next juncture reads.
  let running:{chain_id:string}|null=null,record:ChainRecord|undefined,last:Record<string,unknown>|null=null,counter=0;
  const progress=()=>({kind:record?.kind,length:record?.length,position:record?.position,ended:record?.ended});
  const busy=()=>({chain_id:running!.chain_id,record:progress()});

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
    const inFlight=runner(account,command,chain,{onProgress:step=>{record=step;}});
    if(!record)await inFlight; // it never started: surface the refusal to the caller
    running={chain_id};
    void inFlight.then(
      outcome=>{last={chain_id,outcome:outcome.outcome,juncture:outcome.juncture,jobs:outcome.jobs};},
      error=>{last={chain_id,outcome:'failed',juncture:{reason:error instanceof Error?error.message:String(error)}};},
    ).finally(()=>{running=null;});
    return {accepted:true,chain_id,record:progress()};
  };
  const menu=async()=>{
    if(running)return {busy:true,...busy()};
    const who=pilot();
    const facts=await factsNow(who);
    const {location,ship,player}=account.state;
    return {
      ...who.stance?{stance:who.stance}:{},mood:facts.mood,
      ...who.objective?{objective:who.objective}:{},
      present:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null,
        in_transit:Boolean(location?.in_transit),fuel:ship?.fuel,max_fuel:ship?.max_fuel,
        hull:ship?.hull,max_hull:ship?.max_hull,
        cargo_free:facts.holdings.cargo_free,credits:player?.credits},
      ...buildMenu(facts),last,
    };
  };

  // Later capabilities (service, more jobs) slot in here; the transport never changes.
  const actions:Record<string,(params:Record<string,unknown>)=>Promise<unknown>>={
    where,
    travel:params=>travel(String(params.poi_id??'')),
    dock:params=>dock(params.base_id===undefined?undefined:String(params.base_id)),
    gather,
    menu,
    job:startJob,
    status:async()=>running?{running:true,...busy()}:{running:false,last},
  };
  return async(action,params={})=>{
    if(!Object.hasOwn(actions,action))throw new Error(`Unknown action: ${action}`);
    return actions[action]!(params);
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
  // A crash leaves the lock: an operator inspects the pilot before a new controller runs.
  const unlock=controllerLock(`${runtime}/controller-${createHash('sha256').update(username).digest('hex').slice(0,16)}.lock`);
  const account=new Account({url:'wss://game.spacemolt.com/ws/v2',reconnect:true,credentials});
  try {
    await account.connect();
    await account.authenticate(credentials());
    // The lib applies each result's state delta; travelTo re-reads authoritatively at every gate.
    const command:ReadinessCommand=(action,params)=>{
      const [tool,name]=action.split('/');
      return account.send(tool!,name!,params);
    };
    // The runner writes the pilot record beside the runtime directory; the agent never does.
    const pilotFile=resolve(runtime,'..','pilot.json');
    const dispatch=serve(account,command,{pilot:()=>readPilot(pilotFile)});
    console.log(JSON.stringify({event:'ready'}));
    for await(const line of createInterface({input:process.stdin,terminal:false})) {
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
  } finally {account.close();unlock();}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
