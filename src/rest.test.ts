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
import type {ChainOutcome} from './chain.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
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
  fuelPrice?:number|null;credits?:number;runChain?:any}={}) {
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
      ...over.runChain?{runChain:over.runChain}:{}});
  return {account,dispatch,runtime,record:()=>written,
    journal:()=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))};
}

test('rest refuses away from home, on a ship this base could service, and while a chain runs, naming what would admit it', async () => {
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

  // A chain in flight owns the pilot; rest waits for the juncture at its end.
  let release:((outcome:ChainOutcome)=>void)|undefined;
  const busy=fixture({runChain:(_a:unknown,_c:unknown,chain:any,options:any)=>{
    options?.onProgress?.({kind:chain.kind,jobs:chain.jobs,length:1,position:0,ended:false});
    return new Promise<ChainOutcome>(resolve=>{release=resolve;});
  }});
  await busy.dispatch('job',{job:'gather',poi_id:'station'});
  const refusedBusy=await busy.dispatch('rest') as any;
  assert.equal(refusedBusy.rested,false);
  assert.match(refusedBusy.reason,/chain is running/);
  assert.equal(busy.record(),undefined);
  release!({outcome:'done',jobs:[],juncture:{reason:'done'}});
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
