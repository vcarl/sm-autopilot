/** Getting somewhere and docking. One function; the id decides what it does. */
import type {ActiveMissionInfo,CompleteMissionResponse,FindRouteResponse,RouteStep,SystemPoi,V2Location} from '@spacemolt/lib';
import {dockAt} from '../dock.ts';
import {resolveFuelReserve} from '../mood-policy.ts';
import {details} from '../response-details.ts';
import {serviceShip} from '../servicing.ts';
import {FuelRouteShortfall,TiredStop,TravelBlocked,travelTo} from '../travel.ts';
import {active} from './missions.ts';
import {acct,checkStop,command,job,pilot,step} from './runtime.ts';
import type {Outcome} from './types.ts';

/** How far off the direct route one distress call may sit, in jumps. ponytail: tunable. */
const DETOUR_JUMPS=1;
/** The share of the route's own length all detours together may add. ponytail: tunable. */
const DETOUR_SHARE=0.25;

export interface Trip {
  /** The quote the trip was admitted on: `target_system`, `target_poi`, `estimated_fuel`,
   * `total_jumps`. A base id resolves to its POI here, which is the arrival check. */
  route:FindRouteResponse;
  /** Where the ship is now (`GameState['location']`). */
  location:V2Location;
  jumps:number;
  /** True when the trip ended docked at the base the id named. */
  docked:boolean;
}

/** A place the pilot can name: a system, a POI, or a base docked at one. */
export interface Place {id:string;name:string;what:'system'|'POI'|'base'}
/** Ids and display names compared the way a pilot writes them: `Last Light` and
 * `last_light` are the same word, `lastlight_station` starts with it. */
const key=(text:string):string=>text.toLowerCase().replace(/[^a-z0-9]+/g,'');
/** The words in an id or a name, so `sirius_station` and `sirius_observatory_station` are
 * visibly about the same place even though neither is a prefix of the other. */
const words=(text:string):string[]=>text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** How `find_route` says an id names nothing. Anything else it throws is a real failure. */
const NOT_A_PLACE=/not found|unknown destination|no such/i;

/** Everything a word can be matched against once `find_route` has said no: the systems on
 * the map, and the POIs and the bases docked at them in the system the ship is in. Reads
 * only, and a read that fails is no suggestions — never a failed trip. */
async function nameable():Promise<Place[]> {
  const places:Place[]=[];
  try {
    const map=details(await command('spacemolt/get_map',{})) as {systems?:{system_id:string;name?:string}[]};
    for(const row of map.systems??[])places.push({id:row.system_id,name:row.name??row.system_id,what:'system'});
  } catch {/* no map is no suggestions */}
  try {
    const here=(details(await command('spacemolt/get_system',{})) as {system?:{pois?:SystemPoi[]}}).system;
    for(const poi of here?.pois??[]) {
      places.push({id:poi.id,name:poi.name??poi.id,what:'POI'});
      if(poi.base_id)places.push({id:poi.base_id,name:poi.base_name??poi.base_id,what:'base'});
    }
  } catch {/* ditto */}
  return places;
}

/** The system a guess names and the bases known to be in it: `node_alpha_station` names Node
 * Alpha, whatever word the pilot suffixed it with. Exactly one base there is what the guess
 * can only have meant, and `destination` flies to it; several (or none) keep the refusal, with
 * the bases named in it so the next script writes an id instead of another guess.
 *
 * `where` is the system the bases in `places` were listed from; a guess naming any other
 * system answers nothing. ponytail: that is the system the ship is in, because `get_map`
 * lists no POIs for a far one (see `scout`, orient.ts). Widen it when a read exists that
 * lists a far system's bases. */
export function systemBases(id:string,places:Place[],where?:string):{system:Place;bases:Place[]}|undefined {
  const want=key(id),asked=new Set(words(id));
  const system=places.find(place=>place.what==='system'&&place.id===where
    &&([key(place.id),key(place.name)].some(k=>k.length>=3&&want.startsWith(k))
      ||words(place.id).every(word=>asked.has(word))));
  return system?{system,bases:places.filter(place=>place.what==='base')}:undefined;
}

