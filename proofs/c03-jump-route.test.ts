import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {travelTo,TravelBlocked} from '../src/travel.ts';
import type {ReadinessCommand} from '../src/readiness.ts';
import {FakeLibGoalAccount} from '../src/test-support/fake-lib-account.ts';

type Scenario='normal'|'reroute'|'arrived'|'second'|'pending'|'transport'|'fuel'|'route'|'connection';

// Fixture-owned routes and prices; only the account boundary is simulated.
function fixture(mode:Scenario,delay=2_000) {
  let time=0,attempts=0,arrivalAt=Infinity,arrivalSystem='';
  const initial={location:{system_id:'a',poi_id:'a_gate',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:44,max_fuel:120,cargo_used:0}};
  const quotes:{at:number;state:typeof initial;cost:number}[]=[],settled:number[]=[],sleeps:number[]=[];
  const paths:Record<string,string[]>={a:['a','b','c'],x:['x','d','c'],d:['d','c'],b:['b','c']};
  const connections:Record<string,string[]>={a:['b'],x:['d'],d:['c'],b:['c']};
  const rejectsFirst=['reroute','arrived','second','pending','transport'].includes(mode);
  const firstError=mode==='transport'?new ConnectionClosedError('lost jump reply'):
    new SpacemoltError('in_transit','jump rejected after movement');
  if(mode==='pending')Object.assign(firstError,{pendingCommand:{}});
  const secondError=new SpacemoltError('in_transit','later jump rejected');
  const account=new FakeLibGoalAccount(initial,{spacemolt:{
    find_route:payload=>{
      assert.deepEqual(payload,{id:'c'});
      assert.deepEqual(account.state,server,'every quote uses refreshed position, fuel and cargo');
      const path=paths[server.location.system_id];
      assert.ok(path,'never quote unknown or already-arrived location');
      const cost=(path.length-1)*10;
      quotes.push({at:time,state:structuredClone(server),cost});
      return {found:true,target_system:'c',total_jumps:path.length-1,estimated_fuel:cost,fuel_per_jump:10,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:path.map((system_id,jumps)=>({system_id,jumps,
          via_wormhole:mode==='route'&&server.location.system_id==='b'}))};
    },
    get_system:()=>({system:{connections:mode==='connection'&&server.location.system_id==='b'?[]:
      connections[server.location.system_id]}}),
    jump:payload=>{
      assert.deepEqual(account.state,server);
      assert.equal(payload?.id,paths[server.location.system_id][1]);
      attempts++;
      if(attempts===1&&rejectsFirst) {
        server.location.in_transit=true;server.ship.fuel=44;server.ship.cargo_used=40;
        arrivalSystem=mode==='arrived'?'c':'x';arrivalAt=time+delay;
        assert.equal(account.state.location!.in_transit,false,'rejection leaves stale cache');
        throw firstError;
      }
      // A successful intervening jump must not replenish the trip's retry allowance.
      if(mode==='second'&&attempts===3)throw secondError;
      server.ship.fuel-=10;server.location.in_transit=true;
      arrivalSystem=String(payload?.id);arrivalAt=time+delay;
      assert.equal(account.state.location!.in_transit,false);
      assert.ok(account.state.ship!.fuel>server.ship.fuel);
      return {};
    },
  }},()=>time);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');return account.send(tool,action,payload);
  };
  return {account,server,quotes,settled,sleeps,firstError,secondError,now:()=>time,
    run:()=>travelTo(account,command,{system_id:'c'},{mood:'Focused',now:()=>time,
      sleep:async(ms)=>{
        sleeps.push(ms);time+=ms;
        if(time>=arrivalAt) {
          Object.assign(server.location,{system_id:arrivalSystem,poi_id:arrivalSystem+'_gate',in_transit:false});
          arrivalAt=Infinity;
          if(mode==='fuel'&&arrivalSystem==='b')server.ship.fuel--;
        }
        // Cargo pushes do not update cached location/fuel or authorize arrival.
        account.state.ship!.cargo_used=++server.ship.cargo_used;
      },
      checkpoint:async(isSettled=false)=>{
        if(isSettled) {
          assert.equal(server.location.in_transit,false);
          assert.deepEqual(account.state,server);
          assert.equal(account.refreshes.at(-1),time);
          settled.push(time);
        }
      },
    })};
}

