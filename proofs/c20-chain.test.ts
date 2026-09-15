import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpacemoltError} from '@spacemolt/lib';
import {FuelJournal,type PilotFuelState,type ServicedStation} from '../src/fuel-journal.ts';
import {FuelTravelExecution} from '../src/fuel-transition.ts';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import type {GatherPlan} from '../src/gather-job.ts';
import {runChain,type Chain,type ChainRecord} from '../src/chain.ts';

// The C9 fixture, run more than once: the same server, the same over-claiming replies
// (99 ore, 9_999 credits), so every number below can only come from authoritative deltas.
// What is new here is that three trips happen under one call and report one outcome.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const site={system_id:'sol',poi_id:'belt'};
const TANK=120,CAPACITY=14,FUEL_PRICE=5,HULL_PRICE=5;
const CYCLES_PER_JOB=4,INCOME_PER_JOB=8*10+4*4;
const prices:Record<string,number>={ore:10,carbon:4};
const stations:ServicedStation[]=[{...home,services:{refuel:true},
  observation:{source:'station_info',observedAt:'2026-09-14T00:00:00Z'}}];
const plan:GatherPlan={home,site,mood:'Cautious',keep:['cabin_economy']};

async function fixture() {
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false},
    ship:{id:'ship',fuel:TANK,max_fuel:TANK,hull:90,max_hull:100,shield:5,max_shield:5,
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
  const directory=await mkdtemp(join(tmpdir(),'c20-chain-'));
  const pilot:PilotFuelState={mood:'Cautious',stance:'gather',objective:{ore:36},
    home:{base_id:home.base_id},obligations:[]};
  const journal=await FuelJournal.open(directory,'pilot-c20',pilot);
  const execution=new FuelTravelExecution(journal,stations);
  const records:ChainRecord[]=[];
  return {server,account,calls,hooks,records,
    count:(action:string)=>calls.filter(call=>call.action===action).length,
    run:(chain:Chain)=>runChain(account,command,chain,
      {fuelExecution:execution,onProgress:record=>records.push(structuredClone(record))}),
    close:()=>rm(directory,{recursive:true,force:true})};
}

const sequence=(count:number):Chain=>({kind:'sequence',jobs:Array.from({length:count},()=>({job:'gather' as const,params:plan}))});

test('C20: a chain of three gather jobs runs with one juncture at the end and one outcome',async()=>{
  const f=await fixture();
  try {
    const result=await f.run(sequence(3));

    // One call, one outcome, one juncture — for three trips out and back.
    assert.equal(result.outcome,'done',result.juncture.reason);
    assert.deepEqual(Object.keys(result).sort(),['jobs','juncture','outcome']);
    assert.equal(f.count('spacemolt/undock'),3,'three trips left the dock');
    assert.equal(f.count('spacemolt/dock'),3,'three trips came back');
    assert.equal(f.count('spacemolt/mine'),3*CYCLES_PER_JOB);

    // Each job reports its own compact outcome; the step logs stay out of the agent's world.
    assert.equal(result.jobs.length,3);
    assert.ok(result.jobs.every(job=>job.outcome==='done'),JSON.stringify(result.jobs));
    assert.ok(result.jobs.every(job=>!('steps' in job)&&!('serviced' in job)),'no step logs in the chain outcome');
    for(const job of result.jobs) {
      assert.deepEqual(job.yield,[{item_id:'carbon',quantity:4},{item_id:'ore',quantity:8}]);
      assert.equal(job.cleared,INCOME_PER_JOB,'the wallet delta, never the reply 9_999');
    }
    // The chain's account of income is the server's: three trips of settled cargo.
    const income=result.jobs.reduce((total,job)=>total+job.cleared,0);
    assert.equal(income,3*INCOME_PER_JOB);
    assert.match(result.juncture.reason,/3 of 3/);

    // The world agrees: docked at home, hold clear but for what the pilot keeps, serviced.
    assert.equal(f.server.location.docked_at,home.base_id);
    assert.deepEqual(f.server.cargo,[{item_id:'cabin_economy',quantity:2}]);
    assert.deepEqual([f.server.ship.fuel,f.server.ship.hull],[TANK,100]);

    // The definition travels with the run so a restart could see where it was (S32/N22).
    const positions=f.records.map(record=>record.position);
    assert.deepEqual(positions,[0,1,2,3]);
    assert.deepEqual(f.records.map(record=>record.ended),[false,false,false,true]);
    for(const record of f.records) {
      assert.equal(record.kind,'sequence');
      assert.equal(record.jobs.length,3);
      assert.deepEqual(JSON.parse(JSON.stringify(record)),record,'the record is serialisable');
    }
  } finally {await f.close();}
});

