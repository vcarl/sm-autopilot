import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionClosedError,SpacemoltError,type MapSystemInfo,type Account} from '@spacemolt/lib';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {menuEffect} from '../menu.ts';
import {bind,onBinding,unbind,type Pilot} from '../runtime.ts';
const menu=(runtime?:string)=>onBinding(menuEffect(runtime));
import {around,exploreNearby,mapOf,markSeen,nearFacts,readSeen} from './exploration.ts';

const sys=(system_id:string,connections:string[],over:Partial<MapSystemInfo>={}):MapSystemInfo=>
  ({system_id,name:system_id,connections,visited:false,poi_count:1,online:0,position:{x:0,y:0},visited_at:'',...over});

test('the walk: jumps to every system, nearest first, with what the map and memory say of each',()=>{
  const map=[sys('home',['a','b'],{visited:true}),sys('a',['home','c'],{visited:true,empire:'solarian'}),
    sys('b',['home']),sys('c',['a','d'],{is_stronghold:true,online:3}),sys('d',['c']),sys('island',[])];
  const near=around(map,'home',Infinity,{a:{police:40,pirates:2,at:new Date(Date.now()-60_000).toISOString()}});
  assert.deepEqual(near.map(row=>[row.system_id,row.jumps,row.visited]),[['a',1,true],['b',1,false],['c',2,false],['d',3,false]]);
  assert.equal(around(map,'home',2).length,3,'max bounds the walk');
  assert.equal(nearFacts(near[0]!),'1 jump, visited, empire solarian, police 40, 2 pirate(s) at arrival seen 6t ago');
  assert.equal(nearFacts(near[2]!),'2 jumps, never visited, no empire listed, a stronghold, 3 online');
});

// sol – deep_range – a – b – c, and every system up to `a` already visited.
const CHAIN:WorldOptions={systems:[{id:'a',connections:['deep_range'],pois:[{id:'a_rock'}]},
  {id:'b',connections:['a'],pois:[{id:'b_rock'}]},{id:'c',connections:['b'],pois:[{id:'c_rock'}]}]};
function world(record:Pilot,options:WorldOptions,map:(row:Record<string,any>)=>void=()=>{},before:(action:string)=>void=()=>{}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-explore-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],...options});
  const command:typeof game.command=async(action,params)=>{
    before(action);
    const res=await game.command(action,params);
    if(action==='spacemolt/get_map'&&params?.system_id===undefined)for(const row of (res as any).structuredContent.systems)map(row);
    return res;
  };
  bind({account:game.account as unknown as Account,command,pilot:()=>record,runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}

test('told to explore, the menu offers the nearest unvisited system several jumps out, a dangerous one with its facts',async()=>{
  // Live 2026-09-30 (kvothe): told to explore, 41 jumps between visited systems, because the menu
  // looked only one jump out.
  const f=world({mood:'Focused',stance:'Prospector',objective:'explore the unvisited systems'},CHAIN,row=>{
    if(['sol','deep_range','a'].includes(row.system_id))row.visited=true;
    if(row.system_id==='b')row.is_stronghold=true;
    if(row.system_id==='c')row.empire='solarian';
  });
  try {
    const built=await menu(f.runtime);
    const row=built.moves.find(m=>m.call==="goTo('b')");
    assert.equal(row?.gen,'explore',JSON.stringify(built.moves));
    assert.equal(row!.said,'explore: b, 3 jumps, never visited, no empire listed, a stronghold');
  } finally {f.close();}
});

test('nothing unvisited within range: no explore move',async()=>{
  const far:WorldOptions={systems:['s1','s2','s3','s4','s5'].map((id,i,all)=>({id,connections:[i?all[i-1]!:'deep_range'],pois:[{id:`${id}_rock`}]}))};
  const f=world({mood:'Focused',stance:'Scout'},far,row=>{if(row.system_id!=='s5')row.visited=true;});
  try {
    const built=await menu(f.runtime);
    assert.ok(!built.moves.some(m=>m.gen==='explore'),JSON.stringify(built.moves));
  } finally {f.close();}
});

test('exploreNearby visits and scouts the nearest unvisited systems, keeps what it saw, and honours avoid',async()=>{
  const branch:WorldOptions={systems:[...CHAIN.systems!,{id:'side',connections:['sol'],pois:[{id:'side_rock'}]}]};
  const f=world({mood:'Focused'},branch);
  try {
    const out=await exploreNearby({systems:2});
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.visited.map(row=>row.system_id),['deep_range','a']);
    assert.deepEqual(out.detail.visited[0]!.stations,['range_base']);
    assert.deepEqual(Object.keys(readSeen(f.runtime)).sort(),['a','deep_range']);
    assert.equal(out.detail.unvisited[0]?.system_id,'b','nearest from where the ship now is');
  } finally {f.close();}
  const g=world({mood:'Focused'},branch);
  try {
    // Everything past deep_range routes through it, so avoiding it leaves only `side`.
    const out=await exploreNearby({systems:3,avoid:['deep_range']});
    assert.deepEqual(out.detail.visited.map(row=>row.system_id),['side']);
    assert.ok(!Object.keys(readSeen(g.runtime)).includes('deep_range'));
    // Skipped for its route is not visited: `a` is still what is left in range.
    assert.deepEqual(out.detail.unvisited.map(row=>row.system_id),['a']);
    assert.match(out.did,/1 more unvisited within 3 jumps, nearest a/);
  } finally {g.close();}
});

