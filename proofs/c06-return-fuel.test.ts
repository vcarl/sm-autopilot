import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FuelJournal,type PilotFuelState,type ServicedStation} from '../src/fuel-journal.ts';
import {FuelTravelExecution,FuelTired} from '../src/fuel-transition.ts';
import type {ReadinessCommand} from '../src/readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from '../src/test-support/fake-lib-account.ts';

// D2 fuel reserves asserted here, never read back from the production resolver.
const reserves={Cautious:30,Aggressive:12} as const;
const home={system_id:'a',poi_id:'gate',base_id:'home'};
const belt={system_id:'b',poi_id:'belt'};
// Home is the only place that sells fuel, so the return leg and the route to the
// nearest serviced station are the same route: what D3 measures and what the pilot flies.
const stations:ServicedStation[]=[{...home,services:{refuel:true},
  observation:{source:'station_info',observedAt:'2026-09-14T00:00:00Z'}}];
const EMPTY=7,LOADED=21,CARGO=40,TANK=120;

// Recording handler-map pattern from the C1-C5 proofs: the server is independent of
// the cache, and only a refresh exposes it to production code.
async function fixture(mood:keyof typeof reserves) {
  const directory=await mkdtemp(join(tmpdir(),'c06-return-fuel-'));
  const pilot:PilotFuelState={mood,stance:'gather',objective:{ore:CARGO},home:{base_id:home.base_id},obligations:[]};
  const journal=await FuelJournal.open(directory,'pilot-c06',pilot);
  const initial={location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:TANK,cargo_used:0}};
  // A loaded hold costs more to move than the empty outbound leg.
  const leg=()=>server.ship.cargo_used===0?EMPTY:LOADED;
  const quotes:{target:unknown;origin:string;fuel:number;cargo:number;cost:number}[]=[];
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>{
      const target=id===home.base_id?home.system_id:String(id),origin=server.location.system_id;
      const path=origin===target?[origin]:[origin,target],estimated_fuel=origin===target?0:leg();
      quotes.push({target:id,origin,fuel:server.ship.fuel,cargo:server.ship.cargo_used,cost:estimated_fuel});
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
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{const [tool,action]=name.split('/');return account.send(tool,action,payload);};
  return {directory,pilot,journal,account,server,command,quotes,
    execution:new FuelTravelExecution(journal,stations),
    moves:()=>account.calls.filter(c=>['undock','jump','travel','dock'].includes(c.action)).map(c=>c.action)};
}

test('C6: the return leg is re-checked against actual fuel and position, and a shortfall imposes Tired',async()=>{
  for(const mood of ['Cautious','Aggressive'] as const)for(const deficit of [0,1]) {
    const f=await fixture(mood);
    try {
      const reserve=reserves[mood];
      // Outbound, empty: the trip that puts the pilot away from its only fuel station.
      await f.execution.travel(f.account,f.command,{system_id:belt.system_id});
      assert.deepEqual(f.server.location,{system_id:belt.system_id,poi_id:belt.poi_id,docked_at:null,in_transit:false});
      assert.equal(f.server.ship.fuel,100-EMPTY);
      assert.equal(f.journal.snapshot.state.mood,mood,'the outbound leg leaves the chosen mood alone');

      // Work at the belt fills the hold and burns fuel on the server only. The cached
      // ship stays empty and rich enough to authorize the trip it can no longer afford.
      const required=LOADED+reserve;
      f.server.ship.cargo_used=CARGO;
      f.server.ship.fuel=required-deficit;
      assert.ok(f.account.state.ship!.fuel>required&&f.account.state.ship!.cargo_used===0,'stale cache would permit the return');
      const moved=f.moves().length,quoted=f.quotes.length;

      const trip=f.execution.travel(f.account,f.command,home);
      if(deficit) {
        await assert.rejects(trip,error=>{
          assert.ok(error instanceof FuelTired,String(error));
          assert.equal(error.message,
            `Tired recorded: fuel_below_route_minimum: have ${required-deficit}, need ${required}; shortfall ${deficit} fuel units`);
          return true;
        });
        assert.deepEqual(f.moves().slice(moved),[],'a shortfall departs nothing');
        assert.equal(f.server.ship.fuel,required-deficit);
        assert.deepEqual(f.server.location,{system_id:belt.system_id,poi_id:belt.poi_id,docked_at:null,in_transit:false});
        const {state,transitions}=f.journal.snapshot;
        assert.equal(state.mood,'Tired','the world imposes Tired; nobody chose it');
        assert.deepEqual({...state,mood},f.pilot,'stance, objective, home and obligations are untouched');
        assert.equal(transitions.length,1);
        const crossing=transitions[0];
        if(crossing.rule!=='D3.fuel')throw new Error(`expected a D3.fuel crossing, got ${crossing.rule}`);
        assert.equal(crossing.priorMood,mood,'the chosen mood is retained for restoration');
        assert.equal(crossing.evidence.shortfall,deficit);
        assert.equal(crossing.evidence.effectiveReserve,reserve);
        assert.equal(crossing.station.base_id,home.base_id);
        // Reopening loses neither the imposition nor the mood waiting to be restored.
        const reopened=await FuelJournal.open(f.directory,'pilot-c06',{...f.pilot,mood:'Relaxed'});
        assert.deepEqual(reopened.snapshot,f.journal.snapshot);
      } else {
        const result=await trip;
        assert.equal(result.location!.docked_at,home.base_id);
        assert.deepEqual(result.location,f.server.location);
        assert.deepEqual(f.moves().slice(moved),['jump','dock']);
        assert.equal(f.server.ship.fuel,reserve,'an affordable return lands with exactly the mood reserve');
        assert.equal(f.journal.snapshot.state.mood,mood,'an affordable return stays in the chosen mood');
        assert.deepEqual(f.journal.snapshot.transitions,[]);
      }
      // Both the leg and the D3 margin were quoted from the belt, with the loaded
      // hold and the live fuel, not from the outbound quote or the cache.
      assert.deepEqual(f.quotes.slice(quoted,quoted+2),[
        {target:home.system_id,origin:belt.system_id,fuel:required-deficit,cargo:CARGO,cost:LOADED},
        {target:home.base_id,origin:belt.system_id,fuel:required-deficit,cargo:CARGO,cost:LOADED},
      ]);
    } finally {await rm(f.directory,{recursive:true,force:true});}
  }
});

