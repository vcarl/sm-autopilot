/** Looking around. Reads only; nothing here spends a tick or a credit. */
import type {ActiveMissionInfo,CarrierProfile,GetNearbyResponse,GetWrecksResponse,
  ListShipsResponse,MapSystemInfo,ResourceInfo,StorageLocation,SystemConnection,SystemInfo,SystemPoi,
  TaxEstimateResponse,V2Missions,ViewStorageResponse} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {acct,command,job,pilot,present,type Pilot} from './runtime.ts';
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
  /** Reads that failed this time, by name. Never guessed. */
  missing:string[];
}

/** One read that may fail: the game is on the other side of a socket and an orientation is
 * worth having without every counter answering. */
async function attempt<T>(missing:string[],name:string,read:()=>Promise<T>):Promise<T|undefined> {
  try {return await read();} catch {missing.push(name);return undefined;}
}

/** Refresh the whole world model in one call: where you are, what you have, what you owe,
 * what you own elsewhere, your skills, your missions, and the pilot record. Over the seven
 * reads it adds: one call, each reply cut to what a decision needs, and `next` naming the
 * most obvious gap ("no home set", "hold is full", "tax due 16 cr"). Returns `done` always. */
export function orient():Promise<Outcome<Orientation>> {
  return job<Orientation>('orient','',async()=>{
    const missing:string[]=[];
    await attempt(missing,'skills',()=>command('spacemolt/get_skills',{}));
    const store=await attempt(missing,'storage',async()=>details(await command('spacemolt_storage/view',{})) as ViewStorageResponse);
    const ships=await attempt(missing,'ships',async()=>details(await command('spacemolt_ship/list_ships',{})) as ListShipsResponse);
    const active=await attempt(missing,'missions',async()=>{
      const reply=details(await command('spacemolt/get_active_missions',{})) as {missions?:V2Missions};
      return reply.missions?.active??(acct().state.missions as V2Missions|undefined)?.active??[];
    });
    const tax=await attempt(missing,'tax',async()=>details(await command('spacemolt/get_tax_estimate',{})) as TaxEstimateResponse);
    const carrier=await attempt(missing,'carrier',async()=>(details(await command('spacemolt_shipping/profile',{})) as {profile?:CarrierProfile}).profile);
    const who=pilot(),now=present();
    const bounty=Number((acct().state.player as any)?.bounty??0);
    const taxDue=tax?Number(tax.income_tax_total??0)+Number(tax.property_tax_total??0)-Number(tax.tax_prepaid??0):0;
    const next:string[]=[];
    if(!who.home)next.push('no home set: the operator sets pilot.json home; note() it and stop');
    if(!who.mood)next.push('no mood: the shift has not been opened; reflect at rest');
    if(now.ship&&now.ship.cargo_used>=now.ship.cargo_capacity)next.push('the hold is full: sell(rows) or stow(rows) before a gather');
    if(taxDue>0)next.push(`tax due ${taxDue} cr`);
    if(carrier&&Number((carrier as any).outstanding_debt??0)>0)next.push(`shipping debt ${(carrier as any).outstanding_debt} cr`);
    const lowest=Object.entries(now.skills).sort((a,b)=>a[1].level-b[1].level)[0];
    if(lowest)next.push(`lowest skill: ${lowest[0]} ${lowest[1].level}`);
    const place=now.location?.docked_at?`docked at ${now.location.docked_at}`:`at ${now.location?.poi_id??'?'}`;
    return {status:'done',
      did:`${place} (${now.location?.system_name??now.location?.system_id}), fuel ${now.ship?.fuel}/${now.ship?.max_fuel}, hull ${now.ship?.hull}/${now.ship?.max_hull}, hold ${now.ship?.cargo_used}/${now.ship?.cargo_capacity}, ${now.credits} cr, ${active?.length??'?'} missions, holdings at ${store?.locations?.length??'?'} bases${missing.length?`; missing: ${missing.join(', ')}`:''}`,
      detail:{present:now,storage:store?.locations??[],ships:ships?.ships??[],active_missions:active??[],
        owes:{...tax?{tax}:{},...carrier?{carrier}:{},bounty},pilot:who,missing},
      next};
  });
}

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

