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
/** Temp file then rename; a no-op when the place is already kept or either id is empty. */
export function markPlace(runtime:string,base_id:string,system_id:string):void {
  const places=readPlaces(runtime);
  if(!base_id||!system_id||places[base_id]===system_id)return;
  try {
    mkdirSync(runtime,{recursive:true});
    const path=join(runtime,FILE),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify({...places,[base_id]:system_id},null,2),{mode:0o600});
    renameSync(temp,path);
  } catch {/* a place not kept is only looked up again */}
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
/** Temp file then rename; a no-op when the id is already listed or empty. */
function addToList(runtime:string,file:string,id:string):void {
  const ids=readList(runtime,file);
  if(!id||ids.has(id))return;
  try {
    mkdirSync(runtime,{recursive:true});
    const path=join(runtime,file),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify([...ids,id],null,2),{mode:0o600});
    renameSync(temp,path);
  } catch {/* unkept: seen again next time */}
}
