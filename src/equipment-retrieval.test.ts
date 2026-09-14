import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOwnedMiningEquipment,retrieveOwnedMiningEquipment} from './equipment-retrieval.ts';
import {executionFixture} from './execution-fixture.ts';

const station=(base_id:string,system_id:string)=>({base_id,system_id,poi_id:base_id,station_name:base_id,services:['storage','refuel'],rationale:'fixture',observed_at:'fixture'});

test('remote owned-laser preparation preserves cabin, cargo and other modules through serviced home return',async()=>{
  const home=station('home','home-system'),remote=station('remote','remote-system');
  const state:any={player:{credits:200000},location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id,in_transit:false},
    ship:{id:'ship',cargo_used:10,cargo_capacity:120,cpu_used:5,cpu_capacity:20,power_used:5,power_capacity:20,utility_slots:2,fuel:120,max_fuel:120,hull:100,max_hull:100,shield:20,max_shield:20,incapacitated:false},
    cargo:[{item_id:'steel_plate',quantity:10,size:1}],modules:[{module_id:'expander',type_id:'cargo_expander_ii',slot:'utility',size:10},{module_id:'cabin',type_id:'economy_passenger_cabin',slot:'utility',size:10}]};
  let storage=[{item_id:'mining_laser_i',quantity:1,size:10}];
  const account:any={state,get location(){return state.location},get ship(){return state.ship},get cargo(){return state.cargo},get credits(){return state.player.credits},refresh:async()=>{}};
  const command=async(action:string,params:any={})=>{
    if(action==='spacemolt_storage/view')return {base_id:state.location.docked_at,items:state.location.docked_at==='remote'?structuredClone(storage):[],locations:[{base_id:'remote',system:'remote-system',item_count:1}]};
    if(action==='spacemolt_storage/withdraw'){storage=[];state.cargo.push({item_id:params.item_id,quantity:1,size:10});state.ship.cargo_used+=10;return {cost:0};}
    if(action==='spacemolt/uninstall_mod'){const row=state.modules.find((m:any)=>m.module_id===params.id);state.modules=state.modules.filter((m:any)=>m!==row);state.cargo.push({item_id:row.type_id,quantity:1,size:row.size});state.ship.cargo_used+=row.size;return {cost:0};}
    if(action==='spacemolt/install_mod'){state.cargo=state.cargo.filter((r:any)=>r.item_id!==params.id);state.ship.cargo_used-=10;state.modules.push({module_id:'laser-module',type_id:params.id,slot:'utility',size:10,stats:{mining_power:1}});return {cost:0};}
    throw new Error(action);
  };
  const observed=await assessOwnedMiningEquipment(account,command,[home,remote]);
  assert.equal(observed.status,'retrieval_candidates');assert.equal(observed.candidates?.[0].status,'contents_unverified');
  // A prior attempt may already have withdrawn the laser before a later blocker.
  state.cargo.push({item_id:'mining_laser_i',quantity:1,size:10});state.ship.cargo_used+=10;
  const travel=async(destination:any)=>{state.location={system_id:destination.system_id,poi_id:destination.poi_id,docked_at:destination.base_id,in_transit:false};return {arrived:destination.base_id}};
  const receipt:any=await retrieveOwnedMiningEquipment(account,command,remote,home,{travel,service:async()=>({status:'serviced'})});
  assert.equal(receipt.status,'completed');assert.equal(state.location.docked_at,'home');
  assert.deepEqual(state.cargo,[{item_id:'steel_plate',quantity:10,size:1},{item_id:'economy_passenger_cabin',quantity:1,size:10}]);
  assert.deepEqual(state.modules.map((m:any)=>m.module_id),['expander','laser-module']);
  assert.equal(storage.length,1,'A carried recovered laser prevents a second withdrawal');assert.equal(receipt.fitted_module.stats.mining_power,1);
});

test('unverified storage, item sizes, or passenger custody block before equipment mutation',async()=>{
  const home=station('home','home-system'),remote=station('remote','remote-system');let withdrawals=0;
  const state:any={player:{credits:200000},location:{system_id:'home-system',poi_id:'home',docked_at:'home',in_transit:false},ship:{id:'ship',cargo_used:0,cargo_capacity:20,cpu_used:0,cpu_capacity:20,power_used:0,power_capacity:20,utility_slots:1,fuel:20,max_fuel:20,hull:20,max_hull:20,shield:20,max_shield:20,incapacitated:false},cargo:[],modules:[]};
  const account:any={state,get location(){return state.location},get ship(){return state.ship},get cargo(){return state.cargo},get credits(){return state.player.credits},refresh:async()=>{}};
  const command=async(action:string)=>{if(action==='spacemolt_storage/view')return {base_id:'remote',items:[]};if(action==='spacemolt_storage/withdraw')withdrawals++;throw new Error(action)};
  await assert.rejects(retrieveOwnedMiningEquipment(account,command,remote,home,{travel:async()=>{state.location={system_id:'remote-system',poi_id:'remote',docked_at:'remote',in_transit:false}},service:async()=>{}}),/not verified/);
  assert.equal(withdrawals,0);assert.deepEqual(state.cargo,[]);assert.deepEqual(state.modules,[]);
  const unknownSize=async(action:string)=>{if(action==='spacemolt_storage/view')return {base_id:'remote',items:[{item_id:'mining_laser_i',quantity:1}]};if(action==='spacemolt_storage/withdraw')withdrawals++;throw new Error(action)};
  await assert.rejects(retrieveOwnedMiningEquipment(account,unknownSize,remote,home,{travel:async()=>{},service:async()=>{}}),/sizes are required/);
  assert.equal(withdrawals,0);
});

