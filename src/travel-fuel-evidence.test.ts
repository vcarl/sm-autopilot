import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import * as travel from './travel.ts';
import type {ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

function fixture() {
  const destination={system_id:'c'};
  let lossOnUndock=0,lossOnJump=0,invalidQuote=false,moveError:Error|undefined,quotedCost:number|undefined;
  const initial={
    location:{system_id:'a',poi_id:'gate',docked_at:'home' as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0},
  };
  const account:FakeLibGoalAccount<typeof initial>=new FakeLibGoalAccount(initial,{spacemolt:{
    find_route:()=>{
      assert.deepEqual(account.state,server);
      const path=server.location.system_id==='a'?['a','b','c']:['b','c'];
      return {found:true,target_system:'c',total_jumps:path.length-1,
        route:path.map((system_id,jumps)=>({system_id,jumps})),
        estimated_fuel:invalidQuote?-1:(quotedCost??20)*(path.length-1)/2,fuel_per_jump:10,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used};
    },
    undock:()=>{server.location.docked_at=null;server.ship.fuel-=lossOnUndock;return {};},
    get_system:()=>({system:{connections:['b','c']}}),
    jump:({id}={})=>{
      if(moveError)throw moveError;
      server.location.system_id=String(id);server.ship.fuel-=10+lossOnJump;
      assert.notDeepEqual(account.state.location,server.location);
      return {};
    },
  }});
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');return account.send(tool,action,payload);
  };
  return {account,server,destination,command,
    configure:(config:{undock?:number;jump?:number;invalid?:boolean;error?:Error;cost?:number})=>{
      lossOnUndock=config.undock??0;lossOnJump=config.jump??0;
      invalidQuote=config.invalid??false;moveError=config.error;quotedCost=config.cost;
    }};
}

test('fuel refusals retain authoritative fractional evidence at every departure boundary',async()=>{
  for(const stage of ['initial','hook','undock','jump'] as const)for(const deficit of [0,0.25]) {
    const f=fixture(),reserve=30.5,required=20+reserve;
    f.server.ship.fuel=required-(stage==='initial'?deficit:0);
    f.configure({undock:stage==='undock'?deficit:0,jump:stage==='jump'?deficit:0});
    assert.equal(f.account.state.ship!.fuel,100,'cache still suggests ample fuel');
    const options:travel.TravelOptions={mood:'Focused',standingPolicy:{fuelReserveFloor:reserve},
      beforeMove:async()=>{if(stage==='hook')f.server.ship.fuel-=deficit;}};
    if(!deficit) {
      const result=await travel.travelTo(f.account,f.command,f.destination,options);
      assert.deepEqual(result.location,f.server.location);
      assert.equal(f.server.ship.fuel,reserve);
      assert.equal(result.jumps,2);
      continue;
    }
    await assert.rejects(travel.travelTo(f.account,f.command,f.destination,options),error=>{
      assert.ok(error instanceof travel.TravelBlocked);
      assert.ok('evidence' in error,'fuel refusal must expose structured evidence');
    assert.ok(error instanceof travel.FuelRouteShortfall);
      const cost=stage==='jump'?10:20,need=cost+reserve;
      assert.equal(error.message,`fuel_below_route_minimum: have ${need-deficit}, need ${need}; shortfall ${deficit} fuel units`);
      const observed=structuredClone(f.server);
      const origin={...observed.location,docked_at:stage==='undock'?'home':observed.location.docked_at};
      assert.deepEqual(error.evidence,{kind:'available_fuel',actualFuel:need-deficit,quotedCost:cost,
        effectiveReserve:reserve,requiredFuel:need,shortfall:deficit,destination:f.destination,
        observed:{ship:observed.ship,location:observed.location},quoteOrigin:origin});
      assert.deepEqual(f.account.state,f.server);
      const saved=structuredClone(error.evidence);
      f.account.state.ship!.fuel=999;f.account.state.location!.poi_id='cache-mutated';
      f.server.ship.fuel=888;f.destination.system_id='changed';
      assert.deepEqual(error.evidence,saved,'evidence must own its snapshots');
      return true;
    });
    assert.deepEqual(f.account.calls.map(c=>c.action),stage==='jump'?
      ['find_route','undock','get_system','jump','find_route']:stage==='undock'?
      ['find_route','undock','get_system']:['find_route']);
  }
});

