import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionClosedError,SpacemoltError,type MapSystemInfo,type Account} from '@spacemolt/lib';
import type {ReadinessAccount} from '../../readiness.ts';
import {journalRun} from '../../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {menu,type RunSummary} from '../menu.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {around,exploreNearby,markSeen,nearFacts,readMap,readSeen} from './exploration.ts';

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

test('the menu finds an unvisited system several jumps out, keeps a dangerous one with its facts, and names the next ones',async()=>{
  // Live 2026-09-30 (kvothe): told to explore, 41 jumps between visited systems, because the menu
  // looked only one jump out. Three repeated goTo runs, so the repetition rule is also in play.
  const f=world({mood:'Focused',stance:'Prospector',objective:'explore the unvisited systems'},CHAIN,row=>{
    if(['sol','deep_range','a'].includes(row.system_id))row.visited=true;
    if(row.system_id==='b')row.is_stronghold=true;
    if(row.system_id==='c')row.empire='solarian';
  });
  try {
    const run:RunSummary={fn:'goTo',arg:'deep_range',status:'done',credits:0,items:0,xp:0,at:'range_base'};
    for(let i=0;i<3;i++)journalRun(f.runtime,{phase:'ended',script:'index.ts',outcome:'done',work:run});
    const built=await menu(f.runtime);
    const row=built.moves.find(m=>m.call==="goTo('b')");
    assert.ok(row,JSON.stringify(built.moves));
    // Fresh, so goTo's repetition does not sink it: it ranks over the other work the menu holds.
    assert.ok(built.moves.indexOf(row!)<built.moves.findIndex(m=>m.call==='service()'),JSON.stringify(built.moves));
    assert.match(row!.why,/^b \(3 jumps, never visited, no empire listed, a stronghold\)/);
    assert.match(row!.why,/Next nearest: c 'c' \(4 jumps, never visited, empire solarian\)/);
    assert.deepEqual(built.neighbours?.map(n=>[n.system_id,n.visited]),[['deep_range',true]]);
  } finally {f.close();}
});

test('nothing unvisited within range: not_now names the nearest and how far',async()=>{
  const far:WorldOptions={systems:['s1','s2','s3','s4','s5'].map((id,i,all)=>({id,connections:[i?all[i-1]!:'deep_range'],pois:[{id:`${id}_rock`}]}))};
  const f=world({mood:'Focused',stance:'Scout'},far,row=>{if(row.system_id!=='s5')row.visited=true;});
  try {
    const built=await menu(f.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith("goTo('s5')")),JSON.stringify(built.moves));
    const line=built.not_now.find(row=>row.move==="goTo('s5')");
    assert.match(line?.why??'',/nothing unvisited within 5 jumps; the nearest is s5 \(6 jumps, never visited/,JSON.stringify(built.not_now));
  } finally {f.close();}
  const all=world({mood:'Focused',stance:'Scout'},{},row=>{row.visited=true;});
  try {
    const built=await menu(all.runtime);
    assert.ok(built.not_now.some(row=>row.move==='goTo'&&/every system on the map is visited/.test(row.why)),JSON.stringify(built.not_now));
  } finally {all.close();}
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

test('readMap keeps the rows that decode and reads a reply with no map as empty',async()=>{
  const row={system_id:'a',name:'A',connections:['b'],visited:false,online:0,poi_count:1,position:{x:0,y:0},visited_at:''};
  assert.deepEqual((await readMap(async()=>({structuredContent:{systems:[row,{system_id:'broken'}]}}))).map(r=>r.system_id),['a']);
  assert.deepEqual(await readMap(async()=>({structuredContent:{}})),[]);
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