/** Where a nameable id lives, as the server answers it, and the id it turned out to be. A
 * base id answers with the POI it sits at (`target_poi`), which is what the arrival check
 * must wait for (report 01, fix 1).
 *
 * The server classifies a word it does not know as a system, so its "Target system not
 * found" says nothing about what was actually named. When it says that, the word is matched
 * against the systems on the map and the POIs and bases here: an exact match on an id or a
 * display name is what the pilot meant (names are what prose gives them), and the near
 * misses go in the refusal so the next script can correct itself. */
export async function destination(id:string):Promise<{id:string;quote:FindRouteResponse}> {
  // The live server answers an id it cannot place with an error, not a `found:false` body,
  // so "no such place" arrives as a throw. Only that one is swallowed — a disconnect, a
  // rate limit or anything else is a failed trip, not a spelling suggestion.
  const ask=async(target:string)=>{
    try {return details(await command('spacemolt/find_route',{id:target})) as FindRouteResponse;}
    catch(error) {
      if(!NOT_A_PLACE.test((error as Error).message??''))throw error;
      return {found:false} as FindRouteResponse;
    }
  };
  const first=await ask(id);
  if(first.found)return {id,quote:first};
  const places=await nameable();
  const want=key(id);
  const hit=places.find(place=>place.id!==id&&(key(place.id)===want||key(place.name)===want));
  if(hit) {
    const second=await ask(hit.id);
    if(second.found)return {id:hit.id,quote:second};
  }
  // "The station in Node Alpha" is one place when the system has one base: go there and say
  // so, rather than refusing a guess whose intent has only one reading.
  const named=systemBases(id,places,acct().state.location?.system_id);
  const one=named?.bases.length===1?named.bases[0]!:undefined;
  if(one) {
    const third=await ask(one.id);
    if(third.found) {
      step(`${id} is not a place; going to ${one.id}, the one base in ${named!.system.name}`);
      return {id:one.id,quote:third};
    }
  }
  // ponytail: shared words, plus a prefix either way — not an edit distance. A guess built
  // out of the right words (`sirius_station` for `sirius_observatory_station`) and one built
  // by suffixing a system name (`lastlight_station` for `last_light`) both land; a typo
  // inside a word lands nowhere. Reach for a distance only when that shows up in the journal.
  const asked=new Set(words(id));
  const score=(place:Place):number=>{
    const shared=[...new Set([...words(place.id),...words(place.name)])].filter(word=>asked.has(word)).length;
    const prefix=[key(place.id),key(place.name)].some(k=>k!==want&&k.length>=3&&(k.startsWith(want)||want.startsWith(k)));
    return shared+(prefix?1:0);
  };
  const near=places.map(place=>({place,score:score(place)})).filter(row=>row.score>0)
    .sort((a,b)=>b.score-a.score).map(row=>row.place);
  // A guess that named a system with more than one base: which ones, by id, because "the
  // station there" is exactly what could not be picked for it.
  const several=named&&named.bases.length!==1
    ?`; ${named.system.name} has ${named.bases.length} base(s)${named.bases.length?`: ${named.bases.map(p=>`${p.id} (${p.name})`).join(', ')}`:''}`:'';
  throw new TravelBlocked(`no system, POI or base is named ${id}${several}`
    +(near.length?`; nearest: ${near.slice(0,4).map(p=>`${p.id} (${p.what} ${p.name})`).join(', ')}`
      :several?'':'; scout() lists the POIs and bases here, orient() the systems you know'));
}

/** The quote alone, for callers that only want the fuel and jumps. */
export async function route(id:string):Promise<FindRouteResponse> {return (await destination(id)).quote;}

/** Whether `id` is a base sitting at `poiId` in `systemId`, per that system's own POI rows
 * (`base_id` on the row) — the only way to tell a base from its POI when a base's id is the
 * same as its POI's, as it is on the live server (report 02, fix 1). A ship not yet in that
 * system cannot ask; `isBase` below falls back to the route heuristic for that case, the same
 * reach limit `systemBases` above already lives with. */
