/** The reference image a picture sends: the one subject the moment calls for (`subjectOf`), its codex art (or a species
 * portrait, species.ts) cropped to the subject (crop.ts), and an ETag cache of the files. One reference, because only the
 * most forcefully posed subject is re-posed; the others keep their catalog poses (experiments/qwen-spike/README.md, finding 9). */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {extname,join} from 'node:path';
import {keepJson} from '../play/places.ts';
import {isRecord} from '../run-record.ts';
import {crop,type Box} from './crop.ts';
import {INVOLVEMENT,depicted,type Kind,type Moment,type Scored} from './moments.ts';

export const CDN='https://assets.spacemolt.com/images/';
/** A species reference, resolved when it is fetched (species.ts): `species:<id>`. */
export const SPECIES='species:';
export type SubjectKind='ship'|'creature'|'item';
/** Events in which a ship named is one fought. A ship named elsewhere (an arrival's neighbours) is no subject. */
const FOUGHT=new Set(['combat','hazard']);

/** The one subject a picture draws from a reference: the moment's best-scoring event that has one (system & connection and
 * uncatalogued are never depicted), and in it a ship fought, else a creature, else an item. The pilot's own events come first;
 * only when none has a subject does a battle it merely heard of count, and then only its ship, only in the system the picture
 * shows (the depicted lead's, as the frames give it), drawn at a distance (`fought` false). Null when no event has one. */
/** `noProp`: items that are no prop (oracle.ts `PROPS`). Live 2026-10-19 (recipe3 and recipe4, 3db6ff6c): the Argon Gas art, a
 * glowing tube, drew as fire on the console in every render. An extraction offers no item at all: its picture is the body mined
 * outside the canopy (live 2026-10-19, recipe6, a28932b8: quantum fragments on the console drew as glowing flowers). */
export function subjectOf(m:Moment|null,noProp:ReadonlySet<string>=new Set()):{kind:SubjectKind;id:string;event:Scored;fought:boolean}|null {
  const events=[...m?.events??[]].sort((a,b)=>b.score-a.score).filter(e=>e.category!=='system'&&e.category!=='uncatalogued');
  const id=(e:Scored,k:Kind)=>e.identities.find(i=>i.kind===k)?.id;
  for(const e of events.filter(e=>e.involvement===INVOLVEMENT.self)) {
    const fought=FOUGHT.has(e.category),ship=fought?id(e,'ship_class'):undefined,creature=id(e,'species'),item=e.category==='extraction'?undefined:e.identities.find(i=>i.kind==='item'&&!noProp.has(i.id))?.id;
    if(ship)return {kind:'ship',id:ship,event:e,fought};
    if(creature)return {kind:'creature',id:creature,event:e,fought};
    if(item)return {kind:'item',id:item,event:e,fought};
  }
  // Live 2026-10-19 (kvothe 7b7030a8): a battle in Nashira, heard of on the way, drew its Dialectic diving at us over Bharani.
  const here=m?depicted(m)?.lead.pilot?.system:undefined,seen=(e:Scored)=>(typeof e.facts.system_id==='string'?e.facts.system_id:e.pilot?.system)===here;
  for(const e of events.filter(e=>e.involvement!==INVOLVEMENT.self&&FOUGHT.has(e.category)&&here&&seen(e))) {
    const ship=id(e,'ship_class');
    if(ship)return {kind:'ship',id:ship,event:e,fought:false};
  }
  return null;
}

/** ponytail: one fixed crop per kind of art, read off the codex's framing (ships: 1200x896 photos, the ship in the middle
 * band with a yard or a starfield around it; items: a square, the item centred on dark). A species portrait is already one
 * creature on a plain ground and is sent whole. A subject outside its box is cut: lift to a box per image, or a detector, then. */
export const BOXES:Record<SubjectKind,Box|null>={ship:{x:0.08,y:0.2,w:0.8,h:0.6},item:{x:0.15,y:0.15,w:0.7,h:0.7},creature:null};
export interface Ref {kind:SubjectKind;url:string;box:Box|null}
export const refOf=(s:{kind:SubjectKind;id:string}):Ref=>({kind:s.kind,box:BOXES[s.kind],
  url:s.kind==='ship'?`${CDN}ships/catalog/${s.id}.webp`:s.kind==='item'?`${CDN}items/${s.id}.webp`:SPECIES+s.id});

/** A species' image, catalog or portrait (species.ts `speciesRef`, bound to its runtime and imager). */
export type SpeciesSource=(id:string)=>Promise<{bytes:Uint8Array;type:string;source:string;status:string}>;
export interface Fetched {url:string;status:string;type?:string;bytes?:number;error?:string;
  /** The bytes sent: the crop, else the image whole; null when it could not be fetched. */
  sent:Uint8Array|null;crop:{box:Box;px:Box;from:{width:number;height:number}}|null;portrait:Uint8Array|null}
