import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import type {Mood} from '../src/mood-policy.ts';
import {ServiceBlocked,serviceShip} from '../src/servicing.ts';

// Recording handler-map pattern from the C1/C2 proofs. Server state is independent:
// only refresh exposes it to production code, never a shared object.
function fixture(opts:{fuel?:number;hull?:number;credits?:number;fuelPrice?:number|null;repairPrice?:number|null}={}) {
  const fuelPrice=opts.fuelPrice===undefined?5:opts.fuelPrice;
  const repairPrice=opts.repairPrice===undefined?5:opts.repairPrice;
  const server={
    location:{system_id:'a',poi_id:'dock',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',fuel:opts.fuel??110,max_fuel:120,hull:opts.hull??90,max_hull:100,
      shield:10,max_shield:10,cargo_used:4,cargo_capacity:50},
    player:{credits:opts.credits??100_000},
    cargo:[{item_id:'ore',quantity:4}],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}],
  };
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const calls:{action:string;fuel:number;hull:number}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_base':()=>({delta:{details:{
      services:['refuel','repair'],
      base:{poi_id:'dock',...repairPrice===null?{}:{repair_price_per_hull:repairPrice}},
      ...fuelPrice===null?{}:{fuel_price_all_in:fuelPrice}}}}),
    'spacemolt/refuel':()=>{
      const filled=server.ship.max_fuel-server.ship.fuel;
      server.ship.fuel=server.ship.max_fuel;
      return {delta:{details:{action:'refuel',source:'station',fuel:server.ship.fuel,cost:filled*(fuelPrice??0)}}};
    },
    'spacemolt/repair':()=>{
      const repaired=server.ship.max_hull-server.ship.hull;
      server.ship.hull=server.ship.max_hull;
      return {delta:{details:{action:'repair',source:'station',hull:server.ship.hull,cost:repaired*(repairPrice??0)}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,fuel:server.ship.fuel,hull:server.ship.hull});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params ?? {});
  };
  return {server,account,calls,handlers,command};
}

test('C5: the mood spend margin gates a full service and the verified post-state decides success',async()=>{
  // The operator's D2 max-spend-per-job column, asserted here, not read back from
  // the resolver. Ten fuel units and ten hull points short at half the margin each.
  const margins={Relaxed:500,Cautious:500,Focused:1000,Opportunistic:1000,Aggressive:2000} as const;
  for(const [mood,margin] of Object.entries(margins))for(const over of [0,1]) {
    const f=fixture({fuelPrice:margin/20+over,repairPrice:margin/20});
    const run=serviceShip(f.account,f.command,{mood:mood as Mood});
    if(over) {
      await assert.rejects(run,error=>error instanceof ServiceBlocked&&
        error.message.includes(`exceeds the ${mood} service spend margin ${margin}`)&&
        error.message.includes('shortfall 10 fuel units')&&
        error.message.includes('shortfall 10 hull points'),`${mood}: one credit per unit over the margin`);
      // Nothing is bought at all: a partial fill inside the margin is not a service.
      assert.deepEqual(f.calls.map(c=>c.action),['spacemolt/get_base'],mood);
      assert.equal(f.server.ship.fuel,110);assert.equal(f.server.ship.hull,90);
    } else {
      const result=await run;
      assert.deepEqual(f.calls.map(c=>c.action),['spacemolt/get_base','spacemolt/refuel','spacemolt/repair'],mood);
      assert.equal(result.spent,margin,mood);
      assert.deepEqual([result.fuel,result.hull],[120,100],mood);
      // D3: a serviced dock restores the full tank and full hull, whatever the mood.
      assert.equal(f.server.ship.fuel,120);assert.equal(f.server.ship.hull,100);
      assert.equal(f.account.state.ship!.fuel,120);assert.equal(f.account.state.ship!.hull,100);
    }
  }
  // Tired's D2 row is "service only", not zero: the resupply leg is bounded by the
  // wallet and the operator's reserve, never by a job budget it cannot earn.
  const tired=fixture({fuelPrice:1_000,repairPrice:1_000});
  const result=await serviceShip(tired.account,tired.command,{mood:'Tired'});
  assert.equal(result.spent,20_000);
  assert.deepEqual([tired.server.ship.fuel,tired.server.ship.hull],[120,100]);
});