test('Industry prepare dispatch docks at an observed local source and returns verified recovered custody',async t=>{
  const f=executionFixture(t);
  const locations=f.execution.deps.locations!;
  (f.execution.deps as any).locations=async(...args:any[])=>{const observed:any=await (locations as any)(...args);for(const row of observed.stations??[])row.services=[...new Set([...(row.services??[]),'storage'])];return observed;};
  f.execution.context={...f.execution.context,stance:'Industry',mood:'Focused',objective:'Recover owned mining capability',stop_condition:'objective'} as any;
  f.state.location.docked_at=null;
  f.state.cargo=[{item_id:'steel_plate',quantity:10,size:1}];f.state.ship.cargo_used=10;f.state.ship.utility_slots=2;
  f.state.modules=[{module_id:'expander',type_id:'cargo_expander_ii',slot:'utility',size:10},{module_id:'cabin',type_id:'economy_passenger_cabin',slot:'utility',size:10}];
  let laserStored=1,onboard=true,mutations=0;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool:string,action:string,params:any):Promise<any>=>{
    if(tool==='spacemolt'&&action==='get_system')return {structuredContent:{system:{id:'system',pois:[]}}};
    if(tool==='spacemolt'&&action==='list_passengers')return {structuredContent:{count:onboard?1:0,passengers:onboard?[{citizen_id:'passenger',destination:'elsewhere'}]:[]}};
    if(tool==='spacemolt_storage'&&action==='view')return {structuredContent:{base_id:'base',items:laserStored?[{item_id:'mining_laser_i',quantity:1,size:10}]:[],locations:[{base_id:'base',system:'system',item_count:1}]}};
    if(tool==='spacemolt_storage'&&action==='withdraw'){mutations++;laserStored=0;f.state.cargo.push({item_id:'mining_laser_i',quantity:1,size:10});f.state.ship.cargo_used+=10;return {structuredContent:{cost:0}};}
    if(tool==='spacemolt'&&action==='uninstall_mod'){mutations++;f.state.modules=f.state.modules.filter((row:any)=>row.module_id!==params.id);f.state.cargo.push({item_id:'economy_passenger_cabin',quantity:1,size:10});f.state.ship.cargo_used+=10;return {structuredContent:{cost:0}};}
    if(tool==='spacemolt'&&action==='install_mod'){mutations++;f.state.cargo=f.state.cargo.filter((row:any)=>row.item_id!==params.id);f.state.ship.cargo_used-=10;f.state.modules.push({module_id:'laser',type_id:'mining_laser_i',slot:'utility',size:10,stats:{mining_power:1}});return {structuredContent:{cost:0}};}
    return send(tool,action,params);
  };
  await f.execution.observe(false);
  await f.execution.dispatch('plan',{home_base_id:'base',home_rationale:'Current station stores owned mining equipment and supports the objective'});f.execution.handoff();
  const occupied:any=await f.execution.dispatch('prepare',{equipment_base_id:'base'});
  assert.equal(occupied.status,'blocked');assert.match(occupied.error,/passengers|custody/i);assert.equal(mutations,0);
  onboard=false;
  const job:any=await f.execution.dispatch('prepare',{equipment_base_id:'base'});
  assert.equal(job.status,'completed',JSON.stringify({error:job.error,result:job.result}));assert.equal(job.result.status,'completed');assert.equal(f.state.location.docked_at,'base');
  assert.equal(laserStored,0);assert.deepEqual(f.state.cargo,[{item_id:'steel_plate',quantity:10,size:1},{item_id:'economy_passenger_cabin',quantity:1,size:10}]);
  assert.deepEqual(f.state.modules.map((row:any)=>row.module_id),['expander','laser']);
  f.state.location.docked_at=null;const mutationCount=mutations;
  const ready:any=await f.execution.dispatch('prepare',{equipment_base_id:'base'});
  assert.equal(ready.status,'completed');assert.equal(f.state.location.docked_at,'base');assert.equal(mutations,mutationCount,'Already-fitted recovery only returns and services');
});
