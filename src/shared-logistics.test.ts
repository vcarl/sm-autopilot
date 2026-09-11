import test from 'node:test';
import assert from 'node:assert/strict';
import {freightFixture} from './logistics-fixture.ts';
import {passengerFixture} from './passenger-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {transportReceipt,validateTransportRoute} from './execution-logistics.ts';
import {resolveContext} from './execution-policy.ts';

test('transport admission checks fresh home reachability from the delivery system before accepting either custody',async t=>{
  for(const kind of ['freight','passengers'])for(const issue of ['home_outside','destination_moved','destination_poi_changed','destination_missing','destination_wrecked']) {
    const f=kind==='freight'?freightFixture(t):passengerFixture(t);await f.choose();
    const locations=f.execution.deps.locations!;
    f.execution.deps.locations=async(system,params)=>{
      const observation=await locations(system,params);
      if(params.refresh_map) {
        assert.deepEqual(new Set(params.observed_destination_ids as string[]),new Set(['other','base']));
        const target={...observation.stations!.find(row=>row.base_id==='other')!,id:'other',system_id:issue==='destination_moved'?'moved':'far',poi_id:issue==='destination_poi_changed'?'new-poi':'other',hops:0,rationale:'fixture',observed_at:'fixture'};
        return {...observation,origin_system:system,destination_matches:[
          {requested_id:'base',status:issue==='home_outside'?'outside_route_limit':'resolved',station:{...f.execution.context.home!,id:'base',station_name:'Moved home',hops:issue==='home_outside'?4:2}},
          {requested_id:'other',status:issue==='destination_missing'?'missing':issue==='destination_wrecked'?'wrecked':'resolved',station:target}]};
      }
      return {...observation,stations:observation.stations!.map(row=>row.base_id==='other'?{...row,system_id:'far',hops:2}:row)};
    };
    const send=f.account.send.bind(f.account);
    f.account.send=async(tool,action,params:any)=>action==='find_route'?{structuredContent:{found:true,target_system:'far',total_jumps:2,estimated_fuel:20,fuel_per_jump:10,route:[{system_id:'system',jumps:0},{system_id:'middle',jumps:1},{system_id:'far',jumps:2}]}} as any:send(tool,action,params);
    const job:any=await f.execution.dispatch('transport',kind==='freight'?{kind,shipment_id:'freight'}:{kind,destination:'other'});
    assert.notEqual(job.status,'completed');
    assert.equal(f.calls.some(row=>['spacemolt/load_passenger','spacemolt_shipping/accept','spacemolt/undock'].includes(row.key)),false);
    assert.equal(job.transport_return_checks[0].origin_system,'far');
    assert.equal(job.transport_return_checks[0].status,'blocked');
    if(issue==='home_outside')assert.equal(job.transport_return_checks[0].observation.destination_matches[0].station.hops,4);
    assert.equal(f.store.data.home?.base_id,'base');
  }
});

test('home movement after boarding preserves passengers, while already-arrived custody can settle with blocked return evidence',async t=>{
  const f=passengerFixture(t,{autoDeliver:false});await f.choose();
  const locations=f.execution.deps.locations!;let moved=false;
  f.execution.deps.locations=async(system,params)=>{
    const observation=await locations(system,params);
    if(!params.refresh_map)return observation;
    return {...observation,destination_matches:[
      {requested_id:'base',status:moved?'outside_route_limit':'resolved',station:{...f.execution.context.home!,id:'base',station_name:'Home',hops:moved?4:0}},
      {requested_id:'other',status:'resolved',station:{...observation.stations!.find(row=>row.base_id==='other')!,id:'other',rationale:'fixture',observed_at:'fixture'}}]};
  };
  f.onBoard(()=>{moved=true;});
  const first:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.equal(f.passengers().length,1);
  assert.deepEqual(first.transport_return_checks.map((row:any)=>row.status),['reachable','blocked']);
  assert.equal(f.calls.some(row=>row.key==='spacemolt/travel'),false);
  assert.equal(f.calls.filter(row=>row.key==='spacemolt/load_passenger').length,1);
  // Represent an externally verified arrival before resuming the recorded custody.
  f.state.location={...f.state.location,poi_id:'other',docked_at:'other'};
  const store=new ExecutionStore(f.directory,'pilot');await store.startNewRun(f.account);
  const resumed=new Execution(f.account,store,f.execution.context,f.execution.deps);
  f.state.ship.fuel=16;
  const callStart=f.calls.length;
  const result:any=await resumed.dispatch('transport',{resume_job_id:first.id});
  assert.equal(transportReceipt(result.result)!.status,'completed');
  assert.equal(result.transport_return_checks[0].status,'blocked');
  assert.equal(f.passengers().length,0);assert.equal(f.calls.filter(row=>row.key==='spacemolt/load_passenger').length,1);
  assert.equal(f.calls.filter(row=>row.key==='spacemolt/unload_passenger').length,1);
  const settlingCalls=f.calls.slice(callStart);
  assert.ok(settlingCalls.findIndex(row=>row.key==='spacemolt/unload_passenger')<settlingCalls.findIndex(row=>row.key==='spacemolt/refuel'),'Existing arrived custody settles before return servicing');
  const freight=freightFixture(t);await freight.choose();
  const send=freight.account.send.bind(freight.account);
  freight.account.send=async(tool,action,params)=>{
    const reply=await send(tool,action,params);
    if(tool==='spacemolt_storage'&&action==='withdraw')freight.execution.signal('Tired after verified package loading');
    return reply;
  };
  const carrying:any=await freight.execution.dispatch('transport',{kind:'freight',shipment_id:'freight'});
  assert.equal(transportReceipt(carrying.result)!.pending_action,undefined);
  assert.equal(freight.state.cargo.some((row:any)=>row.item_id==='package:box'),true);
  freight.state.location={...freight.state.location,poi_id:'other',docked_at:'other'};
  const restored=new ExecutionStore(freight.directory,'pilot');await restored.startNewRun(freight.account);
  const continuation=new Execution(freight.account,restored,freight.execution.context,freight.execution.deps);
  // After admission, the destination station moves while this ship remains docked.
  freight.state.location={...freight.state.location,system_id:'moved-system',poi_id:'moved-poi'};
  freight.state.ship.fuel=16;
  const beforeSettlement=freight.calls.length;
  const settled:any=await continuation.dispatch('transport',{resume_job_id:carrying.id});
  const delivered=transportReceipt(settled.result)!;
  assert.equal(delivered.status,'completed');assert.equal(delivered.destination.system_id,'moved-system');
  const resumedCalls=freight.calls.slice(beforeSettlement),deliveryIndex=resumedCalls.findIndex(row=>row.key==='spacemolt_shipping/deliver');
  assert.ok(deliveryIndex>=0);
  assert.equal(resumedCalls.slice(0,deliveryIndex).some(row=>['spacemolt/travel','spacemolt/jump','spacemolt/undock','spacemolt/refuel'].includes(row.key)),false);
  assert.equal(freight.calls.filter(row=>row.key==='spacemolt_shipping/accept').length,1);
  assert.equal(freight.state.cargo.some((row:any)=>row.item_id==='package:box'),false);
});

