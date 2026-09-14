import test from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {discoverPassengerSupply} from './passenger-supply.ts';
import {executionFixture} from './execution-fixture.ts';
import {executionCatalog} from './execution.ts';
import {resolveContext} from './execution-policy.ts';
import {catalog,validateAction} from './policy.ts';

const cabin='economy_passenger_cabin';
const report=(base_id:string,system_id='near')=>({base_id,system_id,submitted_at_tick:20,items:[{item_id:cabin,sell_volume:2,best_sell:50}]});
test('shared passenger fitting discovers dated identity-verified supply without mutation or session change',async t=>{
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Logistics',mood:'Focused',objective:'Find a passenger cabin'},f.execution.context);
  Object.assign(f.state.ship,{cpu_used:0,cpu_capacity:20,power_used:0,power_capacity:20,utility_slots:1});
  let quote:Record<string,unknown>={quantity_requested:1,available:0,unfilled:1,total_cost:0,subtotal:0,sales_tax:0,fills:[]};
  let supplierSystem='near',supplierPoi='supply-poi',shortlistSupplier=true,supplierOutside=false;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{
    const reply=await send(tool,action,params);
    if(action==='dock'&&f.state.location.poi_id===supplierPoi)f.state.location.docked_at='supply';
    const results:Record<string,unknown>={
      inspect:{catalog:{items:[{id:cabin,slot:'utility',size:10,cpu_usage:3,power_usage:4,passenger_economy_berths:12,required_skills:{}}]}},
      view:{items:[]},estimate_purchase:quote,
      query_trade_intel:{intel_level:2,total:1,entries:[report('supply')]},
    };
    return action in results?{structuredContent:results[action]} as any:reply;
  };
  const locations=f.execution.deps.locations!;
  f.execution.deps.locations=async(system,params)=>{
    if(!params.observed_destination_ids){const found=await locations(system,params);if(shortlistSupplier)found.stations!.push({base_id:'supply',poi_id:'old-poi',system_id:'old',system_name:'Old',station_name:'Old supply',services:[],hops:1});return found;}
    assert.equal(params.max_jumps,f.execution.context.mood==='Cautious'?1:2);assert.deepEqual(params.observed_destination_ids,['supply']);
    return {destination_matches:[{requested_id:'supply',status:supplierOutside?'outside_route_limit':'resolved',station:{id:'directory',base_id:'supply',poi_id:supplierPoi,system_id:supplierSystem,station_name:'Supply',hops:supplierSystem===system?0:2,rationale:'',observed_at:'now'}}]};
  };
  const before=structuredClone(f.state),context=structuredClone(f.execution.context),tools=executionCatalog(f.execution.context);
  const result:any=await f.execution.dispatch('assess',{kind:'passenger_fit'});
  assert.equal(result.status,'blocked');assert.equal(result.supply_discovery.status,'leads');
  const lead=result.supply_discovery.candidates[0];
  assert.equal(lead.base_id,'supply');assert.equal(lead.reported_supply.submitted_at_tick,20);
  assert.equal(lead.availability,'unknown');assert.equal(lead.all_in_cost,null);assert.equal(lead.requires_fresh_onsite_quote,true);
  assert.deepEqual(f.state,before);assert.deepEqual(f.execution.context,context);assert.deepEqual(executionCatalog(f.execution.context),tools);
  assert.ok(!f.calls.some(row=>/buy|install_mod|travel|jump|undock|load_passenger/.test(row.key)));
  assert.equal(f.calls.filter(row=>row.key==='spacemolt_intel/query_trade_intel').length,1);
  validateAction('spacemolt_intel/query_trade_intel');assert.ok(!catalog()['spacemolt_intel/query_trade_intel']);
  const home:any=await f.execution.dispatch('plan',{home_base_id:'supply',home_rationale:'Current dated cabin lead'});
  assert.equal(home.context.home.poi_id,'supply-poi');assert.equal(home.context.home.system_id,'near');
  f.execution.handoff();
  for(const invalid of [
    {quantity_requested:1,available:1,unfilled:0,total_cost:0,subtotal:50,sales_tax:5,fills:[{quantity:1,price_each:50}]},
    {quantity_requested:1,available:1,unfilled:0,fills:[{quantity:1,price_each:50}]},
    {quantity_requested:1,unfilled:1,fills:[]},
  ]) {
    quote=invalid;
    const malformed:any=await f.execution.dispatch('assess',{kind:'passenger_fit'});
    assert.equal(malformed.status,'blocked');assert.equal(malformed.supply_discovery,undefined);
  }
  assert.equal(f.calls.filter(row=>row.key==='spacemolt_intel/query_trade_intel').length,1);
  await f.execution.dispatch('plan',{home_base_id:'base',home_rationale:'Preserve the original home'});f.execution.handoff();
  const originalHome=structuredClone(f.execution.context.home);
  supplierSystem='system';supplierPoi='moved-poi';
  for(const shortlisted of [true,false]) {
    shortlistSupplier=shortlisted;
    const travel:any=await f.execution.dispatch('travel',{base_id:'supply'});
    assert.equal(travel.status,'completed',travel.error);
    assert.equal(f.state.location.poi_id,supplierPoi);assert.equal(f.state.location.docked_at,'supply');
    assert.deepEqual(f.execution.context.home,originalHome);
    assert.ok(f.calls.some(call=>call.key==='spacemolt/travel'&&call.params.id===supplierPoi));
    supplierPoi='relocated-poi';
  }
  await f.execution.dispatch('plan',{mood:'Cautious'});f.execution.handoff();
  supplierOutside=true;
  const priorTravel=f.calls.filter(call=>call.key==='spacemolt/travel'&&call.params.id===supplierPoi).length;
  const distant:any=await f.execution.dispatch('travel',{base_id:'supply'});
  assert.equal(distant.status,'blocked');assert.match(distant.error,/outside_route_limit/);
  assert.equal(f.calls.filter(call=>call.key==='spacemolt/travel'&&call.params.id===supplierPoi).length,priorTravel);
  assert.deepEqual(f.execution.context.home,originalHome);
  const unknown=executionFixture(t);unknown.execution.context=resolveContext({stance:'Logistics'},unknown.execution.context);await unknown.choose();
  const unseen:any=await unknown.execution.dispatch('travel',{base_id:'unseen-supplier'});
  assert.equal(unseen.status,'blocked');assert.match(unseen.error,/Observe destination/);
  assert.ok(!unknown.calls.some(call=>call.key==='spacemolt/travel'));

});