async function baseAt(systemId:string,poiId:string,id:string):Promise<boolean> {
  if(acct().state.location?.system_id!==systemId)return false;
  const pois=(details(await command('spacemolt/get_system',{})).system?.pois??[]) as SystemPoi[];
  return pois.some(row=>row.id===poiId&&row.base_id===id);
}

/** The system an active distress mission wants visited, or undefined when it is not one to
 * fly to: a `visit_system` objective carries `system_id` and nothing else, and arriving is
 * what moves it to 1 of 1 — `complete_mission` then claims it. Community and expired ones
 * are left alone. */
function distressTarget(mission:ActiveMissionInfo):string|undefined {
  if(mission.community||mission.expires_in_ticks<=0)return undefined;
  if(!/distress/i.test(`${mission.type} ${mission.title}`))return undefined;
  return (mission.objectives??[]).find(o=>!o.completed&&o.system_id)?.system_id;
}

/** A distress call this trip passes near enough to answer, and what including it costs. */
export interface Stop {id:string;title:string;system:string;extra:number;at:number}
/** Which distress calls the quoted route can answer on the way, given a `find_route` leg for
 * each candidate system that is not already on it. Pure, so the budget is testable. */
export function distressPlan(quote:Pick<FindRouteResponse,'route'|'total_jumps'|'estimated_fuel'|'fuel_per_jump'|'fuel_available'>,
  missions:ActiveMissionInfo[],legs:Map<string,{route?:RouteStep[];total_jumps:number}>,noGo:string[],reserve:number):Stop[] {
  const onRoute=new Set((quote.route??[]).map(s=>s.system_id));
  let budget=quote.total_jumps*DETOUR_SHARE;
  const stops:Stop[]=[];
  for(const mission of missions) {
    const system=distressTarget(mission);
    if(!system||noGo.includes(system))continue;
    const row={id:mission.mission_id,title:mission.title,system};
    if(onRoute.has(system)) {
      stops.push({...row,extra:0,at:Math.max(0,(quote.route??[]).findIndex(s=>s.system_id===system))});
      continue;
    }
    const leg=legs.get(system);
    if(!leg)continue;
    // ponytail: the detour is counted on the way out only — the hop back onto the route is
    // never re-quoted, so a dead end costs more than this says. Re-quote from the stop if it bites.
    const extra=(leg.route??[]).filter(s=>!onRoute.has(s.system_id)).length;
    if(extra>DETOUR_JUMPS||extra>budget)continue;
    budget-=extra;
    stops.push({...row,extra,at:leg.total_jumps});
  }
  stops.sort((a,b)=>a.at-b.at);
  // Each extra jump is paid twice, out and back. Drop the farthest stops until the tank
  // covers the whole trip plus the mood's reserve.
  let extra=stops.reduce((sum,s)=>sum+s.extra,0);
  while(stops.length&&quote.fuel_available<quote.estimated_fuel+extra*quote.fuel_per_jump*2+reserve)
    extra-=stops.pop()!.extra;
  return stops;
}

/** The plan above, with the active list and the one `find_route` per off-route candidate it
 * needs. Reads only; a read that fails is no stops, never a failed trip. */
async function distressStops(quote:FindRouteResponse,noGo:string[],reserve:number):Promise<Stop[]> {
  let mine;
  try {mine=await active();} catch {return [];}
  const onRoute=new Set((quote.route??[]).map(s=>s.system_id));
  const legs=new Map<string,{route?:RouteStep[];total_jumps:number}>();
  for(const mission of mine.active) {
    const system=distressTarget(mission);
    if(!system||onRoute.has(system)||legs.has(system)||noGo.includes(system))continue;
    try {legs.set(system,await route(system));} catch {/* no route there is no stop */}
  }
  return distressPlan(quote,mine.active,legs,noGo,reserve);
}

