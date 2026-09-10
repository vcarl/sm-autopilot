import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.ts';
import {gatherFixture} from './gather-fixture.ts';
import {Execution,executionCatalog} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {ExecutionHost} from './execution-host.ts';

test('one_job permits scout then hunt across handoff/reconnect, closes finished or blocked attempts, and only verified host new_run replenishes admission',async t=>{
  const f=executionFixture(t);await f.choose();
  const catalog=executionCatalog(f.execution.context);
  const scout:any=await f.execution.dispatch('track',{poi_ids:['belt']});
  assert.equal(scout.status,'completed');assert.equal(scout.stopping_reason,undefined);
  f.execution.plan({objective:'Continue the same bounded Hunt'});f.execution.handoff();
  const store=new ExecutionStore(f.directory,'pilot');
  const resumed=new Execution(f.account,store,f.execution.context,f.execution.deps);
  const hunt:any=await resumed.dispatch('hunt',{poi_id:'belt'});
  assert.equal(hunt.status,'completed');assert.match(hunt.stopping_reason,/attempt finished/);
  assert.deepEqual(executionCatalog(resumed.context),catalog);
  const calls=f.calls.length;
  await assert.rejects(resumed.dispatch('track',{poi_ids:['belt']}),/admission closed/);
  await assert.rejects(resumed.dispatch('hunt',{poi_id:'belt'}),/admission closed/);
  await assert.rejects(resumed.dispatch('plan',{stance:'Industry'}),/latched/);
  assert.equal(f.calls.length,calls);
  const host=new ExecutionHost(f.account,f.directory,f.execution.deps);
  const configure={...f.execution.context,wildlife:true,new_run:true};
  f.state.ship.fuel--;
  await assert.rejects(host.dispatch('execution/configure',configure),/fully serviced/);
  assert.equal(store.data.stop,hunt.stopping_reason);
  f.state.ship.fuel=f.state.ship.max_fuel;
  await host.dispatch('execution/configure',configure);
  const nextScout:any=await host.dispatch('job/track',{poi_ids:['belt']});
  assert.equal(nextScout.status,'completed');assert.equal(nextScout.stopping_reason,undefined);
  const tired:any=await host.dispatch('job/return_to_base');
  assert.equal(tired.status,'returned_to_base');assert.equal(tired.stopping_reason,'Tired');
  const industry=gatherFixture(t);await industry.choose();
  const gather:any=await industry.execution.dispatch('gather',{poi_id:'belt',cycles:1});
  assert.equal(gather.status,'completed');assert.match(gather.stopping_reason,/gather attempt finished/);
  await assert.rejects(industry.execution.dispatch('gather',{poi_id:'belt'}),/admission closed/);
});

test('scout repetition, empty discovery and admitted route blockers stop the durable run without another productive mutation',async t=>{
  for(const condition of ['repeat','empty','route']) {
    const f=executionFixture(t);await f.choose();
    const send=f.account.send.bind(f.account);
    f.account.send=async(tool,action,params):Promise<any>=>{
      if(condition==='empty'&&action==='get_nearby')return {structuredContent:{creatures:[]}};
      if(condition==='route'&&action==='find_route')return {structuredContent:{found:true,total_jumps:3,route:[]}};
      return send(tool,action,params);
    };
    let result:any=await f.execution.dispatch('track',condition==='route'?{target_system_id:'too_far'}:{poi_ids:['belt']});
    if(condition==='repeat') {
      assert.equal(result.stopping_reason,undefined);
      const movements=f.calls.filter(call=>['spacemolt/undock','spacemolt/travel','spacemolt/jump','spacemolt/scan'].includes(call.key));
      f.execution.plan({objective:'Same operating period after a new conversation'});f.execution.handoff();
      const resumed=new Execution(f.account,new ExecutionStore(f.directory,'pilot'),f.execution.context,f.execution.deps);
      result=await resumed.dispatch('track',{poi_ids:['belt']});
      assert.equal(result.status,'blocked');assert.match(result.error,/scouting allowance/);
      assert.deepEqual(f.calls.filter(call=>['spacemolt/undock','spacemolt/travel','spacemolt/jump','spacemolt/scan'].includes(call.key)),movements);
    } else if(condition==='route')assert.equal(result.status,'blocked');
    else {assert.equal(result.status,'completed');assert.match(result.stopping_reason,/no eligible quarry/);}
    assert.ok(result.stopping_reason);
    assert.equal(result.after.location.docked_at,'base');
    assert.equal(result.after.ship.fuel,result.after.ship.max_fuel);
    const restarted=new Execution(f.account,new ExecutionStore(f.directory,'pilot'),f.execution.context,f.execution.deps);
    const calls=f.calls.length;
    await assert.rejects(restarted.dispatch('track',{target_system_id:'another_place'}),/admission closed/);
    await assert.rejects(restarted.dispatch('hunt',{poi_id:'belt'}),/admission closed/);
    assert.equal(f.calls.length,calls);
    assert.ok(!f.calls.some(call=>call.key==='spacemolt/hunt'));
  }
});
