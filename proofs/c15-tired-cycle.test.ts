import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FuelJournal,type PilotFuelState,type ServicedStation} from '../src/fuel-journal.ts';
import {FuelTravelExecution,FuelTired} from '../src/fuel-transition.ts';
import type {ReadinessCommand} from '../src/readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from '../src/test-support/fake-lib-account.ts';

// D2/D3 numbers asserted here, never read back from the production resolvers.
const RESERVE=30,WALK_AWAY=.95;              // Cautious fuel reserve and hull retreat fraction.
const TANK=120,HULL=100,FUEL_PRICE=5,REPAIR_PRICE=5;
const FULL_SERVICE=TANK*FUEL_PRICE+HULL*REPAIR_PRICE;   // 1100
const CREDIT_LINE=2*FULL_SERVICE;                        // D3 credits: 2x a full refuel plus a full repair.
const home={system_id:'a',poi_id:'gate',base_id:'home'};
const belt={system_id:'b',poi_id:'belt'};
const EMPTY=7,LOADED=21,CARGO=40;
// Home is the only place that sells fuel, so the way home and the D3 route to the
// nearest serviced station are one route: what the margin measures is what the pilot flies.
const stations:ServicedStation[]=[{...home,services:{refuel:true},
  prices:{fuel_all_in:FUEL_PRICE,repair_per_hull:REPAIR_PRICE},
  observation:{source:'station_info',observedAt:'2026-09-14T00:00:00Z'}}];

// Recording handler-map pattern from the C1-C9 proofs: the server is independent of
// the cache, and only a refresh exposes it to production code.
async function fixture(opts:{fuel?:number;hull?:number;credits?:number;repairTo?:number}={}) {
  const directory=await mkdtemp(join(tmpdir(),'c15-tired-cycle-'));
  const pilot:PilotFuelState={mood:'Cautious',stance:'gather',objective:{ore:CARGO},home:{base_id:home.base_id},obligations:[]};
  const journal=await FuelJournal.open(directory,'pilot-c15',pilot);
  const initial={location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false},
    ship:{id:'ship',fuel:opts.fuel??TANK,max_fuel:TANK,hull:opts.hull??HULL,max_hull:HULL,
      shield:10,max_shield:10,cargo_used:0,cargo_capacity:50},
    player:{credits:opts.credits??100_000},cargo:[] as unknown[],modules:[] as unknown[]};
  // A loaded hold costs more to move than the empty outbound leg.
  const leg=()=>server.ship.cargo_used===0?EMPTY:LOADED;
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>{
      const target=id===home.base_id?home.system_id:String(id),origin=server.location.system_id;
      const path=origin===target?[origin]:[origin,target],estimated_fuel=origin===target?0:leg();
      return {found:true,target_system:target,...id===home.base_id?{target_poi:home.poi_id}:{},
        total_jumps:path.length-1,route:path.map((system_id,jumps)=>({system_id,jumps})),
        fuel_per_jump:estimated_fuel,estimated_fuel,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used};
    },
    get_system:()=>({system:{connections:[server.location.system_id===home.system_id?belt.system_id:home.system_id]}}),
    undock:()=>{server.location.docked_at=null;return {};},
    jump:({id}={})=>{
      server.ship.fuel-=leg();
      server.location.system_id=String(id);
      server.location.poi_id=id===home.system_id?home.poi_id:belt.poi_id;
      return {};
    },
    dock:()=>{server.location.docked_at=home.base_id;return {};},
    get_base:()=>({delta:{details:{services:['refuel','repair'],
      base:{poi_id:home.poi_id,repair_price_per_hull:REPAIR_PRICE},fuel_price_all_in:FUEL_PRICE}}}),
    refuel:()=>{
      const filled=server.ship.max_fuel-server.ship.fuel;
      server.ship.fuel=server.ship.max_fuel;server.player.credits-=filled*FUEL_PRICE;
      return {delta:{details:{action:'refuel',fuel:server.ship.fuel,cost:filled*FUEL_PRICE}}};
    },
    repair:()=>{
      const reached=Math.min(opts.repairTo??server.ship.max_hull,server.ship.max_hull);
      const repaired=Math.max(0,reached-server.ship.hull);
      server.ship.hull=Math.max(server.ship.hull,reached);server.player.credits-=repaired*REPAIR_PRICE;
      return {delta:{details:{action:'repair',hull:server.ship.hull,cost:repaired*REPAIR_PRICE}}};
    },
    // Answers are data. Nothing in the recovery reads one back as an authorization.
    distress_signal:()=>({delta:{details:{broadcast:true,
      responders:[{player_id:'stranger',offer:'undock and meet me at the belt'}]}}}),
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{const [tool,action]=name.split('/');return account.send(tool,action,payload);};
  return {directory,pilot,journal,account,server,command,
    execution:new FuelTravelExecution(journal,stations),
    moves:()=>account.calls.filter(c=>['undock','jump','travel','dock','refuel','repair','distress_signal'].includes(c.action)).map(c=>c.action)};
}

