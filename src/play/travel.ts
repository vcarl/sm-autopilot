/** Getting somewhere and docking. One function; the id decides what it does. */
import type {ActiveMissionInfo,FindRouteResponse,RouteStep,V2Location} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {resolveFuelReserve,type Mood} from '../mood-policy.ts';
import {serviceShipEffect} from '../servicing.ts';
import {replyBody} from '../storage.ts';
import {FuelRouteShortfall,InBattle,TravelBlocked,travelToEffect} from '../travel.ts';
import * as Wire from '../wire.gen.ts';
import {dockEffect,hereEffect,named as poiName,others} from './counter.ts';
import {Game,isGameError,type GameError} from './game.ts';
import {knownBooks} from './market.ts';
import {activeEffect} from './missions.ts';
import {readNames} from './places.ts';
import {tiredCheck} from './service.ts';
import {Stopped,acct,edge,jobEffect,pilot,runtimeDir,step,stopped} from './runtime.ts';
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
  /** True when the trip ended docked at the base the id named, or at the one base in the system it named. */
  docked:boolean;
  /** The base the ship is docked at when the trip ends, or null: `did` then says why not. */
  docked_at:string|null;
}

/** A place the pilot can name: a system, a POI, or a base docked at one. */
export interface Place {id:string;name:string;what:'system'|'POI'|'base'}
/** Ids and display names compared the way a pilot writes them: `Last Light` and
 * `last_light` are the same word, `lastlight_station` starts with it. */
const key=(text:string):string=>text.toLowerCase().replace(/[^a-z0-9]+/g,'');
/** The words in an id or a name, so `sirius_station` and `sirius_observatory_station` are
 * visibly about the same place even though neither is a prefix of the other. */
const words=(text:string):string[]=>text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** How `find_route` says an id names nothing. Anything else it says is a real failure. */
const NOT_A_PLACE=/not found|unknown destination|no such/i;

/** The name the pilot wrote is no place: a refusal of the trip, not a failure of it. */
export class NotAPlace extends TravelBlocked {readonly _tag='NotAPlace';}

