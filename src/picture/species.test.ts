/** A species' reference (`species.ts`): catalog art first, a portrait generated once from the game's own words else. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {blankScene,scoredEvent as ev,withMoment} from '../test-support/scene.ts';
import {pngOf} from './crop.ts';
import {seedOf} from './imager.ts';
import {MISSING_RECHECK_MS,SPECIES_ART,creatureClause,nameClause,portraitPrompt,speciesFacts,speciesName,speciesRef} from './species.ts';

const IMAGER={url:'http://imager',model:'m',style:'S'},ART=SPECIES_ART.replace('{id}','veil_ray');
const portrait=pngOf(2,2,new Uint8Array(16).fill(90)),art=new Uint8Array([1,2,3]);
/** A stub of the CDN and the imager: `catalog` answers the species art, every call is recorded. */
function stub(catalog:'404'|'200') {
  const calls:{url:string;body?:string}[]=[];
  const fetch=async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);calls.push({url,...typeof init?.body==='string'?{body:init.body}:{}});
    if(url===ART)return catalog==='200'?new Response(art,{status:200,headers:{'content-type':'image/webp','cache-control':'max-age=60'}}):new Response('no',{status:404});
    if(url.endsWith('/v1/images/generations'))return new Response(JSON.stringify({data:[{b64_json:Buffer.from(portrait).toString('base64')}]}),{status:200});
    throw new Error(`unexpected ${url}`);
  };
  return {fetch,calls,catalog:()=>calls.filter(c=>c.url===ART).length,drawn:()=>calls.filter(c=>c.url.endsWith('/generations')).length};
}
const opts=(cache:string,s:ReturnType<typeof stub>,at:number)=>({name:'Veil-Ray',facts:[],cache,imager:IMAGER,fetch:s.fetch,now:()=>at});