test('C3 reaches a multi-system target with fresh quotes and reroutes a rejected jump from actual position',async()=>{
  for(const mode of ['normal','reroute','arrived'] as const)for(const delay of [2_000,32_000]) {
    const f=fixture(mode,delay),result=await f.run();
    const interval=Math.ceil(delay/30_000)*30_000;
    const origins=mode==='normal'?['a','b']:mode==='reroute'?['a','x','d']:['a'];
    assert.deepEqual(f.quotes.map(q=>q.state.location.system_id),origins);
    assert.deepEqual(f.quotes.map(q=>q.at),origins.map((_,i)=>i*interval));
    assert.deepEqual(f.quotes.map(q=>q.state.ship.fuel),mode==='reroute'?[44,44,34]:mode==='normal'?[44,34]:[44]);
    assert.deepEqual(f.quotes.map(q=>q.state.ship.cargo_used),mode==='reroute'?
      [0,40+interval/2_000,40+2*interval/2_000]:mode==='normal'?[0,interval/2_000]:[0]);
    for(const quote of f.quotes)assert.equal(quote.state.ship.fuel,quote.cost+24,'Focused reserve at exact boundary');
    assert.deepEqual(f.account.calls.filter(c=>c.action==='jump').map(c=>c.payload?.id),
      mode==='normal'?['b','c']:mode==='reroute'?['b','d','c']:['b'],'no replay of stale b-to-c route');
    const legs=mode==='arrived'?1:mode==='reroute'?3:2;
    assert.deepEqual(f.settled,Array.from({length:legs+1},(_,i)=>i*interval));
    assert.equal(f.now(),legs*interval);
    assert.ok(f.sleeps.every(ms=>ms===2_000));
    assert.deepEqual([...new Set(f.account.refreshes.filter(at=>at>0))],
      Array.from({length:f.now()/30_000},(_,i)=>(i+1)*30_000));
    assert.equal(result.jumps,mode==='arrived'?0:2,'rejected commands do not count as confirmed jumps');
    assert.equal(result.location!.system_id,'c');
    assert.deepEqual(result.location,f.server.location);
    assert.deepEqual(f.account.state,f.server);
    assert.equal(f.server.ship.fuel,mode==='arrived'?44:24);
  }
});

test('C3 stops on exhausted trip retries, uncertain commands, refreshed fuel shortfall or invalid remaining route',async()=>{
  for(const mode of ['second','pending','transport','fuel','route','connection'] as const) {
    const f=fixture(mode);
    await assert.rejects(f.run(),error=>{
      if(mode==='second')return error===f.secondError;
      if(mode==='pending'||mode==='transport')return error===f.firstError;
      return error instanceof TravelBlocked&&(mode==='fuel'?
        /have 33, need 34; shortfall 1 fuel units/.test(error.message):
        mode==='route'?/inconsistent or uses a wormhole/.test(error.message):/not a verified normal connection/.test(error.message));
    });
    const uncertain=mode==='pending'||mode==='transport';
    assert.deepEqual(f.account.calls.filter(c=>c.action==='jump').map(c=>c.payload?.id),
      mode==='second'?['b','d','c']:['b']);
    assert.deepEqual(f.quotes.map(q=>q.state.location.system_id),mode==='second'?['a','x','d']:uncertain?['a']:['a','b']);
    assert.deepEqual(f.settled,mode==='second'?[0,30_000,60_000]:uncertain?[0]:[0,30_000]);
    assert.equal(f.now(),mode==='second'?60_000:uncertain?0:30_000);
    if(uncertain) {
      assert.deepEqual(f.sleeps,[]);
      assert.equal(f.account.state.location!.in_transit,false);
      assert.equal(f.server.location.in_transit,true);
    } else {
      assert.deepEqual(f.account.state,f.server);
      assert.equal(f.server.location.system_id,mode==='second'?'d':'b');
    }
  }
});