/** A failure in its own fields' words, for a step line. */
const told=(error:GameError|Error):string=>isGameError(error)
  ?error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`:error.message;

// What the trip reads of each reply: the fields it uses, each optional because the live server omits spec fields.
const decodeQuote=Schema.decodeUnknownOption(Wire.FindRouteResponse.mapFields(fields=>({found:Schema.optionalKey(fields.found),
  target_system:Schema.optionalKey(fields.target_system),target_poi:fields.target_poi,total_jumps:Schema.optionalKey(fields.total_jumps),
  estimated_fuel:Schema.optionalKey(fields.estimated_fuel),fuel_per_jump:Schema.optionalKey(fields.fuel_per_jump),
  fuel_available:Schema.optionalKey(fields.fuel_available),
  route:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.RouteStep.mapFields(Struct.pick(['system_id'])))))})));
const decodeMap=Schema.decodeUnknownOption(Wire.GetMapResponse.mapFields(()=>({systems:Schema.Array(Wire.MapSystemInfo.mapFields(row=>({
  system_id:row.system_id,name:Schema.optionalKey(row.name)})))})));
const decodePois=Schema.decodeUnknownOption(Wire.GetSystemResponse.mapFields(fields=>({system:fields.system.mapFields(sys=>({
  pois:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ClientPOIInfo_2.mapFields(poi=>({id:poi.id,name:Schema.optionalKey(poi.name),
    base_id:poi.base_id,base_name:poi.base_name})))))}))})));
const decodeEarned=Schema.decodeUnknownOption(Wire.CompleteMissionResponse.mapFields(fields=>({title:Schema.optionalKey(fields.title),
  credits_earned:Schema.optionalKey(fields.credits_earned)})));
// The frozen surface promises the lib's types; the code reads only the fields decoded above.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asQuote=(body:unknown)=>body as FindRouteResponse; // cast: frozen surface (FindRouteResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asLocation=(state:unknown)=>state as V2Location; // cast: frozen surface (V2Location)

/** The POI rows of the system the ship is in. A reply that does not read is no rows, said in a step. */
const poisHere=()=>Effect.gen(function*() {
  const read=decodePois(replyBody(yield* (yield* Game).command('spacemolt/get_system',{})));
  if(Option.isSome(read))return read.value.system.pois??[];
  step('get_system: the reply did not read; no POIs');
  return [];
});

/** Everything a word can be matched against once `find_route` has said no: the systems on
 * the map, and the POIs and the bases docked at them in the system the ship is in. Reads
 * only, and a read that fails is no suggestions, said in a step — never a failed trip. */
const nameable=()=>Effect.gen(function*() {
  const places:Place[]=[];
  const map=yield* Effect.result((yield* Game).command('spacemolt/get_map',{}));
  if(Result.isFailure(map))step(`get_map: ${told(map.failure)}; no systems to suggest`);
  else {
    const read=decodeMap(replyBody(map.success));
    if(Option.isNone(read))step('get_map: the reply did not read; no systems to suggest');
    else for(const row of read.value.systems)places.push({id:row.system_id,name:row.name??row.system_id,what:'system'});
  }
  const pois=yield* Effect.result(poisHere());
  if(Result.isFailure(pois))step(`get_system: ${told(pois.failure)}; no POIs to suggest`);
  else for(const poi of pois.success) {
    places.push({id:poi.id,name:poi.name??poi.id,what:'POI'});
    if(poi.base_id)places.push({id:poi.base_id,name:poi.base_name??poi.base_id,what:'base'});
  }
  return places;
});

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
 * misses go in the refusal so the next script can correct itself. A name that is no place
 * fails with `NotAPlace`; any other refusal or a lost reply on `find_route` is its own tag. */
export const destinationEffect=(id:string)=>Effect.gen(function*() {
  // The live server answers an id it cannot place with an error, not a `found:false` body,
  // so "no such place" arrives as a refusal. Only that one is swallowed — a disconnect, a
  // rate limit or anything else is a failed trip, not a spelling suggestion.
  const ask=(target:string)=>Effect.gen(function*() {
    const sent=yield* Effect.result((yield* Game).command('spacemolt/find_route',{id:target}));
    if(Result.isFailure(sent)) {
      const error=sent.failure;
      if(error._tag==='ReplyLost'||!NOT_A_PLACE.test(error.message))return yield* error;
      return asQuote({found:false});
    }
    const body=replyBody(sent.success);
    if(Option.isSome(decodeQuote(body)))return asQuote(body);
    step(`find_route ${target}: the reply did not read; taken as no route`);
    return asQuote({found:false});
  });
  const first=yield* ask(id);
  if(first.found)return {id,quote:first};
  const local=yield* nameable();
  // The bases in the market memory are nameable from anywhere: the one read that knows a far
  // base's id. `Node Alpha Processing Station` lands on `node_alpha_processing_station` by the
  // same word match; an opaque id answers to the name kept for it (`names.json`), as does a POI
  // the pilot was shown named.
  const names=readNames(runtimeDir()),far=new Set(knownBooks().map(book=>book.base_id));
  const places=[...local,...[...new Set([...far,...Object.keys(names)])].filter(id=>!local.some(place=>place.id===id))
    .map(id=>({id,name:names[id]??id,what:far.has(id)?'base' as const:'POI' as const}))];
  const want=key(id);
  const hit=places.find(place=>place.id!==id&&(key(place.id)===want||key(place.name)===want));
  if(hit) {
    const second=yield* ask(hit.id);
    if(second.found)return {id:hit.id,quote:second};
  }
  // "The station in Node Alpha" is one place when the system has one base: go there and say
  // so, rather than refusing a guess whose intent has only one reading.
  const named=systemBases(id,local,acct().state.location?.system_id);
  const [one]=named?.bases.length===1?named.bases:[];
  if(named&&one) {
    const third=yield* ask(one.id);
    if(third.found) {
      step(`${id} is not a place; going to ${one.id}, the one base in ${named.system.name}`);
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
  return yield* Effect.fail(new NotAPlace(`no system, POI or base is named ${id}${several}`
    +(near.length?`; nearest: ${near.slice(0,4).map(p=>`${p.id} (${p.what} ${p.name})`).join(', ')}`
      :several?'':'; scout() lists the POIs and bases here, orient() the systems you know')));
});

/** The quote alone, for callers that only want the fuel and jumps. */
export const routeEffect=(id:string)=>destinationEffect(id).pipe(Effect.map(found=>found.quote));

/** Whether `id` is a base sitting at `poiId` in `systemId`, per that system's own POI rows
 * (`base_id` on the row) — the only way to tell a base from its POI when a base's id is the
 * same as its POI's, as it is on the live server (report 02, fix 1). A ship not yet in that
 * system cannot ask and this answers false, so it is asked only where the ship already is:
 * once on arrival, to decide the dock, and for the already-there check below. */
const baseAt=(systemId:string,poiId:string,id:string)=>Effect.gen(function*() {
  if(acct().state.location?.system_id!==systemId)return false;
  return (yield* poisHere()).some(row=>row.id===poiId&&row.base_id===id);
});

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
  missions:ActiveMissionInfo[],legs:Map<string,{route?:RouteStep[];total_jumps:number}>,reserve:number):Stop[] {
  const onRoute=new Set((quote.route??[]).map(s=>s.system_id));
  let budget=quote.total_jumps*DETOUR_SHARE;
  const stops:Stop[]=[];
  for(const mission of missions) {
    const system=distressTarget(mission);
    if(!system)continue;
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
  // Each extra jump is paid twice, out and back. Drop the farthest stops until the whole trip
  // ends above the mood's reserve. This is not travel admission (the trip itself needs only its
  // route): a detour is optional work, and one that would take the tank under the reserve is
  // work that makes the pilot Tired, so it is not taken.
  let extra=stops.reduce((sum,s)=>sum+s.extra,0);
  while(stops.length&&quote.fuel_available<quote.estimated_fuel+extra*quote.fuel_per_jump*2+reserve) {
    const dropped=stops.pop();
    if(dropped)extra-=dropped.extra;
  }
  return stops;
}

/** The plan above, with the active list and the one `find_route` per off-route candidate it
 * needs. Reads only; a read that fails is no stops, said in a step, never a failed trip. */
const distressStops=(quote:FindRouteResponse,reserve:number)=>Effect.gen(function*() {
  const read=yield* Effect.result(activeEffect());
  if(Result.isFailure(read)) {step(`no distress stops: the missions read failed (${told(read.failure)})`);return [];}
  const mine=read.success;
  const onRoute=new Set((quote.route??[]).map(s=>s.system_id));
  const legs=new Map<string,{route?:RouteStep[];total_jumps:number}>();
  for(const mission of mine.active) {
    const system=distressTarget(mission);
    if(!system||onRoute.has(system)||legs.has(system))continue;
    const leg=yield* Effect.result(routeEffect(system));
    if(Result.isSuccess(leg))legs.set(system,leg.success);
    else step(`distress at ${system}: no route (${told(leg.failure)}), so no stop`);
  }
  return distressPlan(quote,mine.active,legs,reserve);
});

/** `; not docked: ...` for a trip that ended out at a POI — said, so no script believes it is at
 * a counter. A read that fails still says not docked, just not why. */
const undocked=()=>Effect.gen(function*() {
  const read=yield* Effect.result(hereEffect());
  if(Result.isFailure(read))return '; not docked';
  const {row,bases}=read.success;
  const poi=acct().state.location?.poi_id;
  return `; at ${poiName(poi,row)}, not docked: `+(row?.base_id?`${row.base_id} is here, and prices(), sell() and the other counter helpers dock at it`:`no base at this POI${others(bases)}`);
});

/** Fly to a POI, a base, or a system, jumping as many times as the route needs, and dock
 * when the target is a base — or a system with exactly one base, whose base is the only place in
 * it a pilot can trade, service or read a market. A system with several bases (or none) ends
 * wherever the jump lands. The destination is always named: there is no default.
 *
 * Over `find_route` + `jump`/`travel` + `dock` it adds: base ids resolved to their POI before
 * the arrival wait, a fuel check that the tank covers the route, a refuel first when docked and short, and one
 * `partial` on stop instead of a wedged runner.
 *
 * On the way it answers active distress calls: a mission whose system is on the route, or at
 * most `DETOUR_JUMPS` off it while all detours together stay inside `DETOUR_SHARE` of the
 * route and the whole trip still ends above the mood's reserve, is flown through and claimed
 * with `complete_mission`. It never accepts a mission, and never detours under Tired.
 *
 * Idempotent: already there (and docked, if a base) sends nothing and is `done`. */
export function goTo(id:string):Promise<Outcome<Trip>> {return edge(goToEffect(id));}

/** `goTo` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal or a lost reply on
 * a leg ends the trip naming the action and the code; a lost reply on a jump, travel or dock is never re-sent, and
 * the ship's place is re-read from the game. */
export const goToEffect=(id:string)=>jobEffect<Trip>('goTo',id,Effect.gen(function*() {
  const game=yield* Game;
  const who=pilot();
  const target=id;
  const none:Trip={route:asQuote({}),location:asLocation(acct().state.location),jumps:0,docked:false,docked_at:acct().state.location?.docked_at??null};
  // What the pilot wrote may be an id or a display name; `named` is the id it turned out to
  // be, and every comparison below is made against that, never against the word.
  const found=yield* Effect.result(destinationEffect(target));
  if(Result.isFailure(found)) {
    // `NotAPlace` is a refusal; anything else is a failed trip, so the job wrapper reports it as `failed` or by its code.
    if(!(found.failure instanceof NotAPlace))return yield* found.failure;
    return {status:'refused' as const,did:`could not route to ${target}`,why:found.failure.message,detail:none};
  }
  const quote=found.success.quote;
  let named=found.success.id;
  const detail=():Trip=>({route:quote,location:asLocation(acct().state.location),jumps:0,docked:false,docked_at:acct().state.location?.docked_at??null});
  // A name was accepted; say which id it was, so the next script can write the id.
  if(named!==target)step(`${target} is ${named}`);
  // A system id answers with a system and no POI of its own. Passing it on as a `poi_id`
  // is what the server rejects as "Unknown destination" after the jump was already flown
  // and paid for: a system is reached wherever in it the jump lands, so name no POI.
  let poi=quote.target_poi===undefined&&quote.target_system===named?undefined:quote.target_poi??named;
  // A system named, and the ship in it: when it has one base, that base is where the trip ends.
  const settle=()=>Effect.gen(function*() {
    if(poi||acct().state.location?.system_id!==quote.target_system)return;
    const listed=yield* Effect.result(poisHere());
    if(Result.isFailure(listed)) {
      step(`${target}: no listing (${told(listed.failure)}); the system is reached wherever the jump landed`);
      return;
    }
    const bases=listed.success.filter(row=>row.base_id);
    const [only]=bases;
    if(bases.length!==1||!only?.base_id)return;
    poi=only.id;named=only.base_id;
    step(`${target} has one base; going on to ${named}`);
  });
  yield* settle();
  const {location}=acct().state;
  // Already there, and docked if the place is a base — asked of the system's own POI rows,
  // which only answer for the system the ship is in, which this branch has established.
  if(location&&location.system_id===quote.target_system&&(!poi||location.poi_id===poi)) {
    const base=poi?yield* baseAt(quote.target_system,poi,named):false;
    if(!base||location.docked_at===named)
      return {status:'done' as const,did:`already at ${target}${poi?'':` (${location.poi_id})`}${location.docked_at?'':yield* undocked()}`,detail:{...detail(),docked:Boolean(location.docked_at)}};
  }
  const mood=who.mood??'Cautious';
  // Tired flies straight to the base it is being serviced at; nothing is answered on the way.
  const stops=mood==='Tired'?[]:yield* distressStops(quote,resolveFuelReserve(mood));
  const planned=quote.total_jumps+stops.reduce((sum,s)=>sum+s.extra*2,0);
  step(`goTo ${poi??quote.target_system} ${planned?`${planned} jump(s)`:'same system'} ${quote.estimated_fuel} fuel quoted`
    +(stops.length?`, answering ${stops.length} distress call(s) at ${stops.map(s=>s.system).join(', ')}`:''));
  let jumps=0;
  const answered:string[]=[];
  // The mood is read when it is needed, never frozen at the top of the trip: a leg that takes
  // fuel under the reserve imposes Tired mid-route, and the refuel is Tired's to buy.
  const flying=():Mood=>pilot().mood??'Cautious';
  // A refuel that does not complete is said, and the fuel check after it decides: a lost reply is
  // never re-sent, the quote that follows re-reads the tank.
  const refuel=()=>Effect.gen(function*() {
    const served=yield* Effect.result(serviceShipEffect(acct(),{mood:flying(),creditReserve:who.permissions?.credit_reserve??0,
      ...runtimeDir()===undefined?{}:{runtime:runtimeDir()}}));
    if(Result.isFailure(served))step(`refuel on the way did not complete (${told(served.failure)}); the fuel check decides`);
  });
  const fly=(destination:{system_id:string;poi_id?:string})=>travelToEffect(acct(),destination,{
    maxJumps:null,
    checkpoint:()=>stopped()?Effect.fail(new Stopped()):Effect.void,
    onJump:()=>{jumps++;step(`jump ${jumps} of ${planned}, fuel ${acct().state.ship?.fuel}`);},
    refuelWith:refuel,
  });
  const flown=yield* Effect.result(Effect.gen(function*() {
    for(const stop of stops) {
      yield* fly({system_id:stop.system});
      const sent=yield* Effect.result(game.command('spacemolt/complete_mission',{id:stop.id}));
      if(Result.isFailure(sent)) {
        // Arriving is what the server counts; if it did not, the call is still active and
        // the trip carries on. It is left for the board, never abandoned here, and never re-sent.
        step(`distress ${stop.title} at ${stop.system} not claimable: ${told(sent.failure)}`);
        continue;
      }
      const read=decodeEarned(replyBody(sent.success));
      const paid=Option.isSome(read)?read.value:{};
      answered.push(`completed distress ${paid.title??stop.title} at ${stop.system} en route for ${paid.credits_earned??0} cr`);
      step(`completed distress ${stop.id} at ${stop.system} +${paid.credits_earned??0} cr`);
    }
    yield* fly({system_id:quote.target_system,...poi?{poi_id:poi}:{}});
    if(!poi){yield* settle();if(poi)yield* fly({system_id:quote.target_system,poi_id:poi});}
  }));
  if(Result.isFailure(flown)) {
    const error=flown.failure;
    // A battle is a state the trip cannot argue with, and it is not the trip breaking: it is
    // refused, with the call that ends it named, so the next juncture disengages instead of
    // re-issuing the same refused move (the loop that lost three ships on 2026-09-24).
    if(error instanceof InBattle)
      return {status:jumps?'partial' as const:'refused' as const,
        did:jumps?`stopped at ${acct().state.location?.system_id} short of ${target}: a battle`:`did not fly to ${target}`,
        why:error.message,detail:{...detail(),jumps},
        next:['disengage() — retreat and wait for the battle to end, then goTo again']};
    if(error instanceof FuelRouteShortfall) {
      const {actualFuel,requiredFuel,shortfall}=error.evidence;
      // A detour already flown is work behind the refusal, so the trip is partial and the
      // `did` says where the ship actually is rather than claiming it never left.
      return {status:jumps?'partial' as const:'refused' as const,
        did:jumps?`stopped at ${acct().state.location?.system_id} short of ${target} after ${jumps} jump(s)${answered.length?`; ${answered.join('; ')}`:''}`:`did not fly to ${target}`,
        why:`fuel ${actualFuel}, the route needs ${requiredFuel}; short ${shortfall}`,
        detail:{...detail(),jumps},next:['service() where you are docked, or a nearer destination']};
    }
    return yield* Effect.fail(error);
  }
  let docked=false;
  // The dock is decided by the system's own listing, not the route heuristic: a system id
  // may also answer with a POI, and docking "at a system" would wedge here.
  if(poi&&(yield* baseAt(quote.target_system,poi,named))) {
    const done=yield* dockEffect(named);
    // Live 2026-10-02 (kvothe 16:37Z): an `Access denied` dock broke the whole run after the
    // flight had landed. The ship arrived; the base said no. That is a partial, in its words.
    if('refused' in done)return {status:'partial' as const,did:`arrived at ${target} after ${jumps} jump(s); docking refused: ${done.refused}`,
      why:done.refused,detail:{...detail(),jumps}};
    docked=true;step(`docked at ${named}`);
  }
  yield* tiredCheck('arrival');
  const at=acct().state.location;
  return {status:'done' as const,did:`arrived at ${target}${poi?'':` (${at?.poi_id})`}${docked?named===target?' and docked':` and docked at ${named}`:''} after ${jumps} jump(s)`
    +(at?.docked_at?'':yield* undocked())+(answered.length?`; ${answered.join('; ')}`:''),detail:{...detail(),jumps,docked}};
}));
