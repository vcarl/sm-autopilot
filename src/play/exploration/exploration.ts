/** Exploration trains only by the first visit to a system, and circuit missions ("visit four
 * stations", 10,000–20,000 cr) stack under any cargo. Scouting is knowledge, which is the
 * first word of the objective.
 *
 * The map walk lives here and is shared: `candidates` (trading/scout.ts) walks it for books, the
 * `exploreNearby` to pick its hops. */
import {readFileSync} from 'node:fs';
import type {FaintSignature,SurveyedPoi} from '@spacemolt/lib';
import {join} from 'node:path';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {sightingTicksOld} from '../../sighting-memory.ts';
import * as Wire from '../../wire.gen.ts';
import {Game,field,type GameError} from '../game.ts';
import {scoutEffect} from '../orient.ts';
import {keepJson} from '../places.ts';
import {Stopped,acct,admit,edge,jobEffect,pilot,reached,runtimeDir,step,stopped} from '../runtime.ts';
import {goToEffect} from '../travel.ts';
import type {Outcome} from '../types.ts';
import {replyBody} from '../../storage.ts';

/** What this runtime saw standing in a system: its police level and security status (`get_system`
 * answers them only from inside, and `get_map` carries neither), the pirates `get_nearby` counted
 * at the arrival point, and when. Kept in `systems.json`, one row per system, the newest look wins. */
const SystemSeen=Schema.Struct({police:Schema.optionalKey(Schema.Number),security:Schema.optionalKey(Schema.String),
  pirates:Schema.optionalKey(Schema.Number),at:Schema.String});
/** An interface, so the pilot-facing `Near.seen` keeps its name; its members are the schema's. */
export interface SystemSeen extends Schema.Schema.Type<typeof SystemSeen> {}
const SEEN='systems.json';
const decodeSeen=Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String,Schema.Unknown)));
const decodeRow=Schema.decodeUnknownOption(SystemSeen);
export function readSeen(dir:string|undefined):Record<string,SystemSeen> {
  if(!dir)return {};
  try {
    // A row that does not decode is dropped and the rest kept; a file that is no record reads as empty.
    const rows=decodeSeen(readFileSync(join(dir,SEEN),'utf8'));
    return Option.isSome(rows)?Object.fromEntries(Object.entries(rows.value).flatMap(([id,row])=>{const seen=decodeRow(row);return Option.isSome(seen)?[[id,seen.value]]:[];})):{};
  } catch {return {};} // edge: an absent or unreadable file is nothing seen
}
export function markSeen(dir:string,system_id:string,row:SystemSeen):void {
  keepJson(dir,SEEN,{...readSeen(dir),[system_id]:row});
}

/** One system as the walk reaches it: the map's own facts, and what this runtime saw there. */
export interface Near {system_id:string;name:string;jumps:number;visited:boolean;empire?:string;
  stronghold?:boolean;online?:number;seen?:SystemSeen}