test('exploreNearby ends Tired, refused for fuel, and surveys when asked',async()=>{
  // Tired from the first arrival on: the hop that left it so ends the circuit there.
  let game:any;
  const tired=world({stance:'Scout',get mood(){return game?.location.system_id==='deep_range'?'Tired':'Focused';}} as Pilot,CHAIN);
  try {
    game=(tired.account as any).server;
    const out=await exploreNearby({systems:3});
    assert.equal(out.detail.ended,'tired',JSON.stringify(out));
    assert.deepEqual(out.detail.visited.map(row=>row.system_id),['deep_range']);
    assert.ok(out.next?.includes('service() at the nearest base'),JSON.stringify(out.next));
  } finally {tired.close();}
  const dry=world({mood:'Focused'},CHAIN,undefined,action=>{if(action==='spacemolt/jump')throw new Error('Not enough fuel to jump');});
  try {
    const out=await exploreNearby();
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.equal(out.detail.ended,'refused');
    assert.match(out.why??'',/^deep_range: /);
    assert.equal(out.detail.unvisited[0]?.system_id,'deep_range','refused for fuel is still unvisited');
  } finally {dry.close();}
  const survey=world({mood:'Focused'},CHAIN);
  try {
    const out=await exploreNearby({systems:1,survey:true});
    assert.ok(out.detail.visited[0]?.survey,JSON.stringify(out.detail.visited));
  } finally {survey.close();}
});

test('systems.json keeps the newest look per system',()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-seen-'));
  try {
    markSeen(dir,'a',{police:0,at:'2026-09-30T00:00:00Z'});
    markSeen(dir,'a',{police:20,pirates:1,at:'2026-09-30T01:00:00Z'});
    assert.deepEqual(readSeen(dir),{a:{police:20,pirates:1,at:'2026-09-30T01:00:00Z'}});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('exploreNearby: a refused survey is named with its action and code, and the system is still visited',async()=>{
  const f=world({mood:'Focused'},CHAIN,undefined,action=>{if(action==='spacemolt/survey_system')throw new SpacemoltError('rate_limited','slow down');});
  try {
    const out=await exploreNearby({systems:1,survey:true});
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.visited.map(row=>row.system_id),['deep_range']);
    assert.equal(out.detail.visited[0]?.survey,'survey refused: spacemolt/survey_system: rate_limited — slow down');
  } finally {f.close();}
});

test('exploreNearby: a survey whose reply is lost is said as lost, and the visit goes on',async()=>{
  const f=world({mood:'Focused'},CHAIN,undefined,action=>{if(action==='spacemolt/survey_system')throw new ConnectionClosedError();});
  try {
    const out=await exploreNearby({systems:1,survey:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.visited[0]?.survey,'survey refused: reply lost on spacemolt/survey_system');
  } finally {f.close();}
});

test('exploreNearby: a scout that broke ends the run naming it, not reading a system off nothing',async()=>{
  // A broken scout's detail is `{}`: exploreNearby read `seen.detail.system.name` off it and crashed.
  // The jump reads the system once on arrival; the scout's read is the one that breaks.
  let systemReads=0;
  const f=world({mood:'Focused'},CHAIN,undefined,action=>{if(action==='spacemolt/get_system'&&++systemReads>1)throw new Error('socket gone');});
  try {
    const out=await exploreNearby({systems:1});
    assert.equal(out.detail.ended,'refused',JSON.stringify(out));
    assert.deepEqual(out.detail.visited,[]);
    assert.match(out.why??'',/^deep_range: scout failed: .*socket gone/);
  } finally {f.close();}
});

test('exploreNearby: a refused map read ends the run as refused, naming the code',async()=>{
  const f=world({mood:'Focused'},CHAIN,undefined,action=>{if(action==='spacemolt/get_map')throw new SpacemoltError('rate_limited','slow down');});
  try {
    const out=await exploreNearby();
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.equal(out.why,'spacemolt/get_map: rate_limited — slow down');
  } finally {f.close();}
});

test('mapOf keeps the rows that decode and reads a reply with no map as empty',async()=>{
  const row={system_id:'a',name:'A',connections:['b'],visited:false,online:0,poi_count:1,position:{x:0,y:0},visited_at:''};
  assert.deepEqual(mapOf({structuredContent:{systems:[row,{system_id:'broken'}]}}).map(r=>r.system_id),['a']);
  assert.deepEqual(mapOf({structuredContent:{}}),[]);
});

test('systems.json: a torn file, or a row that is not a look, reads as nothing',()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-seen-'));
  try {
    assert.deepEqual(readSeen(dir),{});
    writeFileSync(join(dir,'systems.json'),JSON.stringify({a:{police:3,at:'t'},b:'oops',c:{police:'high',at:'t'}}));
    assert.deepEqual(readSeen(dir),{a:{police:3,at:'t'}});
    writeFileSync(join(dir,'systems.json'),'{torn');
    assert.deepEqual(readSeen(dir),{});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