test('invalidated departure context never becomes fuel-crossing evidence',async()=>{
  const changes={
    ship:(f:ReturnType<typeof fixture>)=>{f.server.ship.id='replacement';},
    system:(f:ReturnType<typeof fixture>)=>{f.server.location.system_id='elsewhere';},
    poi:(f:ReturnType<typeof fixture>)=>{f.server.location.poi_id='elsewhere';},
    dock:(f:ReturnType<typeof fixture>)=>{f.server.location.docked_at='other-base';},
    transit:(f:ReturnType<typeof fixture>)=>{f.server.location.in_transit=true;},
    cargo:(f:ReturnType<typeof fixture>)=>{f.server.ship.cargo_used=1;},
    capacity:(f:ReturnType<typeof fixture>)=>{f.server.ship.max_fuel=40;},
  };
  for(const stage of ['hook','undock'])for(const [context,change] of Object.entries(changes))for(const loss of [0,0.25]) {
    const f=fixture();f.server.ship.fuel=44;
    const invalidate=()=>{
      change(f);f.server.ship.fuel-=loss;
      assert.notDeepEqual(f.account.state,f.server,'server change must not update cached quote context');
    };
    const command:ReadinessCommand=async(name,payload)=>{
      const result=await f.command(name,payload);
      if(stage==='undock'&&name==='spacemolt/undock')invalidate();
      return result;
    };
    await assert.rejects(travel.travelTo(f.account,command,f.destination,{
      mood:'Focused',beforeMove:async()=>{if(stage==='hook')invalidate();},
    }),error=>{
      assert.ok(error instanceof travel.TravelBlocked,`${stage}/${context}/${loss}: contextual refusal`);
      assert.ok(!(error instanceof travel.FuelRouteShortfall),`${stage}/${context}/${loss}: invalid quote cannot establish fuel crossing`);
      assert.match(error.message,/Route origin, load or fuel changed before departure/);
      return true;
    });
    assert.deepEqual(f.account.state,f.server,'refusal follows authoritative refresh');
    assert.deepEqual(f.account.calls.map(c=>c.action),stage==='hook'?
      ['find_route']:['find_route','undock','get_system'],'no further movement after invalidation');
  }
});

test('tank changes during any route quote invalidate context before fuel classification or refueling',async()=>{
  for(const stage of ['initial','post-refuel','subsequent-leg'])for(const capacity of ['smaller','larger'])for(const deficit of [0,0.25]) {
    const f=fixture(),required=stage==='subsequent-leg'?34:44;
    f.server.ship.fuel=stage==='post-refuel'?40:stage==='initial'?required-deficit:44;
    f.configure({jump:stage==='subsequent-leg'?deficit:0});
    let quotes=0,refuels=0;
    const command:ReadinessCommand=async(name,payload)=>{
      const result=await f.command(name,payload);
      if(name==='spacemolt/find_route'&&++quotes===(stage==='initial'?1:2)) {
        f.server.ship.max_fuel=capacity==='smaller'?required-1:121;
        assert.equal(f.account.state.ship!.max_fuel,120,'quote cache retains pre-change capacity');
      }
      return result;
    };
    await assert.rejects(travel.travelTo(f.account,command,f.destination,{
      mood:'Focused',refuel:async minimum=>{
        refuels++;assert.equal(minimum,44);
        f.server.ship.fuel=44-deficit;
        await f.account.refresh();
      },
    }),error=>{
      const scenario=`${stage}/${capacity}/${deficit}`;
      assert.ok(error instanceof travel.TravelBlocked,scenario);
      assert.ok(!(error instanceof travel.FuelRouteShortfall),`${scenario}: invalid quote cannot establish fuel crossing`);
      assert.match(error.message,/changed while quoting route/,scenario);
      return true;
    });
    assert.deepEqual(f.account.state,f.server,'refusal uses authoritative post-quote state');
    assert.equal(refuels,stage==='post-refuel'?1:0,'no refueling after invalidation');
    assert.deepEqual(f.account.calls.map(c=>c.action),stage==='subsequent-leg'?
      ['find_route','undock','get_system','jump','find_route']:stage==='post-refuel'?
      ['find_route','find_route']:['find_route'],'no commands after invalidation');
  }
});

