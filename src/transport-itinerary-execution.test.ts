import test from 'node:test';
import assert from 'node:assert/strict';
import {passengerFixture} from './passenger-fixture.ts';
import {transportReceipt} from './execution-logistics.ts';

function itineraryFixture(t:any,unexpectedBurn=false) {
  const f=passengerFixture(t),systems=['system','middle','target'];
  let serverTick=1;
  const distance=(from:string,to:string)=>Math.abs(systems.indexOf(from)-systems.indexOf(to));
  f.execution.deps.locations=async(origin,params)=>{
    const stations=[{base_id:'base',id:'base',poi_id:'station',system_id:'system',system_name:'Home',station_name:'Home',services:['refuel'],hops:distance(origin!,'system')},
      {base_id:'other',id:'other',poi_id:'other',system_id:'target',system_name:'Target',station_name:'Target',services:['refuel'],hops:distance(origin!,'target')}];
    return {origin_system:origin,stations,destination_matches:(params.observed_destination_ids as string[]??[]).map(requested_id=>({requested_id,status:'resolved' as const,station:{...stations.find(row=>row.base_id===requested_id)!,rationale:'fixture',observed_at:'fixture'}}))};
  };
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params:any={})=>{
    const reply=await send(tool,action,params);
    if(tool==='spacemolt_shipping'&&action==='active')return {structuredContent:{action:'active',tick:serverTick,shipments:[]}} as any;
    if(action==='find_route') {
      const start=systems.indexOf(f.state.location.system_id),end=systems.indexOf(params.id),direction=Math.sign(end-start),steps=distance(f.state.location.system_id,params.id);
      const perJump=f.state.ship.cargo_used>1?30:10;
      return {structuredContent:{found:true,target_system:params.id,total_jumps:steps,estimated_fuel:steps*perJump,fuel_per_jump:perJump,
        cargo_used:f.state.ship.cargo_used,fuel_available:f.state.ship.fuel,
        route:Array.from({length:steps+1},(_,jumps)=>({system_id:systems[start+jumps*direction],jumps}))}} as any;
    }
    if(action==='get_system') {
      const index=systems.indexOf(f.state.location.system_id);
      return {structuredContent:{system:{id:f.state.location.system_id,connections:systems.filter((_row,i)=>Math.abs(i-index)===1),pois:[]}}} as any;
    }
    if(action==='jump') {
      const burn=unexpectedBurn&&f.state.location.system_id==='system'&&params.id==='middle'?80:10;
      f.state.ship.fuel-=burn;f.state.location={system_id:params.id,poi_id:'arrival-'+params.id,docked_at:null};
      if(params.id==='middle')serverTick=10;
    }
    return reply;
  };
  return f;
}

test('a late accepted leg blocks the next productive leg while preserving custody and recording overrun',async t=>{
  const f=itineraryFixture(t);await f.choose();f.execution.context.limits.max_ticks=5;
  const job:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.notEqual(job.status,'completed');assert.equal(f.passengers().length,1);
  const timing=job.transport_progress_checks.map((row:any)=>row.timing).filter(Boolean);
  const blocked=timing.find((row:any)=>row.status==='blocked');
  assert.ok(blocked);assert.equal(blocked.start_tick,1);assert.equal(blocked.elapsed_ticks,9);assert.equal(blocked.overrun_ticks,4);
  const jumps=f.calls.filter(row=>row.key==='spacemolt/jump').map(row=>row.params.id);
  assert.deepEqual(jumps,['middle','system'],'Only the accepted outward leg and defensive return ran');
  assert.ok(job.transport_progress_checks.some((row:any)=>row.deadlines?.selected?.length));
});

test('boarding-induced load changes invalidate the full fuel itinerary before any productive travel',async t=>{
  const f=itineraryFixture(t);await f.choose();
  f.onBoard(()=>{f.state.cargo.push({item_id:'passenger-baggage',quantity:10,size:1});f.state.ship.cargo_used+=10;});
  const job:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.notEqual(job.status,'completed');assert.equal(f.passengers().length,1);
  const plans=job.transport_itinerary_checks.filter((row:any)=>row.fuel).map((row:any)=>row.fuel);
  assert.equal(plans[0].status,'ready');assert.equal(plans.at(-1).status,'blocked');
  assert.ok(plans.at(-1).required_fuel>plans[0].required_fuel);
  assert.equal(f.calls.some(row=>['spacemolt/undock','spacemolt/jump','spacemolt/travel'].includes(row.key)),false);
  assert.equal(f.calls.filter(row=>row.key==='spacemolt/load_passenger').length,1);
  assert.equal(transportReceipt(job.result)!.loaded.length,1);
});

test('unexpected first-jump fuel consumption blocks the next productive jump while allowing custody-preserving return',async t=>{
  const f=itineraryFixture(t,true);await f.choose();
  const job:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.notEqual(job.status,'completed');assert.equal(f.passengers().length,1);
  const jumps=f.calls.filter(row=>row.key==='spacemolt/jump').map(row=>row.params.id);
  assert.deepEqual(jumps,['middle','system'],'Only the first outward jump and defensive return occur');
  const plans=job.transport_itinerary_checks.filter((row:any)=>row.fuel).map((row:any)=>row.fuel);
  assert.equal(plans[0].status,'ready');
  const blocked=plans.find((row:any)=>row.status==='blocked');
  assert.equal(blocked.current.system_id,'middle');assert.equal(blocked.current.fuel,40);
  assert.equal(blocked.required_fuel,47);
  assert.equal(f.state.location.docked_at,'base');assert.equal(f.state.ship.fuel,120);
  const service=job.result.cleanup.service;
  assert.ok(service.transport_cleanup_budget.planning_overrun>0);
  assert.equal(service.transport_cleanup_budget.actual_service_spend,job.budget_spending.gross_spend);
  assert.ok(job.budget_spending.gross_spend<=job.budget_spending.max_spend);
  assert.equal(f.calls.some(row=>row.key==='spacemolt/unload_passenger'),false);
  assert.ok(job.transport_itinerary_checks.some((row:any)=>row.movement?.after.location.system_id==='middle'));
});
