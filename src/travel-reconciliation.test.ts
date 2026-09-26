import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import type {ReadinessCommand} from './readiness.ts';
import {ArrivalUnresolved,TravelBlocked,travelTo} from './travel.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

// Port the navigation reconciliation contract through the production movement path.
// A rejected move leaves the server location unknown and the cache at its old origin.
function fixture(kind:'jump'|'travel',mode:'arrived'|'elsewhere'|'fuel'|'timeout'|'second'|'pending'|'transport',resolveAt=2_000) {
  const local=kind==='travel';
  const destination=local?{system_id:'a',poi_id:'belt'}:{system_id:'b'};
  const resolved={system_id:local?'a':'c',poi_id:'resolved_gate'};
  const target={system_id:destination.system_id,poi_id:local?'belt':'b_gate'};
  const movementActions=local?['travel']:['get_system','jump'];
  let time=0,attempts=0,arrivalAt=Infinity;
  const initial={location:{system_id:'a',poi_id:'a_gate',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const quotes:{at:number;state:typeof initial;cost:number}[]=[],sleeps:number[]=[],settled:number[]=[];
  const firstError=mode==='transport'?new ConnectionClosedError('connection lost'):
    new SpacemoltError('in_transit','first move rejected');
  if(mode==='pending')Object.assign(firstError,{pendingCommand:{}});
  const secondError=new SpacemoltError('in_transit','second move rejected');
  const account:FakeLibGoalAccount<typeof initial>=new FakeLibGoalAccount(initial,{spacemolt:{
    find_route:payload=>{
      assert.deepEqual(payload,{id:destination.system_id});
      assert.ok(server.location.system_id,'unknown location cannot be quoted');
      assert.deepEqual(account.state,server,'quote must use authoritative origin, fuel and cargo');
      const cost=server.location.poi_id==='a_gate'?10:20;
      quotes.push({at:time,state:structuredClone(server),cost});
      return {found:true,target_system:destination.system_id,total_jumps:local?0:1,estimated_fuel:cost,fuel_per_jump:local?0:cost,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:local?[{system_id:'a',jumps:0}]:[{system_id:server.location.system_id,jumps:0},{system_id:'b',jumps:1}]};
    },
    get_system:payload=>{assert.deepEqual(payload,{});return {system:{connections:['b']}};},
    [kind]:payload=>{
      assert.deepEqual(payload,{id:local?destination.poi_id:destination.system_id});
      assert.deepEqual(account.state,server);
      attempts++;
      if(attempts===1) {
        server.location.system_id='';server.location.poi_id='';
        server.ship.fuel=mode==='fuel'?19:50;server.ship.cargo_used=40;
        assert.equal(account.state.location!.system_id,'a');
        assert.equal(account.state.ship!.fuel,100);
        throw firstError;
      }
      assert.equal(attempts,2,'reconciliation permits at most one retry');
      assert.equal(quotes.length,2,'retry needs a fresh quote');
      assert.equal(server.location.system_id,resolved.system_id,'retry must depart from resolved origin');
      assert.equal(server.location.poi_id,resolved.poi_id);
      assert.equal(quotes[1].at,time);
      assert.deepEqual(quotes[1].state,server);
      if(mode==='second')throw secondError;
      server.ship.fuel-=quotes[1].cost;server.location.in_transit=true;arrivalAt=time+2_000;
      return {};
    },
  }},()=>time);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  const options={now:()=>time,maxWaitMs:65_001,
    sleep:async(ms:number)=>{
      sleeps.push(ms);time+=ms;
      if(!server.location.system_id&&mode!=='timeout'&&time>=resolveAt) {
        Object.assign(server.location,mode==='arrived'?target:resolved);
      }
      if(time>=arrivalAt) {
        Object.assign(server.location,target);server.location.in_transit=false;
      }
      // Unrelated pushes cannot make cached location authoritative or delay reads.
      account.state.ship!.cargo_used=++server.ship.cargo_used;
    },
    checkpoint:async(isSettled=false)=>{
      if(isSettled) {
        assert.ok(server.location.system_id);
        assert.equal(server.location.in_transit,false);
        assert.deepEqual(account.state,server);
        assert.equal(account.refreshes.at(-1),time);
        settled.push(time);
      }
    },
  };
  return {destination,resolved,movementActions,account,server,quotes,sleeps,settled,firstError,secondError,now:()=>time,
    run:()=>travelTo(account,command,destination,options)};
}

test('rejected local travel or jump reconciles unknown location at destination or re-quotes authoritative position and load before retry',async()=>{
  for(const kind of ['jump','travel'] as const)for(const mode of ['arrived','elsewhere'] as const)for(const resolveAt of [2_000,32_000]) {
    const f=fixture(kind,mode,resolveAt),result=await f.run();
    const observedAt=Math.ceil(resolveAt/30_000)*30_000;
    assert.deepEqual(f.quotes[0].state.location,{system_id:'a',poi_id:'a_gate',docked_at:null,in_transit:false});
    assert.deepEqual(f.settled,mode==='arrived'?[0,observedAt]:[0,observedAt,observedAt+30_000]);
    assert.deepEqual(f.account.calls.map(c=>c.action),mode==='arrived'?
      ['find_route',...f.movementActions]:['find_route',...f.movementActions,'find_route',...f.movementActions]);
    assert.equal(f.quotes.length,mode==='arrived'?1:2);
    if(mode==='elsewhere') {
      const quote=f.quotes[1];
      assert.equal(quote.at,observedAt);
      assert.equal(quote.state.location.system_id,f.resolved.system_id);
      assert.equal(quote.state.location.poi_id,f.resolved.poi_id);
      assert.equal(quote.state.ship.fuel,50);
      assert.equal(quote.state.ship.cargo_used,40+observedAt/2_000);
      assert.equal(f.server.ship.fuel,30,'the fresh route cost is what the leg spends');
    }
    assert.equal(result.location!.system_id,f.destination.system_id);
    if(kind==='travel')assert.equal(result.location!.poi_id,f.destination.poi_id);
    assert.deepEqual(result.location,f.server.location);
    assert.deepEqual(f.account.state,f.server);
    assert.equal(result.jumps,mode==='arrived'||kind==='travel'?0:1,'rejected commands are not confirmed jump receipts');
    assert.ok(f.sleeps.every(ms=>ms===2_000));
    assert.deepEqual([...new Set(f.account.refreshes.filter(at=>at>0))],
      Array.from({length:f.now()/30_000},(_,i)=>(i+1)*30_000));
  }
});

test('post-rejection reconciliation blocks fuel shortfalls, unresolved location, exhausted retries and uncertain commands',async()=>{
  for(const kind of ['jump','travel'] as const)for(const mode of ['fuel','timeout','second','pending','transport'] as const) {
    const f=fixture(kind,mode);
    await assert.rejects(f.run(),error=>mode==='fuel'?
      error instanceof TravelBlocked&&/have 19, need 20; shortfall 1 fuel units/.test(error.message):
      mode==='timeout'?error instanceof ArrivalUnresolved:error===(mode==='second'?f.secondError:f.firstError));
    const actions=['find_route',...f.movementActions];
    if(mode==='fuel'||mode==='second')actions.push('find_route');
    if(mode==='second')actions.push(...f.movementActions);
    assert.deepEqual(f.account.calls.map(c=>c.action),actions);
    assert.deepEqual(f.settled,mode==='fuel'||mode==='second'?[0,30_000]:[0]);
    if(mode==='fuel'||mode==='second') {
      assert.equal(f.quotes[1].state.location.system_id,f.resolved.system_id);
      assert.equal(f.quotes[1].state.location.poi_id,f.resolved.poi_id);
      assert.equal(f.quotes[1].state.ship.fuel,mode==='fuel'?19:50);
      assert.equal(f.quotes[1].state.ship.cargo_used,55);
      assert.equal(f.quotes[1].at,30_000);
      assert.equal(f.now(),30_000);
      assert.deepEqual(f.account.state,f.server);
    } else if(mode==='timeout') {
      assert.equal(f.now(),65_001);
      assert.deepEqual(f.account.refreshes.filter(at=>at>0),[30_000,60_000,65_001]);
      assert.equal(f.sleeps.at(-1),1_001);
      assert.ok(f.sleeps.slice(0,-1).every(ms=>ms===2_000));
      assert.equal(f.account.state.location!.system_id,'');
      assert.deepEqual(f.account.state,f.server);
    } else {
      assert.equal(f.now(),0);
      assert.deepEqual(f.sleeps,[]);
      assert.equal(f.account.state.location!.system_id,'a');
      assert.equal(f.server.location.system_id,'','uncertain command stays with its caller for reconciliation');
    }
  }
});
