import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Pilot,type ServeOptions} from './bridge.ts';
import {controllerLock} from './controller-lock.ts';
import type {ChainOutcome} from './chain.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

// The station POI and the base docked at it carry different ids, as the live game does.
const system={id:'sol',name:'Sol',pois:[
  {id:'station',name:'Sol Station',type:'station',position:{x:0,y:0},has_base:true,
    base_id:'sol_base',base_name:'Sol Base'},
  {id:'belt',name:'Inner Belt',type:'asteroid_belt',position:{x:1,y:1}},
]};

function fixture(options:ServeOptions={}) {
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base' as string|null,in_transit:false},
    // The hold leaves the dock already full, so a gather job mines nothing and still
    // has to come home, settle and service before it may call itself done.
    // Hull stays above the Cautious D3 line: a ship below it is Tired and starts no job.
    ship:{id:'ship',fuel:100,max_fuel:120,hull:96,max_hull:100,cargo_used:12,cargo_capacity:12},
    player:{credits:1_000},
    cargo:[{item_id:'ore',quantity:12}] as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
  });
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system}}),
    'spacemolt/find_route':()=>({found:true,target_system:'sol',total_jumps:0,estimated_fuel:7,fuel_per_jump:0,
      fuel_available:account.server.ship.fuel,cargo_used:account.server.ship.cargo_used,route:[{system_id:'sol',jumps:0}]}),
    'spacemolt/undock':()=>{account.server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{account.server.location.docked_at='sol_base';return {};},
    // The server settles the move before the next authoritative read, as a same-system hop does.
    'spacemolt/travel':params=>{account.server.ship.fuel-=7;account.server.location.poi_id=String(params.id);return {};},
    'spacemolt_market/view_market':()=>({delta:{details:{items:[{item_id:'ore',buy_price:10}]}}}),
    'spacemolt/sell':params=>{
      const quantity=Number(params.quantity);
      account.server.cargo=account.server.cargo.filter(row=>row.item_id!==params.id);
      account.server.ship.cargo_used-=quantity;
      account.server.player.credits+=quantity*10;
      return {delta:{details:{action:'sell',quantity_sold:quantity}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],fuel_price_all_in:1,
      base:{poi_id:'station',repair_price_per_hull:1}}}}),
    'spacemolt/refuel':()=>{
      const cost=account.server.ship.max_fuel-account.server.ship.fuel;
      account.server.ship.fuel=account.server.ship.max_fuel;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'refuel',cost}}};
    },
    'spacemolt/repair':()=>{
      const cost=account.server.ship.max_hull-account.server.ship.hull;
      account.server.ship.hull=account.server.ship.max_hull;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'repair',cost}}};
    },
    'spacemolt_storage/view':()=>({structuredContent:{action:'view_storage',base_id:'sol_base',
      hint:'',items:[{item_id:'ore',name:'Ore',quantity:340},{item_id:'scrap',quantity:2}],
      ships:[{ship_id:'spare',class_id:'hauler',cargo_used:0,modules:0}],
      locations:[{base_id:'sol_base',base_name:'Sol Base',item_count:2,ship_count:1,
        system:'sol',system_name:'Sol'}]}}),
  };
  const command:ReadinessCommand=async(action,params)=>{
    sent.push({action,params:structuredClone(params)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]!(params);
  };
  return {account,sent,dispatch:serve(account as unknown as ReadinessAccount,command,options)};
}

test('where reports the live position and the destinations the model may name', async () => {
  const f=fixture();
  const observed=await f.dispatch('where') as any;
  assert.equal(f.account.refreshes.length,1,'position must come from an authoritative read');
  assert.deepEqual(observed.system,{id:'sol',name:'Sol'});
  assert.deepEqual(observed.poi,{id:'station',name:'Sol Station'});
  // A base id is not a POI id: the model is told which base it is docked at, by name.
  assert.deepEqual(observed.docked_at,{base_id:'sol_base',name:'Sol Base'});
  assert.equal(observed.in_transit,false);
  assert.deepEqual(observed.fuel,100);
  assert.deepEqual(observed.pois,[{id:'station',name:'Sol Station',type:'station'},
    {id:'belt',name:'Inner Belt',type:'asteroid_belt'}]);
  // Every listed destination is nameable and nothing heavier rides along.
  assert.ok(JSON.stringify(observed).length<2048);
  for(const poi of observed.pois)assert.deepEqual(Object.keys(poi),['id','name','type']);
});