/** What the walk reads of a map row: the spec's own fields, picked, with the spec's requiredness. */
const MapRow=Wire.MapSystemInfo.mapFields(Struct.pick(['system_id','name','connections','visited','empire','is_stronghold','online','poi_count']));
type MapRow=typeof MapRow.Type;
const decodeMapRow=Schema.decodeUnknownOption(MapRow);
/** The rows of a `get_map` reply that decode; a reply with no map, or a row that is not one, adds nothing. */
export const mapOf=(reply:unknown):MapRow[]=>{
  const systems=field(replyBody(reply),'systems');
  return Array.isArray(systems)?systems.flatMap(row=>{const decoded=decodeMapRow(row);return Option.isSome(decoded)?[decoded.value]:[];}):[];
};
/** Jumps from `here` to every system within `max`, one breadth-first walk over the map's links. */
export function jumpsFrom(map:readonly MapRow[],here:string,max=Infinity):Map<string,number> {
  const links=new Map(map.map(row=>[row.system_id,row.connections]));
  const dist=new Map([[here,0]]);
  let frontier=[here];
  for(let n=1;n<=max&&frontier.length;n++)frontier=frontier.flatMap(system=>links.get(system)??[]).filter(system=>!dist.has(system)&&!!dist.set(system,n));
  return dist;
}
/** Every other system within `max` jumps, nearest first, with the facts the map and memory hold. */
export function around(map:readonly MapRow[],here:string,max=Infinity,seen:Record<string,SystemSeen>={}):Near[] {
  const dist=jumpsFrom(map,here,max);
  return map.flatMap(row=>{
    const jumps=dist.get(row.system_id),seenHere=seen[row.system_id];
    if(row.system_id===here||jumps===undefined)return [];
    return [{system_id:row.system_id,name:row.name,
      jumps,visited:row.visited,...row.empire?{empire:row.empire}:{},...row.is_stronghold?{stronghold:true as const}:{},
      ...row.online?{online:row.online}:{},...seenHere?{seen:seenHere}:{}}];
  }).sort((a,b)=>a.jumps-b.jumps||a.system_id.localeCompare(b.system_id));
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
 * in `systems.json` for later reads. `survey:true` also sends `survey_system` in each
 * (scanning XP, hidden POIs). `avoid` is a list of system ids you will not go to or through: a
 * target whose route crosses one is skipped. Nothing else is skipped — the danger is yours to judge
 * from the facts. Flies with `goTo`, so a hop the tank cannot cover is
 * refused and ends the circuit, and a hop that leaves you Tired ends it there. Does not come home:
 * `goTo` your base after. Trains exploration (first visits), navigation, piloting. */
export function exploreNearby(opts:{systems?:number;jumps?:number;survey?:boolean;avoid?:string[]}={}):Promise<Outcome<Explored>> {
  return edge(exploreNearbyEffect(opts));
}

const decodeRoute=Schema.decodeUnknownOption(Wire.FindRouteResponse.mapFields(()=>({
  route:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.RouteStep.mapFields(Struct.pick(['system_id'])))))})));
