/** Where each base is: `places.json` in the pilot's runtime dir, base id to system id. Written
 * whenever a base's system is learned — a docked `book()`, a `find_route` in `routes()`, a
 * freighter arriving at a stop — and read by `farBooks`, so a base is placed once, ever. A ledger
 * entry carries no system, so without this every `routes()` would place the same bases again. */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {details} from '../response-details.ts';

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

/** Display names for opaque ids: `names.json` beside `places.json`, id to the name the game gave
 * it. Live 2026-10-02 (kvothe): player bases and POIs have hex ids (`b495c6003fc83e18f6d8cecbe6929133`
 * at Dheneb), and the pilot's replies carried them raw ("between nova_terra_central and b495c600…").
 * Learned from replies already being read, at the command seam (the bridge's and each freighter's),
 * so it costs no game call. Only opaque ids are kept: `nova_terra_central` is its own name. */
const NAMES='names.json';
const OPAQUE=/^[0-9a-f]{16,}$/;
export function readNames(runtime:string|undefined):Record<string,string> {
  if(!runtime)return {};
  try {const kept=JSON.parse(readFileSync(join(runtime,NAMES),'utf8'));return kept&&typeof kept==='object'&&!Array.isArray(kept)?kept:{};}
  catch {return {};}
}
/** Every id/name pair a reply carries: `base_id`/`base_name` and `poi_id`/`poi_name` anywhere in it,
 * `get_system`'s POI rows, `get_base`'s base, and `find_route`'s target POI. A routed base with no
 * name of its own yet is named for the POI it sits at (`find_route` says "travel to Hex Star"),
 * until a read that names the base itself replaces it. */
export function learnNames(runtime:string,action:string,params:Record<string,unknown>|undefined,reply:unknown):void {
  const body=details(reply) as Record<string,any>,named:Record<string,string>={},fallback:Record<string,string>={};
  const put=(to:Record<string,string>,id:unknown,name:unknown)=>{
    if(typeof id==='string'&&OPAQUE.test(id)&&typeof name==='string'&&name.trim()&&name!==id)to[id]=name.trim();};
  const walk=(value:unknown,depth:number):void=>{
    if(!value||typeof value!=='object'||depth>6)return;
    if(Array.isArray(value)){for(const row of value)walk(row,depth+1);return;}
    const row=value as Record<string,unknown>;
    put(named,row.base_id,row.base_name);put(named,row.poi_id,row.poi_name);
    for(const child of Object.values(row))walk(child,depth+1);
  };
  // A base's id can be its POI's (report 02), so the POI's name goes in first and the base's
  // own, from the walk, lands over it.
  const verb=action.split('/')[1];
  if(verb==='get_system')for(const poi of (body.system?.pois??[]) as Record<string,unknown>[])put(named,poi.id,poi.name);
  if(verb==='get_base')put(named,body.base?.id,body.base?.name);
  walk(body,0);
  if(verb==='find_route'&&body.found!==false){put(fallback,body.target_poi,body.target_poi_name);put(fallback,params?.id,body.target_poi_name);}
  if(!Object.keys(named).length&&!Object.keys(fallback).length)return;
  // A base's own name beats the POI name it was routed by; a kept name beats a fallback.
  const kept=readNames(runtime),next={...fallback,...kept,...named};
  if(Object.keys(next).some(id=>next[id]!==kept[id]))keepJson(runtime,NAMES,next);
}
/** An opaque id as the pilot reads it, `Name (id)`; the id stays whole so it can be passed back
 * to `goTo`. An id with no known name, or a readable one, is itself. */
export const placeName=(id:string,names:Record<string,string>):string=>names[id]?`${names[id]} (${id})`:id;
/** `placeName` over prose: every bare opaque id in `text` gains its name. An id in quotes is code
 * (`goTo('…')`, `{at:'…'}`) and is left alone, as is one whose name already stands beside it. */
export function nameIds(text:string,names:Record<string,string>):string {
  if(!text||!Object.keys(names).length)return text;
  return text.replace(/(?<![\w'"])[0-9a-f]{16,}(?![\w'"])/g,(id:string,at:number)=>{
    const name=names[id];
    if(!name||text.slice(Math.max(0,at-name.length-2),at)===`${name} (`)return id;
    const after=/^ \(([^)]*)\)/.exec(text.slice(at+id.length));
    return after?.[1]!.includes(name)?id:placeName(id,names);
  });
}
