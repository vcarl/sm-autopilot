/** Where each base is: `places.json` in the pilot's runtime dir, base id to system id. Written
 * whenever a base's system is learned — a docked `book()`, a `find_route` in `routes()`, a
 * freighter arriving at a stop — and read by `farBooks`, so a base is placed once, ever. A ledger
 * entry carries no system, so without this every `routes()` would place the same bases again. */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';

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
