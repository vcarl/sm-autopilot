/** Looking around. Reads only; nothing here spends a tick or a credit. */
import type {ActiveMissionInfo,CarrierProfile,GetNearbyResponse,GetWrecksResponse,
  ListShipsResponse,MapSystemInfo,ResourceInfo,StorageLocation,SystemConnection,SystemInfo,SystemPoi,
  TaxEstimateResponse,V2Resource} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {replyBody} from '../storage.ts';
import {battleNowEffect,type BattleNow} from '../travel.ts';
import * as Wire from '../wire.gen.ts';
import {Game,field} from './game.ts';
import {acct,edge,jobEffect,pilot,present,step,type Pilot} from './runtime.ts';
import type {Outcome,Present} from './types.ts';

export interface Orientation {
  present:Present;
  /** Every base holding something of yours, from anywhere (`storage/view.locations`). */
  storage:StorageLocation[];
  /** Ships you own and where they are parked (`ship/list_ships`). */
  ships:ListShipsResponse['ships'];
  /** Your active missions (`get_active_missions`). */
  active_missions:ActiveMissionInfo[];
  /** What accrues behind your back: the tax estimate and the carrier record with its debt. */
  owes:{tax?:TaxEstimateResponse;carrier?:CarrierProfile;bounty:number};
  pilot:Pilot;
  /** The battle holding the ship right now, or absent when none is. Read first and said first:
   * nothing else in an orientation matters while a fight is on. */
  battle?:BattleNow;
  /** Reads that failed this time, by name. Never guessed. */
  missing:string[];
}

// Only what this file reads: the live server omits spec fields, so a whole-reply decode would refuse
// real replies. The surface hands the pilot the lib's rows whole, so each reply is passed on raw, once.
const decodeStore=Schema.decodeUnknownOption(Wire.ViewStorageResponse.mapFields(()=>({
  locations:Schema.Array(Wire.StorageLocation_1.mapFields(Struct.pick([])))})));
const decodeShips=Schema.decodeUnknownOption(Wire.ListShipsResponse.mapFields(()=>({
  ships:Schema.Array(Wire.OwnedShipInfo.mapFields(Struct.pick([])))})));
const decodeMissions=Schema.decodeUnknownOption(Wire.V2GameState.mapFields(()=>({missions:Schema.optionalKey(
  Wire.V2Missions.mapFields(()=>({active:Schema.Array(Wire.ActiveMissionInfo_1.mapFields(Struct.pick([])))})))})));
const decodeTax=Schema.decodeUnknownOption(Wire.TaxEstimateResponse.mapFields(fields=>({income_tax_total:Schema.optionalKey(fields.income_tax_total),
  property_tax_total:Schema.optionalKey(fields.property_tax_total),tax_prepaid:Schema.optionalKey(fields.tax_prepaid)})));
const decodeCarrier=Schema.decodeUnknownOption(Wire.ShippingProfileResponse.mapFields(()=>({profile:Schema.optionalKey(Schema.NullOr(
  Wire.CarrierProfile_2.mapFields(fields=>({outstanding_debt:Schema.optionalKey(fields.outstanding_debt)}))))})));
// oxlint-disable-next-line typescript/consistent-type-assertions
const asStorage=(rows:unknown)=>rows as StorageLocation[]; // cast: frozen surface (StorageLocation[])
// oxlint-disable-next-line typescript/consistent-type-assertions
const asShips=(rows:unknown)=>rows as ListShipsResponse['ships']; // cast: frozen surface (ListShipsResponse['ships'])
// oxlint-disable-next-line typescript/consistent-type-assertions
const asMissions=(rows:unknown)=>rows as ActiveMissionInfo[]; // cast: frozen surface (ActiveMissionInfo[])
// oxlint-disable-next-line typescript/consistent-type-assertions
const asTax=(body:unknown)=>body as TaxEstimateResponse; // cast: frozen surface (TaxEstimateResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asCarrier=(profile:unknown)=>profile as CarrierProfile; // cast: frozen surface (CarrierProfile)

/** One read that may fail: the game is on the other side of a socket and an orientation is worth
 * having without every counter answering. A refusal, a lost reply or a reply that does not read names
 * the read in `missing`; a defect is a bug and goes up. `body` is the reply as the game sent it. */
const read=<A>(missing:string[],name:string,action:string,decode:(body:unknown)=>Option.Option<A>)=>Effect.gen(function*() {
  const sent=yield* Effect.result((yield* Game).command(action,{}));
  const body=Result.isSuccess(sent)?replyBody(sent.success):undefined;
  const got=Result.isSuccess(sent)?decode(body):Option.none<A>();
  if(Option.isNone(got)){missing.push(name);return undefined;}
  return {body,read:got.value};
});