test('C6: resupply restores the chosen mood from a live read, with nothing latched',async()=>{
  for(const mood of ['Cautious','Aggressive'] as const)for(const place of ['belt','home'] as const) {
    const f=await fixture(mood);
    try {
      const reserve=reserves[mood];
      const onward=place==='belt'?home:{system_id:belt.system_id};
      if(place==='belt') {
        await f.execution.travel(f.account,f.command,{system_id:belt.system_id});
        f.server.ship.cargo_used=CARGO;
        f.server.ship.fuel=LOADED+reserve-1;
      } else f.server.ship.fuel=reserve-1;
      await assert.rejects(f.execution.travel(f.account,f.command,onward),FuelTired);
      assert.equal(f.journal.snapshot.state.mood,'Tired');

      // D3's line: a full tank at a serviced dock, route-to-station plus the mood's
      // reserve away from one. A partial fill is not a resupply.
      const line=place==='belt'?LOADED+reserve:TANK;
      const moved=f.moves().length;
      f.server.ship.fuel=line-0.5;
      await assert.rejects(f.execution.resupply(f.account,f.command),error=>{
        assert.ok(error instanceof FuelTired,String(error));
        assert.match(error.message,/shortfall 0\.5 fuel units/);
        return true;
      });
      assert.equal(f.journal.snapshot.state.mood,'Tired','a partial fill does not clear Tired');

      f.server.ship.fuel=line;
      assert.equal(await f.execution.resupply(f.account,f.command),mood);
      const {state,transitions}=f.journal.snapshot;
      assert.equal(state.mood,mood,'resupply restores the mood held before the crossing');
      assert.deepEqual({...state,mood},f.pilot,'the stance is untouched throughout');
      assert.equal(transitions.at(-1)!.rule,'D3.resupply');
      assert.equal(transitions.at(-1)!.priorMood,'Tired');
      assert.deepEqual(f.moves().slice(moved),[],'clearing Tired moves nothing');

      // Nothing latched: a second call is a no-op, a reopened journal reads the mood
      // back, and the pilot flies again in it with nobody un-Tiring it by hand.
      assert.equal(await f.execution.resupply(f.account,f.command),mood);
      assert.deepEqual((await FuelJournal.open(f.directory,'pilot-c06',{...f.pilot,mood:'Relaxed'})).snapshot,f.journal.snapshot);
      const result=await f.execution.travel(f.account,f.command,onward);
      assert.equal(result.location!.system_id,onward.system_id);
      assert.deepEqual(result.location,f.server.location);
      assert.equal(f.journal.snapshot.state.mood,mood);
      assert.equal(f.server.ship.fuel,place==='belt'?reserve:TANK-EMPTY);
    } finally {await rm(f.directory,{recursive:true,force:true});}
  }
});
