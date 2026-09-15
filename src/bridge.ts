/** Minimal SpaceMolt bridge: `where`, `travel` and `dock`, one JSON request per stdin line. */
import {Account} from '@spacemolt/lib';
import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {dockAt} from './dock.ts';
import {FuelRouteShortfall,travelTo} from './travel.ts';

export type Dispatch=(action:string,params?:Record<string,unknown>)=>Promise<unknown>;

/** Pure dispatch over an account + command pair, so tests never connect. */
export function serve(account:ReadinessAccount,command:ReadinessCommand):Dispatch {
  const where=async()=>{
    await account.refresh();
    const {location,ship}=account.state;
    // get_system answers `kind:'transit'` with no system while under way.
    const system=details(await command('spacemolt/get_system',{})).system;
    const pois=((system?.pois??[]) as Record<string,unknown>[]).map(poi=>({id:poi.id,name:poi.name,type:poi.type}));
    return {
      system:{id:location?.system_id,name:system?.name},
      poi:{id:location?.poi_id,name:pois.find(poi=>poi.id===location?.poi_id)?.name},
      docked_at:location?.docked_at??null,
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
    const elapsed=()=>Math.round((Date.now()-started)/1000);
    try {
      const {location}=await travelTo(account,command,{system_id:system,poi_id:poiId},{mood:'Cautious'});
      return {arrived:true,location:{system:location?.system_id,poi:location?.poi_id,docked_at:location?.docked_at??null},
        fuel:account.state.ship?.fuel,elapsed_s:elapsed()};
    } catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      if(error instanceof FuelRouteShortfall) {
        const {actualFuel,requiredFuel,shortfall}=error.evidence;
        return {arrived:false,reason,fuel:actualFuel,required_fuel:requiredFuel,shortfall,elapsed_s:elapsed()};
      }
      return {arrived:false,reason,elapsed_s:elapsed()};
    }
  };
  const dock=async(baseId?:string)=>{
    try {
      const {docked_at,already_docked}=await dockAt(account,command,baseId);
      return {docked:true,docked_at,already_docked};
    } catch(error){return {docked:false,reason:error instanceof Error?error.message:String(error)};}
  };
  // Later capabilities (service, jobs) slot in here; the transport never changes.
  const actions:Record<string,(params:Record<string,unknown>)=>Promise<unknown>>={
    where,
    travel:params=>travel(String(params.poi_id??'')),
    dock:params=>dock(params.base_id===undefined?undefined:String(params.base_id)),
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
    const dispatch=serve(account,command);
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
