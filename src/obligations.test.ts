import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.ts';
import {ExecutionStore} from './execution-store.ts';

test('Hunt admission protects transport commitments; Tired records fresh deadlines and queued work without settling or discarding them',async t=>{
  for(const kind of ['passengers','freight']) {
    const f=executionFixture(t);await f.choose();
    const send=f.account.send.bind(f.account);
    const passenger={citizen_id:'traveler',destination:'other',destination_system:'system',ticks_remaining:100};
    const shipment={contract:{id:'cargo-contract',destination_base_id:'other'},role:'carrier',package_in_your_cargo:true,ticks_to_deadline:200};
    const production={kind:'queue',jobs:[{job_id:'production',est_completion_tick:150}],total_jobs:1};
    f.account.send=async(tool,action,params)=>{
      if(action==='list_passengers'&&kind==='passengers')return {structuredContent:{count:1,passengers:[passenger]}} as any;
      if(tool==='spacemolt_shipping'&&action==='active'&&kind==='freight')return {structuredContent:{action:'active',shipments:[shipment],tick:0}} as any;
      if(action==='craft')return {structuredContent:production} as any;
      return send(tool,action,params);
    };
    const denied:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
    assert.equal(denied.status,'blocked');assert.match(denied.error,/transport commitments/);
    assert.ok(!f.calls.some(c=>['spacemolt/hunt','spacemolt/undock'].includes(c.key)));
    f.state.ship.shield=10;
    f.execution.deps.combat!.sleep=async()=>{passenger.ticks_remaining=80;production.jobs=[];production.total_jobs=0;f.state.ship.shield=35;};
    const returned:any=await f.execution.dispatch('return_to_base');
    assert.equal(returned.status,'returned_to_base');
    assert.equal(returned.obligations.production.jobs[0].job_id,'production');
    assert.deepEqual(returned.obligations_after.production.jobs,[]);
    if(kind==='passengers') {
      assert.equal(returned.obligations.passengers.passengers[0].ticks_remaining,100);
      assert.equal(returned.obligations_after.passengers.passengers[0].ticks_remaining,80);
    } else assert.deepEqual(returned.obligations_after.freight.shipments,[shipment]);
    assert.equal(returned.obligation_verification.status,'observed');
    assert.deepEqual(new ExecutionStore(f.directory,'pilot').data.jobs.at(-1)?.obligations_after,returned.obligations_after);
    assert.ok(!f.calls.some(c=>/deliver|unload_passenger|cancel|sell|jettison/.test(c.key)));
    assert.equal(f.store.data.home?.base_id,'base');
  }
});

test('missing obligation lists cannot authorize a sortie or establish verified return; queued production alone does not prohibit Hunt',async t=>{
  const f=executionFixture(t);await f.choose();
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{
    if(action==='craft')return {structuredContent:{kind:'queue',jobs:[{job_id:'pending-output'}],total_jobs:1}} as any;
    if(tool==='spacemolt_shipping'&&action==='active')return {structuredContent:{shipments:[{role:'shipper',package_in_your_cargo:false}],tick:0}} as any;
    return send(tool,action,params);
  };
  const hunted:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(hunted.status,'completed');
  assert.equal(hunted.obligations_after.production.jobs[0].job_id,'pending-output');
  f.account.send=async(tool,action,params)=>action==='list_passengers'?{structuredContent:{}} as any:send(tool,action,params);
  const denied:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(denied.status,'blocked');assert.match(denied.error,/Incomplete obligation/);
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/hunt').length,1);
  assert.equal(denied.obligation_verification.status,'unavailable');
  f.account.send=async(tool,action,params)=>action==='craft'?{structuredContent:{kind:'queue',jobs:[],total_jobs:1}} as any:send(tool,action,params);
  await assert.rejects(f.execution.dispatch('observe'),/Incomplete obligation/);
  f.account.send=async(tool,action,params)=>tool==='spacemolt_shipping'&&action==='active'?{structuredContent:{shipments:[{role:'shipper'}]}} as any:send(tool,action,params);
  const unknownCustody:any=await f.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(unknownCustody.status,'blocked');assert.match(unknownCustody.error,/transport commitments/);
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/hunt').length,1);
  const malformed=executionFixture(t);await malformed.choose();
  malformed.state.location={system_id:'system',poi_id:'belt',docked_at:null};
  const realSend=malformed.account.send.bind(malformed.account);
  malformed.account.send=async(tool,action,params)=>action==='list_passengers'?{structuredContent:{}} as any:realSend(tool,action,params);
  const safe:any=await malformed.execution.dispatch('return_to_base');
  assert.equal(safe.status,'blocked');
  assert.equal(safe.after.location.docked_at,'base');
  assert.equal(safe.after.ship.fuel,safe.after.ship.max_fuel);
  assert.match(safe.obligation_admission_error,/Incomplete obligation/);
  assert.equal(safe.obligation_verification.status,'unavailable');
  const lost=executionFixture(t);await lost.choose();
  const lostSend=lost.account.send.bind(lost.account);let lose=true;
  lost.account.send=async(tool,action,params)=>{
    const result=await lostSend(tool,action,params);
    if(action==='travel'&&lose){lose=false;throw new Error('Lost arrival response');}
    return result;
  };
  assert.equal((await lost.execution.dispatch('hunt',{poi_id:'belt'}) as any).status,'needs_reconciliation');
  lost.account.send=async(tool,action,params)=>action==='list_passengers'?{structuredContent:{}} as any:lostSend(tool,action,params);
  const recovered:any=await lost.execution.reconcile();
  assert.equal(recovered.status,'blocked');
  assert.equal(recovered.after.location.docked_at,'base');
  assert.equal(recovered.after.ship.fuel,recovered.after.ship.max_fuel);
  assert.equal(recovered.obligation_verification.status,'unavailable');
  assert.match(recovered.reconciliation.at(-1).obligation_error,/Incomplete obligation/);
  const g=executionFixture(t);await g.choose();
  const original=g.account.send.bind(g.account);let reads=0;
  g.account.send=async(tool,action,params)=>{
    if(action==='list_passengers'&&++reads>1)throw new Error('Observation connection lost');
    return original(tool,action,params);
  };
  const returned:any=await g.execution.dispatch('return_to_base');
  assert.notEqual(returned.status,'returned_to_base');
  assert.equal(returned.obligation_verification.status,'unavailable');
  assert.equal(returned.after.location.docked_at,'base');
  assert.ok(returned.obligations);
});
