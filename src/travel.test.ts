import test from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {travelTo,TravelBlocked} from './travel.ts';

test('fuel lost after undocking reports the refreshed shortfall before jump or local travel',async()=>{
  for(const local of [false,true]) {
    const initial={location:{system_id:'a',poi_id:'station',docked_at:'base' as string|null},
      ship:{id:'ship',fuel:40,max_fuel:120,cargo_used:0}};
    const handlers:FakeCommandHandlers={spacemolt:{
      find_route:()=>({found:true,target_system:local?'a':'b',total_jumps:local?0:1,
        estimated_fuel:10,fuel_per_jump:10,fuel_available:server.ship.fuel,cargo_used:0,
        route:[{system_id:'a',jumps:0},...local?[]:[{system_id:'b',jumps:1}]]}),
      undock:()=>{server.location.docked_at=null;server.ship.fuel=39;return {};},
      get_system:()=>({system:{connections:['b']}}),
    }};
    const account=new FakeLibGoalAccount(initial,handlers);
    const server=account.server,calls=account.calls;
    const command:ReadinessCommand=(name,payload)=>{
      const [tool,action]=name.split('/');
      return account.send(tool,action,payload);
    };
    await assert.rejects(travelTo(account,command,local?{system_id:'a',poi_id:'belt'}:{system_id:'b'},{mood:'Cautious'}),
    error=>error instanceof TravelBlocked&&/have 39, need 40; shortfall 1 fuel units/.test(error.message));
    assert.deepEqual(calls,[
      {tool:'spacemolt',action:'find_route',payload:{id:local?'a':'b'}},
      {tool:'spacemolt',action:'undock',payload:{}},
      ...local?[]:[{tool:'spacemolt',action:'get_system',payload:{}}],
    ]);
    assert.ok(account.refreshes.length>0);
    assert.deepEqual(account.state,server);
    assert.equal(account.state.ship!.fuel,39);
    assert.equal(server.location.system_id,'a');
    assert.equal(server.location.poi_id,'station');
  }
});

// Route costs are deliberately asymmetric and change with the return cargo.
test('travel re-quotes actual remaining fuel, bounds definitive retries, and never replays uncertain movement',async()=>{
  for(const mode of ['reserve','capacity','replan','uncertain','pending','return']) {
    let now=0,jumps=0,refuels=0;
    const initial={location:{system_id:'a',poi_id:'a_station',docked_at:'a_base' as string|null,in_transit:false},ship:{id:'ship',fuel:mode==='reserve'?18:100,max_fuel:100,cargo_used:0}};
    const handlers:FakeCommandHandlers={spacemolt:{
      find_route:(params={})=>{
        const from=server.location.system_id,to=String(params.id),same=from===to;
        const fuel=same?0:mode==='capacity'?120:from==='b'?95:10;
        return {found:true,target_system:to,total_jumps:same?0:1,estimated_fuel:fuel,fuel_per_jump:fuel,
          fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
          route:[{system_id:from,jumps:0},...same?[]:[{system_id:to,jumps:1}]]};
      },
      get_system:()=>({system:{connections:['a','b']}}),
      undock:()=>{server.location.docked_at=null;return {};},
      jump:(params={})=>{
        jumps++;
        if(mode==='replan')throw new SpacemoltError('in_transit','rejected');
        if(mode==='uncertain')throw new SpacemoltError('mutation_timeout','unknown');
        if(mode==='pending'){const error=new SpacemoltError('in_transit','pending');Object.assign(error,{pendingCommand:{}});throw error;}
        server.location={system_id:String(params.id),poi_id:'gate',docked_at:null,in_transit:false};server.ship.fuel-=10;
        assert.notDeepEqual(account.state.location,server.location);
        assert.notEqual(account.state.ship!.fuel,server.ship.fuel);
        return {};
      },
      travel:(params={})=>{
        server.location.poi_id=String(params.id);
        assert.notDeepEqual(account.state.location,server.location);
        return {};
      },
    }};
    const account=new FakeLibGoalAccount(initial,handlers,()=>now);
    const server=account.server,calls=account.calls;
    const command:ReadinessCommand=(name,payload)=>{
      const [tool,action]=name.split('/');
      return account.send(tool,action,payload);
    };
    const options={reserve:17,now:()=>now,sleep:async(ms:number)=>{now+=ms;},
      refuel:async()=>{refuels++;server.ship.fuel=100;await account.refresh();}};
    const target={system_id:'b',poi_id:'b_station'};
    if(mode==='return') {
      await travelTo(account,command,target,options);server.ship.cargo_used=80;
      const at=calls.length;
      await assert.rejects(travelTo(account,command,{system_id:'a'},options),/fuel_below_route_minimum/);
      assert.deepEqual(calls.slice(at),[{tool:'spacemolt',action:'find_route',payload:{id:'a'}}]);
    } else if(mode==='reserve') {
      await travelTo(account,command,target,options);assert.equal(refuels,1);assert.equal(jumps,1);
    } else {
      await assert.rejects(travelTo(account,command,target,options),mode==='capacity'?/tank capacity/:/rejected|unknown|pending/);
      assert.equal(jumps,mode==='capacity'?0:mode==='replan'?2:1);
      assert.equal(refuels,0);assert.ok(!calls.some(c=>c.tool==='spacemolt'&&c.action==='travel'));
    }
    assert.ok(account.refreshes.length>0);
    assert.deepEqual(account.state,server);
  }
});

test('objective travel admits a longer finite quoted route while retaining fuel limits and refusing an expanding reroute',async()=>{
  for(const mode of ['arrive','fuel','expanded']) {
    const systems=['a','b','c','d'];
    const initial={location:{system_id:'a',poi_id:'gate',docked_at:null,in_transit:false},ship:{id:'ship',fuel:100,max_fuel:100,cargo_used:0}};
    const handlers:FakeCommandHandlers={spacemolt:{
      find_route:()=>{
        const route=mode==='expanded'&&account.calls.some(c=>c.action==='jump')?['b','x','c','d']:systems.slice(systems.indexOf(server.location.system_id));
        return {found:true,target_system:'d',total_jumps:route.length-1,estimated_fuel:mode==='fuel'?95:(route.length-1)*10,fuel_per_jump:10,
          fuel_available:server.ship.fuel,cargo_used:0,route:route.map((system_id,jumps)=>({system_id,jumps}))};
      },
      get_system:()=>({system:{connections:systems}}),
      jump:(params={})=>{
        server.location.system_id=String(params.id);server.ship.fuel-=10;
        assert.notDeepEqual(account.state.location,server.location);
        assert.notEqual(account.state.ship!.fuel,server.ship.fuel);
        return {};
      },
    }};
    const account=new FakeLibGoalAccount(initial,handlers);
    const server=account.server;
    const command:ReadinessCommand=(name,payload)=>{
      const [tool,action]=name.split('/');
      return account.send(tool,action,payload);
    };
    const moved=()=>account.calls.filter(c=>c.tool==='spacemolt'&&c.action==='jump').map(c=>c.payload!.id);
    const trip=travelTo(account,command,{system_id:'d'},{maxJumps:null,reserve:17});
    if(mode==='arrive') {
      const result=await trip;assert.deepEqual(moved(),['b','c','d']);
      assert.deepEqual(result.location,server.location);
      assert.equal(account.state.ship!.fuel,70);
    }
    else {
      await assert.rejects(trip,mode==='fuel'?/tank capacity/:/normal jumps/);
      assert.deepEqual(moved(),mode==='fuel'?[]:['b']);
    }
    assert.ok(account.refreshes.length>0);
    assert.deepEqual(account.state,server);
  }
});