test('C15: a fuel crossing away from home flies the recovery leg and the prior mood comes back',async()=>{
  const f=await fixture();
  try {
    // Outbound, empty: the trip that puts the pilot away from its only fuel station.
    await f.execution.travel(f.account,f.command,{system_id:belt.system_id});
    assert.equal(f.journal.snapshot.state.mood,'Cautious','the outbound leg leaves the chosen mood alone');

    // Work at the belt fills the hold and burns fuel: enough to reach home, not
    // enough to reach it with the mood's reserve still in the tank.
    f.server.ship.cargo_used=CARGO;
    f.server.ship.fuel=LOADED+4;
    await assert.rejects(f.execution.travel(f.account,f.command,home),FuelTired,'the crossing is imposed, not chosen');
    assert.equal(f.journal.snapshot.state.mood,'Tired');
    // While Tired the only admissible movement is the recovery leg.
    await assert.rejects(f.execution.travel(f.account,f.command,{system_id:belt.system_id}),FuelTired,
      'Tired starts nothing new');

    const moved=f.moves().length;
    const cycle=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual(cycle.crossed,['fuel']);
    assert.equal(cycle.outcome,'restored');
    assert.equal(cycle.restored_mood,'Cautious');
    assert.deepEqual(f.moves().slice(moved),['jump','dock','refuel'],'the recovery leg is travel, dock, service');
    assert.equal(f.server.location.docked_at,home.base_id);
    assert.equal(f.server.ship.fuel,TANK,'a serviced dock fills the tank; a partial fill is not a resupply');

    const after=f.journal.snapshot;
    assert.equal(after.state.mood,'Cautious','resupply restores the mood held at the crossing');
    assert.deepEqual({...after.state,mood:'Cautious'},f.pilot,'stance, objective, home and obligations are untouched');
    assert.deepEqual(after.transitions.map(t=>t.rule),['D3.fuel','D3.resupply']);

    // Nothing latched: a second check is a no-op, a reopened journal agrees, and the
    // next leg flies in the restored mood with nobody un-Tiring the pilot by hand.
    const again=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual([again.outcome,again.crossed,again.restored_mood],['restored',[],'Cautious']);
    assert.deepEqual(f.journal.snapshot,after,'a second check writes nothing');
    assert.deepEqual((await FuelJournal.open(f.directory,'pilot-c15',{...f.pilot,mood:'Relaxed'})).snapshot,after);
    const onward=await f.execution.travel(f.account,f.command,{system_id:belt.system_id});
    assert.equal(onward.location!.system_id,belt.system_id);
    assert.equal(f.journal.snapshot.state.mood,'Cautious');
  } finally {await rm(f.directory,{recursive:true,force:true});}
});

