import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.ts';
import {ExecutionStore} from './execution-store.ts';
import {stances} from './execution-policy.ts';

test('idle Relaxed defense verifies participation, retreats with a durable job, and never initiates or repeats defensive mutations',async t=>{
  const f=executionFixture(t);await f.choose();
  f.execution.context.mood='Relaxed';
  f.execution.requestDefense();
  assert.equal((await f.execution.respondToDanger() as any).status,'no_active_battle');
  assert.equal(f.execution.stopped(),false);assert.equal(f.store.data.jobs.length,0);
  f.state.location={system_id:'system',poi_id:'belt',docked_at:null};f.attack();
  f.execution.requestDefense();f.execution.requestDefense();
  const receipt:any=await f.execution.respondToDanger();
  assert.equal(receipt.status,'returned_to_base');
  assert.equal(receipt.defense[0].result.retreated,true);
  assert.equal(receipt.after.location.docked_at,'base');
  assert.equal(receipt.after.ship.fuel,receipt.after.ship.max_fuel);
  assert.deepEqual(receipt.obligations_after.missions,f.state.missions);
  assert.ok(!f.calls.some(c=>c.key==='spacemolt/hunt'));
  assert.ok(f.calls.some(c=>c.key==='spacemolt_battle/stance'&&c.params.id==='flee'));
  assert.deepEqual(new ExecutionStore(f.directory,'pilot').data.jobs.at(-1)?.defense,receipt.defense);
  await f.execution.respondToDanger();assert.equal(f.store.data.jobs.length,1);
  for(const stance of stances) {
    const other=executionFixture(t);await other.choose();other.execution.context.stance=stance;other.execution.context.mood='Relaxed';
    const context=structuredClone(other.execution.context);
    other.execution.plan({objective:'A later operating period'});
    other.attack();other.execution.requestDefense();
    await assert.rejects(other.execution.dispatch('prepare'),/handoff|admission/);
    assert.equal(other.store.data.jobs.at(-1)?.status,'returned_to_base');
    assert.deepEqual(other.execution.context,context);
    assert.ok(!other.calls.some(c=>c.key==='spacemolt/hunt'));
  }
  const lost=executionFixture(t);await lost.choose();lost.attack();
  const send=lost.account.send.bind(lost.account);let failed=false;
  lost.account.send=async(tool,action,params)=>{
    const result=await send(tool,action,params);
    if(action==='stance'&&!failed){failed=true;throw new Error('Lost defensive stance response');}
    return result;
  };
  lost.execution.requestDefense();
  const uncertain:any=await lost.execution.respondToDanger();
  assert.equal(uncertain.status,'needs_reconciliation');
  assert.equal(new ExecutionStore(lost.directory,'pilot').unresolved()?.id,uncertain.id);
  const recovered:any=await lost.execution.reconcile();
  assert.equal(recovered.status,'returned_to_base');
  assert.ok(!lost.calls.some(c=>c.key==='spacemolt/hunt'));
});

test('danger waits for pending movement, suspends its stale objective, interrupts service waits, and leaves intentional Hunt tactics in control',async t=>{
  const f=executionFixture(t);await f.choose();
  const send=f.account.send.bind(f.account);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),waiting=new Promise<void>(resolve=>release=resolve);
  let pending=false,raced=false;
  f.account.send=async(tool,action,params)=>{
    if(pending)raced=true;
    if(action==='travel'&&params?.id==='other') {
      pending=true;entered();await waiting;pending=false;
      const result=await send(tool,action,params);f.attack();return result;
    }
    return send(tool,action,params);
  };
  const work=f.execution.dispatch('travel',{base_id:'other'});await started;
  f.execution.requestDefense();assert.equal(f.calls.some(c=>c.key==='spacemolt_battle/stance'),false);
  release();const receipt:any=await work;
  assert.equal(raced,false);assert.equal(receipt.defense[0].result.retreated,true);
  assert.equal(receipt.after.location.docked_at,'base');
  const returning=executionFixture(t);await returning.choose();returning.state.location={system_id:'system',poi_id:'other',docked_at:'other'};
  const returnSend=returning.account.send.bind(returning.account);let interrupted=false;
  returning.account.send=async(tool,action,params)=>{
    const result=await returnSend(tool,action,params);
    if(action==='undock'&&!interrupted){interrupted=true;returning.attack();returning.execution.requestDefense();}
    return result;
  };
  const home:any=await returning.execution.dispatch('return_to_base');
  assert.equal(home.status,'returned_to_base');
  assert.equal(home.after.location.docked_at,'base');
  assert.equal(home.return_reassessments.length,1);
  assert.equal(returning.calls.filter(c=>c.key==='spacemolt/undock').length,1);
  const resting=executionFixture(t);await resting.choose();resting.state.ship.shield=10;
  const sleep=resting.execution.deps.combat!.sleep!;let attacked=false;
  resting.execution.deps.combat!.sleep=async(ms)=>{
    await sleep(ms);
    if(!attacked){attacked=true;resting.attack();resting.execution.requestDefense();}
    resting.state.ship.shield=35;
  };
  const serviced:any=await resting.execution.dispatch('prepare');
  assert.ok(serviced.defense[0].result.retreated);
  assert.equal(resting.execution.stopped(),true);
  assert.ok(!resting.calls.some(c=>c.key==='spacemolt/install_mod'));
  const hunt=executionFixture(t);await hunt.choose();const original=hunt.account.send.bind(hunt.account);
  hunt.account.send=async(tool,action,params)=>{const result=await original(tool,action,params);if(action==='hunt')hunt.execution.requestDefense();return result;};
  const hunted:any=await hunt.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(hunted.status,'completed');assert.equal(hunted.defense,undefined);
  assert.ok(!hunt.calls.some(c=>c.key==='spacemolt_battle/stance'&&c.params.id==='flee'));
});