test('C20: a blocked job ends the chain there, naming which job, with no job after it',async()=>{
  const f=await fixture();
  try {
    // The second trip finds the site out before it has anything: a world the pilot answers.
    f.hooks.mine=cycle=>{
      if(cycle!==CYCLES_PER_JOB+1)return undefined;
      throw new SpacemoltError('depleted','the site gives no more');
    };
    const result=await f.run(sequence(3));

    assert.equal(result.outcome,'blocked',result.juncture.reason);
    assert.equal(result.jobs.length,2,'the chain stopped at the job that blocked');
    assert.deepEqual(result.jobs.map(job=>job.outcome),['done','blocked']);
    // The chain's outcome is that job's outcome, and the reason names its place in the chain.
    assert.match(result.juncture.reason,/job 2 of 3/);
    assert.match(result.juncture.reason,/blocked/);
    assert.match(result.juncture.reason,/depleted/);
    assert.ok(!/\bfailed\b/.test(result.juncture.reason));
    assert.match(result.jobs[1]!.reason??'',/mine blocked/);
    assert.deepEqual(result.jobs[1]!.yield,[]);
    assert.equal(result.jobs[1]!.cleared,0,'a blocked trip settled nothing');

    // Nothing ran after the blocker: two departures, one return, one settled trip.
    assert.equal(f.count('spacemolt/undock'),2);
    assert.equal(f.count('spacemolt/dock'),1);
    assert.equal(f.count('spacemolt/mine'),CYCLES_PER_JOB+1);
    assert.equal(f.server.player.credits,1_000+INCOME_PER_JOB-(28*FUEL_PRICE+10*HULL_PRICE));
    assert.deepEqual(f.records.map(record=>[record.position,record.ended]),[[0,false],[1,false],[2,true]]);
  } finally {await f.close();}
});

test('C20: a loop re-runs the one job to its length; once is a sequence of one',async()=>{
  const f=await fixture();
  try {
    const result=await f.run({kind:'loop',jobs:[{job:'gather',params:plan}],length:3});
    assert.equal(result.outcome,'done',result.juncture.reason);
    assert.equal(result.jobs.length,3,'the loop ran its length, not its job count');
    assert.equal(f.count('spacemolt/undock'),3);
    assert.match(result.juncture.reason,/3 of 3/);
    assert.deepEqual(f.records.map(record=>record.position),[0,1,2,3]);
    assert.ok(f.records.every(record=>record.kind==='loop'&&record.jobs.length===1));
  } finally {await f.close();}

  const g=await fixture();
  try {
    const result=await g.run({kind:'once',jobs:[{job:'gather',params:plan}]});
    assert.equal(result.outcome,'done',result.juncture.reason);
    assert.equal(result.jobs.length,1);
    assert.equal(g.count('spacemolt/undock'),1);
    assert.match(result.juncture.reason,/1 of 1/);
  } finally {await g.close();}
});

test('C20: a loop stops at a job that did not finish, however much length is left',async()=>{
  const f=await fixture();
  try {
    f.hooks.mine=cycle=>{
      if(cycle!==CYCLES_PER_JOB+1)return undefined;
      throw new SpacemoltError('depleted','the site gives no more');
    };
    const result=await f.run({kind:'loop',jobs:[{job:'gather',params:plan}],length:5});
    assert.equal(result.outcome,'blocked',result.juncture.reason);
    assert.equal(result.jobs.length,2);
    assert.match(result.juncture.reason,/job 2 of 5/);
    assert.equal(f.count('spacemolt/undock'),2);
  } finally {await f.close();}
});

test('C20: a chain the agent could not have meant is refused before anything moves',async()=>{
  const f=await fixture();
  try {
    const bad:[string,Chain][]=[
      ['empty',{kind:'sequence',jobs:[]}],
      ['loop without a length',{kind:'loop',jobs:[{job:'gather',params:plan}]}],
      ['loop of many jobs',{kind:'loop',jobs:[{job:'gather',params:plan},{job:'gather',params:plan}],length:2}],
      ['once of many jobs',{kind:'once',jobs:[{job:'gather',params:plan},{job:'gather',params:plan}]}],
      ['unknown kind',{kind:'forever' as Chain['kind'],jobs:[{job:'gather',params:plan}]}],
      ['fractional length',{kind:'loop',jobs:[{job:'gather',params:plan}],length:2.5}],
    ];
    for(const [name,chain] of bad)
      await assert.rejects(()=>f.run(chain),/chain/i,name);
    assert.deepEqual(f.calls,[],'nothing was sent to the game');
  } finally {await f.close();}
});
