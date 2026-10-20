/** A species' reference image: the game's own art when it publishes some, else a portrait generated once
 * from what the game says about the species, kept per species and reused for every picture after.
 *
 * What the game says (2026-10-17): `CreatureInfo` (get_nearby, observation) carries `species`, `name`,
 * `role` and hull; `scan` reports species, role (grazer/predator), danger and hull; the catalog has no
 * species list, and no species description exists anywhere; catalog item descriptions name the species
 * their loot comes from ("scraped from a veil-ray's filtering combs"). docs/wildlife.md describes the
 * fauna in general (forty-five spaceborne species, grazers/predators/scavengers) and publishes no
 * per-species facts. No creature art is on the CDN. */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isRecord} from '../run-record.ts';
import {draw,seedOf,type Imager} from './imager.ts';
import {speciesKey} from './moments.ts';
import type {Scene} from './oracle.ts';
import {cachedRef} from './refs.ts';

// ponytail: a guess at where the game will publish species art (images/creatures, species, wildlife,
// fauna and codex/creatures all 404 on 2026-10-17); a miss is re-probed daily, so art that appears is
// used with no code change. Replace with the real path once the game names it.
export const SPECIES_ART='https://assets.spacemolt.com/images/creatures/{id}.webp';
export const MISSING_RECHECK_MS=24*3600_000,PORTRAIT_SIZE='1024x1024';

export interface Manifest {source?:'catalog'|'generated';url?:string;prompt?:string;prompt_sha?:string;seed?:number;model?:string;at?:string;catalog_missing_at?:string}
export interface SpeciesImage {bytes:Uint8Array;type:string;source:'catalog'|'generated';status:'cache'|'200'|'304'|'made'}

const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** What the game itself says of the species: each catalog item description that says the item comes from
 * one ("from a veil-ray", "a veil-ray's combs"; "veil_ray" also matches "veil ray"), verbatim. An item only
 * made from such an item ("set from veil-ray verdigris curd") says nothing of the creature and is left out. */
export function speciesFacts(items:readonly unknown[],id:string):string[] {
  const name=id.split('_').map(escape).join('[- ]?'),re=new RegExp(`\\bfrom an? ${name}\\b|\\b${name}'s\\b`,'i');
  return items.flatMap(i=>isRecord(i)&&typeof i.description==='string'&&re.test(i.description)?[i.description]:[]);
}

/** What the name itself says: split on hyphens and spaces, the last word is the kind of creature and the earlier
 * ones what marks it ("Veil-Ray": a ray-like creature with veil-like features; no article inside, since a rule cannot tell
 * "a veil" from "ash"). One word says nothing more (null); no anatomy beyond the words. */
export function creatureClause(name:string):string|null {
  const words=name.toLowerCase().split(/[-\s]+/).filter(Boolean),kind=words.pop(),marks=words.join(' ');
  return kind&&marks?`a ${kind}-like creature with ${marks}-like features`:null;
}
export const nameClause=(name:string)=>{const c=creatureClause(name);return c?[`Its name describes it: ${c}.`]:[];};

/** The portrait prompt: the creature alone as a reference study, from the game's own words only (its name,
 * then any catalog sentence naming it). No style line: it is a reference, not a picture. */
export const portraitPrompt=(name:string,facts:readonly string[])=>[
  `Reference study of a single ${name}, a spaceborne creature, alone: full body, centred on a plain dark background.`,
  ...nameClause(name),
  ...facts.length?[`The game's catalog says, of what comes from it: ${facts.map(f=>`"${f}"`).join(' ')}`]:[],
  'No ships, no other creatures, no text.'].join(' ');

/** The catalog's items (`runtime/catalog.json`, the game's public catalog the lib keeps); none without one. */
export function catalogItems(runtime:string):unknown[] {
  try {const c:unknown=JSON.parse(readFileSync(join(runtime,'catalog.json'),'utf8'));const items=isRecord(c)&&isRecord(c.catalog)?c.catalog.items:undefined;return Array.isArray(items)?items:[];}
  catch {return [];} // edge: no catalog kept yet is no catalog facts
}