test('C5: a partial fill names the gap in units and an already-serviced ship issues nothing',async()=>{
  for(const mode of ['satisfied','stale-cache','station-short','unchanged','credits',
    'no-fuel-quote','no-repair-quote','hull-short','overcharge']) {
    const f=fixture(mode==='satisfied'?{fuel:120,hull:100}:mode==='credits'?{credits:60}:
      mode==='no-fuel-quote'?{fuelPrice:null}:mode==='no-repair-quote'?{repairPrice:null}:{});
    if(mode==='stale-cache') {
      // A cache claiming a serviced ship must not stand in for an authoritative read.
      f.account.state.ship!.fuel=120;f.account.state.ship!.hull=100;
    }
    if(mode==='station-short')f.handlers['spacemolt/refuel']=()=>{
      f.server.ship.fuel+=3;return {delta:{details:{cost:15}}};
    };
    if(mode==='unchanged')f.handlers['spacemolt/refuel']=()=>({delta:{details:{action:'refuel',fuel:120,cost:50}}});
    if(mode==='hull-short')f.handlers['spacemolt/repair']=()=>{
      f.server.ship.hull+=4;return {delta:{details:{cost:20}}};
    };
    if(mode==='overcharge')f.handlers['spacemolt/refuel']=()=>{
      f.server.ship.fuel=120;return {delta:{details:{cost:999}}};
    };
    const run=serviceShip(f.account,f.command,{mood:'Cautious'});
    if(mode==='satisfied'||mode==='stale-cache') {
      const result=await run;
      assert.equal(result.satisfied,true,mode);
      if(mode==='satisfied') {
        assert.deepEqual(f.calls,[],'an already-serviced ship issues nothing');
        assert.deepEqual(result.issued,[]);assert.equal(result.spent,0);
      } else {
        assert.deepEqual(f.calls.map(c=>c.action),['spacemolt/get_base','spacemolt/refuel','spacemolt/repair']);
        assert.deepEqual([f.server.ship.fuel,f.server.ship.hull],[120,100]);
      }
      continue;
    }
    const expected:Record<string,RegExp>={
      'station-short':/fuel have 113, need 120; shortfall 7 fuel units/,
      unchanged:/fuel have 110, need 120; shortfall 10 fuel units/,
      credits:/credits 60 less reserve 0 cannot cover the quoted 100 credits/,
      'no-fuel-quote':/no all-in fuel quote at this station/,
      'no-repair-quote':/no all-in repair quote at this station/,
      'hull-short':/hull have 94, need 100; shortfall 6 hull points/,
      overcharge:/spacemolt\/refuel charged 999 against a 50 credit quote/,
    };
    await assert.rejects(run,error=>error instanceof ServiceBlocked&&
      expected[mode].test(error.message)&&!/\bready\b/.test(error.message),mode);
    const issued=f.calls.map(c=>c.action);
    // Whatever is unresolved, the blocker carries the units still missing.
    if(mode==='credits'||mode.startsWith('no-')) {
      assert.deepEqual(issued,['spacemolt/get_base'],mode);
      assert.deepEqual([f.server.ship.fuel,f.server.ship.hull],[110,90],mode);
    }
    // A short or unpaid-for refuel stops before any further spending.
    if(['station-short','unchanged','overcharge'].includes(mode))
      assert.deepEqual(issued,['spacemolt/get_base','spacemolt/refuel'],mode);
    if(mode==='hull-short') {
      assert.deepEqual(issued,['spacemolt/get_base','spacemolt/refuel','spacemolt/repair']);
      assert.equal(f.server.ship.fuel,120,'the fuel leg still completed');
    }
    if(mode==='no-repair-quote')assert.match((await run.catch(e=>e)).message,/shortfall 10 hull points/);
    if(mode==='no-fuel-quote')assert.match((await run.catch(e=>e)).message,/shortfall 10 fuel units/);
  }
});
