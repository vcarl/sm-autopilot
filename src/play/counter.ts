/** Whether there is a station counter where the ship is, and getting to it: every helper that
 * needs a counter (market, board, store, service) asks here, so "not docked" is either fixed by
 * a dock or said with where the ship actually is. */
import {SpacemoltError,type SystemPoi} from '@spacemolt/lib';
import {dockAt} from '../dock.ts';
import {details} from '../response-details.ts';
import {journalRun} from '../run-record.ts';
import {clearDockRefused,markDockRefused} from './places.ts';
import {acct,command,runtimeDir,step} from './runtime.ts';

/** The POI the ship is at, as this system's own listing (`get_system`) has it — a row with
 * `base_id` has a station — and the bases elsewhere in the system. One read. */
export async function here():Promise<{row?:SystemPoi;bases:string[]}> {
  const pois=(details(await command('spacemolt/get_system',{})).system?.pois??[]) as SystemPoi[];
  const poi=acct().state.location?.poi_id;
  return {row:pois.find(p=>p.id===poi),bases:pois.filter(p=>p.base_id&&p.id!==poi).map(p=>p.base_id!)};
}

/** `belt (Inner Belt)`: the id the pilot writes and the name prose gives it. */
export const named=(id:string|undefined,row?:SystemPoi)=>`${id??'open space'}${row?.name&&row.name!==id?` (${row.name})`:''}`;
export const others=(bases:string[])=>bases.length?`; bases in this system: ${bases.join(', ')}`:'';

/** Dock at `base_id` where the ship stands, or the game's refusal in its own words when it denies
 * access: remembered in `docking.json` and journalled (`dock_refused`), so the next juncture can see
 * which bases turned it away. Any other error is thrown as `dockAt` throws it. */
export async function dock(base_id:string):Promise<{docked:string}|{refused:string}> {
  const runtime=runtimeDir();
  try {
    const docked=(await dockAt(acct(),command,base_id)).docked_at;
    if(runtime)clearDockRefused(runtime,base_id);
    return {docked};
  } catch(error) {
    if(!(error instanceof SpacemoltError&&error.code==='access_denied'))throw error;
    const system_id=acct().state.location?.system_id;
    if(runtime) {
      markDockRefused(runtime,base_id,{...system_id?{system_id}:{},message:error.message,at:new Date().toISOString()});
      journalRun(runtime,{base_id,...system_id?{system_id}:{},code:error.code,message:error.message},'dock_refused');
    }
    return {refused:error.message};
  }
}

/** Docked already, or docked now when a base sits at this POI; otherwise why not, naming the
 * POI, the system, and the bases in this system. */
export async function counter():Promise<{docked:string}|{refused:string}> {
  const docked=acct().state.location?.docked_at;
  if(docked)return {docked};
  const {row,bases}=await here();
  if(row?.base_id) {
    step(`docking at ${row.base_id}: its counter is here`);
    const done=await dock(row.base_id);
    return 'docked' in done?done:{refused:`docking refused at ${row.base_id}: ${done.refused}`};
  }
  const at=acct().state.location;
  return {refused:`not docked: at ${named(at?.poi_id,row)} in ${at?.system_name??at?.system_id??'?'}, no station here${others(bases)}`};
}
