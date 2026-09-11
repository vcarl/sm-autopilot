import test from 'node:test';
import assert from 'node:assert/strict';
import {passengerFixture} from './passenger-fixture.ts';
import {transportReceipt} from './execution-logistics.ts';
import {remainingTransportCleanup} from './transport-budget.ts';

test('new custody reserves itinerary-priced cleanup within gross spending and wallet bounds, including away pickups',async t=>{
  for(const scenario of ['away_with_quote','away_without_quote','small_budget','small_wallet','unknown_price','changed_ship']) {
    const destination=['away_with_quote','away_without_quote','changed_ship'].includes(scenario)?'base':'other';
    const f=passengerFixture(t,{destination});await f.choose();
    if(scenario==='away_with_quote')f.execution.context.limits.max_spend=100;
    if(scenario==='small_budget')f.execution.context.limits.max_spend=5;
    if(scenario==='small_wallet')f.state.player.credits=150005;
    const send=f.account.send.bind(f.account);
    f.account.send=async(tool,action,params)=>{
      const reply=await send(tool,action,params);
      if(tool==='spacemolt'&&action==='get_base')return {structuredContent:{fuel_price_all_in:scenario==='unknown_price'?null:f.state.location.docked_at==='base'?3:5}} as any;
      return reply;
    };
    if(scenario==='away_with_quote'||scenario==='changed_ship') {
      const travel:any=await f.execution.dispatch('travel',{base_id:'other'});
      assert.equal(travel.status,'completed');
      assert.equal(travel.service_fuel_quotes[0].base_id,'base');
      if(scenario==='changed_ship')f.state.ship.id='replacement-ship';
    } else if(scenario==='away_without_quote')f.state.location={...f.state.location,poi_id:'other',docked_at:'other'};
    const job:any=await f.execution.dispatch('transport',{kind:'passengers',destination});
    if(scenario==='away_with_quote') {
      assert.equal(job.status,'completed');
      assert.equal(job.transport_cleanup_allocation.quote.base_id,'base');
      assert.equal(job.transport_cleanup_allocation.quote.unit_price,3);
      assert.equal(job.transport_cleanup_allocation.amount,17*3);
      assert.equal(transportReceipt(job.result)!.status,'completed');
    } else {
      assert.equal(job.status,'blocked');
      assert.equal(f.calls.some(row=>row.key==='spacemolt/load_passenger'),false);
      assert.ok(job.transport_itinerary_checks,`${scenario}: ${JSON.stringify(job.result)}`);
      assert.equal(job.transport_itinerary_checks.find((row:any)=>row.cleanup).cleanup.status,'blocked');
    }
  }
});

test('repriced cleanup stays within the original gross budget and reports planning overruns across linked returns',async t=>{
  const f=passengerFixture(t);await f.choose();
  let price=3;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{
    const missing=f.state.ship.max_fuel-f.state.ship.fuel;
    const reply=await send(tool,action,params);
    if(tool==='spacemolt'&&action==='refuel') {
      const cost=missing*price,extra=cost-(reply as any).structuredContent.cost;
      f.state.player.credits-=extra;f.state.player.stats.credits_spent+=extra;
      return {structuredContent:{...(reply as any).structuredContent,cost}} as any;
    }
    return tool==='spacemolt'&&action==='get_base'?{structuredContent:{fuel_price_all_in:price}} as any:reply;
  };
  f.onBoard(()=>{price=600;});
  const delivered:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'other'});
  assert.equal(transportReceipt(delivered.result)!.status,'completed');
  assert.equal(f.passengers().length,0);
  assert.equal(delivered.status,'blocked');
  assert.equal(f.calls.some(row=>row.key==='spacemolt/refuel'),false);
  assert.ok(f.state.player.credits>200000);
  assert.equal(delivered.transport_cleanup_allocation.amount,51);
  price=100;
  const cleanup:any=await f.execution.dispatch('return_to_base');
  assert.equal(cleanup.status,'returned_to_base');
  assert.equal(cleanup.budget_owner_id,delivered.id);
  assert.equal(cleanup.budget_spending.gross_spend,200);
  assert.equal(cleanup.result.service.transport_cleanup_budget.planning_overrun,149);
  assert.equal(remainingTransportCleanup(cleanup,f.store.data.jobs),0);
  const repeated:any=await f.execution.dispatch('return_to_base');
  assert.equal(repeated.budget_owner_id,delivered.id);
  assert.equal(remainingTransportCleanup(repeated,f.store.data.jobs),0);
  assert.equal(f.calls.filter(row=>row.key==='spacemolt/refuel').length,1);
});