/** Refresh the whole world model in one call: where you are, what you have, what you owe,
 * what you own elsewhere, your skills, your missions, and the pilot record. Over the seven
 * reads it adds: one call, each reply cut to what a decision needs, and `next` naming the
 * most obvious gap ("hold is full", "tax due 16 cr"). Returns `done` always. */
export function orient():Promise<Outcome<Orientation>> {return edge(orientEffect());}

/** `orient` as an Effect, for `edge` and for converted callers; never in a barrel. */
export const orientEffect=()=>jobEffect<Orientation,Game>('orient','',Effect.gen(function*() {
  const missing:string[]=[];
  // Before every other read: a pilot that does not know it is in a fight spends its first
  // move on something the server will refuse `in_battle`, or dies making it (2026-09-25).
  const fight=yield* battleNowEffect();
  yield* read(missing,'skills','spacemolt/get_skills',Option.some);
  const store=yield* read(missing,'storage','spacemolt_storage/view',decodeStore);
  const ships=yield* read(missing,'ships','spacemolt_ship/list_ships',decodeShips);
  const missionsRead=yield* read(missing,'missions','spacemolt/get_active_missions',decodeMissions);
  const tax=yield* read(missing,'tax','spacemolt/get_tax_estimate',decodeTax);
  const carrier=yield* read(missing,'carrier','spacemolt_shipping/profile',decodeCarrier);
  const who=pilot(),now=present();
  const active=missionsRead&&(missionsRead.read.missions?asMissions(field(field(missionsRead.body,'missions'),'active')):acct().state.missions?.active??[]);
  const bounty=Number(field(acct().state.player,'bounty')??0);
  const taxDue=tax?(tax.read.income_tax_total??0)+(tax.read.property_tax_total??0)-(tax.read.tax_prepaid??0):0;
  const debt=carrier?.read.profile?.outstanding_debt??0;
  const next:string[]=[];
  if(now.ship&&now.ship.cargo_used>=now.ship.cargo_capacity)next.push('the hold is full: sell(rows) or stow(rows) before a gather');
  if(taxDue>0)next.push(`tax due ${taxDue} cr`);
  if(debt>0)next.push(`shipping debt ${debt} cr`);
  const lowest=Object.entries(now.skills).sort((a,b)=>a[1].level-b[1].level)[0];
  if(lowest)next.push(`lowest skill: ${lowest[0]} ${lowest[1].level}`);
  const place=now.location?.docked_at?`docked at ${now.location.docked_at}`:`at ${now.location?.poi_id??'?'}`;
  const owes={...tax?{tax:asTax(tax.body)}:{},...carrier?.read.profile?{carrier:asCarrier(field(carrier.body,'profile'))}:{},bounty};
  return {status:'done' as const,
    did:`${fight?`IN BATTLE with ${fight.opponent} (battle tick ${fight.tick}): disengage() or fight it; no travel, jump or undock until it ends. `:''}${place} (${now.location?.system_name??now.location?.system_id}), fuel ${now.ship?.fuel}/${now.ship?.max_fuel}, hull ${now.ship?.hull}/${now.ship?.max_hull}, hold ${now.ship?.cargo_used}/${now.ship?.cargo_capacity}, ${now.credits} cr, ${active?.length??'?'} missions, holdings at ${store?.read.locations.length??'?'} bases${missing.length?`; missing: ${missing.join(', ')}`:''}`,
    detail:{present:now,storage:store?asStorage(field(store.body,'locations')):[],ships:ships?asShips(field(ships.body,'ships')):[],active_missions:active??[],
      owes,pilot:who,...fight?{battle:fight}:{},missing},
    next};
}));

export interface ScoutReport {
  /** The live `get_system` answer when you are in it; the map entry when you are not. */
  system:SystemInfo|MapSystemInfo;
  /** Every POI: type, base id and services if it has a station. */
  pois:SystemPoi[];
  /** Resources at the POI you are standing at, from `location.resources`. Absent elsewhere:
   * the report is then guesswork until you go there. */
  resources:Record<string,ResourceInfo[]>;
  /** Systems one jump away, each with the fuel `find_route` quotes for it. */
  connections:(SystemConnection&{fuel:number})[];
  /** Only for the POI you are standing at. */
  here?:{nearby:GetNearbyResponse;wrecks:GetWrecksResponse;police:number};
}

// What `scout` reads of each reply; the same rule as above.
const decodeRoute=Schema.decodeUnknownOption(Wire.FindRouteResponse.mapFields(fields=>({found:fields.found,
  message:Schema.optionalKey(fields.message),target_system:Schema.optionalKey(fields.target_system)})));
