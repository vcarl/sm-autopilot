import test from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {executionFixture} from './execution-fixture.ts';
import {gatherFixture} from './gather-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';

test('mobile home resolves by base identity for return and Industry without mutating session policy or choosing a new home',async t=>{
  for(const docked of [true,false]) {
    const f=executionFixture(t);await f.choose();
    f.execution.context.home!.system_id='old_system';f.store.save();
    const context=JSON.stringify(f.execution.context),home=structuredClone(f.store.data.home);
    if(!docked)f.state.location={system_id:'system',poi_id:'belt',docked_at:null};
    const receipt:any=await f.execution.dispatch('return_to_base');
    assert.equal(receipt.status,'returned_to_base');
    assert.equal(receipt.return_plan.temporary,false);
    assert.equal(receipt.return_plan.destination.base_id,home!.base_id);
    assert.equal(receipt.return_plan.destination.system_id,'system');
    assert.equal(receipt.return_plan.home_location_source,docked?'authenticated_home_dock':'station_directory');
    assert.ok(!f.calls.some(c=>c.key==='spacemolt/jump'||c.key==='spacemolt/find_route'));
    assert.deepEqual(f.store.data.home,home);
    assert.equal(JSON.stringify(f.execution.context),context);
  }
  const f=gatherFixture(t);await f.choose();f.execution.context.home!.system_id='old_system';f.store.save();
  const context=JSON.stringify(f.execution.context);
  const observed:any=await f.execution.dispatch('observe');
  assert.equal(observed.home_location.destination.system_id,f.state.location.system_id);
  const assessment:any=await f.execution.dispatch('assess',{poi_id:'belt'});
  assert.equal(assessment.status,'ready_to_verify_resources');
  const receipt:any=await f.execution.dispatch('gather',{poi_id:'belt',cycles:1});
  assert.equal(receipt.status,'completed');
  assert.deepEqual(receipt.result.gather.retained_cargo,{ore:2});
  assert.equal(JSON.stringify(f.execution.context),context);
});

test('restarted final cleanup reuses its verified fallback and budget but checks fresh service needs; a new run retries home',async t=>{
  const f=executionFixture(t);await f.choose();
  const home=structuredClone(f.store.data.home);
  f.state.location={system_id:'system',poi_id:'belt',docked_at:null};
  const send=f.account.send.bind(f.account);let denied=0;
  f.account.send=async(tool,action,params)=>{
    if(action==='dock'&&f.state.location.poi_id==='station'){denied++;throw new SpacemoltError('access_denied','Home denied');}
    return send(tool,action,params);
  };
  const first:any=await f.execution.dispatch('return_to_base');
  assert.equal(first.status,'returned_to_base');assert.equal(denied,1);
  const store=new ExecutionStore(f.directory,'pilot');
  const resumed=new Execution(f.account,store,f.execution.context,f.execution.deps);
  f.state.ship.fuel--;
  const calls=f.calls.length;
  const second:any=await resumed.dispatch('return_to_base');
  assert.equal(second.status,'returned_to_base');assert.equal(denied,1);
  assert.equal(second.return_plan.reused_from_job_id,first.id);
  assert.equal(second.budget_owner_id,first.id);
  assert.equal(second.spending.gross_spend,3);
  assert.equal(second.budget_spending.gross_spend,first.spending.gross_spend+3);
  assert.ok(!f.calls.slice(calls).some(c=>['spacemolt/undock','spacemolt/travel','spacemolt/jump'].includes(c.key)));
  assert.equal(second.obligation_verification.status,'observed');
  f.state.ship.hull--;
  const damaged:any=await resumed.dispatch('return_to_base');
  assert.equal(damaged.status,'blocked');assert.match(damaged.error,/repair quote/);assert.equal(denied,1);
  assert.deepEqual(store.data.home,home);
  f.state.ship.hull=f.state.ship.max_hull;
  await store.startNewRun(f.account);
  const next=new Execution(f.account,store,f.execution.context,f.execution.deps);
  await next.dispatch('return_to_base');
  assert.equal(denied,2);
});
