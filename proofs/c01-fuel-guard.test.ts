import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {travelTo,TravelBlocked} from '../src/travel.ts';

// Recording handler-map pattern from the ported fake account. Server state is
// independent: only refresh exposes it to production code, never a shared object.
function fixture(fuel:number,cost:number,local=false) {
  const server={location:{system_id:'a',poi_id:'station',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',fuel,max_fuel:120,cargo_used:0}};
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const calls:string[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/find_route':({id})=>({delta:{details:{found:true,target_system:id,
      total_jumps:local?0:1,estimated_fuel:cost,fuel_per_jump:cost,
      fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
      route:[{system_id:'a',jumps:0},...local?[]:[{system_id:'b',jumps:1}]]}}}),
    'spacemolt/get_system':()=>({structuredContent:{system:{connections:['b']}}}),
    'spacemolt/undock':()=>{server.location.docked_at=null;return {};},
    'spacemolt/jump':({id})=>{server.location.system_id=String(id);server.ship.fuel-=cost;return {};},
    'spacemolt/travel':({id})=>{server.location.poi_id=String(id);server.ship.fuel-=cost;return {};},
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push(action);
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params);
  };
  const destination=local?{system_id:'a',poi_id:'belt'}:{system_id:'b'};
  return {server,account,calls,handlers,command,destination};
}

test('C1: D2 moods determine exact quoted fuel boundaries through real departure',async()=>{
  // These are the operator's D2 acceptance thresholds, not values read back from
  // the resolver. Relaxed/Tired travel here is repositioning/resupply, not a job.
  const reserves={Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0} as const;
  for(const [mood,reserve] of Object.entries(reserves))for(const local of [false,true]) {
    const cost=10.25;
    for(const deficit of [0,1,0.25]) {
      const f=fixture(cost+reserve-deficit,cost,local);
      const trip=travelTo(f.account,f.command,f.destination,{mood:mood as keyof typeof reserves});
      if(deficit) {
        await assert.rejects(trip,error=>error instanceof TravelBlocked&&
          error.message.includes(`shortfall ${deficit} fuel units`),`${mood}: ${deficit} below threshold`);
        assert.deepEqual(f.calls,['spacemolt/find_route']);
        assert.equal(f.server.location.docked_at,'base');
      } else {
        await trip;
        assert.deepEqual(f.calls,local?['spacemolt/find_route','spacemolt/undock','spacemolt/travel']:
          ['spacemolt/find_route','spacemolt/undock','spacemolt/get_system','spacemolt/jump']);
        assert.equal(f.account.state.ship!.fuel,reserve);
        assert.equal(f.account.state.location!.system_id,f.destination.system_id);
        if(local)assert.equal(f.account.state.location!.poi_id,'belt');
      }
    }
  }
  for(const mood of ['Cautious','Aggressive'] as const) {
    const f=fixture(30,10);
    if(mood==='Cautious') {
      await assert.rejects(travelTo(f.account,f.command,f.destination,{mood}),/shortfall 10 fuel units/);
      assert.deepEqual(f.calls,['spacemolt/find_route']);
    } else {await travelTo(f.account,f.command,f.destination,{mood});assert.equal(f.server.location.system_id,'b');}
  }
});

test('C1: capacity, inconsistent quotes and fresh fuel prevent unsafe movement',async()=>{
  for(const mode of ['capacity','quote','cached-high','cached-low','during-quote','before-move']) {
    const f=fixture(40,10);
    let expected=/shortfall 1 fuel units/;
    if(mode==='capacity'){f.server.ship.max_fuel=39;f.server.ship.fuel=39;expected=/tank capacity.*shortfall 1 fuel units/;}
    if(mode==='quote') {
      const quote=f.handlers['spacemolt/find_route'];
      f.handlers['spacemolt/find_route']=params=>{
        const result=quote(params) as any;result.delta.details.fuel_available=100;return result;
      };expected=/quote does not match current fuel/;
    }
    if(mode==='cached-high')f.server.ship.fuel=39;
    if(mode==='cached-low')f.account.state.ship!.fuel=0;
    if(mode==='during-quote') {
      const quote=f.handlers['spacemolt/find_route'];
      f.handlers['spacemolt/find_route']=params=>{const result=quote(params);f.server.ship.fuel=39;return result;};
      expected=/changed while quoting route/;
    }
    const trip=travelTo(f.account,f.command,f.destination,{mood:'Cautious',
      beforeMove:async()=>{if(mode==='before-move')f.server.ship.fuel=39;}});
    if(mode==='cached-low') {await trip;assert.equal(f.server.location.system_id,'b');}
    else {
      await assert.rejects(trip,expected);
      assert.deepEqual(f.calls,['spacemolt/find_route'],mode);
      assert.equal(f.server.location.docked_at,'base',mode);
    }
  }
});