test('shared Logistics delivers freight and passengers once, preserves spending and stops after serviced return',async t=>{
  for(const kind of ['freight','passengers']) {
    const f=kind==='freight'?freightFixture(t):passengerFixture(t);await f.choose();
    if(kind==='passengers') {
      const fit:any=await f.execution.dispatch('assess',{kind:'passenger_fit'});
      assert.equal(fit.status,'ready');
      const prepared:any=await f.execution.dispatch('prepare',{kind:'passengers'});
      assert.equal(prepared.status,'completed');
      assert.equal(prepared.result.status,'ready');
      assert.equal(f.calls.some(call=>['spacemolt/buy','spacemolt/install_mod','spacemolt/uninstall_mod'].includes(call.key)),false);
    }
    const job:any=await f.execution.dispatch('transport',kind==='freight'?{kind,shipment_id:'freight'}:{kind,destination:'other'});
    assert.equal(job.status,'completed',JSON.stringify(job.result));
    assert.equal(transportReceipt(job.result)?.status,'completed');
    assert.equal(f.state.location.docked_at,'base');assert.equal(f.state.ship.fuel,f.state.ship.max_fuel);
    assert.match(job.stopping_reason,/one_job transport/);
    assert.ok(job.cash_delta>0);assert.ok(job.spending.gross_spend>0);
    await assert.rejects(f.execution.dispatch('transport',{kind,destination:'other'}));
    const paid=f.calls.filter(call=>call.key==='spacemolt/refuel').length;
    await f.execution.dispatch('return_to_base');
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/refuel').length,paid);
  }
});

test('Tired after boarding retains passenger custody and later resumes without boarding again; mood constrains routes',async t=>{
  const f=passengerFixture(t);await f.choose();f.onBoard(()=>f.execution.signal('Tired'));
  const first:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.notEqual(first.status,'completed');assert.equal(f.passengers().length,1);
  assert.equal(f.calls.some(call=>call.key==='spacemolt/unload_passenger'),false);
  const store=new ExecutionStore(f.directory,'pilot');await store.startNewRun(f.account);
  const execution=new Execution(f.account,store,f.execution.context,f.execution.deps);
  const next:any=await execution.dispatch('transport',{resume_job_id:first.id});
  assert.equal(next.status,'completed',JSON.stringify(next));assert.equal(f.passengers().length,0);
  assert.equal(f.calls.filter(call=>call.key==='spacemolt/load_passenger').length,1);
  assert.equal(next.budget_owner_id,first.id);
  const target={base_id:'far',poi_id:'far',system_id:'far',rationale:'fixture',observed_at:'fixture'};
  const command=async()=>({found:true,target_system:'far',total_jumps:2,estimated_fuel:20,fuel_per_jump:10,route:[{system_id:'system',jumps:0},{system_id:'middle',jumps:1},{system_id:'far',jumps:2}]});
  await assert.rejects(validateTransportRoute(f.account,command,target,resolveContext({stance:'Logistics',mood:'Cautious',objective:'Delivery'})),/mood jump/);
  await validateTransportRoute(f.account,command,target,resolveContext({stance:'Logistics',mood:'Focused',objective:'Delivery'}));
});
