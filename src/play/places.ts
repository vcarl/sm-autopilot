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
