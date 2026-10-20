/** The public galaxy map kept in `runtime/galaxy.json`, and ids fitted onto a rect of it. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';
import {fetchMap,type GalaxyMap} from '@spacemolt/lib';
import {keepJson} from '../play/places.ts';

export interface Galaxy {fetched_at:string;systems:Record<string,{id:string;name:string;x:number;y:number;connections:string[]}>}
export interface Placed {id:string;x:number;y:number;known:boolean}

const FILE='galaxy.json',BASE='https://game.spacemolt.com',DAY_MS=24*60*60_000;
const decode=Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({fetched_at:Schema.String,systems:Schema.Record(Schema.String,
  Schema.Struct({id:Schema.String,name:Schema.String,x:Schema.Number,y:Schema.Number,connections:Schema.Array(Schema.String)}))})));

/** The kept map, refetched when absent or older than `maxAgeMs`; a failed fetch answers the stale copy, else an empty galaxy. Never throws. */
export async function loadGalaxy(runtime:string,opts:{maxAgeMs?:number;fetch?:(base:string)=>Promise<GalaxyMap>;base?:string}={}):Promise<Galaxy> {
  let copy:Galaxy|undefined;
  try {
    const read=decode(readFileSync(join(runtime,FILE),'utf8'));
    if(Option.isSome(read))copy={fetched_at:read.value.fetched_at,systems:Object.fromEntries(Object.entries(read.value.systems).map(([id,system])=>[id,{...system,connections:[...system.connections]}]))};
  } catch {} // edge: no copy yet, or one that cannot be read
  if(copy&&Date.now()-Date.parse(copy.fetched_at)<(opts.maxAgeMs??DAY_MS))return copy;
  try {
    const got=await (opts.fetch??fetchMap)(opts.base??BASE);
    const fresh:Galaxy={fetched_at:new Date().toISOString(),systems:Object.fromEntries(got.systems.flatMap(({id,name,x,y,connections})=> // edge: a malformed entry is dropped, so what is kept always decodes again
      typeof id==='string'&&Number.isFinite(x)&&Number.isFinite(y)&&Array.isArray(connections)?[[id,{id,name:typeof name==='string'?name:id,x,y,connections:connections.filter(c=>typeof c==='string')}]]:[]))};
    if(Object.keys(fresh.systems).length>0) { // edge: an empty answer is not a map; it must not replace a good copy
      keepJson(runtime,FILE,fresh);
      return fresh;
    }
  } catch {} // edge: the map is public HTTP, not the game; offline draws what was kept
  return copy??{fetched_at:'1970-01-01T00:00:00.000Z',systems:{}};
}

/** `ids` placed in `rect`, known systems scaled alike on both axes and centred inside `margin`; unknown ids in a row along the bottom edge. */
export function fit(ids:string[],galaxy:Galaxy,rect:{x:number;y:number;w:number;h:number},margin=24):{placed:Record<string,Placed>;unknown:string[]} {
  const all=[...new Set(ids)],known=all.flatMap(id=>galaxy.systems[id]??[]),unknown=all.filter(id=>!galaxy.systems[id]);
  const [x0,x1]=[Math.min(...known.map(s=>s.x)),Math.max(...known.map(s=>s.x))],[y0,y1]=[Math.min(...known.map(s=>s.y)),Math.max(...known.map(s=>s.y))];
  const scale=Math.min(x1>x0?(rect.w-2*margin)/(x1-x0):Infinity,y1>y0?(rect.h-2*margin)/(y1-y0):Infinity),k=Number.isFinite(scale)?scale:0;
  const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2,placed:Record<string,Placed>={};
  for(const s of known)placed[s.id]={id:s.id,x:cx+(s.x-(x0+x1)/2)*k,y:cy+(s.y-(y0+y1)/2)*k,known:true};
  unknown.forEach((id,i)=>{placed[id]={id,x:rect.x+margin+(i+0.5)*(rect.w-2*margin)/unknown.length,y:rect.y+rect.h-margin,known:false};});
  return {placed,unknown};
}

/** Ids connected to any of `ids`, first seen first, once each; the visited ids and ids not in the galaxy are left out. */
export function neighbours(ids:string[],galaxy:Galaxy):string[] {
  const visited=new Set(ids);
  return [...new Set(ids.flatMap(id=>galaxy.systems[id]?.connections??[]))].filter(id=>!visited.has(id)&&galaxy.systems[id]!==undefined);
}
