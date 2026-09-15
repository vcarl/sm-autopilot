import assert from 'node:assert/strict';
import test from 'node:test';
import {serve} from './bridge.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

// The station POI and the base docked at it carry different ids, as the live game does.
const system={id:'sol',name:'Sol',pois:[
  {id:'station',name:'Sol Station',type:'station',position:{x:0,y:0},has_base:true,
    base_id:'sol_base',base_name:'Sol Base'},
  {id:'belt',name:'Inner Belt',type:'asteroid_belt',position:{x:1,y:1}},
]};

function fixture() {
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base' as string|null,in_transit:false},
    // The hold leaves the dock already full, so a gather job mines nothing and still
    // has to come home, settle and service before it may call itself done.
    ship:{id:'ship',fuel:100,max_fuel:120,hull:80,max_hull:100,cargo_used:12,cargo_capacity:12},
    player:{credits:1_000},
    cargo:[{item_id:'ore',quantity:12}] as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
  });
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system}}),
    'spacemolt/find_route':()=>({found:true,target_system:'sol',total_jumps:0,estimated_fuel:7,fuel_per_jump:0,
      fuel_available:account.server.ship.fuel,cargo_used:account.server.ship.cargo_used,route:[{system_id:'sol',jumps:0}]}),
    'spacemolt/undock':()=>{account.server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{account.server.location.docked_at='sol_base';return {};},
    // The server settles the move before the next authoritative read, as a same-system hop does.
    'spacemolt/travel':params=>{account.server.ship.fuel-=7;account.server.location.poi_id=String(params.id);return {};},
    'spacemolt_market/view_market':()=>({delta:{details:{items:[{item_id:'ore',buy_price:10}]}}}),
    'spacemolt/sell':params=>{
      const quantity=Number(params.quantity);
      account.server.cargo=account.server.cargo.filter(row=>row.item_id!==params.id);
      account.server.ship.cargo_used-=quantity;
      account.server.player.credits+=quantity*10;
      return {delta:{details:{action:'sell',quantity_sold:quantity}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],fuel_price_all_in:1,
      base:{poi_id:'station',repair_price_per_hull:1}}}}),
    'spacemolt/refuel':()=>{
      const cost=account.server.ship.max_fuel-account.server.ship.fuel;
      account.server.ship.fuel=account.server.ship.max_fuel;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'refuel',cost}}};
    },
    'spacemolt/repair':()=>{
      const cost=account.server.ship.max_hull-account.server.ship.hull;
      account.server.ship.hull=account.server.ship.max_hull;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'repair',cost}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    sent.push({action,params:structuredClone(params)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]!(params);
  };
  return {account,sent,dispatch:serve(account as unknown as ReadinessAccount,command)};
}

test('where reports the live position and the destinations the model may name', async () => {
  const f=fixture();
  const observed=await f.dispatch('where') as any;
  assert.equal(f.account.refreshes.length,1,'position must come from an authoritative read');
  assert.deepEqual(observed.system,{id:'sol',name:'Sol'});
  assert.deepEqual(observed.poi,{id:'station',name:'Sol Station'});
  // A base id is not a POI id: the model is told which base it is docked at, by name.
  assert.deepEqual(observed.docked_at,{base_id:'sol_base',name:'Sol Base'});
  assert.equal(observed.in_transit,false);
  assert.deepEqual(observed.fuel,100);
  assert.deepEqual(observed.pois,[{id:'station',name:'Sol Station',type:'station'},
    {id:'belt',name:'Inner Belt',type:'asteroid_belt'}]);
  // Every listed destination is nameable and nothing heavier rides along.
  assert.ok(JSON.stringify(observed).length<2048);
  for(const poi of observed.pois)assert.deepEqual(Object.keys(poi),['id','name','type']);
});

test('travel undocks, flies to the named poi, and reports the arrival a live read confirms', async () => {
  const f=fixture();
  const result=await f.dispatch('travel',{poi_id:'belt'}) as any;
  assert.equal(result.arrived,true);
  assert.deepEqual(result.location,{system:'sol',poi:'belt',docked_at:null});
  assert.equal(result.fuel,93);
  assert.equal(typeof result.elapsed_s,'number');
  assert.deepEqual(f.sent.map(call=>call.action),
    ['spacemolt/find_route','spacemolt/undock','spacemolt/travel']);
  assert.deepEqual(f.sent.at(-1)!.params,{id:'belt'});
  assert.equal(f.account.server.location.poi_id,'belt');
  // A destination the model never named must not become a flight.
  await assert.rejects(fixture().dispatch('travel',{}),/poi_id/);
});

test('dock reports the dock the pilot already has and otherwise docks once, live read deciding', async () => {
  const f=fixture();
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:true});
  assert.equal(f.sent.length,0,'a dock the pilot already has is never re-sent');
  f.account.server.location.docked_at=null; // the pilot left the station
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.deepEqual(f.sent.map(call=>call.action),['spacemolt/dock']);
  // A dock somewhere else is reported, never overwritten.
  const elsewhere=fixture();
  elsewhere.account.server.location.docked_at='other_base';
  const refused=await elsewhere.dispatch('dock',{base_id:'sol_base'}) as any;
  assert.equal(refused.docked,false);
  assert.match(refused.reason,/other_base/);
  assert.equal(elsewhere.sent.length,0);
});

test('gather runs one job from the dock the ship is at and reports a verified outcome', async () => {
  const f=fixture();
  const result=await f.dispatch('gather',{poi_id:'belt'}) as any;
  assert.equal(result.outcome,'done',result.reason);
  // Dock to dock: out to the belt, home to the station POI, dock at the base behind it.
  assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt/travel').map(call=>call.params),
    [{id:'belt'},{id:'station'}]);
  assert.deepEqual(f.account.server.location,
    {system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false});
  assert.deepEqual(result.steps.map((step:any)=>step.name),
    ['travel','mine','return','dock','settle','service','verify']);
  assert.deepEqual(result.sold,[{item_id:'ore',quantity:12,quoted:120,cleared:120}]);
  // The hold is empty, the tank and hull are full, and the wallet reflects the trip.
  assert.deepEqual(f.account.server.cargo,[]);
  assert.deepEqual([f.account.server.ship.fuel,f.account.server.ship.hull],[120,100]);
  assert.equal(f.account.server.player.credits,1_000+120-34-20);
  assert.ok(JSON.stringify(result).length<2048,'one compact outcome, not a transcript');
  // A destination the model never named must not become a trip.
  await assert.rejects(fixture().dispatch('gather',{}),/poi_id/);
});
