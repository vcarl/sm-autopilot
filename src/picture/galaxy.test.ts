/** The galaxy: the public map kept on disk, and ids fitted to a rect (`galaxy.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {GalaxyMap} from '@spacemolt/lib';
import {fit,loadGalaxy,neighbours,type Galaxy} from './galaxy.ts';

const dir=()=>mkdtempSync(join(tmpdir(),'spacemolt-galaxy-'));
const map=(...ids:string[])=>({empires:{},systems:ids.map((id,i)=>({id,name:id.toUpperCase(),x:i,y:i*2,connections:ids.filter(other=>other!==id)}))}) as unknown as GalaxyMap;

test('loadGalaxy caches to galaxy.json and reuses it inside maxAge',async()=>{
  const runtime=dir();
  let calls=0;
  const fetch=async()=>{calls++;return map('a','b');};
  const first=await loadGalaxy(runtime,{fetch});
  const second=await loadGalaxy(runtime,{fetch});
  assert.equal(calls,1);
  assert.ok(existsSync(join(runtime,'galaxy.json')));
  assert.deepEqual(Object.keys(first.systems),['a','b']);
  assert.deepEqual(second,first);
  assert.deepEqual(JSON.parse(readFileSync(join(runtime,'galaxy.json'),'utf8')),first);
});

test('loadGalaxy drops malformed fetched systems so the kept copy still reads',async()=>{
  const runtime=dir();
  let calls=0;
  const fetch=async()=>{calls++;return {empires:{},systems:[{id:'a',name:'A',x:1,y:2,connections:['b']},{id:'b',name:'B',y:2,connections:[]}]} as unknown as GalaxyMap;};
  const first=await loadGalaxy(runtime,{fetch});
  assert.deepEqual(Object.keys(first.systems),['a']);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(runtime,'galaxy.json'),'utf8')).systems),['a']);
  assert.deepEqual(await loadGalaxy(runtime,{fetch}),first);
  assert.equal(calls,1);
});

test('loadGalaxy returns the stale copy when fetch fails',async()=>{
  const runtime=dir();
  const stale:Galaxy={fetched_at:'2020-01-01T00:00:00.000Z',systems:{a:{id:'a',name:'A',x:1,y:2,connections:[]}}};
  writeFileSync(join(runtime,'galaxy.json'),JSON.stringify(stale));
  const fetch=async()=>{throw new Error('offline');};
  assert.deepEqual(await loadGalaxy(runtime,{fetch}),stale);
  assert.deepEqual(await loadGalaxy(dir(),{fetch}),{fetched_at:'1970-01-01T00:00:00.000Z',systems:{}});
});

const sys=(id:string,x:number,y:number,connections:string[])=>[id,{id,name:id,x,y,connections}] as const;
const galaxy:Galaxy={fetched_at:'',systems:Object.fromEntries([sys('a',0,0,['b']),sys('b',100,0,['a','c']),sys('c',100,50,['b','d']),sys('d',9,9,['c'])])};

test('fit preserves aspect ratio and lists unknown ids',()=>{
  const {placed,unknown}=fit(['a','b','c','zz'],galaxy,{x:0,y:0,w:400,h:400});
  assert.equal(placed.b!.x-placed.a!.x,352);
  assert.equal(placed.c!.y-placed.b!.y,176);
  assert.deepEqual(unknown,['zz']);
  assert.deepEqual(placed.zz,{id:'zz',x:200,y:376,known:false});
  assert.equal(placed.a!.known,true);
  assert.deepEqual(fit(['a'],galaxy,{x:0,y:0,w:400,h:200}).placed.a,{id:'a',x:200,y:100,known:true});
});

test('neighbours lists unvisited connected ids once, in first-seen order',()=>{
  assert.deepEqual(neighbours(['a','c'],galaxy),['b','d']);
  assert.deepEqual(neighbours(['zz'],galaxy),[]);
});

test('loadGalaxy keeps the existing copy when a fetch answers with no systems',async()=>{
  const runtime=dir(),stale:Galaxy={fetched_at:'2020-01-01T00:00:00.000Z',systems:{a:{id:'a',name:'A',x:1,y:2,connections:[]}}};
  writeFileSync(join(runtime,'galaxy.json'),JSON.stringify(stale));
  const fetch=async()=>map();
  assert.deepEqual(await loadGalaxy(runtime,{fetch}),stale);
  assert.deepEqual(JSON.parse(readFileSync(join(runtime,'galaxy.json'),'utf8')),stale);
  assert.deepEqual(await loadGalaxy(dir(),{fetch}),{fetched_at:'1970-01-01T00:00:00.000Z',systems:{}});
});
