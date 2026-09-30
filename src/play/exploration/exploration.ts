/** Exploration trains only by the first visit to a system, and circuit missions ("visit four
 * stations", 10,000–20,000 cr) stack under any cargo. Scouting is knowledge, which is the
 * first word of the objective.
 *
 * The map walk lives here and is shared: `candidates` (trading/scout.ts) walks it for books, the
 * menu for unvisited systems and the neighbours the juncture names, `exploreNearby` to pick its hops. */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {MapSystemInfo} from '@spacemolt/lib';
import type {ReadinessCommand} from '../../readiness.ts';
import {details} from '../../response-details.ts';
import {sightingTicksOld} from '../../sighting-memory.ts';
import {scout} from '../orient.ts';
import {acct,admit,checkStop,command,job,pilot,runtimeDir,step} from '../runtime.ts';
import {goTo} from '../travel.ts';
import type {Outcome} from '../types.ts';

/** What this runtime saw standing in a system: its police level and security status (`get_system`
 * answers them only from inside, and `get_map` carries neither), the pirates `get_nearby` counted
 * at the arrival point, and when. Kept in `systems.json`, one row per system, the newest look wins. */
export interface SystemSeen {police?:number;security?:string;pirates?:number;at:string}
const SEEN='systems.json';
export function readSeen(dir:string|undefined):Record<string,SystemSeen> {
  if(!dir)return {};
  try {const rows=JSON.parse(readFileSync(join(dir,SEEN),'utf8'));return rows&&typeof rows==='object'?rows:{};}
  catch {return {};}
}
/** Temp file then rename, as `places.json` is written. */
export function markSeen(dir:string,system_id:string,row:SystemSeen):void {
  try {
    mkdirSync(dir,{recursive:true});
    const path=join(dir,SEEN),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify({...readSeen(dir),[system_id]:row},null,2),{mode:0o600});
    renameSync(temp,path);
  } catch {/* unkept: seen again next visit */}
}

/** One system as the walk reaches it: the map's own facts, and what this runtime saw there. */
export interface Near {system_id:string;name:string;jumps:number;visited:boolean;empire?:string;
  stronghold?:boolean;online?:number;seen?:SystemSeen}

/** The whole galaxy, one read: every system with its links and whether you have been there. */
export async function readMap(send:ReadinessCommand):Promise<MapSystemInfo[]> {
  return (details(await send('spacemolt/get_map',{})) as {systems?:MapSystemInfo[]}).systems??[];
}
/** Jumps from `here` to every system within `max`, one breadth-first walk over the map's links. */
export function jumpsFrom(map:MapSystemInfo[],here:string,max=Infinity):Map<string,number> {
  const links=new Map(map.map(row=>[row.system_id,row.connections??[]]));
  const dist=new Map([[here,0]]);
  let frontier=[here];
  for(let n=1;n<=max&&frontier.length;n++)frontier=frontier.flatMap(system=>links.get(system)??[]).filter(system=>!dist.has(system)&&!!dist.set(system,n));
  return dist;
}
/** Every other system within `max` jumps, nearest first, with the facts the map and memory hold. */
export function around(map:MapSystemInfo[],here:string,max=Infinity,seen:Record<string,SystemSeen>={}):Near[] {
  const dist=jumpsFrom(map,here,max);
  return map.filter(row=>row.system_id!==here&&dist.has(row.system_id)).map(row=>({system_id:row.system_id,name:row.name??row.system_id,
    jumps:dist.get(row.system_id)!,visited:!!row.visited,...row.empire?{empire:row.empire}:{},...row.is_stronghold?{stronghold:true}:{},
    ...row.online?{online:row.online}:{},...seen[row.system_id]?{seen:seen[row.system_id]}:{}}))
    .sort((a,b)=>a.jumps-b.jumps||a.system_id.localeCompare(b.system_id));
}
/** A system's facts as one clause, for the pilot to weigh: nothing here judges safe or unsafe.
 * The map publishes no police level, so for a system never stood in the empire is the only law
 * there is to name; police and pirates appear once this runtime has seen them.
 * ponytail: the faction intel map (`query_intel`, read by `candidates`) carries `police_level` for
 * systems never stood in; fold it into `seen` when a pilot's faction has mapped its region. */
export function nearFacts(row:Near,now=Date.now()):string {
  const seen=row.seen;
  return [`${row.jumps} jump${row.jumps===1?'':'s'}`,row.visited?'visited':'never visited',
    row.empire?`empire ${row.empire}`:'no empire listed',...row.stronghold?['a stronghold']:[],...row.online?[`${row.online} online`]:[],
    ...seen?[`${[...seen.police!==undefined?[`police ${seen.police}`]:[],...seen.security?[seen.security]:[],
      ...seen.pirates!==undefined?[`${seen.pirates} pirate(s) at arrival`]:[]].join(', ')} seen ${sightingTicksOld(seen.at,now)}t ago`]:[]].join(', ');
}

export interface Explored {
  /** Each system flown to, in order, with what `scout()` read on arrival. */
  visited:{system_id:string;name:string;jumps:number;police?:number;security?:string;pirates?:number;
    stations:string[];belts:string[];pois:number;survey?:string}[];
  /** Unvisited systems still within `jumps` after the last hop, nearest first. */
  unvisited:Near[];
  ended:'done'|'none'|'refused'|'tired';
}