test('travel undocks, flies to the named poi, and reports the arrival a live read confirms', async () => {
  const f=fixture();
  const result=await f.dispatch('travel',{poi_id:'belt'}) as any;
  assert.equal(result.arrived,true);
  assert.deepEqual(result.location,{system:'sol',poi:'belt',docked_at:null});
  assert.equal(result.fuel,93);
  assert.equal(typeof result.elapsed_s,'number');
  assert.deepEqual(f.sent.map(call=>call.action),
    ['spacemolt/find_route','spacemolt/undock','spacemolt/travel']);
  assert.deepEqual(f.sent.at(-1)!.params,{id:'belt'});
  assert.equal(f.account.server.location.poi_id,'belt');
  // A destination the model never named must not become a flight.
  await assert.rejects(fixture().dispatch('travel',{}),/poi_id/);
});

test('dock reports the dock the pilot already has and otherwise docks once, live read deciding', async () => {
  const f=fixture();
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:true});
  assert.equal(f.sent.length,0,'a dock the pilot already has is never re-sent');
  f.account.server.location.docked_at=null; // the pilot left the station
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.deepEqual(f.sent.map(call=>call.action),['spacemolt/dock']);
  // A dock somewhere else is reported, never overwritten.
  const elsewhere=fixture();
  elsewhere.account.server.location.docked_at='other_base';
  const refused=await elsewhere.dispatch('dock',{base_id:'sol_base'}) as any;
  assert.equal(refused.docked,false);
  assert.match(refused.reason,/other_base/);
  assert.equal(elsewhere.sent.length,0);
});

test('gather runs one job from the dock the ship is at and reports a verified outcome', async () => {
  const f=fixture();
  const result=await f.dispatch('gather',{poi_id:'belt'}) as any;
  assert.equal(result.outcome,'done',result.reason);
  // Dock to dock: out to the belt, home to the station POI, dock at the base behind it.
  assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt/travel').map(call=>call.params),
    [{id:'belt'},{id:'station'}]);
  assert.deepEqual(f.account.server.location,
    {system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false});
  assert.deepEqual(result.steps.map((step:any)=>step.name),
    ['travel','mine','return','dock','settle','service','verify']);
  // The hold the pilot undocked with is its own: the counter never sees it, so a job that
  // mined nothing sells nothing and still comes home serviced (C8).
  assert.deepEqual(result.sold,[]);
  assert.deepEqual(f.account.server.cargo,[{item_id:'ore',quantity:12}]);
  assert.deepEqual([f.account.server.ship.fuel,f.account.server.ship.hull],[120,100]);
  assert.equal(f.account.server.player.credits,1_000-34-4);
  assert.ok(JSON.stringify(result).length<2048,'one compact outcome, not a transcript');
  // A destination the model never named must not become a trip.
  await assert.rejects(fixture().dispatch('gather',{}),/poi_id/);
});

test('storage reads the current base by default and passes a named station through, compact', async () => {
  const f=fixture();
  const here=await f.dispatch('storage') as any;
  assert.deepEqual(f.sent.at(-1),{action:'spacemolt_storage/view',params:{}});
  assert.deepEqual(here,{base_id:'sol_base',base_name:'Sol Base',
    items:[{item_id:'ore',name:'Ore',quantity:340},{item_id:'scrap',quantity:2}],
    ships:1,locations:[{base_id:'sol_base',base_name:'Sol Base',system_name:'Sol',
      item_count:2,ship_count:1}]});
  assert.ok(JSON.stringify(here).length<2048);
  await f.dispatch('storage',{station_id:'other_base'});
  assert.deepEqual(f.sent.at(-1),{action:'spacemolt_storage/view',params:{station_id:'other_base'}});
});

const PILOT:Pilot={name:'kvothe',objective:'fill the hold',stance:'Prospector',mood:'Focused',home:'sol_base'};

