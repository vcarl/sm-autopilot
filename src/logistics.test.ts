import test from 'node:test';
import assert from 'node:assert/strict';
import {assessFreight,transportFreight,type FreightReceipt} from './logistics.ts';
import {freightFixture} from './logistics-fixture.ts';
import {Execution,executionCatalog} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {moods,resolveContext} from './execution-policy.ts';
import {transportReceipt} from './execution-logistics.ts';
import {logisticsPolicy} from './logistics-policy.ts';

test('Logistics mood policy reaches freight admission and Tired removes transport',async t=>{
  for(const mood of moods) {
    const f=freightFixture(t);
    f.execution.context=resolveContext({stance:'Logistics',mood,objective:'Deliver only within the resolved allocation'},f.execution.context);
    if(mood==='Tired') {
      assert.equal('transport' in executionCatalog(f.execution.context),false);
      continue;
    }
    await f.choose();
    const policy=logisticsPolicy(f.execution.context);
    f.contract.failure_debt=policy.max_liability;
    const within:any=await f.execution.dispatch('assess',{kind:'freight',shipment_id:'freight'});
    assert.equal(within.status,'ready_to_accept',mood);
    f.contract.failure_debt=policy.max_liability+1;
    const over:any=await f.execution.dispatch('assess',{kind:'freight',shipment_id:'freight'});
    assert.equal(over.status,'blocked',mood);
    assert.ok(over.blockers.some((reason:string)=>reason.includes('liability allocation')),mood);
  }
});

test('personal freight accepts, verifies sealed custody and delivery, and separates payout from wallet income',async t=>{
  for(const hiddenSize of [false,true]) {
    const f=freightFixture(t,{hiddenSize});
    f.contract.reserved_exposure=5000;
    const board=await assessFreight(f.account,f.command,{},f.policy);assert.equal(board.candidates[0].destination.base_id,'other');
    assert.equal(board.candidates[0].readiness,'requires_targeted_assessment');
    assert.equal(board.candidates[0].observed_same_system,true);
    const unresolved=await assessFreight(f.account,f.command,{}, {...f.policy,stations:f.policy.stations.filter(station=>station.base_id!=='other')});
    assert.equal(unresolved.candidates[0].eligible,true);
    assert.equal(unresolved.candidates[0].readiness,'blocked');
    assert.ok(unresolved.candidates[0].blockers.some((text:string)=>text.includes('station directory')));
    const assessed=await assessFreight(f.account,f.command,{shipment_id:'freight'},f.policy);
    assert.equal(assessed.status,'ready_to_accept');assert.equal(assessed.liability.failure_debt,100);
    if(hiddenSize)assert.ok(assessed.unknowns.some((text:string)=>text.includes('size unverified')));
    const snapshots:FreightReceipt[]=[],baseline=f.account.credits!;
    const routeCustody:boolean[]=[];
    const result=await transportFreight(f.account,f.command,{shipment_id:'freight'},assessed,{
      checkpoint:async()=>{},record:row=>snapshots.push(row),validateRoute:async()=>{routeCustody.push(f.account.cargo?.some(row=>row.item_id==='package:box')??false);},
      travel:async base=>{assert.equal(base,'other');f.state.location={system_id:'system',poi_id:'other',docked_at:'other'};},
    });
    assert.equal(result.status,'completed');assert.equal(result.payout,80);assert.equal(f.account.credits!-baseline,180);
    assert.deepEqual(routeCustody,[false,true],'Route admission precedes acceptance and is revalidated with loaded cargo');
    assert.deepEqual(f.state.cargo,[{item_id:'original',quantity:1,size:1}]);assert.equal(result.pending_action,undefined);
    assert.ok(snapshots.some(row=>row.pending_action?.action==='spacemolt_shipping/accept'));
    assert.ok(snapshots.some(row=>row.acceptance&&row.pending_action?.action==='spacemolt_shipping/accept'));
    assert.equal(f.calls.filter(call=>call.key==='spacemolt_shipping/deliver').length,1);
  }
  const constrained=freightFixture(t);const assessment=await assessFreight(constrained.account,constrained.command,{shipment_id:'freight'},{...constrained.policy,max_liability:50});
  assert.equal(assessment.status,'blocked');assert.ok(assessment.blockers.some((text:string)=>text.includes('liability allocation')));
  assert.equal(constrained.calls.some(call=>call.key==='spacemolt_shipping/accept'),false);
  const overCapacity=freightFixture(t);overCapacity.contract.reserved_exposure=10001;
  const capacityAssessment=await assessFreight(overCapacity.account,overCapacity.command,{shipment_id:'freight'},overCapacity.policy);
  assert.equal(capacityAssessment.status,'blocked');
  assert.ok(capacityAssessment.blockers.some((text:string)=>text.includes('capacity unavailable or insufficient')));
  await assert.rejects(transportFreight(overCapacity.account,overCapacity.command,{shipment_id:'freight'},capacityAssessment,{
    record:()=>{},checkpoint:async()=>{},travel:async()=>{},validateRoute:async()=>{},
  }),/capacity unavailable or insufficient/);
  assert.equal(overCapacity.calls.some(call=>call.key==='spacemolt_shipping/accept'),false);
  const shared=freightFixture(t);await shared.choose();
  const job:any=await shared.execution.dispatch('transport',{kind:'freight',shipment_id:'freight'});
  assert.equal(job.status,'completed');assert.equal(job.result.transport.payout,80);
  assert.equal(shared.state.location.docked_at,'base');assert.equal(shared.state.ship.fuel,120);
  assert.equal(job.spending.gross_spend,6);assert.equal(job.cash_delta,174);
  assert.match(job.stopping_reason,/transport/);
});

