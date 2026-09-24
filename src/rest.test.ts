/** Rest is the one act that ends a shift, and the only thing that touches the stance (N6, N10).
 *
 * Two contracts: what rest refuses and what the refusal would take to lift, and what rest
 * leaves behind when it happens — a record with no stance, no mood and no goal, a journal
 * line saying what was cleared, and a mood the world imposed gone with the rest of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalResult,serve,type Pilot} from './bridge.ts';
import type {RunResult} from './run.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {journalRun} from './run-record.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

const system={id:'sol',name:'Sol',pois:[
  {id:'station',name:'Sol Station',type:'station',position:{x:0,y:0},has_base:true,
    base_id:'sol_base',base_name:'Sol Base'},
]};
const PILOT:Pilot={name:'kvothe',objective:'fill the hold',goal:'three loads of ore',
  stance:'Prospector',mood:'Focused'};

/** A pilot docked on a serviced ship, with the record the runner would have written at the
 * last reflection. `over` moves whatever this test wants somewhere else. */
function fixture(over:{ship?:Record<string,number>;pilot?:Pilot;docked?:string|null;
  fuelPrice?:number|null;credits?:number;runPilot?:any;
  skills?:Record<string,{name:string;level:number;max_level:number}>}={}) {
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',
      docked_at:(over.docked===undefined?'sol_base':over.docked) as string|null,in_transit:false},
    ship:{id:'ship',fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_used:0,cargo_capacity:12,...over.ship},
    player:{credits:over.credits??1_000},
    cargo:[] as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
  });
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system}}),
    'spacemolt/find_route':()=>({found:true,estimated_fuel:7}),
    ...over.skills?{'spacemolt/get_skills':()=>({structuredContent:{skills:over.skills}})}:{},
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],
      ...over.fuelPrice===null?{}:{fuel_price_all_in:over.fuelPrice??1},
      base:{poi_id:'station',...over.fuelPrice===null?{}:{repair_price_per_hull:1}}}}}),
  };
  const command:ReadinessCommand=async(action,params)=>{
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]!(params);
  };
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-rest-'));
  let written:Pilot|undefined;
  const dispatch=serve(account as unknown as ReadinessAccount,command,
    {pilot:()=>over.pilot??PILOT,setPilot:next=>{written=next;},runtime,
      ...over.runPilot?{runPilot:over.runPilot}:{}});
  return {account,dispatch,runtime,record:()=>written,
    journal:()=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))};
}

test('rest refuses undocked, on a ship this base could service, and while a script runs, naming what would admit it', async () => {
  // Any base will do, but a base is required: an evening is not put down in open space.
  const adrift=fixture({docked:null});
  const refusedAdrift=await adrift.dispatch('rest') as any;
  assert.equal(refusedAdrift.rested,false);
  assert.match(refusedAdrift.reason,/dock to end the shift/);
  assert.equal(adrift.record(),undefined,'a refused rest writes no record');

  // A base that is not the one the last shift began at is still a base rest happens at: the
  // deadlock where an unset home meant a pilot could never rest, and so never reflect, is gone.
  const elsewhere=fixture({docked:'other_base'});
  assert.equal((await elsewhere.dispatch('rest') as any).rested,true);

  // Docked, but short of fuel at a base that quotes a price the wallet covers: service first.
  const short=fixture({ship:{fuel:60}});
  const refusedShort=await short.dispatch('rest') as any;
  assert.equal(refusedShort.rested,false);
  assert.match(refusedShort.reason,/refuel and repair first/);
  assert.equal(short.record(),undefined);

  // The same short ship with a wallet that cannot pay the counter rests anyway, and says it is
  // short: a service that cannot happen is not a reason to keep an evening open forever.
  // (A counter posting no price is no longer such a case — it bills after the fact.)
  const unserviceable=fixture({ship:{fuel:60},credits:0});
  const rested=await unserviceable.dispatch('rest') as any;
  assert.equal(rested.rested,true);
  assert.equal(rested.serviced,false,'reflection is told the ship is short');

  // A run in flight owns the pilot; rest waits for the juncture at its end.
  let release:((result:RunResult)=>void)|undefined;
  const busy=fixture({runPilot:()=>new Promise<RunResult>(resolve=>{release=resolve;})});
  const flight=busy.dispatch('run',{});
  await new Promise(resolve=>setImmediate(resolve));
  const refusedBusy=await busy.dispatch('rest') as any;
  assert.equal(refusedBusy.rested,false);
  assert.match(refusedBusy.reason,/run is in flight/);
  assert.equal(busy.record(),undefined);
  release!({accepted:true,status:'done',started:'t0'});
  await flight;
});