/** A chain that starts and does not finish, so a juncture can be observed mid-flight. */
function heldChain() {
  const started:any[]=[];
  let release:((outcome:ChainOutcome)=>void)|undefined;
  const runChain=((_account:unknown,_command:unknown,chain:any,options:any)=>{
    started.push(chain);
    options?.onProgress?.({kind:chain.kind,jobs:chain.jobs,
      length:chain.length??chain.jobs.length,position:0,ended:false});
    return new Promise<ChainOutcome>(resolve=>{release=resolve;});
  }) as any;
  return {runChain,started,finish:(outcome:ChainOutcome)=>release!(outcome)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('menu assembles the present from live state and answers with the rules table', async () => {
  const f=fixture({pilot:()=>PILOT});
  const menu=await f.dispatch('menu') as any;
  assert.equal(f.account.refreshes.length>0,true,'the present must come from an authoritative read');
  assert.equal(menu.stance,'Prospector');
  assert.equal(menu.objective,'fill the hold');
  assert.deepEqual([menu.present.docked_at,menu.present.fuel,menu.present.cargo_free],['sol_base',100,0]);
  const offered=menu.options.map((option:any)=>option.job);
  // The station's own counter, the way home to a serviced ship, and the one quoted site.
  assert.ok(offered.includes('Counter: Services'),offered.join(' | '));
  assert.ok(offered.includes('J12 Home, serviced'));
  assert.ok(offered.includes('Travel to belt'),'the route quote for this system governs its POIs');
  for(const option of menu.options)assert.ok(option.reason&&option.bounds.fuelReserve>0);
  // A full hold is why the stance's own job is refused, and the menu says so.
  const refused=menu.unavailable.find((row:any)=>row.job.startsWith('J1 '));
  assert.match(refused.reason,/hold is full/);
  assert.equal(menu.last,null,'nothing has run yet');
  assert.ok(JSON.stringify(menu).length<4096,'one consultation, not a transcript');
  // A pilot with no stance and no mood has no menu at all.
  await assert.rejects(fixture().dispatch('menu'),/mood/);
});

test('job starts one chain in the runner and returns before it ends; status carries it', async () => {
  const held=heldChain();
  const f=fixture({pilot:()=>PILOT,runChain:held.runChain});
  assert.deepEqual(await f.dispatch('status'),{running:false,last:null});

  const started=await f.dispatch('job',{job:'gather',poi_id:'belt',repeat:3}) as any;
  assert.equal(started.accepted,true);
  assert.deepEqual(started.record,{kind:'loop',length:3,position:0,ended:false});
  // The plan came from live state and the pilot's own mood, not from the model. `keep` is
  // the hold the pilot already had, written down so a job resumed after a restart — which
  // never saw the departure — still knows which cargo is the pilot's own and not its take.
  assert.deepEqual(held.started[0].jobs[0].params,
    {home:{system_id:'sol',poi_id:'station',base_id:'sol_base'},site:{system_id:'sol',poi_id:'belt'},
      mood:'Focused',keep:['ore']});
  assert.deepEqual(await f.dispatch('status'),{running:true,chain_id:started.chain_id,record:started.record});

  // A second juncture while the chain runs changes nothing and is told why.
  const refused=await f.dispatch('job',{job:'gather',poi_id:'belt'}) as any;
  assert.equal(refused.accepted,false);
  assert.equal(refused.chain_id,started.chain_id);
  assert.equal(held.started.length,1,'a running chain is never joined by a second');
  const busy=await f.dispatch('menu') as any;
  assert.equal(busy.busy,true);
  assert.equal(busy.options,undefined,'a busy pilot is offered nothing to choose');

  held.finish({outcome:'done',jobs:[],juncture:{reason:'chain done: 3 of 3 jobs'}});
  await settle();
  const after=await f.dispatch('status') as any;
  assert.equal(after.running,false);
  assert.deepEqual(after.last.juncture,{reason:'chain done: 3 of 3 jobs'});
  // The runner is free again, and the next juncture reads the outcome from `last`.
  assert.equal(((await f.dispatch('menu')) as any).last.chain_id,started.chain_id);
});

test('the controller lock is taken over from a dead holder and refused to a live one', () => {
  const path=join(mkdtempSync(join(tmpdir(),'spacemolt-lock-')),'controller.lock');
  // A SIGKILLed bridge never ran its unlock; its pid is gone, so the next bridge may run.
  const reaped=spawnSync(process.execPath,['-e','']).pid!;
  writeFileSync(path,JSON.stringify({pid:reaped,started_at:'2026-01-01T00:00:00.000Z'}));
  const unlock=controllerLock(path);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).pid,process.pid,'the live controller owns the lock');
  // A lock whose holder is alive is never stolen: an operator inspects the pilot first.
  assert.throws(()=>controllerLock(path),/EEXIST/);
  unlock();
  assert.equal(existsSync(path),false);
  unlock(); // the exit handler may run after an explicit release
});
