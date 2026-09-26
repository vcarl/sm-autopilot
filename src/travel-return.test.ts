import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import type {ReadinessCommand} from './readiness.ts';
import {travelTo,TravelBlocked} from './travel.ts';

function fixture(local:boolean) {
  const home={system_id:'a',poi_id:'gate',base_id:'home'};
  const away={system_id:local?'a':'b',poi_id:local?'away':'gate',base_id:'away-base'};
  const initial={location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:'home' as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const quotes:{origin:typeof server.location;fuel:number;cargo:number;cost:number;target:unknown}[]=[];
  // Loaded return travel costs more than the empty outbound leg, even locally.
  const cost=()=>server.ship.cargo_used===0?7:11+server.ship.cargo_used/4;
  const movement=local?'travel':'jump';
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>{
      const origin=structuredClone(server.location);
      quotes.push({origin,fuel:server.ship.fuel,cargo:server.ship.cargo_used,cost:cost(),target:id});
      return {found:true,target_system:id,total_jumps:local?0:1,estimated_fuel:cost(),fuel_per_jump:cost(),
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:[{system_id:origin.system_id,jumps:0},...local?[]:[{system_id:id,jumps:1}]]};
    },
    get_system:()=>({system:{connections:[server.location.system_id==='a'?'b':'a']}}),
    undock:()=>{server.location.docked_at=null;return {};},
    [movement]:({id}={})=>{
      // Command responses do not update the cache; arrival must be refreshed.
      assert.notEqual(account.state,server);
      server.ship.fuel-=cost();
      if(local)server.location.poi_id=String(id);
      else server.location.system_id=String(id);
      assert.notDeepEqual(account.state.location,server.location);
      assert.notEqual(account.state.ship!.fuel,server.ship.fuel);
      return {};
    },
    dock:()=>{
      server.location.docked_at=server.location.system_id===home.system_id&&server.location.poi_id===home.poi_id?
        home.base_id:away.base_id;
      return {};
    },
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server,calls=account.calls;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  return {home,away,server,account,calls,quotes,command,movement};
}

for(const local of [true,false])test(`${local?'local':'cross-system'} return re-quotes loaded fuel cost and enforces the route boundary`,async()=>{
  // The return leg is revalidated on its own loaded route cost and nothing more: the mood's
  // reserve is where Tired begins, not a margin travel keeps (operator, 2026-09-26).
  const reserve=0;
  for(const deficit of [0,1]) {
    const f=fixture(local);
    const outbound=await travelTo(f.account,f.command,f.away,{});
    assert.deepEqual(outbound.location,f.server.location);
    assert.equal(outbound.location!.docked_at,f.away.base_id);
    assert.equal(f.account.state.ship!.fuel,93);
    assert.equal(f.quotes.length,1);
    assert.equal(f.quotes[0].cost,7);

    // Work at the destination changes only authoritative state, leaving a rich,
    // empty cached ship that could incorrectly authorize the one-unit-short trip.
    f.server.ship.cargo_used=40;
    const returnCost=21,required=returnCost+reserve;
    f.server.ship.fuel=required-deficit;
    const returnOrigin=structuredClone(f.server.location);
    assert.equal(f.account.state.ship!.cargo_used,0);
    assert.ok(f.account.state.ship!.fuel>required);
    assert.ok(f.server.ship.fuel>f.quotes[0].cost+reserve,'outbound quote would wrongly permit the short return');
    const callIndex=f.calls.length;
    const trip=travelTo(f.account,f.command,f.home,{});
    if(deficit) {
      await assert.rejects(trip,error=>error instanceof TravelBlocked&&
        error.message===`fuel_below_route_minimum: have ${required-1}, need ${required}; shortfall 1 fuel units`);
      assert.deepEqual(f.calls.slice(callIndex),[{tool:'spacemolt',action:'find_route',payload:{id:f.home.system_id}}]);
      assert.deepEqual(f.server.location,returnOrigin);
      assert.equal(f.server.ship.fuel,required-1);
    } else {
      const result=await trip;
      assert.deepEqual(f.calls.slice(callIndex),[
        {tool:'spacemolt',action:'find_route',payload:{id:f.home.system_id}},
        {tool:'spacemolt',action:'undock',payload:{}},
        ...local?[]:[{tool:'spacemolt',action:'get_system',payload:{}}],
        {tool:'spacemolt',action:f.movement,payload:{id:local?f.home.poi_id:f.home.system_id}},
        {tool:'spacemolt',action:'dock',payload:{}},
      ]);
      assert.equal(result.jumps,local?0:1);
      assert.deepEqual(result.location,{system_id:f.home.system_id,poi_id:f.home.poi_id,docked_at:f.home.base_id,in_transit:false});
      assert.deepEqual(result.location,f.server.location);
      assert.equal(f.server.ship.fuel,reserve);
    }
    assert.deepEqual(f.quotes.slice(1),[{origin:returnOrigin,fuel:required-deficit,cargo:40,cost:returnCost,target:f.home.system_id}]);
    assert.deepEqual(f.account.state,f.server,'return outcome must carry refreshed location, cargo and fuel');
    assert.equal(f.account.state.ship!.cargo_used,40);
  }
});