test('freight interruption, lost acceptance, invalid custody and absent payout remain explicit without replay',async t=>{
  for(const scenario of ['stop','lostAccept','failedWithdrawal','missingPayout'] as const) {
    const f=freightFixture(t,scenario==='stop'?{}:{[scenario]:true});
    const assessment=await assessFreight(f.account,f.command,{shipment_id:'freight'},f.policy);
    let last:FreightReceipt|undefined;
    const result=await transportFreight(f.account,f.command,{shipment_id:'freight'},assessment,{
      record:row=>{last=row;},checkpoint:async()=>{if(scenario==='stop'&&last?.acceptance&&!last.pending_action)throw new Error('Tired');},
      validateRoute:async()=>{},travel:async()=>{f.state.location={system_id:'system',poi_id:'other',docked_at:'other'};},
    });
    assert.equal(result.status,scenario==='stop'?'blocked':'needs_reconciliation');
    assert.equal(f.calls.filter(call=>call.key==='spacemolt_shipping/accept').length,1);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt_shipping/deliver').length,scenario==='missingPayout'?1:0);
    if(scenario==='missingPayout'){assert.equal(result.payout,undefined);assert.ok(result.accounting_unverified);assert.equal(result.delivery?.contract.status,'delivered');}
    else assert.equal(f.contract.status,'in_transit');
    if(scenario==='stop')assert.equal(f.calls.some(call=>call.key==='spacemolt_storage/withdraw'),false);
    assert.equal(last?.status,result.status);
    const reassessment=await assessFreight(f.account,f.command,{shipment_id:'freight'},f.policy);
    assert.equal(reassessment.status,'blocked');
    await assert.rejects(transportFreight(f.account,f.command,{shipment_id:'freight'},reassessment,{record:()=>{},checkpoint:async()=>{},travel:async()=>{},validateRoute:async()=>{}}),/admission/);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt_shipping/accept').length,1);
  }
  const f=freightFixture(t);await f.choose();
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{const result=await send(tool,action,params);if(tool==='spacemolt_shipping'&&action==='accept')f.execution.signal('Tired after acceptance');return result;};
  const first:any=await f.execution.dispatch('transport',{kind:'freight',shipment_id:'freight'});
  const partial=transportReceipt(first.result)!;
  assert.equal(partial.status,'blocked');assert.ok(partial.acceptance);assert.equal(partial.pending_action,undefined);
  const store=new ExecutionStore(f.directory,'pilot');await store.startNewRun(f.account);
  const execution=new Execution(f.account,store,f.execution.context,f.execution.deps);
  const resumed:any=await execution.dispatch('transport',{resume_job_id:first.id});
  assert.equal(resumed.status,'completed');assert.equal(resumed.result.transport.payout,80);
  assert.equal(resumed.budget_owner_id,first.id);assert.equal(f.state.location.docked_at,'base');
  assert.equal(f.calls.filter(call=>call.key==='spacemolt_shipping/accept').length,1);
  assert.equal(f.calls.filter(call=>call.key==='spacemolt_storage/withdraw').length,1);
});
