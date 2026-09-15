import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import type {Facts} from '../src/rules-table.ts';
import {runScript,type RunOutcome} from '../src/script-runner.ts';
import type {RunRecord} from '../src/run-record.ts';

// The C9 fixture, run more than once: the same server, the same over-claiming replies
// (99 ore, 9_999 credits), so every number below can only come from authoritative deltas.
// What is new here is that three trips happen under one call and report one outcome.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const site={system_id:'sol',poi_id:'belt'};
const TANK=120,CAPACITY=14,FUEL_PRICE=5,HULL_PRICE=5;
const CYCLES_PER_JOB=4,STOWED_PER_JOB=[{item_id:'carbon',quantity:4},{item_id:'ore',quantity:8}];
const prices:Record<string,number>={ore:10,carbon:4};
/** A pilot fit to work, so the rules between jobs never stop the script on their own. */
const facts=():Facts=>({stance:'Prospector',mood:'Cautious',
  place:{kind:'base',base_id:home.base_id,is_home:true,counters:['Services','Storage']},
  holdings:{fuel:TANK,max_fuel:TANK,hull:100,max_hull:100,cargo_free:CAPACITY,credits:1_000},
  obligations:{},permissions:{},observed:{}});

async function fixture() {
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false},
    ship:{id:'ship',fuel:TANK,max_fuel:TANK,hull:96,max_hull:100,shield:5,max_shield:5,
      cargo_used:2,cargo_capacity:CAPACITY,incapacitated:false},
    player:{credits:1_000},
    cargo:[{item_id:'cabin_economy',quantity:2}] as {item_id:string;quantity:number}[],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}],
    storage:[] as {item_id:string;quantity:number}[],
  };
  const hooks={mine:(_cycle:number):unknown=>undefined};
  const account:ReadinessAccount={state:structuredClone(server) as unknown as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as unknown as ReadinessAccount['state'];}};
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
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  let cycle=0;
  const handlers:Record<string,(params:any)=>unknown>={
    'spacemolt/find_route':({id})=>{
      const toBase=id===home.base_id;
      const cost=toBase&&server.location.docked_at===home.base_id?0:leg();
      return {found:true,target_system:home.system_id,total_jumps:0,route:[{system_id:home.system_id,jumps:0}],
        estimated_fuel:cost,fuel_per_jump:0,fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        ...toBase?{target_poi:home.poi_id}:{}};
    },
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system:{id:home.system_id,connections:[]}}}),
    'spacemolt/undock':()=>{server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{server.location.docked_at=home.base_id;return {};},
    'spacemolt/travel':({id})=>{server.ship.fuel-=leg();server.location.poi_id=String(id);return {};},
    'spacemolt/mine':()=>{
      const override=hooks.mine(++cycle);
      if(override!==undefined)return override;
      add('ore',2);add('carbon',1);
      return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99}}};
    },
    'spacemolt_market/view_market':()=>({delta:{details:{action:'view_market',
      items:Object.entries(prices).map(([item_id,buy_price])=>({item_id,buy_price}))}}}),
    'spacemolt_storage/view':()=>({delta:{details:{items:structuredClone(server.storage)}}}),
    'spacemolt/sell':({id,quantity})=>{
      const moved=take(String(id),Number(quantity));
      server.player.credits+=moved*(prices[String(id)]??0);
      return {delta:{details:{action:'sell',quantity_sold:99,total_earned:9_999}}};
    },
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
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,params:params??{}});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params??{});
  };
  const runtime=await mkdtemp(join(tmpdir(),'c20-run-'));
  const records:RunRecord[]=[];
  return {server,account,calls,hooks,records,
    count:(action:string)=>calls.filter(call=>call.action===action).length,
    /** Storage rows summed per item, so three trips' takes read as one total. */
    stored:()=>Object.entries(server.storage.reduce<Record<string,number>>((totals,row)=>
      ({...totals,[row.item_id]:(totals[row.item_id]??0)+row.quantity}),{}))
      .sort(([a],[b])=>a<b?-1:1).map(([item_id,quantity])=>({item_id,quantity})),
    run:(script:string,params:Record<string,unknown>):Promise<RunOutcome>=>
      runScript({account,command,script,params,facts:async()=>facts(),mood:'Cautious',
        home:home.base_id,runtime,onProgress:record=>records.push(structuredClone(record))}),
    close:()=>rm(runtime,{recursive:true,force:true})};
}

/** The composed script the agent writes when it wants several trips under one juncture:
 * gather until the store holds `ore` enough, or the run cap is reached. */
const until=(ore:number,max_runs:number)=>
  ({poi_id:site.poi_id,item_id:'ore',quantity:ore,max_runs,base_id:home.base_id});