/** Fly to a POI, a base, or a system, jumping as many times as the route needs, and dock
 * when the target is a base. No argument means home (`pilot().home`); a run with no home
 * and no argument is refused.
 *
 * Over `find_route` + `jump`/`travel` + `dock` it adds: base ids resolved to their POI before
 * the arrival wait, the mood's fuel reserve, a refuel first when docked and short, no-go
 * systems refused, and one `partial` on stop instead of a wedged runner.
 *
 * On the way it answers active distress calls: a mission whose system is on the route, or at
 * most `DETOUR_JUMPS` off it while all detours together stay inside `DETOUR_SHARE` of the
 * route and the tank still covers the rest plus the reserve, is flown through and claimed
 * with `complete_mission`. It never accepts a mission, and never detours under Tired.
 *
 * Idempotent: already there (and docked, if a base) sends nothing and is `done`.
 * Tired: only a base is admitted (service there clears it); a POI or a system is `refused`. */
export function goTo(id?:string):Promise<Outcome<Trip>> {
  return job<Trip>('goTo',id??'home',async()=>{
    const who=pilot();
    const target=id??who.home;
    const none={route:{} as FindRouteResponse,location:acct().state.location as V2Location,jumps:0,docked:false};
    if(!target)return {status:'refused',did:'went nowhere',why:'no destination and no home set in pilot.json',detail:none};
    // What the pilot wrote may be an id or a display name; `named` is the id it turned out
    // to be, and every comparison below is made against that, never against the word.
    let quote:FindRouteResponse,named:string;
    try {({id:named,quote}=await destination(target));}
    catch(error){return {status:'refused',did:`could not route to ${target}`,why:(error as Error).message,detail:none};}
    const detail=():Trip=>({route:quote,location:acct().state.location as V2Location,jumps:0,docked:false});
    // A name was accepted; say which id it was, so the next script can write the id.
    if(named!==target)step(`${target} is ${named}`);
    if((who.permissions?.no_go??[]).includes(quote.target_system))
      return {status:'refused',did:`did not fly to ${target}`,why:`${quote.target_system} is in permissions.no_go`,detail:detail()};
    // A base id is what find_route resolved to a different POI; dock there on arrival. When
    // it resolved to the SAME id (a base id equal to its POI's, as on the live server) that
    // heuristic reads "not a base", so the system's own POI rows get the final say (fix 1).
    const isBase=quote.target_poi!==undefined&&
      (quote.target_poi!==named||await baseAt(quote.target_system,quote.target_poi,named));
    // A system id answers with a system and no POI of its own. Passing it on as a `poi_id`
    // is what the server rejects as "Unknown destination" after the jump was already flown
    // and paid for: a system is reached wherever in it the jump lands, so name no POI.
    const poi=quote.target_poi===undefined&&quote.target_system===named?undefined:quote.target_poi??named;
    if(who.mood==='Tired'&&!isBase)
      return {status:'refused',did:`did not fly to ${target}`,why:'Tired: only a base is admitted, to service there',detail:detail()};
    const {location}=acct().state;
    if(location?.system_id===quote.target_system&&(!poi||location.poi_id===poi)&&(!isBase||location.docked_at===named))
      return {status:'done',did:`already at ${target}${poi?'':` (${location.poi_id})`}`,detail:{...detail(),docked:Boolean(location.docked_at)}};
    const mood=who.mood??'Cautious';
    // Tired flies straight to the base it is being serviced at; nothing is answered on the way.
    const stops=mood==='Tired'?[]:await distressStops(quote,who.permissions?.no_go??[],resolveFuelReserve(mood));
    const planned=quote.total_jumps+stops.reduce((sum,s)=>sum+s.extra*2,0);
    step(`goTo ${poi??quote.target_system} ${planned?`${planned} jump(s)`:'same system'} ${quote.estimated_fuel} fuel quoted`
      +(stops.length?`, answering ${stops.length} distress call(s) at ${stops.map(s=>s.system).join(', ')}`:''));
    let jumps=0,hops=0;
    const answered:string[]=[];
    // `toBase` is the leg that ends where a Tired pilot is serviced. Tired is imposed between
    // any two commands, so every other leg refuses its next move as soon as the mood moves:
    // the route stops at the system the ship is sitting in, from where a base is still
    // admitted, rather than flying on to the end on the mood it departed under.
    const fly=(destination:{system_id:string;poi_id?:string},toBase=false)=>travelTo(acct(),command,destination,{
      mood,maxJumps:null,
      checkpoint:async()=>checkStop(),
      ...toBase?{}:{checkMove:()=>{
        if(pilot().mood==='Tired')throw new TiredStop('Tired: this leg is not going to a base; only a base is admitted from here');
      }},
      onJump:()=>{hops++;step(`jump ${hops} of ${planned}, fuel ${acct().state.ship?.fuel}`);},
      refuel:async()=>{try {await serviceShip(acct(),command,{mood,creditReserve:who.permissions?.credit_reserve??0});} catch {/* the fuel check after decides */}},
    });
    try {
      for(const stop of stops) {
        jumps+=(await fly({system_id:stop.system})).jumps;
        try {
          const paid=details(await command('spacemolt/complete_mission',{id:stop.id})) as CompleteMissionResponse;
          answered.push(`completed distress ${paid.title??stop.title} at ${stop.system} en route for ${paid.credits_earned??0} cr`);
          step(`completed distress ${stop.id} at ${stop.system} +${paid.credits_earned??0} cr`);
        } catch(error) {
          // Arriving is what the server counts; if it did not, the call is still active and
          // the trip carries on. It is left for the board, never abandoned here.
          step(`distress ${stop.title} at ${stop.system} not claimable: ${(error as Error).message}`);
        }
      }
      jumps+=(await fly({system_id:quote.target_system,...poi?{poi_id:poi}:{}},isBase)).jumps;
    } catch(error) {
      // The mood crossed mid-route. What was flown is flown, and the ship is sitting in a
      // system rather than in transit, so the next call can be the base this stop is for.
      // `hops`, not `jumps`: the leg that was interrupted never returned its own count, and a
      // trip that flew a jump and stopped is partial, not a trip that never left.
      if(error instanceof TiredStop)
        return {status:hops?'partial':'refused',
          did:hops?`stopped at ${acct().state.location?.system_id} short of ${target} after ${hops} jump(s)${answered.length?`; ${answered.join('; ')}`:''}`:`did not fly to ${target}`,
          why:error.message,detail:{...detail(),jumps:hops},
          next:['goTo a base and service there; this destination is not one']};
      if(error instanceof FuelRouteShortfall) {
        const {actualFuel,requiredFuel,shortfall}=error.evidence;
        // A detour already flown is work behind the refusal, so the trip is partial and the
        // `did` says where the ship actually is rather than claiming it never left.
        return {status:jumps?'partial':'refused',
          did:jumps?`stopped at ${acct().state.location?.system_id} short of ${target} after ${jumps} jump(s)${answered.length?`; ${answered.join('; ')}`:''}`:`did not fly to ${target}`,
          why:`fuel ${actualFuel}, need ${requiredFuel} with the ${who.mood} reserve; short ${shortfall}`,
          detail:{...detail(),jumps},next:['service() where you are docked, or a nearer destination']};
      }
      throw error;
    }
    let docked=false;
    // The dock is decided by the system's own listing, not the route heuristic: a system id
    // may also answer with a POI, and docking "at a system" would wedge here.
    if(poi&&await baseAt(quote.target_system,poi,named)){await dockAt(acct(),command,named);docked=true;step(`docked at ${named}`);}
    return {status:'done',did:`arrived at ${target}${poi?'':` (${acct().state.location?.poi_id})`}${docked?' and docked':''} after ${jumps} jump(s)`
      +(answered.length?`; ${answered.join('; ')}`:''),detail:{...detail(),jumps,docked}};
  });
}
