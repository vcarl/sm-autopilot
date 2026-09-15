import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpacemoltError} from '@spacemolt/lib';
import {FuelJournal,type PilotFuelState,type ServicedStation} from '../src/fuel-journal.ts';
import {FuelTravelExecution} from '../src/fuel-transition.ts';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import {gatherJob} from '../src/gather-job.ts';

// Recording handler-map pattern from the C5/C6/C7/C8 proofs: the server is independent
// of the cache, and only a refresh exposes it to production code. Every mine reply
// over-claims (99 ore) and every sell reply over-claims (9_999 credits), so the yield
// and cleared assertions below can only pass from authoritative deltas.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const site={system_id:'sol',poi_id:'belt'};
const TANK=120,CAPACITY=14,EMPTY=7,LOADED=21,RESERVE=30,FUEL_PRICE=5,HULL_PRICE=5;
const prices:Record<string,number>={ore:10,carbon:4};
// Home is the only serviced station, so the return leg and the D3 margin are one route.
const stations:ServicedStation[]=[{...home,services:{refuel:true},
  observation:{source:'station_info',observedAt:'2026-09-14T00:00:00Z'}}];
const MUTATIONS=new Set(['spacemolt/undock','spacemolt/dock','spacemolt/travel','spacemolt/mine',
  'spacemolt/sell','spacemolt_storage/deposit','spacemolt/refuel','spacemolt/repair']);

async function fixture(opts:{fuel?:number;fuelPrice?:number|null}={}) {
  const fuelPrice=opts.fuelPrice===undefined?FUEL_PRICE:opts.fuelPrice;
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false},
    ship:{id:'ship',fuel:opts.fuel??TANK,max_fuel:TANK,hull:90,max_hull:100,shield:5,max_shield:5,
      cargo_used:2,cargo_capacity:CAPACITY,incapacitated:false},
    player:{credits:1_000},
    cargo:[{item_id:'cabin_economy',quantity:2}] as {item_id:string;quantity:number}[],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}],
    storage:[] as {item_id:string;quantity:number}[],
  };
  const hooks={mine:(_cycle:number):unknown=>undefined,sell:(_item:string):unknown=>undefined,read:()=>{}};
  const account:ReadinessAccount={state:structuredClone(server) as unknown as ReadinessAccount['state'],
    async refresh(){hooks.read();account.state=structuredClone(server) as unknown as ReadinessAccount['state'];}};
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
  // A loaded hold costs more to move than the empty outbound leg.
  const leg=()=>server.ship.cargo_used>2?LOADED:EMPTY;
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
      const override=hooks.sell(String(id));
      if(override!==undefined)return override;
      const moved=take(String(id),Number(quantity));
      server.player.credits+=moved*(prices[String(id)]??0);
      return {delta:{details:{action:'sell',quantity_sold:99,total_earned:9_999}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],
      base:{poi_id:home.poi_id,repair_price_per_hull:HULL_PRICE},
      ...fuelPrice===null?{}:{fuel_price_all_in:fuelPrice}}}}),
    'spacemolt/refuel':()=>{
      const cost=(server.ship.max_fuel-server.ship.fuel)*(fuelPrice??0);
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
  const directory=await mkdtemp(join(tmpdir(),'c09-gather-'));
  const pilot:PilotFuelState={mood:'Cautious',stance:'gather',objective:{ore:12},
    home:{base_id:home.base_id},obligations:[]};
  const journal=await FuelJournal.open(directory,'pilot-c09',pilot);
  const execution=new FuelTravelExecution(journal,stations);
  return {server,account,calls,hooks,add,journal,
    mutations:()=>calls.filter(call=>MUTATIONS.has(call.action)).map(call=>call.action),
    run:()=>gatherJob(account,command,{home,site,mood:'Cautious',keep:['cabin_economy']},
      {fuelExecution:execution}),
    close:()=>rm(directory,{recursive:true,force:true})};
}

test('C9: one gather job runs dock to dock and the world, not the replies, closes it',async()=>{
  const f=await fixture();
  try {
    const result=await f.run();
    assert.equal(result.outcome,'done',result.reason);
    // One trip out and back: undock, fly, mine the hold full, fly home, dock, settle, service.
    assert.deepEqual(f.mutations(),['spacemolt/undock','spacemolt/travel',
      ...Array(4).fill('spacemolt/mine'),'spacemolt/travel','spacemolt/dock',
      'spacemolt/sell','spacemolt/sell','spacemolt/refuel','spacemolt/repair']);
    assert.deepEqual(result.steps.map(step=>step.name),
      ['travel','mine','return','dock','settle','service','verify']);
    assert.ok(result.steps.every(step=>step.outcome==='done'),JSON.stringify(result.steps));

    // Never 99 and never 9_999: the yield is the cargo delta and `cleared` the wallet delta.
    assert.deepEqual(result.yield,[{item_id:'carbon',quantity:4},{item_id:'ore',quantity:8}]);
    assert.deepEqual(result.settled!.sold,[{item_id:'carbon',quantity:4,quoted:16,cleared:16},
      {item_id:'ore',quantity:8,quoted:80,cleared:80}]);
    assert.deepEqual([result.settled!.unsettled,result.settled!.held],[[],[]]);
    assert.equal(result.serviced!.spent,28*FUEL_PRICE+10*HULL_PRICE);

    // The end state the job claims is the state the server holds.
    assert.deepEqual(f.server.location,
      {system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id,in_transit:false});
    assert.deepEqual(f.server.cargo,[{item_id:'cabin_economy',quantity:2}],'keep cargo is never offered');
    assert.deepEqual([f.server.ship.fuel,f.server.ship.hull],[TANK,100],'serviced to the mood margins');
    assert.equal(f.server.player.credits,1_000+96-190);
    // An affordable trip imposes nothing: the mood the pilot chose still stands.
    assert.equal(f.journal.snapshot.state.mood,'Cautious');
    assert.deepEqual(f.journal.snapshot.transitions,[]);
  } finally {await f.close();}
});