const decodeQuote=Schema.decodeUnknownOption(Wire.FindRouteResponse.mapFields(Struct.pick(['estimated_fuel'])));
const decodeMap=Schema.decodeUnknownOption(Wire.MapSystemInfo.mapFields(fields=>({name:Schema.optionalKey(fields.name),
  poi_count:Schema.optionalKey(fields.poi_count),visited:Schema.optionalKey(fields.visited),connections:Schema.optionalKey(Schema.NullOr(fields.connections))})));
const decodeSystem=Schema.decodeUnknownOption(Wire.GetSystemResponse.mapFields(fields=>({system:fields.system.mapFields(sys=>({
  id:sys.id,name:sys.name,police_level:Schema.optionalKey(sys.police_level),
  connections:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ClientConnectionInfo_2.mapFields(link=>({system_id:link.system_id,
    name:Schema.optionalKey(link.name),distance:link.distance}))))),
  pois:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ClientPOIInfo_2.mapFields(Struct.pick(['id','name','type','base_id','base_name'])))))}))})));
const decodeNearby=Schema.decodeUnknownOption(Wire.GetNearbyResponse.mapFields(Struct.pick(['creature_count','pirate_count'])));
const decodeWrecks=Schema.decodeUnknownOption(Wire.GetWrecksResponse.mapFields(fields=>({count:Schema.optionalKey(fields.count),
  wrecks:Schema.Array(Wire.EnrichedWreck_1.mapFields(Struct.pick([])))})));
// oxlint-disable-next-line typescript/consistent-type-assertions
const asMap=(body:unknown)=>body as MapSystemInfo; // cast: frozen surface (MapSystemInfo)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asSystem=(body:unknown)=>body as SystemInfo; // cast: frozen surface (SystemInfo)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asNearby=(body:unknown)=>body as GetNearbyResponse; // cast: frozen surface (GetNearbyResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asWrecks=(body:unknown)=>body as GetWrecksResponse; // cast: frozen surface (GetWrecksResponse)

/** The map entry of a place no read answered for: the report's `system` is never absent. */
const unknownPlace=(id:string):ScoutReport=>({system:{connections:[],name:id,online:0,poi_count:0,position:{x:0,y:0},system_id:id,visited:false,visited_at:''},
  pois:[],resources:{},connections:[]});
/** `location.resources` rows as the report names a deposit: the location carries `item_id` and `item_name`, the report `resource_id` and `name`. */
const deposit=(row:V2Resource):ResourceInfo=>({resource_id:row.item_id,name:row.item_name,remaining:row.remaining,richness:row.richness,
  remaining_display:row.remaining<0?'unlimited':row.remaining===0?'depleted':`${row.remaining} units`,
  ...row.lock_minimum_stock===undefined?{}:{lock_minimum_stock:row.lock_minimum_stock},
  ...row.supported_power===undefined?{}:{supported_power:row.supported_power},
  ...row.too_sparse===undefined?{}:{too_sparse:row.too_sparse}});

/** What is at a place, without flying there: the POIs of a named system (or this one), what
 * each one is, which have stations, and what is nearby right now if the system is the one
 * you are in. `target` is a system id, a POI id, or a base id; default the current system.
 * A far system answers from `get_map`, which lists no POIs (`system.visited` says whether
 * you have been). Over `get_system`/`get_map`/`get_nearby`/`salvage/wrecks`/`find_route` it
 * adds: the id resolved through `find_route`, one call, and `next` naming belts and stations
 * as ids you can paste into `gatherUntil` and `goTo`. Reads only. */
export function scout(target?:string):Promise<Outcome<ScoutReport>> {return edge(scoutEffect(target));}

/** `scout` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal of the
 * route to the target ends the run, naming the action and the code; a refused quote, nearby or wreck
 * read only leaves its part of the report empty. */