test('capacity refusals are distinct; invalid quotes and uncertain commands are never fuel crossings',async()=>{
  const f=fixture();f.server.ship.max_fuel=43.5;f.server.ship.fuel=40;
  await assert.rejects(travel.travelTo(f.account,f.command,f.destination,{mood:'Focused'}),error=>{
    assert.ok(error instanceof travel.TravelBlocked);
    assert.ok('evidence' in error,'fuel refusal must expose structured evidence');
      assert.ok(error instanceof travel.FuelRouteShortfall);
    assert.equal(error.message,'fuel_below_route_minimum: route and reserve exceed tank capacity; shortfall 4 fuel units; capacity shortfall 0.5 fuel units');
    assert.deepEqual(error.evidence,{kind:'capacity',actualFuel:40,quotedCost:20,effectiveReserve:24,
      requiredFuel:44,shortfall:4,capacityShortfall:0.5,destination:f.destination,
      observed:{ship:f.server.ship,location:f.server.location},quoteOrigin:f.server.location});
    return true;
  });
  assert.deepEqual(f.account.calls.map(c=>c.action),['find_route']);
  for(const cost of [26,40,40.25]) {
    const g=fixture();g.server.ship.max_fuel=50;g.server.ship.fuel=40;
    let refuels=0;
    const options:travel.TravelOptions={mood:'Focused',refuel:async minimum=>{
      refuels++;assert.equal(minimum,44);
      g.server.ship.fuel=50;g.configure({cost});
      assert.equal(g.account.state.ship!.fuel,40,'refill does not update cache');
      await g.account.refresh();
    }};
    if(cost===26) {
      const result=await travel.travelTo(g.account,g.command,g.destination,options);
      assert.deepEqual(result.location,g.server.location);
      assert.equal(result.jumps,2);
    } else {
      await assert.rejects(travel.travelTo(g.account,g.command,g.destination,options),error=>{
        assert.ok(error instanceof travel.FuelRouteShortfall);
        const shortfall=cost+24-50;
        assert.equal(error.evidence.kind,'capacity','refreshed quote must recheck tank capacity');
        assert.equal(error.message,`fuel_below_route_minimum: route and reserve exceed tank capacity; shortfall ${shortfall} fuel units; capacity shortfall ${shortfall} fuel units`);
        assert.deepEqual(error.evidence,{kind:'capacity',actualFuel:50,quotedCost:cost,effectiveReserve:24,
          requiredFuel:cost+24,shortfall,capacityShortfall:shortfall,destination:g.destination,
          observed:{ship:g.server.ship,location:g.server.location},quoteOrigin:g.server.location});
        return true;
      });
      assert.deepEqual(g.account.calls.map(c=>c.action),['find_route','find_route']);
    }
    assert.equal(refuels,1);
  }
  const pending=new SpacemoltError('in_transit','pending');Object.assign(pending,{pendingCommand:{}});
  for(const error of [undefined,pending,new ConnectionClosedError('lost')]) {
    const g=fixture();g.configure({invalid:!error,error});
    await assert.rejects(travel.travelTo(g.account,g.command,g.destination,{mood:'Focused'}),caught=>{
      assert.ok(!(caught instanceof travel.FuelRouteShortfall));
      if(error)assert.equal(caught,error);else assert.ok(caught instanceof travel.TravelBlocked);
      return true;
    });
    assert.deepEqual(g.account.calls.map(c=>c.action),error?
      ['find_route','undock','get_system','jump']:['find_route']);
  }
});
