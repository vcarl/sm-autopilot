import test from 'node:test';
import assert from 'node:assert/strict';
import {freightFixture} from './logistics-fixture.ts';
import {passengerFixture} from './passenger-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {transportReceipt,validateTransportRoute} from './execution-logistics.ts';
import {resolveContext} from './execution-policy.ts';

test('shared Logistics delivers freight and passengers once, preserves spending and stops after serviced return',async t=>{
  for(const kind of ['freight','passengers']) {
    const f=kind==='freight'?freightFixture(t):passengerFixture(t);await f.choose();
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