/** A species' display name: as the game named it in the moment ("Veil-Ray"), else the Scene's name for the id, else the id title-cased. */
export function speciesName(s:Pick<Scene,'moment'|'names'>,id:string):string {
  const said=s.moment?.events.flatMap(e=>e.identities).find(i=>i.kind==='opponent'&&speciesKey(i.id)===id)?.id;
  return said??s.names[id]??id.split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}

const read=(path:string):Manifest=>{try {const m:unknown=JSON.parse(readFileSync(path,'utf8'));return isRecord(m)?{
  ...m.source==='catalog'||m.source==='generated'?{source:m.source}:{},...typeof m.url==='string'?{url:m.url}:{},...typeof m.prompt==='string'?{prompt:m.prompt}:{},...typeof m.prompt_sha==='string'?{prompt_sha:m.prompt_sha}:{},
  ...typeof m.seed==='number'?{seed:m.seed}:{},...typeof m.model==='string'?{model:m.model}:{},...typeof m.at==='string'?{at:m.at}:{},
  ...typeof m.catalog_missing_at==='string'?{catalog_missing_at:m.catalog_missing_at}:{}}:{};} catch {return {};}}; // edge: no manifest is a species never looked up

/** `id`'s reference, in order: the catalog art at `SPECIES_ART` (ETag-cached like every reference; a 404 is
 * remembered for `MISSING_RECHECK_MS`, then probed again), else the portrait kept at
 * `<cache>/species/<id>.png` with its manifest, else a portrait generated now and kept. A portrait is
 * made again only when its prompt changes (the manifest's `prompt_sha`) or its manifest is deleted; catalog art is never replaced by one. */
export async function speciesRef(id:string,o:{name:string;facts:readonly string[];cache:string;imager:Imager;fetch?:typeof fetch;now?:()=>number}):Promise<SpeciesImage> {
  const now=o.now??Date.now,dir=join(o.cache,'species'),meta=join(dir,`${id}.json`),png=join(dir,`${id}.png`),url=SPECIES_ART.replace('{id}',id);
  mkdirSync(dir,{recursive:true});
  const m=read(meta),missing=m.catalog_missing_at?Date.parse(m.catalog_missing_at):NaN;
  if(Number.isNaN(missing)||now()-missing>=MISSING_RECHECK_MS) {
    try {
      const c=await cachedRef(url,o.cache,{...o.fetch?{fetch:o.fetch}:{},now});
      writeFileSync(meta,`${JSON.stringify({...m,source:'catalog',url,at:new Date(now()).toISOString(),catalog_missing_at:undefined},null,2)}\n`);
      return {bytes:c.bytes,type:c.type,source:'catalog',status:c.status};
    } catch(error) {
      if(!(error instanceof Error&&/HTTP 404$/.test(error.message)))throw error;
      m.catalog_missing_at=new Date(now()).toISOString();
      writeFileSync(meta,`${JSON.stringify(m,null,2)}\n`);
    }
  }
  const prompt=portraitPrompt(o.name,o.facts),sha=createHash('sha256').update(prompt).digest('hex');
  if(m.source==='generated'&&m.prompt_sha===sha&&existsSync(png))return {bytes:readFileSync(png),type:'image/png',source:'generated',status:'cache'};
  const seed=seedOf(id);
  const bytes=await draw(o.imager,{prompt,refs:[],size:PORTRAIT_SIZE,seed},{...o.fetch?{fetch:o.fetch}:{},timeoutMs:600_000});
  writeFileSync(png,bytes);
  writeFileSync(meta,`${JSON.stringify({...m,source:'generated',prompt,prompt_sha:sha,seed,model:o.imager.model,at:new Date(now()).toISOString()},null,2)}\n`);
  return {bytes,type:'image/png',source:'generated',status:'made'};
}
