import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.ts';
import {Execution} from './execution.ts';
import {reconcileAction} from './recovery.ts';
import {SpacemoltError} from '@spacemolt/lib';
import {ExecutionStore} from './execution-store.ts';

test('accepted mutation is durably retained before refresh failure; restart reconciles and returns without replay',async t=>{
  const f=executionFixture(t);await f.choose();f.state.ship.fuel=110;
  const send=f.account.send.bind(f.account),refresh=f.account.refresh.bind(f.account);
  let paid=false,failed=false;
  f.account.send=async(tool,action,params)=>{const result=await send(tool,action,params);if(action==='refuel')paid=true;return result;};
  f.account.refresh=async()=>{if(paid&&!failed){failed=true;throw new Error('Lost state refresh after refuel');}return refresh();};
  const receipt:any=await f.execution.dispatch('return_to_base');
  assert.equal(receipt.status,'needs_reconciliation');
  const stored=new ExecutionStore(f.directory,'pilot');
  const uncertain=stored.unresolved()!.actions.find(a=>a.action==='spacemolt/refuel')!;
  assert.ok(uncertain.accepted_result);assert.equal(uncertain.status,'uncertain');
  const restarted=new Execution(f.account,stored,f.execution.context,f.execution.deps);
  const recovered:any=await restarted.reconcile();
  assert.equal(recovered.id,receipt.id);assert.equal(recovered.status,'returned_to_base');
  assert.equal(recovered.cash_delta,-30);
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/refuel').length,1);
  assert.ok(recovered.reconciliation.at(-1).obligations);
  assert.equal(stored.unresolved(),undefined);
  await assert.rejects(restarted.dispatch('hunt',{poi_id:'belt'}),/admission closed/);
  assert.equal((await restarted.reconcile()).status,'no_unfinished_job');
  const movement=executionFixture(t);await movement.choose();let lost=false;
  const move=movement.account.send.bind(movement.account);
  movement.account.send=async(tool,action,params)=>{const value=await move(tool,action,params);if(action==='travel'&&!lost){lost=true;throw new Error('Arrival response lost');}return value;};
  await movement.execution.dispatch('track');
  const arrived:any=await movement.execution.reconcile();assert.equal(arrived.status,'interrupted');
  assert.equal(movement.calls.filter(c=>c.key==='spacemolt/travel'&&c.params.id==='belt').length,1);
  const purchase={action:'spacemolt/buy',params:{id:'ore',quantity:1},status:'uncertain' as const,before:movement.execution.snapshot()};
  assert.equal(reconcileAction(purchase,movement.execution.snapshot(),null).resolved,false);

});

test('lost hunt response is reconciled from live quarry participation and defended; absent battle and unproven purchases stay blocked',async t=>{
  const f=executionFixture(t);await f.choose();
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{const value=await send(tool,action,params);if(action==='hunt')throw new Error('Lost hunt reply');return value;};
  const interrupted:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(interrupted.status,'needs_reconciliation');
  const recovered:any=await f.execution.reconcile();
  assert.equal(recovered.status,'interrupted');
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/hunt').length,1);
  assert.ok(f.calls.some(c=>c.key==='spacemolt_battle/stance'&&c.params.id==='flee'));
  assert.equal(f.state.location.docked_at,'base');assert.equal(f.state.ship.fuel,f.state.ship.max_fuel);
  assert.equal(recovered.reconciliation.at(-1).defense.retreated,true);
  const absent=executionFixture(t);await absent.choose();
  const original=absent.account.send.bind(absent.account);
  absent.account.send=async(tool,action,params)=>{if(action==='hunt')throw new Error('Lost before battle observed');return original(tool,action,params);};
  await absent.execution.dispatch('hunt',{poi_id:'belt'});
  const blocked:any=await absent.execution.reconcile();
  assert.equal(blocked.status,'needs_reconciliation');
  assert.match(blocked.reconciliation.at(-1).error,/Unresolved action/);
  assert.ok(absent.store.unresolved());
  assert.ok(!absent.calls.some(c=>c.key==='spacemolt/refuel'));
  const race=executionFixture(t);await race.choose();let observations=0;
  const raceSend=race.account.send.bind(race.account);
  race.account.send=async(tool,action,params)=>{
    const value=await raceSend(tool,action,params);
    if(action==='hunt')throw new Error('Hunt reply lost');
    if(tool==='spacemolt_battle'&&action==='status'&&++observations>1)throw new SpacemoltError('not_in_battle','Battle ended between reconciliation and defense');
    return value;
  };
  await race.execution.dispatch('hunt',{poi_id:'belt'});
  const ended:any=await race.execution.reconcile();assert.equal(ended.status,'interrupted');
  assert.equal(ended.reconciliation.at(-1).defense.battle_id,'battle');

});
