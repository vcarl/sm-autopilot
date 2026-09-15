import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Dispatch,type Pilot} from '../src/bridge.ts';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';

// The C9/C20 fixture, driven through the bridge instead of the runner directly, because a
// restart is a bridge fact: a second `serve()` over the SAME runtime directory and the same
// server is the only honest way to stage one. Every mine reply still over-claims (99 ore),
// so every number below can only have come from an authoritative read.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const TANK=120,CAPACITY=14,FUEL_PRICE=5,HULL_PRICE=5;
const CYCLES_PER_JOB=4,STOWED_PER_JOB=[{item_id:'carbon',quantity:4},{item_id:'ore',quantity:8}];
const MUTATIONS=new Set(['spacemolt/undock','spacemolt/dock','spacemolt/travel','spacemolt/mine',
  'spacemolt/sell','spacemolt_storage/deposit','spacemolt/refuel','spacemolt/repair']);
const PILOT:Pilot={name:'kvothe',objective:'fill the store',stance:'Prospector',mood:'Cautious',
  home:home.base_id};
/** Two trips' worth of ore asked of the store: the script decides it needs two gathers. */
const TWO_TRIPS={poi_id:'belt',item_id:'ore',quantity:2*8,max_runs:4,base_id:home.base_id};

/** One world, many bridges. Each `bridge()` is a fresh runner process over the same game
 * and the same runtime directory: what one leaves on disk is all the next one knows. */
async function world() {
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,
      in_transit:false},
    ship:{id:'ship',fuel:TANK,max_fuel:TANK,hull:96,max_hull:100,shield:5,max_shield:5,
      cargo_used:2,cargo_capacity:CAPACITY,incapacitated:false},
    player:{credits:1_000},
    cargo:[{item_id:'cabin_economy',quantity:2}] as {item_id:string;quantity:number}[],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}],
    storage:[] as {item_id:string;quantity:number}[],
  };
  const system={id:home.system_id,name:'Sol',connections:[],pois:[
    {id:home.poi_id,name:'Sol Station',type:'station',base_id:home.base_id,base_name:'Sol Base'},
    {id:'belt',name:'Inner Belt',type:'asteroid_belt'},
  ]};
  const add=(item:string,quantity:number)=>{
    const row=server.cargo.find(current=>current.item_id===item);
    if(row)row.quantity+=quantity;else server.cargo.push({item_id:item,quantity});
    server.ship.cargo_used=Math.min(server.ship.cargo_capacity,server.ship.cargo_used+quantity);
  };
  const take=(item:string,quantity:number)=>{
    const row=server.cargo.find(current=>current.item_id===item);
    const moved=Math.min(row?.quantity??0,quantity);
    if(row) {
      row.quantity-=moved;
      if(!row.quantity)server.cargo=server.cargo.filter(current=>current!==row);
    }
    server.ship.cargo_used-=moved;
    return moved;
  };
  const leg=()=>server.ship.cargo_used>2?21:7;
  const handlers:Record<string,(params:any)=>unknown>={
    'spacemolt/find_route':({id})=>{
      const toBase=id===home.base_id;
      const cost=toBase&&server.location.docked_at===home.base_id?0:leg();
      return {found:true,target_system:home.system_id,total_jumps:0,route:[{system_id:home.system_id,jumps:0}],
        estimated_fuel:cost,fuel_per_jump:0,fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        ...toBase?{target_poi:home.poi_id}:{}};
    },
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system}}),
    'spacemolt/undock':()=>{server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{server.location.docked_at=home.base_id;return {};},
    'spacemolt/travel':({id})=>{server.ship.fuel-=leg();server.location.poi_id=String(id);return {};},
    'spacemolt/mine':()=>{
      add('ore',2);add('carbon',1);
      return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99}}};
    },
    'spacemolt_storage/view':()=>({delta:{details:{items:structuredClone(server.storage)}}}),
    'spacemolt_storage/deposit':({item_id,quantity})=>{
      const moved=take(String(item_id),Number(quantity));
      const row=server.storage.find(current=>current.item_id===String(item_id));
      if(row)row.quantity+=moved;else server.storage.push({item_id:String(item_id),quantity:moved});
      return {delta:{details:{action:'deposit_items',item_id,quantity:99,storage_total:99}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],
      base:{poi_id:home.poi_id,repair_price_per_hull:HULL_PRICE},fuel_price_all_in:FUEL_PRICE}}}),
    'spacemolt/refuel':()=>{
      const cost=(server.ship.max_fuel-server.ship.fuel)*FUEL_PRICE;
      server.ship.fuel=server.ship.max_fuel;server.player.credits-=cost;
      return {delta:{details:{action:'refuel',cost}}};
    },
    'spacemolt/repair':()=>{
      const cost=(server.ship.max_hull-server.ship.hull)*HULL_PRICE;
      server.ship.hull=server.ship.max_hull;server.player.credits-=cost;
      return {delta:{details:{action:'repair',cost}}};
    },
  };
  const runtime=await mkdtemp(join(tmpdir(),'c18-resume-'));

  /** One runner. `stall` is the death: from the first command that matches, this bridge
   * answers nothing ever again, exactly as a killed process does mid-step. */
  const bridge=(stall?:(action:string)=>boolean)=>{
    const calls:{action:string;params:Record<string,unknown>}[]=[];
    let dead=false;
    const account:ReadinessAccount={
      state:structuredClone(server) as unknown as ReadinessAccount['state'],
      async refresh(){account.state=structuredClone(server) as unknown as ReadinessAccount['state'];}};
    const command:ReadinessCommand=async(action,params)=>{
      if(dead)return new Promise(()=>{});
      if(stall?.(action)){dead=true;return new Promise(()=>{});}
      calls.push({action,params:params??{}});
      assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
      return handlers[action](params??{});
    };
    return {calls,
      count:(action:string)=>calls.filter(call=>call.action===action).length,
      mutations:()=>calls.filter(call=>MUTATIONS.has(call.action)).map(call=>call.action),
      dispatch:serve(account,command,{pilot:()=>PILOT,runtime}),
      died:()=>dead};
  };
  return {server,runtime,bridge,
    stored:()=>Object.entries(server.storage.reduce<Record<string,number>>((totals,row)=>
      ({...totals,[row.item_id]:(totals[row.item_id]??0)+row.quantity}),{}))
      .sort(([a],[b])=>a<b?-1:1).map(([item_id,quantity])=>({item_id,quantity})),
    /** What a restarting bridge finds on disk, and what a reader of the journal finds. */
    record:()=>JSON.parse(readFileSync(join(runtime,'run.json'),'utf8')),
    runLines:()=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n')
      .filter(Boolean).map(line=>JSON.parse(line))
      .filter(entry=>entry.event==='run'&&entry.phase==='ended'),
    close:()=>rm(runtime,{recursive:true,force:true})};
}

