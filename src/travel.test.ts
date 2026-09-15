import test from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount} from './readiness.ts';
import {travelTo,TravelBlocked} from './travel.ts';

test('fuel lost after undocking reports the refreshed shortfall before jump or local travel',async()=>{
  for(const local of [false,true]) {
    const server={location:{system_id:'a',poi_id:'station',docked_at:'base' as string|null},
      ship:{id:'ship',fuel:40,max_fuel:120,cargo_used:0}};
    const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
      async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
    const calls:string[]=[];
    const handlers:Record<string,()=>unknown>={
      'spacemolt/find_route':()=>({found:true,target_system:local?'a':'b',total_jumps:local?0:1,
        estimated_fuel:10,fuel_per_jump:10,fuel_available:server.ship.fuel,cargo_used:0,
        route:[{system_id:'a',jumps:0},...local?[]:[{system_id:'b',jumps:1}]]}),
      'spacemolt/undock':()=>{server.location.docked_at=null;server.ship.fuel=39;return {};},
      'spacemolt/get_system':()=>({system:{connections:['b']}}),
    };
    await assert.rejects(travelTo(account,async action=>{
      calls.push(action);
      assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
      return handlers[action]();
    },local?{system_id:'a',poi_id:'belt'}:{system_id:'b'},{mood:'Cautious'}),
    error=>error instanceof TravelBlocked&&/have 39, need 40; shortfall 1 fuel units/.test(error.message));
    assert.deepEqual(calls,local?['spacemolt/find_route','spacemolt/undock']:
      ['spacemolt/find_route','spacemolt/undock','spacemolt/get_system']);
    assert.equal(account.state.ship!.fuel,39);
    assert.equal(server.location.system_id,'a');
    assert.equal(server.location.poi_id,'station');
  }
});

// Route costs are deliberately asymmetric and change with the return cargo.
test('travel re-quotes actual remaining fuel, bounds definitive retries, and never replays uncertain movement',async()=>{
  for(const mode of ['reserve','capacity','replan','uncertain','pending','return','stop']) {
    let now=0,jumps=0,refuels=0,stopped=false;
    const calls:string[]=[];
    const state:any={location:{system_id:'a',poi_id:'a_station',docked_at:'a_base'},ship:{id:'ship',fuel:mode==='reserve'?18:100,max_fuel:100,cargo_used:0}};
    const account:ReadinessAccount={state,async refresh(){}};
    const command=async(action:string,params:Record<string,unknown>)=>{
      calls.push(action);
      if(action==='spacemolt/find_route') {
        const from=state.location.system_id,to=String(params.id),same=from===to;
        const fuel=same?0:mode==='capacity'?120:from==='b'?95:10;
        return {found:true,target_system:to,total_jumps:same?0:1,estimated_fuel:fuel,fuel_per_jump:fuel,
          fuel_available:state.ship.fuel,cargo_used:state.ship.cargo_used,
          route:[{system_id:from,jumps:0},...same?[]:[{system_id:to,jumps:1}]]};
      }
      if(action==='spacemolt/get_system')return {system:{connections:['a','b']}};
      if(action==='spacemolt/undock')state.location.docked_at=null;
      if(action==='spacemolt/jump') {
        jumps++;
        if(mode==='replan')throw new SpacemoltError('in_transit','rejected');
        if(mode==='uncertain')throw new SpacemoltError('mutation_timeout','unknown');
        if(mode==='pending'){const error=new SpacemoltError('in_transit','pending');Object.assign(error,{pendingCommand:{}});throw error;}
        state.location={system_id:params.id,poi_id:'gate',in_transit:false};state.ship.fuel-=10;stopped=mode==='stop';
      }
      if(action==='spacemolt/travel')state.location.poi_id=params.id;
      return {};
    };
    const options={reserve:17,now:()=>now,sleep:async(ms:number)=>{now+=ms;},
      checkMove:()=>{if(stopped)throw new Error('Tired');},refuel:async()=>{refuels++;state.ship.fuel=100;}};
    const target={system_id:'b',poi_id:'b_station'};
    if(mode==='return') {
      await travelTo(account,command,target,options);state.ship.cargo_used=80;
      const at=calls.length;
      await assert.rejects(travelTo(account,command,{system_id:'a'},options),/fuel_below_route_minimum/);
      assert.deepEqual(calls.slice(at),['spacemolt/find_route']);
    } else if(mode==='reserve') {
      await travelTo(account,command,target,options);assert.equal(refuels,1);assert.equal(jumps,1);
    } else {
      await assert.rejects(travelTo(account,command,target,options),mode==='stop'?/Tired/:mode==='capacity'?/tank capacity/:/rejected|unknown|pending/);
      assert.equal(jumps,mode==='capacity'?0:mode==='replan'?2:1);
      assert.equal(refuels,0);assert.ok(!calls.includes('spacemolt/travel'));
    }
  }
});

test('objective travel admits a longer finite quoted route while retaining fuel limits and refusing an expanding reroute',async()=>{
  for(const mode of ['arrive','fuel','expanded']) {
    const systems=['a','b','c','d'];
    const state:any={location:{system_id:'a',poi_id:'gate',docked_at:null},ship:{id:'ship',fuel:100,max_fuel:100,cargo_used:0}};
    const account:ReadinessAccount={state,async refresh(){}};
    const moved:string[]=[];
    const command=async(action:string,params:Record<string,unknown>)=>{
      if(action==='spacemolt/find_route') {
        const route=mode==='expanded'&&moved.length?['b','x','c','d']:systems.slice(systems.indexOf(state.location.system_id));
        return {found:true,target_system:'d',total_jumps:route.length-1,estimated_fuel:mode==='fuel'?95:(route.length-1)*10,fuel_per_jump:10,
          fuel_available:state.ship.fuel,cargo_used:0,route:route.map((system_id,jumps)=>({system_id,jumps}))};
      }
      if(action==='spacemolt/get_system')return {system:{connections:systems}};
      if(action==='spacemolt/jump') {
        moved.push(String(params.id));state.location.system_id=params.id;state.ship.fuel-=10;
      }
      return {};
    };
    const trip=travelTo(account,command,{system_id:'d'},{maxJumps:null,reserve:17});
    if(mode==='arrive') {await trip;assert.deepEqual(moved,['b','c','d']);}
    else {
      await assert.rejects(trip,mode==='fuel'?/tank capacity/:/normal jumps/);
      assert.deepEqual(moved,mode==='fuel'?[]:['b']);
    }
  }
});