test('C20: a script of three gather jobs runs with one juncture at the end and one outcome',async()=>{
  const f=await fixture();
  try {
    // Eight ore a trip, twenty-four asked for: the script decides three trips, not the agent.
    const result=await f.run('gather-until',until(24,5));

    // One call, one outcome, one juncture — for three trips out and back.
    assert.equal(result.outcome,'done',result.reason);
    assert.deepEqual(Object.keys(result).sort(),['jobs','outcome','reason','result','script']);
    assert.equal(f.count('spacemolt/undock'),3,'three trips left the dock');
    assert.equal(f.count('spacemolt/dock'),3,'three trips came back');
    assert.equal(f.count('spacemolt/mine'),3*CYCLES_PER_JOB);

    // Each job reports its own compact outcome; the step logs stay out of the agent's world.
    assert.equal(result.jobs.length,3);
    assert.ok(result.jobs.every(job=>job.outcome==='done'),JSON.stringify(result.jobs));
    assert.ok(result.jobs.every(job=>!('steps' in job)&&!('serviced' in job)),'no step logs in the run outcome');
    for(const job of result.jobs) {
      assert.equal(job.job,'gather');
      assert.deepEqual(job.yield,STOWED_PER_JOB);
    }
    // The run's account of its take is the server's: three trips of cargo, all stowed.
    assert.equal(f.count('spacemolt/sell'),0,'a run of gather jobs never sells');
    assert.equal(f.count('spacemolt_storage/deposit'),3*STOWED_PER_JOB.length);
    assert.deepEqual(f.stored(),STOWED_PER_JOB.map(row=>({...row,quantity:row.quantity*3})));
    assert.match(result.reason!,/3 trips/);

    // The world agrees: docked at home, hold clear but for what the pilot keeps, serviced.
    assert.equal(f.server.location.docked_at,home.base_id);
    assert.deepEqual(f.server.cargo,[{item_id:'cabin_economy',quantity:2}]);
    assert.deepEqual([f.server.ship.fuel,f.server.ship.hull],[TANK,100]);

    // The run travels with the record so a restart could see what it was doing (S32/N22).
    const last=f.records.at(-1)!;
    assert.equal(last.script,'gather-until');
    assert.equal(last.ended,true);
    assert.equal(last.last_job,'gather');
    assert.deepEqual(f.records.map(record=>record.ended).slice(0,-1).filter(Boolean),[],
      'the record says unfinished until it is finished');
    for(const record of f.records) {
      assert.equal(record.started,last.started,'one run, one identity: the moment it started');
      assert.deepEqual(record.params,until(24,5));
      assert.deepEqual(JSON.parse(JSON.stringify(record)),record,'the record is serialisable');
    }
  } finally {await f.close();}
});

test('C20: a blocked job ends the script there, naming which job, with no job after it',async()=>{
  const f=await fixture();
  try {
    // The second trip finds the site out before it has anything: a world the pilot answers.
    f.hooks.mine=cycle=>{
      if(cycle!==CYCLES_PER_JOB+1)return undefined;
      throw new SpacemoltError('depleted','the site gives no more');
    };
    const result=await f.run('gather-until',until(24,5));

    assert.equal(result.outcome,'blocked',result.reason);
    assert.equal(result.jobs.length,2,'the script stopped at the job that blocked');
    assert.deepEqual(result.jobs.map(job=>job.outcome),['done','blocked']);
    // The run's outcome is that job's outcome, and the reason names its place in the run.
    assert.match(result.reason!,/job 2 of 2/);
    assert.match(result.reason!,/blocked/);
    assert.match(result.reason!,/depleted/);
    assert.ok(!/\bfailed\b/.test(result.reason!));
    assert.match(result.jobs[1]!.reason??'',/mine blocked/);
    assert.deepEqual(result.jobs[1]!.yield,[]);

    // Nothing ran after the blocker: two departures, one return, one settled trip.
    assert.equal(f.count('spacemolt/undock'),2);
    assert.equal(f.count('spacemolt/dock'),1);
    assert.equal(f.count('spacemolt/mine'),CYCLES_PER_JOB+1);
    // One trip stowed its take and paid for its service; nothing was ever sold.
    assert.deepEqual(f.stored(),STOWED_PER_JOB);
    assert.equal(f.count('spacemolt/sell'),0);
    assert.equal(f.server.player.credits,1_000-(28*FUEL_PRICE+4*HULL_PRICE));
    assert.equal(f.records.at(-1)!.ended,true);
  } finally {await f.close();}
});

test('C20: the script decides how many trips; the gather script is exactly one',async()=>{
  // A store that can never be filled runs to the cap the agent set, and no further.
  const f=await fixture();
  try {
    const result=await f.run('gather-until',until(10_000,3));
    assert.equal(result.outcome,'done',result.reason);
    assert.equal(result.jobs.length,3,'the script ran its cap, not its job count');
    assert.equal(f.count('spacemolt/undock'),3);
    assert.match(result.reason!,/3 trips/);
  } finally {await f.close();}

  const g=await fixture();
  try {
    const result=await g.run('gather',{poi_id:site.poi_id,base_id:home.base_id});
    assert.equal(result.outcome,'done',result.reason);
    assert.equal(result.jobs.length,1);
    assert.equal(g.count('spacemolt/undock'),1);
    assert.match(result.reason!,/^gather done: /);
  } finally {await g.close();}
});

test('C20: a script stops at a job that did not finish, however many trips are left',async()=>{
  const f=await fixture();
  try {
    f.hooks.mine=cycle=>{
      if(cycle!==CYCLES_PER_JOB+1)return undefined;
      throw new SpacemoltError('depleted','the site gives no more');
    };
    const result=await f.run('gather-until',until(10_000,5));
    assert.equal(result.outcome,'blocked',result.reason);
    assert.equal(result.jobs.length,2);
    assert.match(result.reason!,/job 2 of 2/);
    assert.equal(f.count('spacemolt/undock'),2);
  } finally {await f.close();}
});

test('C20: a run the agent could not have meant is refused before anything moves',async()=>{
  const f=await fixture();
  try {
    const bad:[string,string,Record<string,unknown>][]=[
      ['a script that does not exist','forever-war',{}],
      ['a path where a name belongs','../bridge',{}],
      ['no site to work','gather',{}],
      ['a site that is not a name','gather',{poi_id:7}],
      ['a parameter the script does not take','gather',{poi_id:site.poi_id,repeat:3}],
      ['a cap that is not a whole number','gather-until',{...until(24,5),max_runs:2.5}],
    ];
    for(const [name,script,params] of bad)
      await assert.rejects(()=>f.run(script,params),/script/i,name);
    assert.deepEqual(f.calls,[],'nothing was sent to the game');
  } finally {await f.close();}
});
