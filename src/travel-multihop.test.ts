import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import type {ReadinessCommand} from './readiness.ts';
import {travelTo,TravelBlocked,type TravelOptions} from './travel.ts';

function fixture(lossAt?:string) {
  const home={system_id:'a',poi_id:'station',base_id:'home'};
  const away={system_id:'c',poi_id:'gate',base_id:'away'};
  const initial={location:{system_id:'a',poi_id:'station',docked_at:'home' as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const quotes:{origin:typeof server.location;fuel:number;cargo:number;cost:number;target:unknown}[]=[];
  const losses:{cachedFuel:number;actualFuel:number;callIndex:number}[]=[];
  const connections:Record<string,string[]>={a:['c'],c:['b'],b:['a']};
  const paths:Record<string,string[]>={c:['c','b','a'],b:['b','a'],a:['a']};
  // Fixture quotes include the paid station approach. Cargo changes its price
  // as well as both jump prices; no outbound estimate can stand in for return.
  const costs=()=>({c:5+server.ship.cargo_used/10,b:2+server.ship.cargo_used/10,a:server.ship.cargo_used/10});
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>{
      assert.deepEqual(account.state,server,'quote must start from refreshed position, fuel and cargo');
      const path=id==='c'?['a','c']:paths[server.location.system_id];
      const cost=id==='c'?7:path.reduce((sum,system)=>sum+costs()[system as keyof ReturnType<typeof costs>],0);
      quotes.push({origin:structuredClone(server.location),fuel:server.ship.fuel,cargo:server.ship.cargo_used,cost,target:id});
      return {found:true,target_system:id,total_jumps:path.length-1,estimated_fuel:cost,
        fuel_per_jump:id==='c'?7:costs()[server.location.system_id as keyof ReturnType<typeof costs>],
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:path.map((system_id,jumps)=>({system_id,jumps}))};
    },
    get_system:()=>({system:{connections:connections[server.location.system_id]}}),
    undock:()=>{server.location.docked_at=null;return {};},
    jump:({id}={})=>{
      assert.equal(server.location.docked_at,null);
      assert.ok(connections[server.location.system_id].includes(String(id)));
      server.ship.fuel-=id==='c'?7:costs()[server.location.system_id as keyof ReturnType<typeof costs>];
      server.location.system_id=String(id);server.location.poi_id='gate';
      if(id===lossAt) {
        server.ship.fuel-=0.25;
        losses.push({cachedFuel:account.state.ship!.fuel,actualFuel:server.ship.fuel,callIndex:calls.length});
      }
      assert.notDeepEqual(account.state.location,server.location);
      assert.ok(account.state.ship!.fuel>server.ship.fuel,'movement reply leaves rich stale cache');
      return {};
    },
    travel:({id}={})=>{
      assert.equal(server.location.system_id,'a');assert.equal(id,home.poi_id);
      assert.equal(server.location.docked_at,null);
      assert.ok(costs().a>0);
      server.ship.fuel-=costs().a;server.location.poi_id=String(id);
      assert.notDeepEqual(account.state.location,server.location);
      return {};
    },
    dock:()=>{
      const destination=server.location.system_id==='a'?home:away;
      assert.equal(server.location.system_id,destination.system_id);
      assert.equal(server.location.poi_id,destination.poi_id);
      assert.equal(account.state.location!.docked_at,null);
      server.location.docked_at=destination.base_id;
      return {}; // Only refresh can establish docking, never this reply.
    },
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server,calls=account.calls;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  return {home,away,server,account,calls,quotes,losses,command};
}

async function outbound(f:ReturnType<typeof fixture>,options:TravelOptions,reserve:number) {
  const result=await travelTo(f.account,f.command,f.away,options);
  assert.equal(result.jumps,1);
  assert.deepEqual(result.location,{system_id:'c',poi_id:'gate',docked_at:'away',in_transit:false});
  assert.deepEqual(f.account.state,f.server);
  assert.equal(f.server.ship.fuel,93);
  assert.deepEqual(f.quotes,[{origin:{system_id:'a',poi_id:'station',docked_at:'home',in_transit:false},
    fuel:100,cargo:0,cost:7,target:'c'}]);
  f.server.ship.cargo_used=40;f.server.ship.fuel=19+reserve;
  assert.equal(f.account.state.ship!.cargo_used,0);
  assert.ok(f.account.state.ship!.fuel>f.server.ship.fuel);
}

function expectedQuotes(reserve:number) {
  return [
    {origin:{system_id:'c',poi_id:'gate',docked_at:'away',in_transit:false},fuel:19+reserve,cargo:40,cost:19,target:'a'},
    {origin:{system_id:'b',poi_id:'gate',docked_at:null,in_transit:false},fuel:10+reserve,cargo:40,cost:10,target:'a'},
    {origin:{system_id:'a',poi_id:'gate',docked_at:null,in_transit:false},fuel:4+reserve,cargo:40,cost:4,target:'a'},
  ];
}

test('loaded two-jump return re-quotes each leg and docks with the effective reserve retained',async()=>{
  // Independent D2 expectation; production travelTo resolves the mood itself.
  for(const floor of [undefined,30.5]) {
    const reserve=floor??24,options:TravelOptions={mood:'Focused',
      standingPolicy:floor===undefined?undefined:{fuelReserveFloor:floor}};
    const f=fixture();await outbound(f,options,reserve);
    const callIndex=f.calls.length;
    const result=await travelTo(f.account,f.command,f.home,options);
    assert.deepEqual(f.quotes.slice(1),expectedQuotes(reserve));
    for(const quote of f.quotes.slice(1))assert.equal(quote.fuel,quote.cost+reserve);
    assert.deepEqual(f.calls.slice(callIndex),[
      {tool:'spacemolt',action:'find_route',payload:{id:'a'}},
      {tool:'spacemolt',action:'undock',payload:{}},
      {tool:'spacemolt',action:'get_system',payload:{}},
      {tool:'spacemolt',action:'jump',payload:{id:'b'}},
      {tool:'spacemolt',action:'find_route',payload:{id:'a'}},
      {tool:'spacemolt',action:'get_system',payload:{}},
      {tool:'spacemolt',action:'jump',payload:{id:'a'}},
      {tool:'spacemolt',action:'find_route',payload:{id:'a'}},
      {tool:'spacemolt',action:'travel',payload:{id:'station'}},
      {tool:'spacemolt',action:'dock',payload:{}},
    ]);
    assert.equal(result.jumps,2);
    assert.deepEqual(result.location,{system_id:'a',poi_id:'station',docked_at:'home',in_transit:false});
    assert.deepEqual(result.location,f.server.location);
    assert.equal(f.server.ship.fuel,reserve);
    assert.equal(f.server.ship.cargo_used,40);
    assert.deepEqual(f.account.state,f.server);
  }
});

test('fuel loss after either return jump blocks the next jump or paid local leg despite stale cache',async()=>{
  for(const floor of [undefined,30.5])for(const lossAt of ['b','a']) {
    const reserve=floor??24,options:TravelOptions={mood:'Focused',
      standingPolicy:floor===undefined?undefined:{fuelReserveFloor:floor}};
    const f=fixture(lossAt);await outbound(f,options,reserve);
    const callIndex=f.calls.length,required=(lossAt==='b'?10:4)+reserve;
    await assert.rejects(travelTo(f.account,f.command,f.home,options),error=>error instanceof TravelBlocked&&
      error.message===`fuel_below_route_minimum: have ${required-0.25}, need ${required}; shortfall 0.25 fuel units`);
    const expected=expectedQuotes(reserve).slice(0,lossAt==='b'?2:3);
    expected.at(-1)!.fuel-=0.25;
    assert.deepEqual(f.quotes.slice(1),expected);
    assert.equal(f.losses.length,1);
    assert.ok(f.losses[0].cachedFuel>required,'cached fuel would incorrectly permit the next leg');
    assert.equal(f.losses[0].actualFuel,required-0.25);
    assert.deepEqual(f.calls.slice(f.losses[0].callIndex),[{tool:'spacemolt',action:'find_route',payload:{id:'a'}}],
      'no movement or docking after the arrival fuel loss');
    assert.deepEqual(f.calls.slice(callIndex).filter(c=>c.tool==='spacemolt'&&c.action==='jump').map(c=>c.payload?.id),
      lossAt==='b'?['b']:['b','a']);
    assert.deepEqual(f.server.location,{system_id:lossAt,poi_id:'gate',docked_at:null,in_transit:false});
    assert.equal(f.server.ship.fuel,required-0.25);
    assert.equal(f.server.ship.cargo_used,40);
    assert.deepEqual(f.account.state,f.server);
  }
});