/** A run outlives the call that started it, so the end is waited for, never awaited. */
async function drain(dispatch:Dispatch) {
  for(let turn=0;turn<20_000;turn++) {
    await new Promise(resolve=>setImmediate(resolve));
    if(!((await dispatch('status')) as any).running)return;
  }
  throw new Error('the run never ended');
}

test('C18: a run interrupted after the mine step resumes at the return, mining nothing twice',async()=>{
  const w=await world();
  try {
    // The first runner dies at the return leg's route quote: hold full, out at the belt.
    const first=w.bridge(action=>action==='spacemolt/find_route'&&
      w.server.location.poi_id==='belt'&&w.server.ship.cargo_used>=CAPACITY);
    const started=await first.dispatch('run',{script:'gather-until',params:TWO_TRIPS}) as any;
    assert.equal(started.accepted,true);
    for(let turn=0;turn<200&&!first.died();turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(first.died(),'the bridge must die mid-job for this to be a restart');
    assert.equal(first.count('spacemolt/mine'),CYCLES_PER_JOB,'the first runner filled the hold once');

    // What the dead runner left behind is the run: the script, its parameters, the hold the
    // pilot set out with, and where it had got to — unfinished.
    const interrupted=w.record();
    assert.equal(interrupted.ended,false);
    assert.equal(interrupted.script,'gather-until');
    assert.equal(interrupted.started,started.record.started);
    assert.deepEqual(interrupted.params,TWO_TRIPS);
    assert.equal(interrupted.last_job,'gather','the first job had not finished');
    assert.deepEqual(interrupted.keep,['cabin_economy'],
      "the pilot's own hold, written down before the departure that proved it");

    // A fresh runner over the same world and the same runtime directory.
    const second=w.bridge();
    assert.deepEqual(await second.dispatch('status'),{running:false,last:null},
      'nothing has finished yet, so there is no outcome to report');
    const resumed=await second.dispatch('resume') as any;
    assert.equal(resumed.resumed,true);
    assert.equal(resumed.script,'gather-until');
    assert.equal(resumed.record.started,started.record.started,
      'the run kept its identity across the restart');
    await drain(second.dispatch);

    // The resumed job re-issued no mutation whose effect was already visible: the first
    // thing the new runner sends is the flight home, never an undock and never a mine.
    assert.equal(second.mutations()[0],'spacemolt/travel');
    assert.deepEqual(second.calls.find(call=>call.action==='spacemolt/travel')!.params,{id:home.poi_id});
    assert.equal(second.count('spacemolt/undock'),1,'only the SECOND job left the dock');
    assert.equal(second.count('spacemolt/mine'),CYCLES_PER_JOB,'only the second job mined');
    assert.equal(second.count('spacemolt/dock'),2,'the resumed job docked, then the second job did');

    // Two jobs' worth of ore reached the store, and the first job's take was not lost.
    assert.deepEqual(w.stored(),STOWED_PER_JOB.map(row=>({...row,quantity:row.quantity*2})));
    assert.deepEqual(w.server.cargo,[{item_id:'cabin_economy',quantity:2}],
      'the pilot keeps its own hold; only the take was stowed');
    assert.deepEqual([w.server.ship.fuel,w.server.ship.hull],[TANK,100]);

    // One outcome and one juncture for the whole run, both halves of it included.
    const status=await second.dispatch('status') as any;
    assert.equal(status.running,false);
    assert.equal(status.last.script,'gather-until');
    assert.equal(status.last.outcome,'done',status.last.reason);
    assert.equal(status.last.jobs.length,2);
    assert.match(status.last.reason,/2 jobs/);
    assert.equal(w.runLines().length,1,'a run ends once, so the journal says so once');
    assert.equal(w.runLines()[0].outcome,'done');
    assert.equal(w.runLines()[0].started,started.record.started);
    assert.equal(w.record().ended,true);
  } finally {await w.close();}
});

test('C18: interrupted docked at home with the take aboard, the resumed job only settles',async()=>{
  const w=await world();
  try {
    const first=w.bridge(action=>action==='spacemolt_storage/view');
    await first.dispatch('run',{script:'gather',params:{poi_id:'belt',base_id:home.base_id}});
    for(let turn=0;turn<200&&!first.died();turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(first.died());
    // The trip is over bar the counter: docked at home, this job's take still in the hold.
    assert.equal(w.server.location.docked_at,home.base_id);
    assert.equal(w.server.ship.cargo_used,CAPACITY);
    assert.equal(w.record().ended,false);

    const second=w.bridge();
    assert.equal(((await second.dispatch('resume')) as any).resumed,true);
    await drain(second.dispatch);

    // Nothing that had already happened happened again: no flight, no mining, no docking.
    assert.deepEqual([...new Set(second.mutations())],
      ['spacemolt_storage/deposit','spacemolt/refuel','spacemolt/repair'],
      'the resumed job stowed and serviced, and did nothing else');
    assert.deepEqual(w.stored(),STOWED_PER_JOB);
    assert.deepEqual(w.server.cargo,[{item_id:'cabin_economy',quantity:2}]);
    assert.equal(((await second.dispatch('status')) as any).last.outcome,'done');
  } finally {await w.close();}
});

test('C18: a run that ended leaves nothing to resume, and a fresh bridge still reads its outcome',async()=>{
  const w=await world();
  try {
    const first=w.bridge();
    const started=await first.dispatch('run',{script:'gather',params:{poi_id:'belt',base_id:home.base_id}}) as any;
    await drain(first.dispatch);
    assert.equal(((await first.dispatch('status')) as any).last.outcome,'done');
    const before=structuredClone(w.server);

    // The runner restarts with the run already finished: the juncture still reads it.
    const second=w.bridge();
    const status=await second.dispatch('status') as any;
    assert.equal(status.running,false);
    assert.equal(status.last.script,'gather');
    assert.equal(status.last.outcome,'done');
    assert.match(status.last.reason,/1 job/);
    assert.equal(((await second.dispatch('menu')) as any).last.script,'gather');

    const resumed=await second.dispatch('resume') as any;
    assert.equal(resumed.resumed,false,'a run that ended naturally is not resumable');
    assert.deepEqual(second.mutations(),[],'a finished run moves nothing on a restart');
    assert.deepEqual(w.server.cargo,before.cargo);
    assert.deepEqual(w.stored(),STOWED_PER_JOB);
    assert.equal(w.runLines().length,1);
  } finally {await w.close();}
});

test('C18: a world no step of the job expects ends the run blocked, the record kept',async()=>{
  const w=await world();
  try {
    const first=w.bridge(action=>action==='spacemolt/find_route'&&
      w.server.location.poi_id==='belt'&&w.server.ship.cargo_used>=CAPACITY);
    const started=await first.dispatch('run',{script:'gather-until',params:TWO_TRIPS}) as any;
    for(let turn=0;turn<200&&!first.died();turn++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(first.died());

    // Between the two runners the ship was moved with no command behind it (S41).
    w.server.location.system_id='vega';
    w.server.location.poi_id='wreck';

    const second=w.bridge();
    assert.equal(((await second.dispatch('resume')) as any).resumed,true);
    await drain(second.dispatch);

    const status=await second.dispatch('status') as any;
    assert.equal(status.outcome,undefined);
    assert.equal(status.last.outcome,'blocked',JSON.stringify(status.last));
    assert.match(status.last.reason,/vega/);
    assert.match(status.last.reason,/job 1 of 1/);
    assert.deepEqual(second.mutations(),[],'an unrecognised world is never acted on');

    // The definition survives for the agent to answer at its next juncture.
    const kept=w.record();
    assert.equal(kept.ended,true,'the run is not left pending a second blind resume');
    assert.equal(kept.started,started.record.started);
    assert.deepEqual(kept.params,TWO_TRIPS);
    assert.equal(kept.outcome.outcome,'blocked');
    assert.equal(w.runLines().length,1);
    assert.equal(w.runLines()[0].outcome,'blocked');
  } finally {await w.close();}
});