/** A refusal or a lost reply as the pilot reads it: the action and the server's code, or that the reply is gone. */
const told=(error:GameError)=>error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`;

/** `exploreNearby` as an Effect, for `edge` and for converted callers; never in a barrel. A survey
 * the game refuses or loses is said in `survey` and the visit goes on; every other failure ends the flight. */
export const exploreNearbyEffect=(opts:{systems?:number;jumps?:number;survey?:boolean;avoid?:string[]}={})=>{
  const count=opts.systems??2,jumps=opts.jumps??3,avoid=new Set(opts.avoid??[]);
  return jobEffect('exploreNearby',`${count} within ${jumps} jumps`,Effect.gen(function*() {
    const game=yield* Game;
    const detail:Explored={visited:[],unvisited:[],ended:'done'},short:string[]=[];
    const blocked=yield* admit('exploreNearby');
    if(blocked)return {status:'refused' as const,did:'explored nothing',why:blocked,detail};
    const map=mapOf(yield* game.command('spacemolt/get_map',{})),tried=new Set<string>();
    // The map was read before the first hop, so a system flown to this run still reads unvisited.
    const left=(skip:Set<string>)=>{
      const here=acct().state.location?.system_id;
      return here?around(map,here,jumps,readSeen(runtimeDir())).filter(row=>!row.visited&&!skip.has(row.system_id)&&!avoid.has(row.system_id)):[];
    };
    while(detail.visited.length<count) {
      if(stopped())return yield* Effect.fail(new Stopped());
      const next=left(tried)[0];
      if(!next){if(!detail.visited.length)detail.ended='none';break;}
      tried.add(next.system_id);
      if(avoid.size) {
        const reply=yield* game.command('spacemolt/find_route',{id:next.system_id});
        // No decodable route is no route: nothing to avoid on it.
        const routed=decodeRoute(replyBody(reply));
        const through=(Option.isSome(routed)?routed.value.route??[]:[]).find(row=>avoid.has(row.system_id));
        if(through){step(`${next.system_id} skipped: the route crosses ${through.system_id}`);continue;}
      }
      const hop=yield* goToEffect(next.system_id);
      if(hop.status!=='done'&&acct().state.location?.system_id!==next.system_id) {
        short.push(`${next.system_id}: ${hop.why??hop.did}`);
        detail.ended='refused';break;
      }
      const scouted=yield* scoutEffect();
      // A scout that broke built no detail (`{}`): the system is named short, not read off nothing.
      const seen=reached(scouted);
      if(!seen){short.push(`${next.system_id}: scout ${scouted.status}: ${scouted.why??scouted.did}`);detail.ended='refused';break;}
      const sys=seen.system;
      const police=field(sys,'police_level'),security=field(sys,'security_status');
      const policeLevel=typeof police==='number'?police:undefined,securityStatus=typeof security==='string'&&security?security:undefined;
      const pirates=seen.here?.nearby.pirate_count;
      const row:SystemSeen={...policeLevel!==undefined?{police:policeLevel}:{},...securityStatus?{security:securityStatus}:{},
        ...pirates!==undefined?{pirates}:{},at:new Date().toISOString()};
      const dir=runtimeDir();
      if(dir)markSeen(dir,next.system_id,row);
      let survey:string|undefined;
      if(opts.survey) {
        const surveyed=yield* Effect.result(surveySystem);
        survey=Result.isFailure(surveyed)?`survey refused: ${told(surveyed.failure)}`:surveyed.success.message??'surveyed';
      }
      const pois=seen.pois;
      detail.visited.push({system_id:next.system_id,name:sys.name??next.system_id,jumps:next.jumps,
        ...policeLevel!==undefined?{police:policeLevel}:{},...securityStatus?{security:securityStatus}:{},...pirates!==undefined?{pirates}:{},
        stations:pois.flatMap(poi=>poi.base_id?[poi.base_id]:[]),belts:pois.filter(poi=>/belt|field|cloud/.test(poi.type)).map(poi=>poi.id),
        pois:pois.length,...survey?{survey}:{}});
      if(pilot().mood==='Tired'){detail.ended='tired';break;}
    }
    // What is left in range: a target skipped for its route or refused for fuel is still unvisited.
    detail.unvisited=left(new Set(detail.visited.map(row=>row.system_id)));
    const nearest=detail.unvisited[0];
    const did=(detail.visited.length?`visited ${detail.visited.map(row=>`${row.name} (${row.system_id}: ${row.pois} POIs, ${row.stations.length} station(s)`
      +`${row.police!==undefined?`, police ${row.police}`:''}${row.security?`, ${row.security}`:''}${row.pirates?`, ${row.pirates} pirate(s) at arrival`:''})`).join('; ')}`
      :`visited nothing${detail.ended==='none'?`: no unvisited system within ${jumps} jumps${avoid.size?' outside avoid':''}`:''}`)
      +(nearest?`; ${detail.unvisited.length} more unvisited within ${jumps} jumps, nearest ${nearest.system_id}`:'');
    const status=short.length?(detail.visited.length?'partial' as const:'refused' as const):'done' as const;
    return {status,did,...short.length?{why:short.join('; ')}:{},detail,
      next:[...detail.ended==='tired'?['service() at the nearest base']:[],...detail.unvisited.length?['exploreNearby() again for the next ones']:[],
        ...detail.ended==='none'?[`exploreNearby({jumps:${jumps+2}}) to look further out`]:[]]};
  }));
};

/** What one `survey_system` read of the system you are in: the hidden POIs it revealed now and those
 * already revealed to you, the faint signatures it could not resolve, and what your fit brought to it. */
export interface Surveyed {
  system_id?:string;
  /** Revealed by this survey. A wormhole is one of these with a wormhole `type`: `goTo` the POI, and
   * `get_poi` there names its destination, expiry and a prediction hint. `resources` lists a deposit's ores. */
  newly_revealed:SurveyedPoi[];
  /** Hidden POIs this system had already revealed to you: travel to them as to any POI. */
  already_revealed:SurveyedPoi[];
  /** Something is there that this survey's power did not resolve: `hint`, `type`, `difficulty`. */
  faint_signatures:FaintSignature[];
  /** The direction-hint an anomaly gives, when the survey heard one. */
  anomaly_hint?:string;
  /** What your fitted gear brought to the survey; the game publishes no table of it, so this is how you learn it. */
  survey_power?:number;
  xp_gained:Record<string,number>;
  message?:string;
}
/** A revealed row: the spec's scalars, and its deposits when they read. The live server leaves spec
 * fields out, so a row is kept on its id, name and type; one without them is no POI to name. */
const decodePoi=Schema.decodeUnknownOption(Wire.SurveyedPOI.mapFields(Struct.pick(['id','name','type','class','description'])));
const decodeResource=Schema.decodeUnknownOption(Wire.ResourceInfo_5);
const decodeSignature=Schema.decodeUnknownOption(Wire.FaintSignature_1);
const listOf=<T>(raw:unknown,read:(row:unknown)=>T|undefined):T[]=>Array.isArray(raw)?raw.flatMap(row=>{const got=read(row);return got===undefined?[]:[got];}):[];
const poiOf=(row:unknown):SurveyedPoi|undefined=>{
  const poi=decodePoi(row);
  if(Option.isNone(poi))return undefined;
  const resources=listOf(field(row,'resources'),raw=>Option.getOrUndefined(decodeResource(raw)));
  return {...poi.value,...resources.length?{resources:resources.map(r=>({...r}))}:{}};
};
/** `survey_system` sent once and read leniently. A refusal or a lost reply is the caller's: a survey
 * is a mutation, so a lost one is not re-sent (live 2026-09-28 12:19Z: "No response to mutation"
 * after 15 s, the one survey a pilot has sent). */
export const surveySystem=Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt/survey_system',{}));
  const text=(key:string)=>{const value=field(body,key);return typeof value==='string'&&value?value:undefined;};
  const power=field(body,'survey_power'),xp=field(body,'xp_gained'),system=text('system_id'),hint=text('anomaly_hint'),message=text('message');
  const surveyed:Surveyed={...system?{system_id:system}:{},
    newly_revealed:listOf(field(body,'newly_revealed'),poiOf),already_revealed:listOf(field(body,'already_revealed'),poiOf),
    faint_signatures:listOf(field(body,'faint_signatures'),row=>Option.getOrUndefined(decodeSignature(row))).map(row=>({...row})),
    ...hint?{anomaly_hint:hint}:{},...typeof power==='number'?{survey_power:power}:{},
    xp_gained:typeof xp==='object'&&xp!==null?Object.fromEntries(Object.entries(xp).filter((pair):pair is [string,number]=>typeof pair[1]==='number')):{},
    ...message?{message}:{}};
  return surveyed;
});

const poiNames=(rows:SurveyedPoi[])=>rows.map(row=>`${row.name} (${row.id}, ${row.type}${row.resources?.length?`: ${row.resources.map(r=>r.resource_id).join(', ')}`:''})`).join(', ');
/** `survey` as an Effect, for `edge`; never in a barrel. Every refusal, a lost reply included, is said
 * with an empty survey in `detail`, so a program reading `detail.newly_revealed` never meets a missing list. */
export const surveyEffect=()=>jobEffect<Surveyed>('survey','',Effect.gen(function*() {
  const got=yield* Effect.result(surveySystem);
  if(Result.isFailure(got)) {
    const lost=got.failure._tag==='ReplyLost';
    return {status:lost?'partial' as const:'refused' as const,did:lost?'sent a survey whose reply never came: what it revealed is unknown':'surveyed nothing',
      why:told(got.failure),detail:{newly_revealed:[],already_revealed:[],faint_signatures:[],xp_gained:{}},
      next:lost?["scout() lists this system's POIs, revealed ones included; survey() again re-reads them"]:[]};
  }
  const s=got.success;
  const where=s.system_id??acct().state.location?.system_id??'this system';
  const xp=Object.entries(s.xp_gained).map(([skill,n])=>`+${n} ${skill}`).join(', ');
  const did=`surveyed ${where}: ${s.newly_revealed.length?`revealed ${poiNames(s.newly_revealed)}`:'nothing new revealed'}`
    +(s.already_revealed.length?`; already revealed: ${poiNames(s.already_revealed)}`:'')
    +(s.faint_signatures.length?`; ${s.faint_signatures.length} faint signature(s): ${s.faint_signatures.map(f=>`${f.type}${f.difficulty?` (${f.difficulty})`:''} — ${f.hint}`).join('; ')}`:'')
    +`; survey power ${s.survey_power??'unreported'}, ${s.anomaly_hint?`anomaly hint: ${s.anomaly_hint}`:'no anomaly hint'}${xp?`; ${xp} xp`:''}`;
  const wormhole=[...s.newly_revealed,...s.already_revealed].find(row=>/wormhole/i.test(row.type));
  return {status:'done' as const,did,detail:s,
    next:wormhole?[`goTo('${wormhole.id}') reaches the wormhole; get_poi there names where it leads`]:[]};
}));