test('C9: a blocked step ends the job at that step, and a failure is never called blocked',async()=>{
  const scenarios={
    // The return leg is re-checked against actual fuel and the loaded hold (C6).
    'tired-return':{opts:{fuel:EMPTY+LOADED+RESERVE-1},outcome:'blocked',step:'return',
      reason:/Tired recorded: fuel_below_route_minimum: have 50, need 51; shortfall 1 fuel units/},
    'depleted-empty':{outcome:'blocked',step:'mine',reason:/depleted/},
    unsettled:{outcome:'blocked',step:'settle',reason:/did not clear/},
    'unpriced-service':{opts:{fuelPrice:null},outcome:'blocked',step:'service',
      reason:/no all-in fuel quote at this station/},
    interrupted:{outcome:'failed',step:'mine',reason:/no longer at sol\/belt/},
    'stray-cargo':{outcome:'failed',step:'verify',reason:/hold still carries 1 salvage/},
  } as const;

  for(const [mode,expected] of Object.entries(scenarios)) {
    const f=await fixture((expected as {opts?:{fuel?:number;fuelPrice?:number|null}}).opts??{});
    try {
      if(mode==='depleted-empty')f.hooks.mine=()=>{throw new SpacemoltError('depleted','the site gives no more');};
      // The world moves with no command behind it, mid-step.
      if(mode==='interrupted')f.hooks.mine=cycle=>{
        if(cycle!==2)return undefined;
        f.server.location.poi_id='other-belt';
        return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99}}};
      };
      if(mode==='unsettled')f.hooks.sell=()=>({delta:{details:{action:'sell',quantity_sold:99,total_earned:9_999}}});
      // A crate drifts into the hold once the counter is clear: only a closing read sees it.
      if(mode==='stray-cargo') {
        let dropped=false,worked=false;
        f.hooks.read=()=>{
          worked||=f.server.ship.cargo_used===CAPACITY;
          if(dropped||!worked||f.server.location.docked_at!==home.base_id)return;
          if(f.server.cargo.some(row=>row.item_id!=='cabin_economy'))return;
          dropped=true;f.add('salvage',1);
        };
      }

      const result=await f.run();
      assert.equal(result.outcome,expected.outcome,`${mode}: ${result.reason}`);
      const ended=result.steps.at(-1)!;
      assert.deepEqual([ended.name,ended.outcome],[expected.step,expected.outcome],mode);
      assert.match(result.reason??'',expected.reason,mode);
      assert.ok(result.reason!.startsWith(`${expected.step} ${expected.outcome}`),mode);
      // Nothing runs past the step that ended the job, and every earlier step is done.
      assert.ok(result.steps.slice(0,-1).every(step=>step.outcome==='done'),mode);
      assert.equal(result.steps.filter(step=>step.name===expected.step).length,1,mode);

      const mutations=f.mutations();
      if(mode==='tired-return') {
        // A shortfall departs nothing, and the world — not the pilot — imposed Tired.
        assert.deepEqual(mutations.slice(2),Array(4).fill('spacemolt/mine'),mode);
        assert.equal(f.server.location.poi_id,site.poi_id,mode);
        assert.equal(f.server.ship.cargo_used,CAPACITY,'the take is still aboard');
        const {state,transitions}=f.journal.snapshot;
        assert.equal(state.mood,'Tired',mode);
        assert.equal(transitions.at(-1)!.priorMood,'Cautious',mode);
        assert.equal((transitions.at(-1) as {evidence:{shortfall:number}}).evidence.shortfall,1,mode);
      }
      if(mode==='depleted-empty') {
        // A site that gave nothing is not a trip to finish: nothing is sold or docked.
        assert.deepEqual(mutations,['spacemolt/undock','spacemolt/travel','spacemolt/mine'],mode);
        assert.deepEqual(result.yield,[],mode);
        assert.equal(result.settled,null,mode);
      }
      if(mode==='interrupted')
        assert.deepEqual(mutations,['spacemolt/undock','spacemolt/travel','spacemolt/mine','spacemolt/mine'],mode);
      if(mode==='unsettled') {
        // Money that did not move is not income, and an unsettled offer is never re-issued.
        assert.equal(mutations.filter(action=>action==='spacemolt/sell').length,2,mode);
        assert.deepEqual(result.settled!.sold,[],mode);
        assert.equal(result.settled!.unsettled.length,2,mode);
        assert.equal(f.server.player.credits,1_000,mode);
      }
      if(mode==='unpriced-service') {
        // The cargo it did settle survives the blocker; nothing was bought unpriced.
        assert.equal(result.settled!.sold.length,2,mode);
        assert.ok(!mutations.includes('spacemolt/refuel'),mode);
      }
      if(mode==='stray-cargo') {
        assert.equal(result.serviced!.satisfied,true,'the service itself completed');
        assert.equal(result.settled!.sold.length,2,mode);
        assert.equal(f.server.cargo.find(row=>row.item_id==='salvage')?.quantity,1,mode);
      }
      if(expected.outcome==='blocked')assert.ok(!/\bfailed\b/.test(result.reason!),mode);
      assert.equal(result.serviced===null,mode!=='stray-cargo',mode);
    } finally {await f.close();}
  }
});