test('supply rejects stale identity, excessive routes and incomplete reports; known denial is explicit and connection uncertainty propagates',async()=>{
  const entries=[report('valid'),report('moved','old'),report('far'),report('unknown'),{...report('bad'),items:[{item_id:cabin,sell_volume:0,best_sell:0}]}];
  const locations:any=async()=>({destination_matches:entries.filter(row=>row.base_id!=='unknown').map(row=>({requested_id:row.base_id,status:'resolved',station:{base_id:row.base_id,poi_id:'poi',system_id:'near',hops:row.base_id==='far'?2:1}}))});
  const command:any=async()=>({structuredContent:{intel_level:2,total:entries.length,entries}});
  const result=await discoverPassengerSupply('origin',1,command,locations);
  assert.deepEqual(result.candidates.map(row=>row.base_id),['valid']);assert.equal(result.rejected.length,entries.length-1);
  const objective=await discoverPassengerSupply('origin',null,command,locations);
  assert.deepEqual(objective.candidates.map(row=>row.base_id),['valid','far']);
  assert.ok(objective.candidates.every(row=>row.availability==='unknown'&&row.all_in_cost===null));
  for(const code of ['not_in_faction','facility_required']){
    const denied=await discoverPassengerSupply('origin',1,async()=>{throw new SpacemoltError(code,'Unavailable');},locations);
    assert.equal(denied.status,'unavailable');assert.equal(denied.candidates.length,0);
  }
  for(const error of [new SpacemoltError('connection_closed','Lost'),new SpacemoltError('upstream_timeout','Lost'),new SpacemoltError('internal_error','Lost'),new SpacemoltError('facility_required','Lost',{pendingCommand:'buy'})]) {
    await assert.rejects(discoverPassengerSupply('origin',1,async()=>{throw error;},locations),caught=>caught===error);
  }
  const empty=await discoverPassengerSupply('origin',1,async()=>({structuredContent:{intel_level:2,entries:[],total:0}}),locations);
  assert.equal(empty.status,'no_established_supply');assert.deepEqual(empty.candidates,[]);
});