/** What is at a place, without flying there: the POIs of a named system (or this one), what
 * each one is, which have stations, and what is nearby right now if the system is the one
 * you are in. `target` is a system id, a POI id, or a base id; default the current system.
 * A far system answers from `get_map`, which lists no POIs (`system.visited` says whether
 * you have been). Over `get_system`/`get_map`/`get_nearby`/`salvage/wrecks`/`find_route` it
 * adds: the id resolved through `find_route`, one call, and `next` naming belts and stations
 * as ids you can paste into `gatherUntil` and `goTo`. Reads only. */
export function scout(target?:string):Promise<Outcome<ScoutReport>> {
  return job<ScoutReport>('scout',target??'',async()=>{
    const {location}=acct().state;
    let system=target??location?.system_id??'';
    if(target&&target!==location?.system_id) {
      const found=details(await command('spacemolt/find_route',{id:target}));
      if(!found.found)return {status:'refused',did:`could not find ${target}`,why:String(found.message??'no route'),detail:{system:{} as SystemInfo,pois:[],resources:{},connections:[]}};
      system=String(found.target_system);
    }
    const here=system===location?.system_id&&!location?.in_transit;
    const resources:Record<string,ResourceInfo[]>={};
    if(here&&location?.poi_id&&Array.isArray(location.resources)&&location.resources.length)
      resources[location.poi_id]=location.resources as unknown as ResourceInfo[];
    if(!here) {
      const map=details(await command('spacemolt/get_map',{system_id:system})) as MapSystemInfo;
      const links=Array.isArray(map.connections)?map.connections:[];
      return {status:'done',did:`${map.name??system}: ${map.poi_count??'?'} POIs (not listed from afar), ${links.length} connections, ${map.visited?'visited before':'never visited'}`,
        detail:{system:map,pois:[],resources,connections:links.map(system_id=>({system_id,name:system_id,fuel:NaN}))},
        next:[`goTo('${system}') then scout() for its POIs`]};
    }
    const info=(details(await command('spacemolt/get_system',{})) as {system:SystemInfo}).system;
    const connections:(SystemConnection&{fuel:number})[]=[];
    for(const link of info?.connections??[]) {
      let fuel=NaN;
      try {fuel=Number(details(await command('spacemolt/find_route',{id:link.system_id})).estimated_fuel);} catch {/* unquoted */}
      connections.push({...link,fuel});
    }
    let nearbyHere:ScoutReport['here'];
    if(location?.poi_id&&!location.docked_at) {
      try {
        const nearby=details(await command('spacemolt/get_nearby',{})) as GetNearbyResponse;
        let wrecks={count:0,wrecks:[]} as unknown as GetWrecksResponse;
        try {wrecks=details(await command('spacemolt_salvage/wrecks',{})) as GetWrecksResponse;} catch {/* none */}
        nearbyHere={nearby,wrecks,police:info.police_level};
      } catch {/* a station POI answers nothing useful */}
    }
    const pois=info?.pois??[];
    const belts=pois.filter(p=>/belt|field|cloud/.test(p.type)),stations=pois.filter(p=>p.base_id);
    const next=[...belts.slice(0,2).map(p=>`gatherUntil({poi:'${p.id}'}) — ${p.type}${resources[p.id]?`: ${resources[p.id]!.map(r=>r.resource_id).join(', ')}`:''}`),
      ...stations.slice(0,2).map(p=>`goTo('${p.base_id}') — ${p.base_name??p.name}`)];
    return {status:'done',
      did:`${info.name} (${info.id}): ${pois.length} POIs, ${belts.length} belt/field, ${stations.length} station(s), police ${info.police_level}, ${connections.length} connections${nearbyHere?`; here: ${nearbyHere.nearby.creature_count} creatures, ${nearbyHere.nearby.pirate_count} pirates, ${nearbyHere.wrecks.count??0} wrecks`:''}`,
      detail:{system:info,pois,resources,connections,...nearbyHere?{here:nearbyHere}:{}},next};
  });
}
