import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Dispatch,type Pilot} from '../src/bridge.ts';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';

// The C9/C18 world, driven through the bridge, because everything this row claims is
// visible from outside the job: the chain's outcome, the journal line, and what the next
// juncture reads as `last`. Every mine reply still over-claims (99 ore), so no number
// below can have come from a reply.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const TANK=120,CAPACITY=14,FUEL_PRICE=5,HULL_PRICE=5;
const CYCLES_PER_JOB=4;
const MUTATIONS=new Set(['spacemolt/undock','spacemolt/dock','spacemolt/travel','spacemolt/mine',
  'spacemolt/sell','spacemolt_storage/deposit','spacemolt/refuel','spacemolt/repair']);
const PILOT:Pilot={name:'kvothe',objective:'fill the store',stance:'Prospector',mood:'Cautious',
  home:home.base_id};
/** The trip out and the hold filled: every scenario below strikes after exactly this much. */
const OUT_AND_MINED=['spacemolt/undock','spacemolt/travel',...Array(CYCLES_PER_JOB).fill('spacemolt/mine')];

async function world() {
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,
      in_transit:false},
    ship:{id:'ship',fuel:TANK,max_fuel:TANK,hull:96,max_hull:100,shield:5,max_shield:5,
      cargo_used:2,cargo_capacity:CAPACITY,incapacitated:false},
    // The pilot's own respawn point, which is the only thing that makes a death readable.
    player:{credits:1_000,home_base:home.base_id,home_poi:home.poi_id,home_system:home.system_id},
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
      server.storage.push({item_id:String(item_id),quantity:moved});
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
  const runtime=await mkdtemp(join(tmpdir(),'c13-unsolicited-'));

  /** The world moves between every look and every act. `strike` arms on the read that first
   * sees a full hold at the belt — the mine step's own closing read — and fires on the NEXT
   * read, which is the one the pilot takes before it acts again. No command is involved:
   * this is the server moving the ship while nothing was asked of it. */
  const bridge=(strike?:()=>void)=>{
    const calls:{action:string;params:Record<string,unknown>}[]=[];
    let armed=false,fired=false;
    const account:ReadinessAccount={
      state:structuredClone(server) as unknown as ReadinessAccount['state'],
      async refresh() {
        if(strike&&!fired) {
          if(armed){fired=true;strike();}
          else armed=server.location.poi_id==='belt'&&server.ship.cargo_used>=CAPACITY;
        }
        account.state=structuredClone(server) as unknown as ReadinessAccount['state'];
      }};
    const command:ReadinessCommand=async(action,params)=>{
      calls.push({action,params:params??{}});
      assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
      return handlers[action](params??{});
    };
    return {calls,fired:()=>fired,
      count:(action:string)=>calls.filter(call=>call.action===action).length,
      mutations:()=>calls.filter(call=>MUTATIONS.has(call.action)).map(call=>call.action),
      dispatch:serve(account,command,{pilot:()=>PILOT,runtime})};
  };
  return {server,runtime,bridge,
    record:()=>JSON.parse(readFileSync(join(runtime,'chain.json'),'utf8')),
    lines:(event:string)=>readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n')
      .filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.event===event),
    close:()=>rm(runtime,{recursive:true,force:true})};
}

/** A chain outlives the call that started it, so the end is waited for, never awaited. */
async function drain(dispatch:Dispatch) {
  for(let turn=0;turn<20_000;turn++) {
    await new Promise(resolve=>setImmediate(resolve));
    if(!((await dispatch('status')) as any).running)return;
  }
  throw new Error('the chain never ended');
}

/** Death and respawn: the ship is gone, a new one sits at the pilot's own home base with
 * the hull whole. Nothing in the state says "you died"; this is what the pilot can see. */
const respawn=(server:any)=>()=>{
  server.ship.id='ship-2';
  server.ship.hull=server.ship.max_hull;
  server.ship.cargo_used=0;
  server.cargo.length=0;
  server.location.poi_id=home.poi_id;
  server.location.docked_at=home.base_id;
};

