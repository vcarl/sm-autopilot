/** Where each base is: `places.json` in the pilot's runtime dir, base id to system id. Written
 * whenever a base's system is learned — a docked `book()`, a `find_route` in `routes()`, a
 * freighter arriving at a stop — and read by `farBooks`, so a base is placed once, ever. A ledger
 * entry carries no system, so without this every `routes()` would place the same bases again. */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE='places.json';

export function readPlaces(runtime:string):Record<string,string> {
  try {const places=JSON.parse(readFileSync(join(runtime,FILE),'utf8'));return places&&typeof places==='object'?places:{};}
  catch {return {};}
}
/** Write `file` in `dir` as JSON, temp file then rename, so a reader never sees half of it. A
 * failed write is dropped: everything kept this way is only looked up or seen again. */
export function keepJson(dir:string,file:string,value:unknown):void {
  try {
    mkdirSync(dir,{recursive:true});
    const path=join(dir,file),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
    renameSync(temp,path);
  } catch {/* unkept */}
}

/** A no-op when the place is already kept or either id is empty. */
export function markPlace(runtime:string,base_id:string,system_id:string):void {
  const places=readPlaces(runtime);
  if(!base_id||!system_id||places[base_id]===system_id)return;
  keepJson(runtime,FILE,{...places,[base_id]:system_id});
}

/** Bases seen away from their kept place: mobile stations, which move between systems. `mobile.json`
 * beside `places.json`, a list of base ids, written by a freighter's host and read by `chart`, which
 * places a mobile base afresh with `find_route` every time, never from `places.json` or a memory. */
const MOBILE='mobile.json';
export const readMobile=(runtime:string)=>readList(runtime,MOBILE);
export const markMobile=(runtime:string,base_id:string)=>addToList(runtime,MOBILE,base_id);

/** Systems whose bases a live `get_system` there listed (or the faction's intel map did):
 * `explored.json` beside `places.json`, a list of system ids, so a system is flown to for its
 * bases once, ever. The bases themselves go to `places.json`. Read by `candidates` (trading/scout.ts). */
const EXPLORED='explored.json';
export const readExplored=(runtime:string)=>readList(runtime,EXPLORED);
export const markExplored=(runtime:string,system_id:string)=>addToList(runtime,EXPLORED,system_id);

function readList(runtime:string,file:string):Set<string> {
  try {const ids=JSON.parse(readFileSync(join(runtime,file),'utf8'));return new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string'):[]);}
  catch {return new Set();}
}
/** A no-op when the id is already listed or empty. */
function addToList(runtime:string,file:string,id:string):void {
  const ids=readList(runtime,file);
  if(!id||ids.has(id))return;
  keepJson(runtime,file,[...ids,id]);
}

/** Bases whose dock the game refused: `docking.json` beside `places.json`, base id to the game's
 * own words and when. Live 2026-09-30..10-02 (kvothe): 18 `Access denied` docks, the same bases
 * retried hours apart, because nothing remembered the refusal. Information only: nothing refuses
 * to try again, and a dock that takes clears the entry. */
const DOCKING='docking.json';
export interface DockRefusal {system_id?:string;message:string;at:string}
export function readDockRefusals(runtime:string|undefined):Record<string,DockRefusal> {
  if(!runtime)return {};
  try {const kept=JSON.parse(readFileSync(join(runtime,DOCKING),'utf8'));return kept&&typeof kept==='object'&&!Array.isArray(kept)?kept:{};}
  catch {return {};}
}
export function markDockRefused(runtime:string,base_id:string,row:DockRefusal):void {
  keepJson(runtime,DOCKING,{...readDockRefusals(runtime),[base_id]:row});
}
export function clearDockRefused(runtime:string,base_id:string):void {
  const kept=readDockRefusals(runtime);
  if(!(base_id in kept))return;
  delete kept[base_id];
  keepJson(runtime,DOCKING,kept);
}
