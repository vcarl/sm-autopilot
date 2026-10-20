/** The end-of-flight post (spec "Plugin side"; Carl's merge bar, 2026-10-19: "the recent locations/actions map and 2 moments from a
 * flight"): the juncture's activity map (raster.ts, drawn as it is, no restyle) and a seat selfie of each of the flight's two moments
 * (oracle.ts `flightScenes`), at `<runtime>/images/{map,selfie}-<utc stamp>[-n].png`, and when SPACEMOLT_JOURNAL_WEBHOOK is set,
 * one Discord message with the map first, then the selfies, and the caption. A flight with no own act (no moment 1) draws nothing.
 * `flight` never throws: each image that fails is `ok: false` with its error, and the rest still post.
 *
 * Run as `node src/picture/flight.ts <runtime> <run_id>` by the bridge (src/pictures.ts), which reads the one JSON line it prints.
 * A child, not a call: the oracle reads 72 h of the frame log (moments.ts `readSince`), well under a second but some 450 MB
 * resident at its peak, half of it the modules, which the bridge's event loop and memory must never pay. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {loadGalaxy} from './galaxy.ts';
import {NEUTRAL,draw,imagerOf,seedOf,type Imager} from './imager.ts';
import {depicted} from './moments.ts';
import {flightScenes,oracleLine,soulPath,type Scene} from './oracle.ts';
import {CAMERA_ORDER,caption,promptOf} from './prompts.ts';
import {renderMap} from './raster.ts';
import {fetchRef,refOf} from './refs.ts';
import {catalogItems,speciesFacts,speciesName,speciesRef} from './species.ts';

export interface Image {kind:'map'|'selfie';ok:boolean;path:string|null;error:string|null;ms:number;
  moment?:{category:string;type:string}|null;seed?:number;camera?:string;prompt?:string;subject_ref?:string|null}
/** `error`: the flight could not be read at all (no scene); an image's own failure is on the image. */
export interface Post {ok:boolean;skipped?:'idle';error?:string;images:Image[];caption:string|null;model:string;posted:boolean|null;post_error?:string}
export interface Flight {picture:Post;oracles:ReturnType<typeof oracleLine>[]}
export interface FlightDeps {env?:Record<string,string|undefined>;fetch?:typeof fetch;now?:()=>Date;
  /** For the tests: the scenes and the map, which otherwise come from the runtime dir. */
  scenes?:(runtime:string,run_id:string)=>Promise<Scene[]>;map?:(runtime:string,juncture:string,pilot:string)=>Promise<Uint8Array>}
const message=(e:unknown)=>e instanceof Error?e.message:String(e);

/** Discord takes files as multipart: the message as `payload_json`, the files as `files[0]`, `files[1]`, … (ten at most). */
export async function postPictures(url:string,files:readonly {png:Uint8Array;name:string}[],content:string,send:typeof fetch=fetch):Promise<void> {
  const form=new FormData();
  form.append('payload_json',JSON.stringify({content:content.slice(0,1900),allowed_mentions:{parse:[]}}));
  files.forEach((f,i)=>form.append(`files[${i}]`,new Blob([new Uint8Array(f.png)],{type:'image/png'}),f.name));
  const r=await send(url,{method:'POST',body:form,signal:AbortSignal.timeout(60_000)});
  if(!r.ok)throw new Error(`webhook HTTP ${r.status}: ${(await r.text().catch(()=>'')).slice(0,200)}`);
}