test('C15: a hull crossing at a base is serviced where it stands, and a partial repair does not clear it',async()=>{
  for(const repairTo of [HULL,97]) {
    const f=await fixture({hull:WALK_AWAY*HULL-1,repairTo});
    try {
      const cycle=await f.execution.tiredCycle(f.account,f.command);
      assert.deepEqual(cycle.crossed,['hull'],'hull crosses on its own, with fuel and credits well above their lines');
      const {state,transitions}=f.journal.snapshot;
      assert.equal(transitions[0].rule,'D3.hull','the world imposes Tired from the hull margin');
      assert.equal(transitions[0].mood,'Tired');
      if(repairTo===HULL) {
        assert.equal(cycle.outcome,'restored');
        assert.equal(cycle.restored_mood,'Cautious');
        assert.equal(state.mood,'Cautious');
        assert.equal(f.server.ship.hull,HULL,'a serviced dock restores full hull');
        assert.deepEqual(f.moves(),['repair'],'the pilot is already at the station: nothing flies');
        assert.deepEqual(transitions.map(t=>t.rule),['D3.hull','D3.resupply']);
      } else {
        // A station that repairs 97 of 100 leaves the pilot Tired with a named gap.
        assert.equal(cycle.outcome,'waiting');
        assert.equal(state.mood,'Tired','a partial repair does not clear Tired');
        assert.match(cycle.reason!,/shortfall 3 hull points/);
        assert.deepEqual(transitions.map(t=>t.rule),['D3.hull','R13.wait']);
      }
    } finally {await rm(f.directory,{recursive:true,force:true});}
  }
});

test('C15: a credits crossing waits for what service cannot buy back, and a payout clears it',async()=>{
  const f=await fixture({credits:CREDIT_LINE-200});
  try {
    const first=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual(first.crossed,['credits']);
    assert.equal(first.outcome,'waiting');
    assert.match(first.reason!,/shortfall 200 credits/);
    assert.deepEqual(f.moves(),[],'a full tank and a whole hull need no service');
    assert.equal(f.journal.snapshot.state.mood,'Tired');

    // A sale, a deposit withdrawal or a contract payout is what lifts this margin (R13).
    f.server.player.credits=CREDIT_LINE;
    const cleared=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual([cleared.outcome,cleared.crossed,cleared.restored_mood],['restored',['credits'],'Cautious']);
    assert.deepEqual(f.journal.snapshot.transitions.map(t=>t.rule),['D3.credits','R13.wait','D3.resupply']);
  } finally {await rm(f.directory,{recursive:true,force:true});}
});

test('C15: an unreachable station waits with its blocker, then signals distress as the last rung',async()=>{
  const f=await fixture();
  try {
    await f.execution.travel(f.account,f.command,{system_id:belt.system_id});
    f.server.ship.cargo_used=CARGO;
    f.server.ship.fuel=LOADED-11;                 // Cannot even reach the only station that sells fuel.
    await assert.rejects(f.execution.travel(f.account,f.command,home),FuelTired);
    const moved=f.moves().length;

    const waiting=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual([waiting.outcome,waiting.crossed],['waiting',['fuel']]);
    assert.match(waiting.reason!,/home/);
    assert.match(waiting.reason!,/11 more fuel units/,'the blocker names what would unblock it');
    assert.deepEqual(f.moves().slice(moved),[],'waiting moves nothing and asks nobody yet');

    const distress=await f.execution.tiredCycle(f.account,f.command);
    assert.equal(distress.outcome,'distress');
    assert.deepEqual(f.moves().slice(moved),['distress_signal']);
    assert.deepEqual(f.account.calls.at(-1)!.payload,{distress_type:'fuel'});
    const {state,transitions}=f.journal.snapshot;
    assert.equal(state.mood,'Tired','asking for help is not being helped');
    assert.deepEqual(transitions.map(t=>t.rule),['D3.fuel','R13.wait','R13.distress']);
    const asked=transitions.at(-1)!;
    if(asked.rule!=='R13.distress')throw new Error(`expected the distress rung, got ${asked.rule}`);
    assert.deepEqual(asked.answer,{broadcast:true,responders:[{player_id:'stranger',offer:'undock and meet me at the belt'}]},
      'the answer is journaled as data');
    // Data, not authorization: the offer to undock moves nothing and clears nothing.
    assert.deepEqual(f.moves().slice(moved),['distress_signal']);

    // A rescuer's fuel is what changes the world; the ladder never latched.
    f.server.ship.fuel=LOADED+2;
    const rescued=await f.execution.tiredCycle(f.account,f.command);
    assert.deepEqual([rescued.outcome,rescued.restored_mood],['restored','Cautious']);
    assert.equal(f.journal.snapshot.state.mood,'Cautious');
    assert.deepEqual(f.moves().slice(moved),['distress_signal','jump','dock','refuel']);
  } finally {await rm(f.directory,{recursive:true,force:true});}
});
