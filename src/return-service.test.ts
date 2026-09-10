import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {executionFixture} from './execution-fixture.ts';
import {stances} from './execution-policy.ts';

test('Tired returns through one explicit service fallback without changing home, custody or authority; uncertain docking never starts a fallback',async t=>{
  const f=executionFixture(t);await f.choose();
  const home=structuredClone(f.store.data.home),cargo=structuredClone(f.state.cargo),missions=structuredClone(f.state.missions);
  f.state.location={system_id:'system',poi_id:'belt',docked_at:null};
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{
    if(action==='dock'&&f.state.location.poi_id==='station')throw new SpacemoltError('access_denied','Home docking denied');
    return send(tool,action,params);
  };
  const receipt:any=await f.execution.dispatch('return_to_base');
  assert.equal(receipt.status,'returned_to_base');
  assert.equal(receipt.return_plan.temporary,true);
  assert.match(receipt.return_plan.reason,/denied/);
  assert.equal(receipt.return_plan.destination.base_id,f.state.location.docked_at);
  assert.equal(f.state.location.docked_at,'other');
  assert.deepEqual(f.store.data.home,home);assert.deepEqual(f.state.cargo,cargo);
  assert.deepEqual(receipt.obligations.missions,missions);
  await assert.rejects(f.execution.dispatch('hunt',{poi_id:'belt'}),/admission closed/);
  for(const stance of stances) {
    const homeless=executionFixture(t);
    homeless.execution.context.stance=stance;
    homeless.execution.context.mood='Tired';
    const returned:any=await homeless.execution.dispatch('return_to_base');
    assert.equal(returned.status,'returned_to_base');
    assert.equal(returned.return_plan.temporary,true);
    assert.equal(homeless.store.data.home,undefined);
    assert.ok(!homeless.calls.some(c=>c.key==='spacemolt/undock'));
  }
  const uncertain=executionFixture(t);await uncertain.choose();
  uncertain.state.location={system_id:'system',poi_id:'belt',docked_at:null};
  const originalSend=uncertain.account.send.bind(uncertain.account);
  uncertain.account.send=async(tool,action,params)=>{
    if(action==='dock')throw new Error('Lost docking response');
    return originalSend(tool,action,params);
  };
  const blocked:any=await uncertain.execution.dispatch('return_to_base');
  assert.equal(blocked.status,'needs_reconciliation');
  assert.equal(blocked.actions.at(-1).action,'spacemolt/dock');
  assert.ok(!uncertain.calls.some(c=>c.key==='spacemolt/travel'&&c.params.id==='other'));
});

test('return waits for observed shield recovery, bounds stalled recovery, and never claims readiness after lost docking or unquoted repair',async t=>{
  const f=executionFixture(t);await f.choose();
  f.state.ship.shield=10;
  const sleep=f.execution.deps.combat!.sleep!;
  f.execution.deps.combat!.sleep=async(ms)=>{await sleep(ms);f.state.ship.shield=f.state.ship.max_shield;};
  const receipt:any=await f.execution.dispatch('return_to_base');
  assert.equal(receipt.status,'returned_to_base');
  assert.ok(receipt.result.service.shield_wait_ms>0);
  assert.equal(receipt.after.ship.shield,receipt.after.ship.max_shield);
  const stalled=executionFixture(t);await stalled.choose();stalled.state.ship.shield=10;
  const blocked:any=await stalled.execution.dispatch('return_to_base');
  assert.equal(blocked.status,'blocked');assert.match(blocked.error,/120 seconds/);
  assert.equal(stalled.state.location.docked_at,'base');
  assert.ok(!stalled.calls.some(c=>c.key==='spacemolt/undock'));
  const moved=executionFixture(t);await moved.choose();moved.state.ship.shield=10;
  moved.execution.deps.combat!.sleep=async()=>{moved.state.location.docked_at=null;moved.state.ship.shield=moved.state.ship.max_shield;};
  const changed:any=await moved.execution.dispatch('return_to_base');
  assert.equal(changed.status,'blocked');assert.match(changed.error,/docking changed/);
  const damaged=executionFixture(t);await damaged.choose();damaged.state.ship.hull--;
  const unquoted:any=await damaged.execution.dispatch('return_to_base');
  assert.equal(unquoted.status,'blocked');assert.match(unquoted.error,/repair quote/);
  assert.ok(!damaged.calls.some(c=>c.key==='spacemolt/repair'));
});
