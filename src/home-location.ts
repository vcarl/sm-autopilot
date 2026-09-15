import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';

/** The pilot's own record of home. The game keeps its own (`player.home_base`), and
 * registerHome is what keeps the two the same (D7 decision 4). */
export interface Home {base_id:string;rationale:string;system_id?:string;poi_id?:string;observed_at?:string}

export class HomeBlocked extends Error {}

/** Choosing home is a station counter act, so it spends a command and is confirmed the
 * way every other mutation is: from an authoritative post-read, never the reply's claim.
 * Without it the pilot respawns at a base it abandoned three shifts ago. */
export async function registerHome(account:ReadinessAccount,command:ReadinessCommand,home:Home):Promise<{home_base:string;issued:boolean}> {
  if(!home?.base_id)throw new HomeBlocked('A home base id is required before registering a home');
  await account.refresh();
  const observed=()=>account.state.player?.home_base;
  const {location}=account.state;
  if(!location||location.in_transit||location.docked_at!==home.base_id)
    throw new HomeBlocked(`Dock at ${home.base_id} before registering it as home; docked at ${location?.docked_at??'nothing'}`);
  if(observed()===home.base_id)return {home_base:home.base_id,issued:false};
  await command('spacemolt_salvage/set_home',{id:home.base_id});
  await account.refresh();
  if(observed()!==home.base_id)
    throw new HomeBlocked(`set_home was accepted but the game still reports home ${observed()??'unset'}, not ${home.base_id}`);
  return {home_base:home.base_id,issued:true};
}

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
