/** Where each base is: `places.json` in the pilot's runtime dir, base id to system id. Written
 * whenever a base's system is learned — a docked `book()`, a `find_route` in `routes()`, a
 * freighter arriving at a stop — and read by `farBooks`, so a base is placed once, ever. A ledger
 * entry carries no system, so without this every `routes()` would place the same bases again. */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';
import {isRecord} from '../run-record.ts';
import {replyBody} from '../storage.ts';

const FILE='places.json';

/** Read leniently: a row whose value is not a string is dropped, the rest kept; a file that is
 * not a record at all reads as empty. */
const decodePlaces=Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String,Schema.Unknown)));
const decodeIds=Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

export function readPlaces(runtime:string):Record<string,string> {
  try {
    const places=decodePlaces(readFileSync(join(runtime,FILE),'utf8'));
    return Option.isSome(places)?Object.fromEntries(Object.entries(places.value).flatMap(([base,system])=>typeof system==='string'?[[base,system]]:[])):{};
  } catch {return {};} // edge: an absent or unreadable file is no places kept
}
/** Write `file` in `dir` as JSON, temp file then rename, so a reader never sees half of it. A
 * failed write is dropped: everything kept this way is only looked up or seen again. */
export function keepJson(dir:string,file:string,value:unknown):void {
  try {
    mkdirSync(dir,{recursive:true});
    const path=join(dir,file),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
    renameSync(temp,path);
  } catch {} // edge: a write that fails is dropped; the next look keeps it again
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
  try {
    const ids=decodeIds(readFileSync(join(runtime,file),'utf8'));
    return new Set(Option.isSome(ids)?ids.value.flatMap(id=>typeof id==='string'?[id]:[]):[]);
  } catch {return new Set();} // edge: an absent or unreadable file is an empty list
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
/** A record of rows, read leniently: a row that is not `T` is dropped, the rest kept. */
function readRecord<T>(runtime:string|undefined,file:string,row:(value:unknown)=>T|undefined):Record<string,T> {
  if(!runtime)return {};
  try {
    const kept=decodePlaces(readFileSync(join(runtime,file),'utf8'));
    return Option.isSome(kept)?Object.fromEntries(Object.entries(kept.value).flatMap(([id,value])=>{const read=row(value);return read===undefined?[]:[[id,read]];})):{};
  } catch {return {};} // edge: an absent or unreadable file is nothing kept
}
const dockRow=(value:unknown):DockRefusal|undefined=>{
  if(!isRecord(value)||typeof value.message!=='string'||typeof value.at!=='string')return undefined;
  return {...typeof value.system_id==='string'?{system_id:value.system_id}:{},message:value.message,at:value.at};
};
export const readDockRefusals=(runtime:string|undefined):Record<string,DockRefusal>=>readRecord(runtime,DOCKING,dockRow);
export function markDockRefused(runtime:string,base_id:string,row:DockRefusal):void {
  keepJson(runtime,DOCKING,{...readDockRefusals(runtime),[base_id]:row});
}
export function clearDockRefused(runtime:string,base_id:string):void {
  const {[base_id]:gone,...kept}=readDockRefusals(runtime);
  if(gone)keepJson(runtime,DOCKING,kept);
}

/** Display names for opaque ids: `names.json` beside `places.json`, id to the name the game gave
 * it. Live 2026-10-02 (kvothe): player bases and POIs have hex ids (`b495c6003fc83e18f6d8cecbe6929133`
 * at Dheneb), and the pilot's replies carried them raw ("between nova_terra_central and b495c600…").
 * Learned from replies already being read, at the command seam (the bridge's and each freighter's),
 * so it costs no game call. Only opaque ids are kept: `nova_terra_central` is its own name. Writes
 * `names.json` only, never a journal line. */
const NAMES='names.json';
const OPAQUE=/^[0-9a-f]{16,}$/;
export const readNames=(runtime:string|undefined):Record<string,string>=>readRecord(runtime,NAMES,value=>typeof value==='string'?value:undefined);
/** Every id/name pair a reply carries: `base_id`/`base_name` and `poi_id`/`poi_name` anywhere in it,
 * `get_system`'s POI rows, `get_base`'s base, and `find_route`'s target POI. A routed base with no
 * name of its own yet is named for the POI it sits at (`find_route` says "travel to Hex Star"),
 * until a read that names the base itself replaces it. */
export function learnNames(runtime:string,action:string,params:Record<string,unknown>|undefined,reply:unknown):void {
  const body=replyBody(reply),named:Record<string,string>={},fallback:Record<string,string>={};
  const at=(value:unknown,key:string):unknown=>isRecord(value)?value[key]:undefined;
  const put=(to:Record<string,string>,id:unknown,name:unknown)=>{
    if(typeof id==='string'&&OPAQUE.test(id)&&typeof name==='string'&&name.trim()&&name!==id)to[id]=name.trim();};
  const walk=(value:unknown,depth:number):void=>{
    if(!isRecord(value)||depth>6)return;
    if(Array.isArray(value)){for(const row of value)walk(row,depth+1);return;}
    put(named,value.base_id,value.base_name);put(named,value.poi_id,value.poi_name);
    for(const child of Object.values(value))walk(child,depth+1);
  };
  // A base's id can be its POI's (report 02), so the POI's name goes in first and the base's
  // own, from the walk, lands over it.
  const verb=action.split('/')[1],pois=at(at(body,'system'),'pois'),base=at(body,'base');
  if(verb==='get_system'&&Array.isArray(pois))for(const poi of pois)put(named,at(poi,'id'),at(poi,'name'));
  if(verb==='get_base')put(named,at(base,'id'),at(base,'name'));
  walk(body,0);
  if(verb==='find_route'&&at(body,'found')!==false){put(fallback,at(body,'target_poi'),at(body,'target_poi_name'));put(fallback,params?.id,at(body,'target_poi_name'));}
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
    return after?.[1]?.includes(name)?id:placeName(id,names);
  });
}