test('catalog art is used when the game publishes it, and no portrait is drawn',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-species-')),s=stub('200');
  try {
    const got=await speciesRef('veil_ray',opts(dir,s,1_000_000));
    assert.deepEqual([got.source,got.type,Buffer.from(got.bytes)],['catalog','image/webp',Buffer.from(art)]);
    assert.equal(s.drawn(),0);
    assert.equal(JSON.parse(readFileSync(join(dir,'species','veil_ray.json'),'utf8')).source,'catalog');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a 404 is remembered for a day, the portrait drawn once and reused, then the catalog probed again',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-species-')),s=stub('404'),t0=1_000_000;
  try {
    const first=await speciesRef('veil_ray',opts(dir,s,t0));
    assert.deepEqual([first.source,first.status,s.catalog(),s.drawn()],['generated','made',1,1]);
    const sent=JSON.parse(s.calls.find(c=>c.url.endsWith('/generations'))?.body??'{}');
    assert.deepEqual([sent.size,sent.seed,sent.prompt],['1024x1024',seedOf('veil_ray'),portraitPrompt('Veil-Ray',[])]);
    const m=JSON.parse(readFileSync(join(dir,'species','veil_ray.json'),'utf8'));
    assert.deepEqual([m.source,m.seed,m.model,m.prompt,typeof m.at,typeof m.catalog_missing_at],['generated',seedOf('veil_ray'),'m',portraitPrompt('Veil-Ray',[]),'string','string']);
    const later=await speciesRef('veil_ray',opts(dir,s,t0+3600_000));
    assert.deepEqual([later.source,later.status,s.catalog(),s.drawn()],['generated','cache',1,1]); // no probe, no drawing
    const nextDay=await speciesRef('veil_ray',opts(dir,s,t0+MISSING_RECHECK_MS+1));
    assert.deepEqual([nextDay.source,nextDay.status,s.catalog(),s.drawn()],['generated','cache',2,1]); // probed again, still the same portrait
    const published=stub('200');
    assert.equal((await speciesRef('veil_ray',opts(dir,published,t0+2*MISSING_RECHECK_MS+2))).source,'catalog'); // art that appears is picked up
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a portrait is drawn again only when its manifest is deleted',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-species-')),s=stub('404');
  try {
    await speciesRef('veil_ray',opts(dir,s,1_000_000));
    rmSync(join(dir,'species','veil_ray.json'));
    assert.ok(existsSync(join(dir,'species','veil_ray.png')));
    const again=await speciesRef('veil_ray',opts(dir,s,1_000_000));
    assert.deepEqual([again.status,s.drawn()],['made',2]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the portrait prompt is the name and the game\'s own sentences, nothing invented',()=>{
  assert.equal(portraitPrompt('Veil-Ray',[]),'Reference study of a single Veil-Ray, a spaceborne creature, alone: full body, centred on a plain dark background. Its name describes it: a ray-like creature with veil-like features. No ships, no other creatures, no text.');
  const items=[{id:'verdigris_curd',description:"Blue-green copper paste scraped from a veil-ray's filtering combs. A ready feedstock for wiring and pigment."},
    {id:'verdigris_kefir',description:'A tangy cultured drink set from veil-ray verdigris curd, a faint copper-blue and sharper than it looks.'},
    {id:'charge_gland',description:'An electrochemical organ from a lantern-slug, dense with biological capacitor plates.'},{id:'rock'}];
  const facts=speciesFacts(items,'veil_ray');
  assert.deepEqual(facts,["Blue-green copper paste scraped from a veil-ray's filtering combs. A ready feedstock for wiring and pigment."]); // the kefir is made from the curd: nothing of the creature
  assert.equal(portraitPrompt('Veil-Ray',facts),`Reference study of a single Veil-Ray, a spaceborne creature, alone: full body, centred on a plain dark background. Its name describes it: a ray-like creature with veil-like features. The game's catalog says, of what comes from it: "${facts[0]}" No ships, no other creatures, no text.`);
  assert.deepEqual(speciesFacts(items,'lantern_slug').length,1);
  assert.deepEqual(speciesFacts(items,'bell_jelly'),[]);
});

test('a species is named as the game named it in the moment, else by the Scene, else by its id',()=>{
  assert.equal(speciesName(withMoment(blankScene(),ev('battle_ended',{identities:[{kind:'opponent',id:'Veil-Ray'},{kind:'species',id:'veil_ray'}]})),'veil_ray'),'Veil-Ray');
  assert.equal(speciesName({...blankScene(),names:{drift_ray:'Drift Ray'}},'drift_ray'),'Drift Ray');
  assert.equal(speciesName(blankScene(),'bell_jelly'),'Bell Jelly');
});

test('the name says what the creature is: the last word its kind, the earlier ones its mark, one word nothing',()=>{
  assert.deepEqual(nameClause('Veil-Ray'),['Its name describes it: a ray-like creature with veil-like features.']);
  assert.deepEqual(nameClause('Ash Glider'),['Its name describes it: a glider-like creature with ash-like features.']);
  assert.deepEqual(nameClause('Glimmerkin'),[]);
  assert.deepEqual([creatureClause('Patina-Grazer'),creatureClause('Glimmerkin')],['a grazer-like creature with patina-like features',null]); // a picture's design clause
  assert.ok(!portraitPrompt('Glimmerkin',[]).includes('Its name'));
  assert.ok(portraitPrompt('Ash Glider',[]).includes('a single Ash Glider,')); // the display name stays as the game wrote it
});

test('a portrait is drawn again when its prompt changes, not when it is the same',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-species-')),s=stub('404');
  try {
    await speciesRef('veil_ray',opts(dir,s,1_000_000));
    await speciesRef('veil_ray',opts(dir,s,1_000_001));
    assert.equal(s.drawn(),1); // same prompt: kept
    const facts=['Blue-green paste from a veil-ray.'],again=await speciesRef('veil_ray',{...opts(dir,s,1_000_002),facts});
    assert.deepEqual([again.status,s.drawn()],['made',2]); // new prompt: redrawn
    assert.equal(JSON.parse(readFileSync(join(dir,'species','veil_ray.json'),'utf8')).prompt,portraitPrompt('Veil-Ray',facts));
    // a manifest from before the hash existed is redrawn once
    const meta=join(dir,'species','veil_ray.json'),m=JSON.parse(readFileSync(meta,'utf8'));delete m.prompt_sha;writeFileSync(meta,JSON.stringify(m));
    await speciesRef('veil_ray',{...opts(dir,s,1_000_003),facts});
    assert.equal(s.drawn(),3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('catalog art is never replaced by a portrait, whatever its manifest says',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-species-')),s=stub('200');
  try {
    await speciesRef('veil_ray',opts(dir,s,1_000_000));
    const meta=join(dir,'species','veil_ray.json'),m=JSON.parse(readFileSync(meta,'utf8'));writeFileSync(meta,JSON.stringify({...m,prompt:'old',prompt_sha:'stale'}));
    const got=await speciesRef('veil_ray',{...opts(dir,s,1_000_000+60_000),facts:['changed']});
    assert.deepEqual([got.source,s.drawn(),existsSync(join(dir,'species','veil_ray.png'))],['catalog',0,false]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
