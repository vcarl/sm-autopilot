import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessCommand} from './readiness.ts';
import {ArrivalUnresolved,travelTo} from './travel.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

// Adapted from setpoint (removed from this repo; see git history), tests/dispatcher/lib-primitives/go-to-poi.test.ts.
// Unknown server location must override cached target coordinates before any act.
function fixture(resolvePoi:string,resolveAt=2_000) {
  let time=0,arrivalAt=Infinity;
  const initial={location:{system_id:'',poi_id:'',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const sleeps:number[]=[],settled:number[]=[],quotes:{at:number;state:typeof initial}[]=[];
  const hooks={poll:()=>{},checkpoint:()=>{}};
  const account:FakeLibGoalAccount<typeof initial>=new FakeLibGoalAccount(initial,{spacemolt:{
    find_route:payload=>{
      assert.deepEqual(payload,{id:'sol'});
      assert.equal(server.location.poi_id,resolvePoi);
      assert.equal(server.location.system_id,'sol');
      assert.equal(server.location.in_transit,false);
      assert.deepEqual(account.state,server,'quote must consume refreshed origin and cargo');
      quotes.push({at:time,state:structuredClone(server)});
      return {found:true,target_system:'sol',total_jumps:0,estimated_fuel:7,fuel_per_jump:0,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:[{system_id:'sol',jumps:0}]};
    },
    travel:payload=>{
      assert.deepEqual(payload,{id:'belt'});
      assert.equal(quotes.length,1);
      assert.deepEqual(account.state,server);
      server.ship.fuel-=7;server.location.in_transit=true;arrivalAt=time+2_000;
      assert.equal(account.state.location!.in_transit,false,'send does not refresh cache');
      return {};
    },
  }},()=>time);
  const server=account.server;
  account.state.location!.system_id='sol';account.state.location!.poi_id='belt';
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool!,action!,payload);
  };
  const options={mood:'Cautious' as const,now:()=>time,maxWaitMs:65_001,
    sleep:async(ms:number)=>{
      assert.ok(ms>0);sleeps.push(ms);time+=ms;
      if(!server.location.system_id&&time>=resolveAt) {
        server.location.system_id='sol';server.location.poi_id=resolvePoi;
      }
      if(time>=arrivalAt){server.location.poi_id='belt';server.location.in_transit=false;}
      // Cargo pushes happen every poll, including while location remains unknown.
      account.state.ship!.cargo_used=++server.ship.cargo_used;
      hooks.poll();
    },
    checkpoint:async(isSettled=false)=>{
      hooks.checkpoint();
      if(isSettled) {
        assert.ok(server.location.system_id);
        assert.equal(server.location.in_transit,false);
        assert.deepEqual(account.state.location,server.location);
        assert.equal(account.refreshes.at(-1),time,'settled location needs an authoritative read');
        settled.push(time);
      }
    },
  };
  return {account,server,sleeps,settled,quotes,hooks,now:()=>time,
    run:()=>travelTo(account,command,{system_id:'sol',poi_id:'belt'},options)};
}

test('unknown location resolves authoritatively at target or permits one freshly quoted local move',async()=>{
  for(const poi of ['belt','other'])for(const resolveAt of [2_000,32_000]) {
    const f=fixture(poi,resolveAt);
    const result=await f.run();
    const resolvedAt=Math.ceil(resolveAt/30_000)*30_000;
    assert.equal(f.settled[0],resolvedAt,'cargo pushes must not postpone location reads');
    assert.deepEqual([...new Set(f.account.refreshes.filter(at=>at>0))],
      Array.from({length:f.now()/30_000},(_,i)=>(i+1)*30_000));
    assert.ok(f.sleeps.every(ms=>ms===2_000));
    assert.deepEqual(result.location,f.server.location);
    assert.equal(result.location!.poi_id,'belt');
    assert.equal(result.location!.in_transit,false);
    assert.equal(result.jumps,0);
    assert.deepEqual(f.account.state.ship,f.server.ship);
    assert.deepEqual(f.account.calls,poi==='belt'?[]:[
      {tool:'spacemolt',action:'find_route',payload:{id:'sol'}},
      {tool:'spacemolt',action:'travel',payload:{id:'belt'}},
    ]);
    assert.equal(f.now(),resolvedAt+(poi==='belt'?0:30_000));
    if(poi==='other') {
      assert.equal(f.quotes[0]!.at,resolvedAt);
      assert.equal(f.quotes[0]!.state.ship.cargo_used,resolvedAt/2_000);
      assert.equal(f.quotes[0]!.state.location.poi_id,'other');
    }
  }
});

test('unknown location times out without commands or settlement and remains interruptible with ship identity guarded',async()=>{
  for(const mode of ['timeout','stop','ship']) {
    const f=fixture('other',Infinity);
    const stop=new Error('observer stop');
    if(mode==='stop')f.hooks.checkpoint=()=>{if(f.now()>=2_000)throw stop;};
    if(mode==='ship')f.hooks.poll=()=>{f.server.ship.id='replacement';};
    await assert.rejects(f.run(),mode==='timeout'?ArrivalUnresolved:mode==='ship'?/Ship changed/:error=>error===stop);
    assert.deepEqual(f.account.calls,[],'unknown location never permits a quote or movement');
    assert.deepEqual(f.settled,[]);
    assert.equal(f.account.state.location!.system_id,'','stale cached target must be discarded');
    assert.equal(f.now(),mode==='timeout'?65_001:mode==='ship'?30_000:2_000);
    if(mode==='timeout') {
      assert.deepEqual(f.account.refreshes.filter(at=>at>0),[30_000,60_000,65_001]);
      assert.equal(f.sleeps.at(-1),1_001,'unaligned deadline takes a final partial wait');
      assert.ok(f.sleeps.slice(0,-1).every(ms=>ms===2_000));
      assert.equal(f.sleeps.reduce((sum,ms)=>sum+ms,0),65_001);
    }
    if(mode==='ship')assert.equal(f.account.state.ship!.id,f.server.ship.id);
    assert.equal(f.account.state.ship!.cargo_used,f.sleeps.length);
  }
});
