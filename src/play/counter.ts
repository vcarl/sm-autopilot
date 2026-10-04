/** Whether there is a station counter where the ship is, and getting to it: every helper that
 * needs a counter (market, board, store, service) asks here, so "not docked" is either fixed by
 * a dock or said with where the ship actually is. */
import type {SystemPoi} from '@spacemolt/lib';
import {Effect} from 'effect';
import {dockAtEffect} from '../dock.ts';
import {Game,Rejected,field} from './game.ts';
import {replyBody} from '../storage.ts';
import {journalRun} from '../run-record.ts';
import {clearDockRefused,markDockRefused} from './places.ts';
import {acct,runtimeDir,step} from './runtime.ts';

/** The part of a `get_system` row the counter reads. A row is kept when it has an `id`, and takes
 * each other field when it is a string: a partial row costs nothing, a malformed one only its field. */
export type PoiRow=Pick<SystemPoi,'id'|'base_id'>&Partial<Pick<SystemPoi,'name'>>;
const rowOf=(raw:unknown):PoiRow[]=>{
  const id=field(raw,'id'),name=field(raw,'name'),base=field(raw,'base_id');
  return typeof id==='string'?[{id,...typeof name==='string'?{name}:{},...typeof base==='string'?{base_id:base}:{}}]:[];
};

/** The POI the ship is at, as this system's own listing (`get_system`) has it — a row with
 * `base_id` has a station — and the bases elsewhere in the system. One read. */
export const hereEffect=()=>Effect.gen(function*() {
  const reply=yield* (yield* Game).command('spacemolt/get_system',{});
  const listed=field(field(replyBody(reply),'system'),'pois');
  const pois=Array.isArray(listed)?listed.flatMap(rowOf):[];
  const poi=acct().state.location?.poi_id;
  const row=pois.find(p=>p.id===poi);
  return {...row?{row}:{},bases:pois.flatMap(p=>p.base_id&&p.id!==poi?[p.base_id]:[])};
});
/** `belt (Inner Belt)`: the id the pilot writes and the name prose gives it. */
export const named=(id:string|undefined,row?:PoiRow)=>`${id??'open space'}${row?.name&&row.name!==id?` (${row.name})`:''}`;
export const others=(bases:string[])=>bases.length?`; bases in this system: ${bases.join(', ')}`:'';

/** Dock at `base_id` where the ship stands, or the game's refusal in its own words when it denies
 * access (`access_denied`, live 2026-09-30..10-02: 18 `Access denied` docks): remembered in
 * `docking.json` and journalled (`dock_refused`), so the next juncture can see which bases turned it
 * away. A dock that takes clears the entry. Every other failure stays in the error channel. */
export const dockEffect=(base_id:string)=>dockAtEffect(acct(),base_id).pipe(
  Effect.map(done=>{const runtime=runtimeDir();if(runtime)clearDockRefused(runtime,base_id);return {docked:done.docked_at};}),
  Effect.catchTag('Rejected',error=>{
    // TravelBlocked's tag is a plain string, so catchTag hands it here too: only a Rejected has a code.
    if(!(error instanceof Rejected)||error.code!=='access_denied')return Effect.fail(error);
    const runtime=runtimeDir(),system_id=acct().state.location?.system_id,where=system_id?{system_id}:{};
    if(runtime) {
      markDockRefused(runtime,base_id,{...where,message:error.message,at:new Date().toISOString()});
      journalRun(runtime,{base_id,...where,code:error.code,message:error.message},'dock_refused');
    }
    return Effect.succeed({refused:error.message});
  }));

/** Docked already, or docked now when a base sits at this POI; otherwise why not, naming the
 * POI, the system, and the bases in this system. */
export const counterEffect=()=>Effect.gen(function*() {
  const docked=acct().state.location?.docked_at;
  if(docked)return {docked};
  const {row,bases}=yield* hereEffect();
  if(row?.base_id) {
    step(`docking at ${row.base_id}: its counter is here`);
    const done=yield* dockEffect(row.base_id);
    return 'docked' in done?done:{refused:`docking refused at ${row.base_id}: ${done.refused}`};
  }
  const at=acct().state.location;
  return {refused:`not docked: at ${named(at?.poi_id,row)} in ${at?.system_name??at?.system_id??'?'}, no station here${others(bases)}`};
});