test('C13: a death and respawn mid-job stops the pilot before its next act, blocked and named',async()=>{
  const w=await world();
  try {
    const runner=w.bridge(respawn(w.server));
    const started=await runner.dispatch('job',{job:'gather',poi_id:'belt',repeat:1}) as any;
    assert.equal(started.accepted,true);
    await drain(runner.dispatch);
    assert.ok(runner.fired(),'the world must have moved the ship for this to be the row');

    // Out and mined, then nothing: the flight home was never issued, nor the dock, nor
    // a deposit against a hold that no longer exists.
    assert.deepEqual(runner.mutations(),OUT_AND_MINED);

    const last=(await runner.dispatch('status') as any).last;
    assert.equal(last.outcome,'blocked',JSON.stringify(last.juncture));
    assert.equal(last.moved.cause,'respawn');
    assert.equal(last.moved.from.poi_id,'belt');
    assert.equal(last.moved.to.docked_at,home.base_id);
    assert.equal(last.moved.to.ship_id,'ship-2');
    assert.match(last.moved.evidence,/belt/);
    assert.match(last.juncture.reason,/return blocked: unsolicited move \(respawn\)/);
    assert.equal(last.jobs[0].moved.cause,'respawn');

    // The journal carries the move on its own line, so a reader of the shift finds it
    // without digging it out of a chain outcome.
    assert.equal(w.lines('unsolicited_move').length,1);
    assert.equal(w.lines('unsolicited_move')[0].cause,'respawn');
    assert.equal(w.lines('unsolicited_move')[0].chain_id,started.chain_id);
    assert.equal(w.lines('chain').length,1);
    assert.equal(w.record().ended,true);
  } finally {await w.close();}
});

test('C13: a ship taken mid-job fails the job and sends nothing more',async()=>{
  const w=await world();
  try {
    const runner=w.bridge(()=>{w.server.ship.incapacitated=true;});
    await runner.dispatch('job',{job:'gather',poi_id:'belt',repeat:1});
    await drain(runner.dispatch);
    assert.ok(runner.fired());
    assert.deepEqual(runner.mutations(),OUT_AND_MINED);

    const last=(await runner.dispatch('status') as any).last;
    // A capture is not a place the agent can simply answer from: the job failed.
    assert.equal(last.outcome,'failed',JSON.stringify(last.juncture));
    assert.equal(last.moved.cause,'captured');
    assert.equal(last.moved.to.incapacitated,true);
    assert.match(last.juncture.reason,/unsolicited move \(captured\)/);
    assert.equal(w.lines('unsolicited_move')[0].cause,'captured');
  } finally {await w.close();}
});

test('C13: a fleet kick puts the ship elsewhere with no transit, and the chain says so',async()=>{
  const w=await world();
  try {
    const runner=w.bridge(()=>{w.server.location.poi_id='other-belt';});
    await runner.dispatch('job',{job:'gather',poi_id:'belt',repeat:1});
    await drain(runner.dispatch);
    assert.ok(runner.fired());
    assert.deepEqual(runner.mutations(),OUT_AND_MINED);

    const last=(await runner.dispatch('status') as any).last;
    assert.equal(last.outcome,'failed',JSON.stringify(last.juncture));
    assert.equal(last.moved.cause,'fleet_kick');
    assert.equal(last.moved.to.poi_id,'other-belt');
    assert.equal(last.moved.to.in_transit,false);
    assert.equal(last.moved.to.ship_id,'ship','the same ship, somewhere it was never sent');
    assert.equal(w.lines('unsolicited_move').length,1);
    assert.equal(w.lines('unsolicited_move')[0].cause,'fleet_kick');
  } finally {await w.close();}
});

test('C13: the pilot travelling where it told itself to go is not an unsolicited move',async()=>{
  const w=await world();
  try {
    const runner=w.bridge();
    await runner.dispatch('job',{job:'gather',poi_id:'belt',repeat:1});
    await drain(runner.dispatch);

    // The ship moved twice under its own commands, and the reconcile before every step
    // said nothing: a commanded move is the pilot's own, whatever the position changed to.
    const last=(await runner.dispatch('status') as any).last;
    assert.equal(last.outcome,'done',JSON.stringify(last.juncture));
    assert.equal(last.moved,undefined);
    assert.equal(last.jobs[0].moved,undefined);
    assert.deepEqual(runner.mutations(),[...OUT_AND_MINED,'spacemolt/travel','spacemolt/dock',
      'spacemolt_storage/deposit','spacemolt_storage/deposit','spacemolt/refuel','spacemolt/repair']);
    assert.deepEqual(w.lines('unsolicited_move'),[]);
    assert.deepEqual(w.server.location,
      {system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id,in_transit:false});
  } finally {await w.close();}
});
