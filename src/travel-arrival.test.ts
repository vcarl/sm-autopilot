import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessCommand} from './readiness.ts';
import {ArrivalUnresolved,travelTo} from './travel.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';

// Adapted from setpoint (removed from this repo; see git history), tests/dispatcher/wait-for-location.test.ts.
// Only refresh delivers location: cargo pushes deliberately leave it stale.
function fixture(local:boolean,arrivalAt:number) {
  let time=0;
  const initial={location:{system_id:'a',poi_id:'origin',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const sleeps:number[]=[],settledInFlight:number[]=[];
  let staleArrivalPolls=0;
  const movement=local?'spacemolt/travel':'spacemolt/jump';
  const destination=local?{system_id:'a',poi_id:'belt'}:{system_id:'b'};
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:()=>({found:true,target_system:destination.system_id,
      total_jumps:local?0:1,estimated_fuel:10,fuel_per_jump:10,
      fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
      route:[{system_id:'a',jumps:0},...local?[]:[{system_id:'b',jumps:1}]]}),
    get_system:()=>({system:{connections:['b']}}),
    [local?'travel':'jump']:params=>{
      assert.equal(params?.id,local?'belt':'b');
      server.location.in_transit=true;
      server.ship.fuel-=10;
      return {};
    },
  }};
  const account=new FakeLibGoalAccount(initial,handlers,()=>time);
  const server=account.server,reads=account.refreshes,calls=account.calls;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool!,action!,payload);
  };
  const options={mood:'Cautious' as const,now:()=>time,
    sleep:async(ms:number)=>{
      assert.ok(ms>0);
      sleeps.push(ms);time+=ms;
      if(time>=arrivalAt) {
        server.location.in_transit=false;
        if(local)server.location.poi_id='belt';
        else server.location.system_id='b';
      }
      server.ship.cargo_used++;
      account.state.ship!.cargo_used=server.ship.cargo_used;
      if(!server.location.in_transit&&account.state.location!.in_transit)staleArrivalPolls++;
    },
    checkpoint:async(settled=false)=>{
      if(settled&&calls.some(call=>`${call.tool}/${call.action}`===movement))settledInFlight.push(time);
    },
  };
  return {account,server,command,destination,options,reads,sleeps,calls,movement,settledInFlight,
    now:()=>time,staleArrivalPolls:()=>staleArrivalPolls};
}

test('travel discovers dropped arrivals within each authoritative refresh interval despite cargo pushes',async()=>{
  for(const local of [true,false])for(const arrivalAt of [2_000,32_000,62_000]) {
    const f=fixture(local,arrivalAt);
    const result=await travelTo(f.account,f.command,f.destination,f.options);
    assert.ok(f.staleArrivalPolls()>0,'server arrival must remain absent from cache until refresh');
    assert.ok(f.now()>=arrivalAt&&f.now()-arrivalAt<=30_000,'dropped arrival discovered within 30 seconds');
    assert.deepEqual(result.location,f.server.location);
    assert.equal(result.location!.in_transit,false);
    const timedReads=f.reads.filter(at=>at>0);
    assert.deepEqual(timedReads,Array.from({length:Math.ceil(arrivalAt/30_000)},(_,i)=>(i+1)*30_000));
    assert.ok(f.sleeps.every(ms=>ms===2_000),'cache polling continues between authoritative reads');
    assert.equal(f.account.state.ship!.cargo_used,f.sleeps.length);
    assert.deepEqual(f.calls.map(call=>`${call.tool}/${call.action}`),local?
      ['spacemolt/find_route','spacemolt/travel']:
      ['spacemolt/find_route','spacemolt/get_system','spacemolt/jump']);
    assert.deepEqual(f.settledInFlight,[f.now()]);
  }
});

test('travel leaves unresolved transit at its deadline without replay, but accepts authoritative arrival at the deadline',async()=>{
  // An unaligned deadline exercises the final partial sleep and forced read.
  // The default-bound arm also covers genuinely long transit without real waits.
  for(const local of [true,false])for(const maxWaitMs of [65_001,undefined])for(const arrives of [false,true]) {
    const deadline=maxWaitMs??600_000;
    const f=fixture(local,arrives?deadline:Infinity);
    const trip=travelTo(f.account,f.command,f.destination,{...f.options,maxWaitMs:maxWaitMs!});
    if(arrives) {
      const result=await trip;
      assert.deepEqual(result.location,f.server.location);
      assert.equal(result.location!.in_transit,false);
      assert.deepEqual(f.settledInFlight,[deadline]);
      assert.ok(f.staleArrivalPolls()>0);
    } else {
      await assert.rejects(trip,ArrivalUnresolved);
      assert.equal(f.account.state.location!.in_transit,true);
      assert.equal(f.account.state.location!.system_id,'a');
      assert.equal(f.account.state.location!.poi_id,'origin');
      assert.deepEqual(f.settledInFlight,[],'unresolved transit must not reach an arrival checkpoint');
    }
    assert.equal(f.now(),deadline);
    assert.equal(f.reads.at(-1),deadline,'deadline requires an authoritative read before deciding');
    assert.equal(f.sleeps.reduce((sum,ms)=>sum+ms,0),deadline);
    assert.deepEqual(f.calls.map(call=>`${call.tool}/${call.action}`),local?
      ['spacemolt/find_route','spacemolt/travel']:
      ['spacemolt/find_route','spacemolt/get_system','spacemolt/jump']);
  }
});