export const scoutEffect=(target?:string)=>jobEffect<ScoutReport,Game>('scout',target??'',Effect.gen(function*() {
  const game=yield* Game;
  const {location}=acct().state;
  let system=target??location?.system_id??'';
  const offSpec=(action:string)=>({status:'failed' as const,did:'scout broke',why:`${action}: reply off spec`,detail:unknownPlace(system)});
  if(target&&target!==location?.system_id) {
    const found=decodeRoute(replyBody(yield* game.command('spacemolt/find_route',{id:target})));
    if(Option.isNone(found))return offSpec('spacemolt/find_route');
    if(!found.value.found)return {status:'refused' as const,did:`could not find ${target}`,why:found.value.message??'no route',detail:unknownPlace(target)};
    system=found.value.target_system??target;
  }
  const here=system===location?.system_id&&!location?.in_transit;
  const resources:Record<string,ResourceInfo[]>={};
  if(here&&location?.poi_id&&Array.isArray(location.resources)&&location.resources.length)
    resources[location.poi_id]=location.resources.map(deposit);
  if(!here) {
    const body=replyBody(yield* game.command('spacemolt/get_map',{system_id:system}));
    const map=decodeMap(body);
    if(Option.isNone(map))return offSpec('spacemolt/get_map');
    const links=map.value.connections??[];
    return {status:'done' as const,did:`${map.value.name??system}: ${map.value.poi_count??'?'} POIs (not listed from afar), ${links.length} connections, ${map.value.visited?'visited before':'never visited'}`,
      detail:{system:asMap(body),pois:[],resources,connections:links.map(system_id=>({system_id,name:system_id,fuel:NaN}))},
      next:[`goTo('${system}') then scout() for its POIs`]};
  }
  const body=replyBody(yield* game.command('spacemolt/get_system',{}));
  const read=decodeSystem(body);
  if(Option.isNone(read))return offSpec('spacemolt/get_system');
  const info=read.value.system,raw=field(body,'system');
  const connections:(SystemConnection&{fuel:number})[]=[];
  for(const link of info.connections??[]) {
    // A quote the game refuses, loses or answers unreadably leaves the fuel unknown: NaN, never a guess.
    const quote=yield* Effect.result(game.command('spacemolt/find_route',{id:link.system_id}));
    const priced=Result.isSuccess(quote)?decodeQuote(replyBody(quote.success)):Option.none();
    connections.push({...link,name:link.name??link.system_id,fuel:Option.isSome(priced)?priced.value.estimated_fuel:NaN});
  }
  let nearbyHere:ScoutReport['here'];
  if(location?.poi_id&&!location.docked_at) {
    // A station POI answers nothing useful, and a refused read has nothing to report either.
    const looked=yield* Effect.result(game.command('spacemolt/get_nearby',{}));
    if(Result.isSuccess(looked)) {
      const nearby=replyBody(looked.success);
      if(Option.isNone(decodeNearby(nearby)))step('spacemolt/get_nearby: the answer did not read; no `here` in the report');
      else {
        let wrecks:GetWrecksResponse={count:0,wrecks:[]};
        const listed=yield* Effect.result(game.command('spacemolt_salvage/wrecks',{}));
        if(Result.isSuccess(listed)) {
          const answer=replyBody(listed.success);
          if(Option.isSome(decodeWrecks(answer)))wrecks=asWrecks(answer);
          else step('spacemolt_salvage/wrecks: the answer did not read; reported as none');
        }
        nearbyHere={nearby:asNearby(nearby),wrecks,police:info.police_level??NaN};
      }
    }
  }
  const pois=info.pois??[];
  const belts=pois.filter(p=>/belt|field|cloud/.test(p.type)),stations=pois.filter(p=>p.base_id);
  // `gatherUntil` settles the take at a base and refuses outright without one — it falls back to
  // `docked_at`, and out at a POI there is none (mining.ts). A hint the library refuses is worse than
  // no hint: it reads as knowledge and the refusal arrives a whole juncture too late. So the
  // base is named, from where the ship is docked or from a station in the system being scouted,
  // and where there is neither the belt is still listed but not as a call to paste.
  const settleAt=location?.docked_at??stations.find(p=>p.base_id)?.base_id;
  const next=[...belts.slice(0,2).map(p=>{
    const seen=resources[p.id];
    const what=`${p.type}${seen?`: ${seen.map(r=>r.resource_id).join(', ')}`:''}`;
    return settleAt
      ?`gatherUntil({poi:'${p.id}',base:'${settleAt}'}) — ${what}`
      :`${p.id} — ${what} (no station in ${info.id} to settle a take at; gatherUntil needs one)`;
  }),
    ...stations.slice(0,2).map(p=>`goTo('${p.base_id}') — ${p.base_name??p.name}`)];
  return {status:'done' as const,
    did:`${info.name} (${info.id}): ${pois.length} POIs, ${belts.length} belt/field, ${stations.length} station(s), police ${info.police_level??'?'}, ${connections.length} connections${nearbyHere?`; here: ${nearbyHere.nearby.creature_count} creatures, ${nearbyHere.nearby.pirate_count} pirates, ${nearbyHere.wrecks.count??0} wrecks`:''}`,
    detail:{system:asSystem(raw),pois:info.pois?asSystem(raw).pois:[],resources,connections,...nearbyHere?{here:nearbyHere}:{}},next};
}));
