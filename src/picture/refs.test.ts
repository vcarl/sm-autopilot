/** The one subject reference (`refs.ts`): which subject a moment sends, its art, and the ETag cache. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {blankScene,scoredEvent as ev,withMoment} from '../test-support/scene.ts';
import {pngOf} from './crop.ts';
import {CDN,cachedRef,fetchRef,refOf,subjectOf} from './refs.ts';

const creature=(score=3)=>ev('battle_ended',{identities:[{kind:'opponent',id:'Veil-Ray'},{kind:'species',id:'veil_ray'}],score});
const fight=(score=3)=>ev('battle_started',{identities:[{kind:'ship_class',id:'eviction_notice'},{kind:'opponent',id:'Commodore'}],score});
const sale=(score=2)=>ev('spacemolt/sell',{identities:[{kind:'item',id:'steel_plate'}],score});
const pick=(lead:ReturnType<typeof ev>,more:ReturnType<typeof ev>[]=[],earlier:ReturnType<typeof ev>[]=[])=>{
  const s=subjectOf(withMoment(blankScene(),lead,more,earlier).moment);return s?[s.kind,s.id,s.fought]:null;};

test('the subject is the best-scoring event\'s, and in it a ship fought before a creature before an item',()=>{
  assert.deepEqual(pick(sale(5),[creature(3),fight(1)]),['item','steel_plate',false]); // the best event with a subject wins, whatever its kind
  assert.deepEqual(pick(ev('player_died',{identities:[{kind:'ship_class',id:'eviction_notice'},{kind:'species',id:'veil_ray'},{kind:'item',id:'steel_plate'}],score:6})),['ship','eviction_notice',true]);
  assert.deepEqual(pick(ev('spacemolt_salvage/loot',{identities:[{kind:'item',id:'creature_carapace'},{kind:'species',id:'veil_ray'}]})),['creature','veil_ray',false]);
  // Live 2026-10-19 (kvothe 08:47Z): the lead, a mission done at a star, has no subject; the next event, a battle with a ship in it, does.
  assert.deepEqual(pick(ev('spacemolt/complete_mission',{score:4}),[fight(2),sale(1)]),['ship','eviction_notice',true]);
});

test('a ship is a subject only when fought; system & connection and the leftovers send nothing; no subject is null',()=>{
  // Live 2026-10-18 (kvothe a28932b8): an arrival names every ship at the POI; none of them is the picture's.
  assert.deepEqual(pick(ev('spacemolt/travel',{identities:[{kind:'ship_class',id:'prospect'}],score:3}),[sale(1)]),['item','steel_plate',false]);
  assert.equal(pick(ev('spacemolt/travel',{identities:[{kind:'ship_class',id:'prospect'}]})),null);
  assert.equal(pick(ev('action_error',{identities:[{kind:'item',id:'iron_ore'}],score:9})),null);
  assert.equal(pick(ev('spacemolt/complete_mission'),[],[creature(9)]),null);
  assert.equal(subjectOf(null),null);
});

// Live 2026-10-19 (kvothe 7b7030a8): a battle in Nashira the pilot only heard of, on its way to Bharani, drew the Dialectic diving at us.
test('a battle the pilot did not fight: its own acts first; then its ship only in the system the picture shows, and at a distance',()=>{
  const at=(system:string)=>({system,poi:null,docked_at:null,ship_class:'dividend'});
  const heard=(system:string,score=3)=>ev('battle_alert',{identities:[{kind:'ship_class',id:'dialectic'},{kind:'species',id:'patina_grazer'}],facts:{system_id:system},involvement:0.5,pilot:at(system),score});
  const done=ev('action_result',{variant:'mission_objective_completed',category:'missions',pilot:at('bharani'),score:4});
  assert.equal(pick(done,[heard('nashira')]),null); // elsewhere: nothing to draw
  assert.deepEqual(pick(done,[heard('bharani')]),['ship','dialectic',false]); // here: at a distance
  assert.deepEqual(pick(done,[heard('bharani',5),sale(1)]),['item','steel_plate',false]); // the pilot's own act first, whatever the score
  assert.equal(pick(ev('battle_alert',{identities:[{kind:'ship_class',id:'dialectic'}],involvement:0.5,score:3})),null); // no place known: never
});

// Live 2026-10-19 (recipe3 and recipe4, 3db6ff6c): the argon tube on the console drew as fire in every render.
test('an item the catalog makes no prop is skipped: the next event\'s item is, else there is no subject',()=>{
  const gas=new Set(['argon_gas']),deposit=ev('spacemolt_storage/deposit',{identities:[{kind:'item',id:'argon_gas'}],score:3});
  assert.equal(subjectOf(withMoment(blankScene(),deposit).moment,gas),null);
  assert.equal(subjectOf(withMoment(blankScene(),deposit,[sale(1)]).moment,gas)?.id,'steel_plate');
  assert.equal(subjectOf(withMoment(blankScene(),deposit).moment)?.id,'argon_gas'); // without the catalog's word, an item as before
});

test('each kind\'s art: a ship\'s and an item\'s codex image cropped to its box, a species\' portrait whole',()=>{
  assert.deepEqual(refOf({kind:'ship',id:'eviction_notice'}),{kind:'ship',url:`${CDN}ships/catalog/eviction_notice.webp`,box:{x:0.08,y:0.2,w:0.8,h:0.6}});
  assert.deepEqual(refOf({kind:'item',id:'copper_wiring'}),{kind:'item',url:`${CDN}items/copper_wiring.webp`,box:{x:0.15,y:0.15,w:0.7,h:0.7}});
  assert.deepEqual(refOf({kind:'creature',id:'veil_ray'}),{kind:'creature',url:'species:veil_ray',box:null});
});

test('a species reference comes from the species source and is sent whole; one that cannot be had is not sent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-refs-'));
  try {
    const img=pngOf(2,2,new Uint8Array(16).fill(200)),ref=refOf({kind:'creature',id:'veil_ray'});
    const known=await fetchRef(ref,dir,async()=>({bytes:img,type:'image/png',source:'generated',status:'made'}));
    assert.deepEqual([known.status,known.sent,known.crop,known.portrait],['generated',img,null,img]);
    const unknown=await fetchRef(ref,dir,async()=>{throw new Error('imager down');});
    assert.deepEqual([unknown.status,unknown.error,unknown.sent],['failed','imager down',null]);
    await cachedRef(`${CDN}items/steel_plate.webp`,dir,{fetch:async()=>new Response(new Uint8Array(img),{status:200,headers:{'content-type':'image/png','cache-control':'max-age=3600'}})});
    const item=await fetchRef(refOf({kind:'item',id:'steel_plate'}),dir);
    assert.deepEqual([item.status,item.crop,item.portrait,Buffer.from(item.sent??[]).equals(Buffer.from(img))],['cache',null,null,true]); // not WebP: sent whole
  } finally {rmSync(dir,{recursive:true,force:true});}
});

const reply=(status:number,body:string,headers:Record<string,string>={})=>new Response(status===304?null:body,{status,headers});

test('the cache fetches once, serves inside max-age, revalidates with If-None-Match and reuses the file on 304',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-refs-')),url=`${CDN}ships/catalog/cobble.webp`;
  const sent:Headers[]=[];let now=1_000_000;
  const answers=[reply(200,'webp-bytes',{etag:'"abc"','last-modified':'Sun, 23 Aug 2026 18:22:58 GMT','cache-control':'public, max-age=60, immutable','content-type':'image/webp'}),reply(304,'')];
  const fetch=async(_url:string|URL|Request,init?:RequestInit)=>{sent.push(new Headers(init?.headers));const next=answers.shift();if(!next)throw new Error('unexpected fetch');return next;};
  try {
    const first=await cachedRef(url,dir,{fetch,now:()=>now});
    assert.equal(first.status,'200');assert.equal(Buffer.from(first.bytes).toString(),'webp-bytes');assert.equal(first.type,'image/webp');
    assert.equal(sent[0]?.get('if-none-match'),null);
    const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'))[url];
    assert.deepEqual({etag:manifest.etag,max_age:manifest.max_age,fetched_at:manifest.fetched_at},{etag:'"abc"',max_age:60,fetched_at:1_000_000});
    assert.ok(existsSync(join(dir,manifest.file)));
    now+=30_000;
    const kept=await cachedRef(url,dir,{fetch,now:()=>now});
    assert.equal(kept.status,'cache');assert.equal(sent.length,1);
    now+=60_000;
    const again=await cachedRef(url,dir,{fetch,now:()=>now});
    assert.equal(again.status,'304');assert.equal(Buffer.from(again.bytes).toString(),'webp-bytes');assert.equal(again.type,'image/webp');
    assert.equal(sent[1]?.get('if-none-match'),'"abc"');assert.equal(sent[1]?.get('if-modified-since'),'Sun, 23 Aug 2026 18:22:58 GMT');
    assert.equal(JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'))[url].fetched_at,1_090_000);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a missing image throws and is not kept',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-refs-'));
  try {
    await assert.rejects(cachedRef(`${CDN}home/empire-pirate.jpg`,dir,{fetch:async()=>reply(404,'no')}),/HTTP 404/);
    assert.ok(!existsSync(join(dir,'manifest.json')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

// Live 2026-10-19 (recipe6, a28932b8): quantum fragments on the console drew as glowing flowers; a mining picture is the body mined.
test('an extraction offers no item',()=>{
  assert.equal(pick(ev('mining_yield',{identities:[{kind:'item',id:'iron_ore'}],score:3})),null);
  assert.deepEqual(pick(ev('mining_yield',{identities:[{kind:'item',id:'iron_ore'}],score:3}),[sale(1)]),['item','steel_plate',false]);
});
