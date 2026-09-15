import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {FuelJournal,type PilotFuelState,type ServicedStation} from './fuel-journal.ts';
import {FuelTravelExecution,FuelTired,FuelMarginUnresolved} from './fuel-transition.ts';
import {FuelRouteShortfall,TravelBlocked} from './travel.ts';
import type {ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

const initial:PilotFuelState={mood:'Focused',stance:'industry',objective:{deliver:4},home:{base_id:'home'},obligations:[{passengers:2}]};
const stations:ServicedStation[]=['z','a','far'].map(base_id=>({base_id,poi_id:`${base_id}-poi`,system_id:'a',
  services:{refuel:true},observation:{source:'station_info',observedAt:'2026-09-14T00:00:00Z'}}));
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'fuel-transition-'));
  const journal=await FuelJournal.open(directory,'pilot',initial);
  let stationCost=20,destinationCost=20,loss=0,moveError:Error|undefined,invalid=false;
  const state={location:{system_id:'a',poi_id:'gate',docked_at:'home' as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const account:FakeLibGoalAccount<typeof state>=new FakeLibGoalAccount(state, {spacemolt:{
    find_route:({id}={})=>{
      const station=stations.find(s=>s.base_id===id),target=station?.system_id??String(id),origin=server.location.system_id;
      const path=origin===target?[origin]:origin==='c'&&target==='a'?['c','b','a']:origin==='a'&&target==='c'?['a','b','c']:[origin,target];
      const result={found:true,target_system:target,...(station?{target_poi:station.poi_id}:{}),total_jumps:path.length-1,
        route:path.map((system_id,jumps)=>({system_id,jumps})),fuel_per_jump:10,
        estimated_fuel:(station?stationCost+(station.base_id==='far'?5:0):destinationCost)*(origin==='b'?0.5:1),
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used};
      if(station&&invalid)server.ship.cargo_used++;
      return result;
    },
    undock:()=>{server.location.docked_at=null;return {};},
    get_system:()=>({system:{connections:['a','b','c']}}),
    jump:({id}={})=>{
      if(moveError)throw moveError;
      server.location.system_id=String(id);server.ship.fuel-=10+loss;return {};
    },
  }});
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{const [tool,action]=name.split('/');return account.send(tool,action,payload);};
  return {directory,journal,account,server,command,execution:new FuelTravelExecution(journal,stations),
    configure:(config:{stationCost?:number;destinationCost?:number;loss?:number;error?:Error;invalid?:boolean})=>{
      stationCost=config.stationCost??20;destinationCost=config.destinationCost??20;loss=config.loss??0;moveError=config.error;invalid=config.invalid??false;
    }};
}
const policy={fuelReserveFloor:30.5};
const movements=(f:Awaited<ReturnType<typeof fixture>>)=>f.account.calls.filter(c=>['jump','travel','undock','dock'].includes(c.action));

test('fuel crossings persist Tired before movement across departure and loaded return checkpoints',async()=>{
  for(const stage of ['initial','hook','undock','return','affordable-destination']) {
    const f=await fixture();
    try {
      if(stage==='return') {
        await f.execution.travel(f.account,f.command,{system_id:'c'},{operatorPolicy:policy});
        f.server.ship.cargo_used=40;f.server.ship.fuel=50.5;
        f.configure({loss:0.25});
      } else {
        f.server.ship.fuel=stage==='initial'||stage==='affordable-destination'?50.25:50.5;
        if(stage==='affordable-destination')f.configure({destinationCost:1});
      }
      const priorMoves=movements(f).length;
      let hook=false;
      const command:ReadinessCommand=async(name,payload)=>{
        const result=await f.command(name,payload);
        if(stage==='undock'&&name==='spacemolt/undock')f.server.ship.fuel-=0.25;
        return result;
      };
      await assert.rejects(f.execution.travel(f.account,command,{system_id:stage==='return'?'a':'c'}, {
        operatorPolicy:policy,beforeMove:async()=>{if(stage==='hook'&&!hook){hook=true;f.server.ship.fuel-=0.25;}},
      }),error=>{assert.ok(error instanceof FuelTired,`${stage}: ${String(error)}`);return true;});
      const saved=f.journal.snapshot,entry=saved.transitions[0];
      assert.deepEqual(saved.state,{...initial,mood:'Tired'});
      assert.equal(entry.priorMood,initial.mood);assert.equal(entry.rule,'D3.fuel');
      assert.match(entry.reason,/shortfall 0.25 fuel units/);
      assert.equal(entry.evidence.shortfall,0.25);assert.equal(entry.evidence.effectiveReserve,30.5);
      assert.equal(entry.station.base_id,'a','lowest fuel cost, then station ID');
      assert.deepEqual(entry.evidence.observed,{ship:f.server.ship,location:f.server.location});
      assert.equal(entry.evidence.quotedCost,stage==='return'?10:20);
      assert.equal(entry.evidence.actualFuel,stage==='return'?40.25:50.25);
      assert.equal(movements(f).length-priorMoves,stage==='return'||stage==='undock'?1:0);
      assert.equal((await stat(f.journal.path)).mode&0o777,0o600);
      const reopened=await FuelJournal.open(f.directory,'pilot',{...initial,mood:'Aggressive'});
      assert.deepEqual(reopened.snapshot,saved);
      const count=f.account.calls.length;
      await assert.rejects(new FuelTravelExecution(reopened,stations).travel(f.account,command,{system_id:'a'}),FuelTired);
      await reopened.record(entry);
      assert.equal(f.account.calls.length,count);assert.deepEqual(reopened.snapshot,saved);
      assert.deepEqual(JSON.parse(await readFile(f.journal.path,'utf8')),saved);
    } finally {await rm(f.directory,{recursive:true,force:true});}
  }
});

test('non-crossings and unresolved evidence preserve mood; failed persistence blocks movement',async()=>{
  const pending=new SpacemoltError('in_transit','pending');Object.assign(pending,{pendingCommand:{}});
  for(const scenario of ['boundary','destination-only','capacity','missing-service','missing-quote','invalidated','departure-invalidated','pending','transport','persistence']) {
    const f=await fixture();
    try {
      let execution=f.execution,expected:(new (...args:any[])=>Error)|Error=TravelBlocked;
      f.server.ship.fuel=50.5;
      if(scenario==='destination-only'){f.server.ship.fuel=40;f.configure({stationCost:5});expected=FuelRouteShortfall;}
      if(scenario==='capacity'){f.server.ship.max_fuel=50;expected=FuelRouteShortfall;}
      if(scenario==='missing-service'){execution=new FuelTravelExecution(f.journal,stations.map(s=>({...s,services:{refuel:false}})));expected=FuelMarginUnresolved;}
      if(scenario==='invalidated'){f.configure({invalid:true});expected=FuelMarginUnresolved;}
      if(scenario==='missing-quote')expected=FuelMarginUnresolved;
      if(scenario==='pending'||scenario==='transport'){expected=scenario==='pending'?pending:new ConnectionClosedError('lost');f.configure({error:expected});}
      if(scenario==='persistence') {
        f.server.ship.fuel=50.25;
        await rm(f.journal.path);await mkdir(f.journal.path);
      }
      const command:ReadinessCommand=async(name,payload)=>{
        const result=await f.command(name,payload);
        if(scenario==='missing-quote'&&stations.some(s=>s.base_id===payload.id))delete (result as any).target_poi;
        return result;
      };
      const run=execution.travel(f.account,command,{system_id:'c'},{operatorPolicy:policy,beforeMove:async()=>{
        if(scenario==='departure-invalidated'){f.server.ship.cargo_used++;f.server.ship.fuel-=0.25;}
      }});
      if(scenario==='boundary') {
        const result=await run;assert.equal(result.location!.system_id,'c');assert.equal(f.server.ship.fuel,30.5);
      } else await assert.rejects(run,error=>{
        assert.ok(!(error instanceof FuelTired),scenario);
        if(expected instanceof Error)assert.equal(error,expected);
        else if(scenario==='persistence')assert.match(String(error),/persistence unresolved/);
        else assert.ok(error instanceof expected,`${scenario}: ${String(error)}`);
        if(scenario==='missing-service')assert.match(String(error),/no observed service-qualified station/);
        if(scenario==='missing-quote')assert.match(String(error),/matching POI, fuel or cargo/);
        return true;
      });
      assert.deepEqual(f.journal.snapshot.state,initial);assert.deepEqual(f.journal.snapshot.transitions,[]);
      if(scenario==='persistence') {
        const count=f.account.calls.length;f.server.ship.fuel=100;
        await assert.rejects(execution.travel(f.account,command,{system_id:'c'}),/persistence unresolved/);
        assert.equal(f.account.calls.length,count,'failed persistence keeps this owner stopped even after fuel recovers');
      }
      if(!['boundary','pending','transport'].includes(scenario))assert.equal(movements(f).length,0,scenario);
      if(scenario!=='persistence')assert.deepEqual((await FuelJournal.open(f.directory,'pilot',initial)).snapshot,f.journal.snapshot);
    } finally {await rm(f.directory,{recursive:true,force:true});}
  }
});