/** `ref`'s image through the cache, a species through `species` (a portrait drawn now is `generated`, a kept one `cache`),
 * cropped to its box. One that cannot be fetched is not sent: the picture is drawn without it. */
export async function fetchRef(ref:Ref,cache:string,species?:SpeciesSource,send?:typeof fetch):Promise<Fetched> {
  let got:{bytes:Uint8Array;type:string;status:string;portrait:boolean};
  try {
    if(ref.url.startsWith(SPECIES)) {
      if(!species)throw new Error('no species source');
      const s=await species(ref.url.slice(SPECIES.length));
      got={bytes:s.bytes,type:s.type,status:s.source==='generated'?s.status==='made'?'generated':'cache':s.status,portrait:s.source==='generated'};
    } else {const c=await cachedRef(ref.url,cache,send?{fetch:send}:{});got={...c,portrait:false};}
  } catch(error) {return {url:ref.url,status:'failed',error:error instanceof Error?error.message:String(error),sent:null,crop:null,portrait:null};}
  const cut=ref.box?await crop(got.bytes,got.type,ref.box):null;
  return {url:ref.url,status:got.status,type:got.type,bytes:got.bytes.length,sent:cut?.png??got.bytes,
    crop:cut&&ref.box?{box:ref.box,px:cut.px,from:cut.from}:null,portrait:got.portrait?got.bytes:null};
}

export interface Cached {bytes:Uint8Array;type:string;status:'cache'|'200'|'304'}
interface Entry {file:string;type:string;etag?:string;last_modified?:string;fetched_at:number;max_age:number}
const TYPES:Record<string,string>={'.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png'};
const MANIFEST='manifest.json';

function manifest(dir:string):Record<string,Entry> {
  try {const read:unknown=JSON.parse(readFileSync(join(dir,MANIFEST),'utf8'));return isRecord(read)?Object.fromEntries(Object.entries(read).flatMap(([url,e])=>
    isRecord(e)&&typeof e.file==='string'&&typeof e.fetched_at==='number'?[[url,{file:e.file,type:String(e.type??''),fetched_at:e.fetched_at,max_age:Number(e.max_age)||0,
      ...typeof e.etag==='string'?{etag:e.etag}:{},...typeof e.last_modified==='string'?{last_modified:e.last_modified}:{}}]]:[])):{};}
  catch {return {};} // edge: no manifest yet, or a torn one, is an empty cache
}

/** `url`'s bytes through the cache in `dir` (production: `runtime/refs/`): a manifest keyed by URL
 * holds each file's ETag, Last-Modified, fetch time and max-age. Inside max-age the file is used as
 * kept; past it, or with `revalidate`, the request carries `If-None-Match`/`If-Modified-Since` and a
 * 304 reuses the file. Anything but 200 or 304 throws. */
export async function cachedRef(url:string,dir:string,opts:{fetch?:typeof fetch;now?:()=>number;revalidate?:boolean}={}):Promise<Cached> {
  const now=opts.now??Date.now,all=manifest(dir),kept=all[url],path=kept?join(dir,kept.file):undefined;
  const have=kept&&path&&existsSync(path)?kept:undefined;
  if(have&&path&&!opts.revalidate&&now()-have.fetched_at<have.max_age*1000)return {bytes:readFileSync(path),type:have.type,status:'cache'};
  const headers:Record<string,string>={'user-agent':'sm-autopilot (picture refs)'};
  if(have?.etag)headers['if-none-match']=have.etag;
  if(have?.last_modified)headers['if-modified-since']=have.last_modified;
  const res=await (opts.fetch??fetch)(url,{headers,signal:AbortSignal.timeout(60_000)});
  if(res.status!==200&&!(res.status===304&&have))throw new Error(`${url}: HTTP ${res.status}`);
  const age=/max-age=(\d+)/.exec(res.headers.get('cache-control')??'')?.[1];
  const file=have?.file??createHash('sha1').update(url).digest('hex')+extname(new URL(url).pathname);
  const bytes=res.status===304&&path?readFileSync(path):new Uint8Array(await res.arrayBuffer());
  if(res.status===200){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,file),bytes);}
  const etag=res.headers.get('etag')??have?.etag,last_modified=res.headers.get('last-modified')??have?.last_modified;
  const type=res.status===200?res.headers.get('content-type')??TYPES[extname(file)]??'application/octet-stream':have?.type??'application/octet-stream';
  keepJson(dir,MANIFEST,{...manifest(dir),[url]:{file,type,fetched_at:now(),max_age:age?Number(age):have?.max_age??0,...etag?{etag}:{},...last_modified?{last_modified}:{}}});
  return {bytes,type,status:res.status===304?'304':'200'};
}