test('docked, the pilot rests whatever the world imposed on it, and the shift comes out clear', async () => {
  // Tired is the world's, not the agent's — and rest is what takes it away for good.
  const tired=fixture({pilot:{...PILOT,mood:'Tired'}});
  const rested=await tired.dispatch('rest') as any;
  assert.equal(rested.rested,true);
  assert.equal(rested.shift_ended,true);
  assert.equal(rested.at_rest,true);

  // The record keeps who the pilot is and what the operator wants; the shift's own three
  // settings are gone, so nothing is latched into the next one.
  assert.deepEqual(tired.record(),{name:'kvothe',objective:'fill the hold'});

  // What was put down is written down: a setting cleared with no record is a mystery later.
  const line=tired.journal().find(entry=>entry.event==='rest');
  assert.ok(line,'rest leaves its own line in the journal');
  assert.deepEqual({stance:line.stance,mood:line.mood,goal:line.goal},
    {stance:'Prospector',mood:'Tired',goal:'three loads of ore'});
  assert.ok(line.at,'the line is stamped');
});

test("the rest report reviews the pilot's own files against how the runs ended", async () => {
  const f=fixture({pilot:{name:'kvothe',objective:'fill the hold'}});
  mkdirSync(join(f.runtime,'pilot'),{recursive:true});
  writeFileSync(join(f.runtime,'pilot','index.ts'),'export default async function main(){}\n');
  for(const ended of [{outcome:'done',reason:'serviced'},{outcome:'refused',reason:'no route'},
    {outcome:'failed',reason:'the hold was full'}])
    journalRun(f.runtime,{phase:'ended',script:'index.ts',...ended});
  const report=await f.dispatch('reflect') as any;
  const mine=report.scripts.find((row:any)=>row.name==='index.ts');
  assert.ok(mine,`the pilot's own file is in the review: ${JSON.stringify(report.scripts)}`);
  assert.equal(mine.bytes,'export default async function main(){}\n'.length);
  assert.equal(mine.runs,3);
  assert.deepEqual(mine.last.map((run:any)=>run.outcome),['done','refused','failed']);
  assert.match(mine.last.at(-1).reason,/hold was full/);
});

test('a reflection measures each skill against the earliest one in the journal, and says so when it cannot',async()=>{
  // An objective phrased as movement ("raise the lowest of weapons/gunnery/tactics by 2 levels")
  // cannot be judged from a level on its own, and nothing but a past reflection holds the number
  // it started at. A pilot that cannot check its own claim asserts it — which is how a live
  // objective was declared done at weapons 2 of a target of 3 (2026-09-24).
  const levels={weapons:{name:'weapons',level:2,max_level:5},gunnery:{name:'gunnery',level:1,max_level:5}};
  const bare=fixture({pilot:{name:'kvothe',objective:'raise the lowest by 2 levels'},skills:levels});
  const first=await bare.dispatch('reflect') as any;
  assert.deepEqual(first.skills.map((row:any)=>[row.name,row.level,row.was]),
    [['gunnery',1,undefined],['weapons',2,undefined]]);
  assert.ok(first.missing.some((row:string)=>/earlier skill levels/.test(row)),
    `with no earlier reflection the gap is named, never guessed: ${JSON.stringify(first.missing)}`);

  // The record of that first reflection is what the next one measures against.
  const f=fixture({pilot:{name:'kvothe',objective:'raise the lowest by 2 levels'},skills:levels});
  journalRun(f.runtime,{request:{action:'reflect'},
    response:{ok:true,result:journalResult('reflect',first)}},'request');
  const second=await f.dispatch('reflect') as any;
  const weapons=second.skills.find((row:any)=>row.name==='weapons');
  assert.equal(weapons.level,2);
  assert.equal(weapons.was,undefined,'a level that has not moved carries no movement');
  const moved=fixture({pilot:{name:'kvothe'},
    skills:{...levels,weapons:{name:'weapons',level:4,max_level:5}}});
  journalRun(moved.runtime,{request:{action:'reflect'},
    response:{ok:true,result:journalResult('reflect',first)}},'request');
  const after=await moved.dispatch('reflect') as any;
  const raised=after.skills.find((row:any)=>row.name==='weapons');
  assert.equal(raised.was,2,`the baseline reaches the report: ${JSON.stringify(after.skills)}`);
  assert.ok(raised.since,'the baseline says when it was taken');
  assert.ok(!after.missing.some((row:string)=>/earlier skill levels/.test(row)));
});
