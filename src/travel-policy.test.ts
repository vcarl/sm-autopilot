import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {travelTo,TravelBlocked} from './travel.ts';

function fixture(local:boolean,fuel:number,cost=10.25) {
  const initial={location:{system_id:'a',poi_id:'gate',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',fuel,max_fuel:120,cargo_used:0}};
  const movement=local?'travel':'jump';
  const destination=local?{system_id:'a',poi_id:'belt'}:{system_id:'b'};
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>({found:true,target_system:id,total_jumps:local?0:1,
      estimated_fuel:cost,fuel_per_jump:cost,fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
      route:[{system_id:'a',jumps:0},...local?[]:[{system_id:'b',jumps:1}]]}),
    get_system:()=>({system:{connections:['b']}}),
    undock:()=>{server.location.docked_at=null;return {};},
    [movement]:({id}={})=>{
      assert.notEqual(account.state,server);
      server.ship.fuel-=cost;
      if(local)server.location.poi_id=String(id);else server.location.system_id=String(id);
      assert.notDeepEqual(account.state.location,server.location);
      assert.notEqual(account.state.ship!.fuel,server.ship.fuel);
      return {};
    },
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server,calls=account.calls;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  return {server,account,calls,handlers,command,destination,movement};
}

// Operator's decision, 2026-09-26: a leg is admitted when the tank covers its quoted route. The
// mood's reserve is where Tired begins (play/runtime.ts `crossed`), never a margin on travel.
test('a leg departs on exactly its route cost, whatever the mood would keep, and is refused a fraction under it',async()=>{
  for(const local of [true,false])for(const deficit of [0,0.25]) {
    const f=fixture(local,10.25-deficit);
    // A rich cache cannot authorize departure when authoritative fuel is short.
    f.account.state.ship!.fuel=120;
    const trip=travelTo(f.account,f.command,f.destination,{});
    if(deficit) {
      await assert.rejects(trip,error=>error instanceof TravelBlocked&&error.message===
        `fuel_below_route_minimum: have ${10.25-deficit}, need 10.25; shortfall ${deficit} fuel units`);
      assert.deepEqual(f.calls,[{tool:'spacemolt',action:'find_route',payload:{id:f.destination.system_id}}]);
      assert.equal(f.server.location.docked_at,'base');
    } else {
      const result=await trip;
      assert.equal(f.calls.filter(c=>c.tool==='spacemolt'&&c.action===f.movement).length,1);
      assert.equal(result.location!.system_id,f.destination.system_id);
      if(local)assert.equal(result.location!.poi_id,'belt');
      assert.equal(f.server.ship.fuel,0);
    }
    assert.ok(f.account.refreshes.length>0);
    assert.deepEqual(f.account.state,f.server);
  }
});

test('the route-cost boundary survives capacity, refuel and departure refreshes',async()=>{
  for(const local of [true,false]) {
    for(const mode of ['capacity','refuel','partial-refuel','before-undock','after-undock']) {
      const required=50.75,f=fixture(local,required,required);
      const refuels:number[]=[];
      if(mode==='capacity')f.server.ship.max_fuel=f.server.ship.fuel=50.5;
      if(mode==='refuel'||mode==='partial-refuel')f.server.ship.fuel=40.25;
      if(mode==='after-undock')f.handlers.spacemolt.undock=()=>{
        f.server.location.docked_at=null;f.server.ship.fuel=50.5;return {};
      };
      const trip=travelTo(f.account,f.command,f.destination,{
        refuel:async minimum=>{
          refuels.push(minimum);f.server.ship.fuel=mode==='partial-refuel'?minimum-0.25:minimum;
          await f.account.refresh();
        },
        beforeMove:async()=>{if(mode==='before-undock')f.server.ship.fuel=50.5;},
      });
      if(mode==='refuel') {
        await trip;
        assert.equal(f.server.ship.fuel,0);
        assert.equal(f.calls.filter(c=>c.tool==='spacemolt'&&c.action===f.movement).length,1);
      } else {
        await assert.rejects(trip,error=>error instanceof TravelBlocked&&
          (mode==='capacity'?error.message.includes('capacity shortfall 0.25 fuel units'):
            error.message==='fuel_below_route_minimum: have 50.5, need 50.75; shortfall 0.25 fuel units'));
        assert.ok(!f.calls.some(c=>c.tool==='spacemolt'&&c.action===f.movement));
        assert.equal(f.server.location.docked_at,mode==='after-undock'?null:'base');
      }
      assert.deepEqual(refuels,mode==='refuel'||mode==='partial-refuel'?[required]:[]);
      assert.equal(f.calls.filter(c=>c.tool==='spacemolt'&&c.action==='find_route').length,refuels.length+1);
      assert.ok(f.account.refreshes.length>0);
      assert.deepEqual(f.account.state,f.server);
    }
  }
});