/** A moment in a few words: what the lead did, the subject's name, where. */
export function momentWords(s:Scene):string|null {
  const lead=s.moment?depicted(s.moment)?.lead:undefined;
  if(!lead)return null;
  const what=lead.type.replace(/^spacemolt[a-z_]*\//,'').replace(/_/g,' ');
  return `${what}${s.subject&&s.subject.kind!=='item'?` (${s.subject.name})`:''}${s.where.poi_name?` at ${s.where.poi_name}`:''}`;
}
/** Where, how and lately (prompts.ts `caption`), then the moments. */
export const flightCaption=(scenes:readonly Scene[])=>{
  const words=scenes.flatMap(s=>momentWords(s)??[]),first=scenes[0];
  return [first?caption(first):'',words.length?`moments: ${words.join('; ')}`:''].filter(Boolean).join(' · ');
};
/** The pilot's name for the map's title: SOUL.md's `You are <Name>`, else "Pilot". */
const pilotName=(runtime:string)=>{try {return /\bYou are ([A-Z][\w'-]*)/.exec(readFileSync(soulPath(runtime),'utf8'))?.[1]??'Pilot';} catch {return 'Pilot';}}; // edge: no SOUL.md

async function selfie(runtime:string,scene:Scene,seed:number,imager:Imager,send:typeof fetch):Promise<{image:Image;png:Uint8Array|null}> {
  const t0=Date.now(),cache=join(runtime,'refs'),lead=scene.moment?depicted(scene.moment)?.lead:undefined,made=promptOf('selfie',scene,imager.style,seed);
  const ref=scene.subject&&made.subject?refOf(scene.subject):null;
  const image:Image={kind:'selfie',ok:false,path:null,error:null,ms:0,moment:lead?{category:lead.category,type:lead.type}:null,seed,
    camera:CAMERA_ORDER[seed%CAMERA_ORDER.length]??'shoulder',prompt:made.text,subject_ref:ref?.url??null};
  try {
    const items=ref?.url.startsWith('species:')?catalogItems(runtime):[];
    const got=ref?await fetchRef(ref,cache,sp=>speciesRef(sp,{name:speciesName(scene,sp),facts:speciesFacts(items,sp),cache,imager,fetch:send}),send):null;
    // As flight-prompt.ts: the subject keeps its place as <image1> when its art could not be had; with none, the flat NEUTRAL frame is edited.
    const png=await draw(imager,{prompt:made.text,refs:ref?[got?.sent??NEUTRAL]:[],seed},{fetch:send,timeoutMs:180_000});
    return {image:{...image,ok:true,ms:Date.now()-t0},png};
  } catch(e) {return {image:{...image,error:message(e),ms:Date.now()-t0},png:null};}
}

export async function flight(runtime:string,run_id:string,o:FlightDeps={}):Promise<Flight> {
  const env=o.env??process.env,imager=imagerOf(env),send=o.fetch??fetch;
  const post:Post={ok:false,images:[],caption:null,model:imager.model,posted:null};
  let scenes:Scene[];
  try {scenes=await (o.scenes??flightScenes)(runtime,run_id);} catch(e) {return {picture:{...post,error:message(e)},oracles:[]};}
  const oracles=scenes.map(oracleLine),first=scenes[0];
  if(!first)return {picture:{...post,error:`no ended run ${run_id} in the journal`},oracles};
  // Carl's channel, ~90 runs a day: a flight with no own act (the majority rule's empty case) posts nothing.
  if(!first.moment)return {picture:{...post,skipped:'idle'},oracles};
  post.caption=flightCaption(scenes);
  const stamp=(o.now?.()??new Date()).toISOString().replace(/\.\d+Z$/,'Z').replaceAll(':','-'),dir=join(runtime,'images');
  const juncture=first.juncture_id??run_id,base=seedOf(run_id);
  const mapped=(async():Promise<{image:Image;png:Uint8Array|null}>=>{
    const t0=Date.now(),image:Image={kind:'map',ok:false,path:null,error:null,ms:0};
    try {
      const png=o.map?await o.map(runtime,juncture,pilotName(runtime)):(await renderMap(runtime,{juncture,pilot:pilotName(runtime),galaxy:await loadGalaxy(runtime,{maxAgeMs:Infinity})})).png;
      return {image:{...image,ok:true,ms:Date.now()-t0},png};
    } catch(e) {return {image:{...image,error:message(e),ms:Date.now()-t0},png:null};}
  })();
  // The map is CPU and the selfies wait on the image server, so the map is drawn while the first selfie is; the selfies one by one.
  const drawn:{image:Image;png:Uint8Array|null}[]=[];
  for(const [i,scene] of scenes.entries())drawn.push(await selfie(runtime,scene,base+i,imager,send));
  const all=[await mapped,...drawn];
  mkdirSync(dir,{recursive:true});
  const files:{png:Uint8Array;name:string}[]=[];
  for(const [i,{image,png}] of all.entries()) {
    if(!png)continue;
    const path=join(dir,image.kind==='map'?`map-${stamp}.png`:`selfie-${stamp}-${i}.png`);
    try {writeFileSync(path,png);image.path=path;files.push({png,name:basename(path)});}
    catch(e) {image.ok=false;image.error=message(e);}
  }
  post.images=all.map(x=>x.image);
  post.ok=files.length>0;
  const hook=env.SPACEMOLT_JOURNAL_WEBHOOK;
  if(hook&&files.length)try {await postPictures(hook,files,post.caption,send);post.posted=true;} catch(e) {post.posted=false;post.post_error=message(e);}
  return {picture:post,oracles};
}

if(import.meta.main) {
  const [runtime='',run='']=process.argv.slice(2);
  process.stdout.write(`${JSON.stringify(await flight(runtime,run))}\n`);
}
