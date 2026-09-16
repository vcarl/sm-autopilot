/** Rest is the one act that ends a shift, and the only thing that touches the stance (N6, N10).
 *
 * Two contracts: what rest refuses and what the refusal would take to lift, and what rest
 * leaves behind when it happens — a record with no stance, no mood and no goal, a journal
 * line saying what was cleared, and a mood the world imposed gone with the rest of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Pilot} from './bridge.ts';
import type {RunOutcome} from './script-runner.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {journalRun} from './run-record.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

const system={id:'sol',name:'Sol',pois:[
  {id:'station',name:'Sol Station',type:'station',position:{x:0,y:0},has_base:true,
    base_id:'sol_base',base_name:'Sol Base'},
]};
const PILOT:Pilot={name:'kvothe',objective:'fill the hold',goal:'three loads of ore',
  stance:'Prospector',mood:'Focused',home:'sol_base'};

/** A pilot at home on a serviced ship, with the record the runner would have written at the
 * last reflection. `over` moves whatever this test wants somewhere else. */
function fixture(over:{ship?:Record<string,number>;pilot?:Pilot;docked?:string|null;
  fuelPrice?:number|null;credits?:number;runScript?:any}={}) {
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
      ...over.runScript?{runScript:over.runScript}:{}});
  return {account,dispatch,runtime,record:()=>written,
    journal:()=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))};
}

test('rest refuses away from home, on a ship this base could service, and while a script runs, naming what would admit it', async () => {
  // Docked somewhere that is not the pilot's home: the whole point of rest is where it happens.
  const away=fixture({docked:'other_base'});
  const refusedAway=await away.dispatch('rest') as any;
  assert.equal(refusedAway.rested,false);
  assert.match(refusedAway.reason,/only at home/);
  assert.equal(away.record(),undefined,'a refused rest writes no record');

  // Home, but short of fuel at a base that quotes a price the wallet covers: service first.
  const short=fixture({ship:{fuel:60}});
  const refusedShort=await short.dispatch('rest') as any;
  assert.equal(refusedShort.rested,false);
  assert.match(refusedShort.reason,/refuel and repair first/);
  assert.equal(short.record(),undefined);

  // The same short ship at a base that posts no quote rests anyway, and says it is short:
  // an unserviceable home is not a reason to keep an evening open forever.
  const unserviceable=fixture({ship:{fuel:60},fuelPrice:null});
  const rested=await unserviceable.dispatch('rest') as any;
  assert.equal(rested.rested,true);
  assert.equal(rested.serviced,false,'reflection is told the ship is short');

  // A run in flight owns the pilot; rest waits for the juncture at its end.
  let release:((outcome:RunOutcome)=>void)|undefined;
  const busy=fixture({runScript:(options:any)=>{
    options?.onProgress?.({script:options.script,params:options.params,started:options.started,
      keep:[],ended:false});
    return new Promise<RunOutcome>(resolve=>{release=resolve;});
  }});
  await busy.dispatch('run',{script:'gather',params:{poi_id:'station'}});
  const refusedBusy=await busy.dispatch('rest') as any;
  assert.equal(refusedBusy.rested,false);
  assert.match(refusedBusy.reason,/script is running/);
  assert.equal(busy.record(),undefined);
  release!({script:'gather',outcome:'done',jobs:[],reason:'gather done: 1 job'});
});

test('at home the pilot rests whatever the world imposed on it, and the shift comes out clear', async () => {
  // Tired is the world's, not the agent's — and rest is what takes it away for good.
  const tired=fixture({pilot:{...PILOT,mood:'Tired'}});
  const rested=await tired.dispatch('rest') as any;
  assert.equal(rested.rested,true);
  assert.equal(rested.shift_ended,true);
  assert.equal(rested.at_rest,true);

  // The record keeps who the pilot is and what the operator wants; the shift's own three
  // settings are gone, so nothing is latched into the next one.
  assert.deepEqual(tired.record(),{name:'kvothe',objective:'fill the hold',home:'sol_base'});

  // What was put down is written down: a setting cleared with no record is a mystery later.
  const line=tired.journal().find(entry=>entry.event==='rest');
  assert.ok(line,'rest leaves its own line in the journal');
  assert.deepEqual({stance:line.stance,mood:line.mood,goal:line.goal,home:line.home},
    {stance:'Prospector',mood:'Tired',goal:'three loads of ore',home:'sol_base'});
  assert.ok(line.at,'the line is stamped');
});

/** A script of the pilot's own, saved so the review has code to read. */
const OWN="import {where,type Ctx,type JobOutcome} from '../jobs/index.ts';\n"+
  "export const params={type:'object',description:'Look around.',properties:{}};\n"+
  "export default async (ctx:Ctx):Promise<JobOutcome>=>{await where(ctx);\n"+
  "return {job:'look',outcome:'done'};};\n";

test("the rest report reviews the pilot's own scripts against how their runs ended", async () => {
  // A resting pilot: no stance, so the consultation is the reflection, not a menu (N7).
  const f=fixture({pilot:{name:'kvothe',objective:'fill the hold',home:'sol_base'}});
  await f.dispatch('scripts',{action:'save',name:'look-around',source:OWN});
  // Three runs of it, the last two badly: this is what a review is supposed to notice.
  for(const ended of [{outcome:'done',reason:'look-around done: 1 job'},
    {outcome:'blocked',reason:'look-around blocked at job 1 of 1: no route'},
    {outcome:'failed',reason:'look-around failed: the hold was full'}])
    journalRun(f.runtime,{phase:'ended',script:'look-around',jobs:[],...ended});
  journalRun(f.runtime,{phase:'ended',script:'gather',outcome:'done',jobs:[]});

  const report=await f.dispatch('reflect') as any;
  const mine=report.scripts.find((row:any)=>row.name==='look-around');
  assert.ok(mine,`the pilot's own script is in the review: ${JSON.stringify(report.scripts)}`);
  assert.equal(mine.saved,true);
  assert.equal(mine.bytes,OWN.length,'with its size, so the review knows what it is reading');
  assert.ok(mine.params.description,'and what it takes');
  assert.equal(mine.runs,3);
  // The last runs, in order, so a script that keeps ending blocked shows it.
  assert.deepEqual(mine.last.map((run:any)=>run.outcome),['done','blocked','failed']);
  assert.match(mine.last.at(-1).reason,/hold was full/);

  // A shipped script carries its use and nothing else: the review is of the pilot's code.
  const shipped=report.scripts.find((row:any)=>row.name==='gather');
  assert.deepEqual(shipped,{name:'gather',runs:1});
  assert.ok(!report.scripts.some((row:any)=>row.name==='stow'),'a script never run is not a review');
});
