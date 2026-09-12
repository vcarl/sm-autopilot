import {executionFixture as fixture} from './execution-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionCatalog} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {resolveContext,stances,moods} from './execution-policy.ts';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {serveInput} from './bridge-input.ts';


test('resolved policy gates stale tools and real Hunt dispatch verifies return/service, preserves home and checkpoints uncertainty',async t=>{
  for(const stance of stances)for(const mood of moods) {
    const context=resolveContext({stance,mood,objective:'test'});
    assert.ok(!('hunt' in executionCatalog(context)));
    if(mood==='Tired')assert.ok(!('travel' in executionCatalog(context)));
  }
  assert.throws(()=>resolveContext({objective:'test',mood:'Cautious',limits:{retreat_hull_fraction:0.8}}),/bounds/);
  const f=fixture(t);await f.choose();
  const visit:any=await f.execution.dispatch('travel',{base_id:'other'});
  assert.equal(visit.status,'completed');assert.equal(f.state.location.docked_at,'other');
  assert.equal(f.store.data.home?.base_id,'base');
  await f.execution.dispatch('travel',{base_id:'base'});
  const receipt:any=await f.execution.dispatch('hunt',{poi_id:'belt',species:'phase_lurker'});
  assert.equal(receipt.status,'completed');assert.equal(receipt.result.sortie.fight.verified_victory,true);
  assert.equal(f.state.ship.fuel,120);assert.equal(f.state.location.docked_at,'base');
  assert.equal(receipt.cash_delta,-6);assert.deepEqual(receipt.obligations.missions,f.state.missions);
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/hunt').length,1);
  assert.ok(receipt.actions.every((a:any)=>a.status==='confirmed'));
  assert.equal(new ExecutionStore(f.directory,'pilot').data.home?.base_id,'base');
  f.execution.signal();
  await assert.rejects(f.execution.dispatch('hunt',{poi_id:'belt'}),/admission closed/);
  const returned:any=await f.execution.dispatch('return_to_base');assert.equal(returned.status,'returned_to_base');
  const unpaid=fixture(t);await unpaid.choose();unpaid.execution.context.limits.max_spend=0;
  const incomplete:any=await unpaid.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(incomplete.status,'blocked');
  assert.equal(incomplete.result.partial.sortie.fight.verified_victory,true);
  assert.ok(unpaid.state.ship.fuel<unpaid.state.ship.max_fuel);
  const locked=resolveContext({objective:'test',mood:'Relaxed'});locked.authority={mood:'Relaxed'};
  assert.throws(()=>resolveContext({mood:'Aggressive'},locked),/locked/);
  const tired=fixture(t);await tired.choose();
  await tired.execution.dispatch('plan',{mood:'Tired'});tired.execution.handoff();
  await assert.rejects(tired.execution.dispatch('plan',{mood:'Aggressive'}),/latched/);
  const broken=fixture(t);await broken.choose();
  const send=broken.account.send.bind(broken.account);
  broken.account.send=async(tool,action,params)=>{if(action==='hunt')throw new Error('Disconnected after acceptance');return send(tool,action,params);};
  const uncertain:any=await broken.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(uncertain.status,'needs_reconciliation');
  const restarted=new ExecutionStore(broken.directory,'pilot');assert.equal(restarted.unresolved()?.id,uncertain.id);
  assert.equal(uncertain.actions.at(-1).action,'spacemolt/hunt');
  await assert.rejects(broken.execution.dispatch('hunt',{poi_id:'belt'}),/reconciliation/);
});

test('a plan that restates the current context keeps the session productive; a real change still hands off',async t=>{
  const f=fixture(t);await f.choose();
  const restated:any=await f.execution.dispatch('plan',{objective:'One verified hunt',mood:'Aggressive'});
  assert.equal(restated.status,'unchanged');
  assert.equal(f.execution.pending as unknown,undefined);
  const rehomed:any=await f.execution.dispatch('plan',{home_base_id:'base',home_rationale:'Services near wildlife and existing storage'});
  assert.equal(rehomed.status,'unchanged');
  assert.equal(f.execution.pending as unknown,undefined);
  const visit:any=await f.execution.dispatch('travel',{base_id:'other'});
  assert.equal(visit.status,'completed');
  const changed:any=await f.execution.dispatch('plan',{objective:'Gather instead'});
  assert.equal(changed.status,'handoff_required');
  assert.equal((f.execution.pending as any)?.objective,'Gather instead');
  await assert.rejects(f.execution.dispatch('travel',{base_id:'base'}),/handoff required/);
});

test('urgent input reaches an active script while ordinary frames remain serialized; Tired changes live combat without inference',async t=>{
  const input=new PassThrough(),lines=createInterface({input});
  let release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r);
  const seen:string[]=[];
  const serving=serveInput(lines,async line=>{seen.push(JSON.parse(line).action);entered();await waiting;},reason=>{seen.push(reason);release();});
  input.write('{"action":"work"}\n');await started;
  input.write('{"action":"control/stop","params":{"reason":"Tired"}}\n');input.end('{"action":"next"}\n');
  await serving;assert.deepEqual(seen,['work','Tired','next']);
  const f=fixture(t);await f.choose();
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{const value=await send(tool,action,params);if(action==='hunt')f.execution.signal();return value;};
  const receipt:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(receipt.status,'returned_to_base');
  assert.ok(f.calls.some(c=>c.key==='spacemolt_battle/stance'&&c.params.id==='flee'));
  assert.equal(receipt.result.sortie.fight.retreated,true);
  assert.equal(f.state.ship.fuel,120);
});
