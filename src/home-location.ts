import type {Home} from './execution-policy.ts';

/** A base choice is stable; a mobile base's waypoint is an observation. */
export function locateHome(home:Home|undefined,location:{system_id?:string;poi_id?:string|null;docked_at?:string|null;in_transit?:unknown}|undefined,stations:Partial<Home>[]=[]):{destination?:Home;source:string} {
  if(!home)return {source:'no_home'};
  const observed_at=new Date().toISOString();
  if(!location?.in_transit&&location?.docked_at===home.base_id&&location.system_id&&location.poi_id) {
    return {destination:{base_id:home.base_id,rationale:home.rationale,system_id:location.system_id,poi_id:location.poi_id,observed_at},source:'authenticated_home_dock'};
  }
  const matches=stations.filter(station=>station.base_id===home.base_id);
  const station=matches.length===1?matches[0]:undefined;
  if(station?.system_id&&station.poi_id) {
    return {destination:{base_id:home.base_id,rationale:home.rationale,system_id:station.system_id,poi_id:station.poi_id,observed_at},source:'station_directory'};
  }
  // A bounded directory's omission does not prove the remembered base vanished.
  return {destination:home,source:'remembered_waypoint'};
}