/** Visit up to `systems` (default 2) unvisited systems, each the nearest one left within `jumps`
 * (default 3) of where the ship now is, and `scout()` each on arrival: its stations, belts, police
 * level and security status, and the pirates at the arrival point, all in `detail.visited` and kept
 * in `systems.json` for the menu to name later. `survey:true` also sends `survey_system` in each
 * (scanning XP, hidden POIs). `avoid` is a list of system ids you will not go to or through: a
 * target whose route crosses one is skipped. Nothing else is skipped — the danger is yours to judge
 * from the facts, and the menu names them. Flies with `goTo`, so a hop the tank cannot cover is
 * refused and ends the circuit, and a hop that leaves you Tired ends it there. Does not come home:
 * `goTo` your base after. Trains exploration (first visits), navigation, piloting. */
export function exploreNearby(opts:{systems?:number;jumps?:number;survey?:boolean;avoid?:string[]}={}):Promise<Outcome<Explored>> {
  const count=opts.systems??2,jumps=opts.jumps??3,avoid=new Set(opts.avoid??[]);
  return job<Explored>('exploreNearby',`${count} within ${jumps} jumps`,async()=>{
    const detail:Explored={visited:[],unvisited:[],ended:'done'},short:string[]=[];
    const blocked=await admit('exploreNearby');
    if(blocked)return {status:'refused',did:'explored nothing',why:blocked,detail};
    const map=await readMap(command),tried=new Set<string>();
    const left=()=>{
      const here=acct().state.location?.system_id;
      return here?around(map,here,jumps,readSeen(runtimeDir())).filter(row=>!row.visited&&!tried.has(row.system_id)&&!avoid.has(row.system_id)):[];
    };
    while(detail.visited.length<count) {
      checkStop();
      const next=left()[0];
      if(!next){if(!detail.visited.length)detail.ended='none';break;}
      tried.add(next.system_id);
      if(avoid.size) {
        const route=details(await command('spacemolt/find_route',{id:next.system_id})).route as {system_id:string}[]|undefined;
        const through=(route??[]).find(row=>avoid.has(row.system_id));
        if(through){step(`${next.system_id} skipped: the route crosses ${through.system_id}`);continue;}
      }
      const hop=await goTo(next.system_id);
      if(hop.status!=='done'&&acct().state.location?.system_id!==next.system_id) {
        short.push(`${next.system_id}: ${hop.why??hop.did}`);
        detail.ended='refused';break;
      }
      const seen=await scout();
      const sys=seen.detail.system as {id?:string;name:string;police_level?:number;security_status?:string};
      const pirates=seen.detail.here?.nearby.pirate_count;
      const row:SystemSeen={...sys.police_level!==undefined?{police:sys.police_level}:{},...sys.security_status?{security:sys.security_status}:{},
        ...pirates!==undefined?{pirates}:{},at:new Date().toISOString()};
      const dir=runtimeDir();
      if(dir)markSeen(dir,next.system_id,row);
      let survey:string|undefined;
      if(opts.survey) {
        try {survey=String(details(await command('spacemolt/survey_system',{})).message??'surveyed');}
        catch(error) {survey=`survey refused: ${error instanceof Error?error.message:String(error)}`;}
      }
      const pois=seen.detail.pois;
      detail.visited.push({system_id:next.system_id,name:sys.name??next.system_id,jumps:next.jumps,
        ...sys.police_level!==undefined?{police:sys.police_level}:{},...sys.security_status?{security:sys.security_status}:{},...pirates!==undefined?{pirates}:{},
        stations:pois.flatMap(poi=>poi.base_id?[poi.base_id]:[]),belts:pois.filter(poi=>/belt|field|cloud/.test(poi.type)).map(poi=>poi.id),
        pois:pois.length,...survey?{survey}:{}});
      if(pilot().mood==='Tired'){detail.ended='tired';break;}
    }
    detail.unvisited=left();
    const did=(detail.visited.length?`visited ${detail.visited.map(row=>`${row.name} (${row.system_id}: ${row.pois} POIs, ${row.stations.length} station(s)`
      +`${row.police!==undefined?`, police ${row.police}`:''}${row.security?`, ${row.security}`:''}${row.pirates?`, ${row.pirates} pirate(s) at arrival`:''})`).join('; ')}`
      :`visited nothing${detail.ended==='none'?`: no unvisited system within ${jumps} jumps${avoid.size?' outside avoid':''}`:''}`)
      +(detail.unvisited.length?`; ${detail.unvisited.length} more unvisited within ${jumps} jumps, nearest ${detail.unvisited[0]!.system_id}`:'');
    const status=short.length?(detail.visited.length?'partial':'refused'):'done';
    return {status,did,...short.length?{why:short.join('; ')}:{},detail,
      next:[...detail.ended==='tired'?['service() at the nearest base']:[],...detail.unvisited.length?['exploreNearby() again for the next ones']:[],
        ...detail.ended==='none'?[`exploreNearby({jumps:${jumps+2}}) to look further out`]:[]]};
  });
}
