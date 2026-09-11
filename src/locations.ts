import { SpacemoltClient, fetchStations, type StationSummary } from '@spacemolt/lib';
import type {Home} from './execution-policy.ts';

const publicData = new SpacemoltClient();
export interface DestinationResolution {
  requested_id:string;status:'resolved'|'missing'|'ambiguous'|'wrecked'|'outside_route_limit';
  station?:Home & {id:string;station_name:string;hops?:number};
}
export interface LocationsObservation {
  status?:string;reason?:string;origin_system?:string;max_jumps?:number;total_stations?:number;
  stations?:{system_id:string;system_name:string;hops:number;station_name:string;id?:string;base_id:string;poi_id:string;services:string[]}[];
  destination_matches?:DestinationResolution[];limitation?:string;
}

/** Match typed directory identities only; names and opaque-ID shapes prove nothing. */
export function resolveStationDestinations(directory:StationSummary[],distances:Map<string,number>,ids:string[],maxJumps:number):DestinationResolution[] {
  if(ids.length>6||ids.some(id=>typeof id!=='string'||!id))throw new Error('Resolve at most six observed destination IDs');
  return [...new Set(ids)].map(requested_id=>{
    const matches=directory.filter(station=>[station.base_id,station.id,station.poi_id].includes(requested_id));
    if(matches.length!==1)return {requested_id,status:matches.length?'ambiguous':'missing'};
    const row=matches[0]!,hops=distances.get(row.system_id);
    const station={id:row.id,base_id:row.base_id,poi_id:row.poi_id,system_id:row.system_id,station_name:row.name,hops,rationale:'Observed passenger destination matched to public station identity',observed_at:new Date().toISOString()};
    return {requested_id,station,status:row.wrecked?'wrecked':hops===undefined||hops>maxJumps?'outside_route_limit':'resolved'};
  });
}

/** Public directory discovery; never opens a player connection. */
export async function industryLocations(systemId: string | undefined, params: Record<string, unknown>):Promise<LocationsObservation> {
  if (!systemId) return {status:'blocked',reason:'Current system is unknown'};
  const maxJumps = Number(params.max_jumps ?? 2), limit = Number(params.limit ?? 10);
  if (!Number.isInteger(maxJumps) || maxJumps < 1 || maxJumps > 5 || !Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('max_jumps must be 1..5 and limit 1..30');
  const destinationIds=params.observed_destination_ids??[];
  if(!Array.isArray(destinationIds)||destinationIds.length>6||destinationIds.some(id=>typeof id!=='string'||!id.trim()))throw new Error('Resolve at most six observed destination IDs');
  if(params.refresh_map!==undefined&&typeof params.refresh_map!=='boolean')throw new Error('refresh_map must be boolean');
  const [map, directory] = await Promise.all([publicData.map(params.refresh_map===true), fetchStations(publicData.httpBaseUrl)]);
  const distances = new Map<string, number>([[systemId, 0]]);
  const queue = [systemId];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!, hops = distances.get(id)!;
    if (hops >= maxJumps) continue;
    for (const next of map.system(id)?.connections ?? []) if (!distances.has(next)) {
      distances.set(next, hops + 1); queue.push(next);
    }
  }
  const destination_matches=resolveStationDestinations(directory.stations,distances,destinationIds,maxJumps);
  const stations = directory.stations.filter(station => !station.wrecked&&distances.has(station.system_id)).map(station => ({
    system_id: station.system_id, system_name: station.system_name, hops: distances.get(station.system_id)!,
    station_name: station.name, id:station.id, base_id: station.base_id, poi_id: station.poi_id, services: station.services,
  })).sort((a,b) => a.hops - b.hops || a.station_name.localeCompare(b.station_name));
  return {origin_system:systemId, max_jumps:maxJumps, total_stations:stations.length, stations:stations.slice(0,limit),destination_matches,
    limitation:'Public station directory and map connections only. Observe live resources, market depth, route costs and docking access before committing travel.'};
}
