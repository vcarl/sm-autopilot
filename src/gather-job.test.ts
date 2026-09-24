import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {gatherJob,type GatherOptions,type GatherPlan} from './gather-job.ts';

// Recording handler-map fixture in the C9 style: the server is independent of the cache
// and only a refresh exposes it. This station quotes EVERY item it is shown and has a
// store, so a job that sells anything — or that stows more than it mined — is visible.
const home={system_id:'sol',poi_id:'station',base_id:'home_base'};
const site={system_id:'sol',poi_id:'belt'};
const TANK=120,CAPACITY=15,LEG=20,FUEL_PRICE=5;
const prices:Record<string,number>={ore:10,cabin_economy:2,steel_plate:1};

function fixture() {
  const server={
    location:{system_id:home.system_id,poi_id:home.poi_id,docked_at:home.base_id as string|null,in_transit:false,
      // What the POI the ship is at gives, as the server answers it: the belt's ore, nothing at the station.
      resources:[] as {item_id:string}[]},
    ship:{id:'ship',fuel:TANK,max_fuel:TANK,hull:100,max_hull:100,shield:5,max_shield:5,
      cargo_used:11,cargo_capacity:CAPACITY,incapacitated:false},
    player:{credits:1_000},
    // What the ship was fitted and loaded with before this job existed.
    cargo:[{item_id:'cabin_economy',quantity:1},{item_id:'steel_plate',quantity:10}] as {item_id:string;quantity:number}[],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}],
    storage:[] as {item_id:string;quantity:number}[],
  };
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
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:any)=>unknown>={
    'spacemolt/find_route':({id})=>({found:true,target_system:home.system_id,total_jumps:0,
      route:[{system_id:home.system_id,jumps:0}],estimated_fuel:LEG,fuel_per_jump:0,
      fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
      ...id===home.base_id?{target_poi:home.poi_id}:{}}),
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',system:{id:home.system_id,connections:[]}}}),
    'spacemolt/undock':()=>{server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{server.location.docked_at=home.base_id;return {};},
    'spacemolt/travel':({id})=>{server.ship.fuel-=LEG;server.location.poi_id=String(id);
      server.location.resources=String(id)===site.poi_id?[{item_id:'ore'}]:[];return {};},
    'spacemolt/mine':()=>{add('ore',2);return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:2}}};},
    'spacemolt_market/view_market':()=>({delta:{details:{action:'view_market',
      items:Object.entries(prices).map(([item_id,buy_price])=>({item_id,buy_price}))}}}),
    'spacemolt/sell':({id,quantity})=>{
      const moved=take(String(id),Number(quantity));
      server.player.credits+=moved*(prices[String(id)]??0);
      return {delta:{details:{action:'sell',quantity_sold:moved,total_earned:moved*(prices[String(id)]??0)}}};
    },
    'spacemolt_storage/view':()=>({delta:{details:{action:'view_storage',items:structuredClone(server.storage)}}}),
    'spacemolt_storage/deposit':({item_id,quantity})=>{
      const moved=take(String(item_id),Number(quantity));
      server.storage.push({item_id:String(item_id),quantity:moved});
      // The reply over-claims; only the authoritative read may say what moved.
      return {delta:{details:{action:'deposit_items',item_id,quantity:99,storage_total:99}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],
      base:{poi_id:home.poi_id,repair_price_per_hull:5},fuel_price_all_in:FUEL_PRICE}}}),
    'spacemolt/refuel':()=>{
      const cost=(server.ship.max_fuel-server.ship.fuel)*FUEL_PRICE;
      server.ship.fuel=server.ship.max_fuel;server.player.credits-=cost;
      return {delta:{details:{action:'refuel',cost}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    calls.push({action,params:params??{}});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params??{});
  };
  return {server,account,calls,
    // The plan is the caller's own object, so a test may move its mood mid-job the way the
    // runtime does, and hand the job the hooks a runner passes it.
    run:(plan:GatherPlan={home,site,mood:'Cautious'},options?:GatherOptions)=>
      gatherJob(account,command,plan,options)};
}

test('a gather job stows what it mined and sells nothing; the starting hold stays aboard',async()=>{
  const f=fixture();
  const result=await f.run();
  assert.equal(result.outcome,'done',result.reason);

  // A gather job never reaches the market counter, under any parameters.
  assert.deepEqual(f.calls.filter(call=>call.action==='spacemolt/sell'),[]);
  assert.deepEqual(result.settled!.sold,[]);
  assert.equal(result.settled!.credits_after,result.settled!.credits_before);

  // Its take is in the station store — the measured yield, never the reply's 99.
  assert.deepEqual(result.yield,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(result.settled!.deposited,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(f.server.storage,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(f.calls.filter(call=>call.action==='spacemolt_storage/deposit').map(call=>call.params),
    [{item_id:'ore',quantity:4}]);

  // The verifying read agrees: what the pilot arrived with is still aboard, untouched.
  assert.deepEqual(f.server.cargo,[{item_id:'cabin_economy',quantity:1},{item_id:'steel_plate',quantity:10}]);
});

test('the next run stows the ore an interrupted trip left aboard, by what the site gives',async()=>{
  const f=fixture();
  // Two ore from a trip that was cut off mid-mine, beside the pilot's own cabin and plates.
  f.server.cargo.push({item_id:'ore',quantity:2});
  f.server.ship.cargo_used+=2;
  const result=await f.run();
  assert.equal(result.outcome,'done',result.reason);

  // This run mined 2 more; all 4 are the belt's ore, so all 4 are stowed — no keep list,
  // no guess that the hold at departure was the pilot's own.
  assert.deepEqual(result.yield,[{item_id:'ore',quantity:2}]);
  assert.deepEqual(result.settled!.deposited,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(f.server.storage,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(f.server.cargo,[{item_id:'cabin_economy',quantity:1},{item_id:'steel_plate',quantity:10}]);
});

// S2: `imposeTired()` moves the mood between any two commands. The outbound leg is not going
// to a base, so a Tired mood must stop it where the ship is; the return leg ends at home's own
// base, which is the one place a Tired pilot may still be flown — stopping must not strand it.
test('Tired refuses the outbound leg and still flies the safe leg home',async()=>{
  const tired=fixture();
  const refused=await tired.run({home,site,mood:'Tired'});
  assert.equal(refused.outcome,'blocked',String(refused.reason));
  assert.deepEqual(refused.steps.map(step=>step.name),['travel']);
  assert.match(refused.reason??'',/only a base is admitted/);
  // Nothing was sent: the refusal came before the leg's own route quote.
  assert.deepEqual(tired.calls,[]);

  // The same mood, imposed after the dig instead of before the trip: the leg home is flown.
  const crossing=fixture();
  const plan:GatherPlan={home,site,mood:'Cautious'};
  const result=await crossing.run(plan,{onStep:step=>{if(step.name==='mine')plan.mood='Tired';}});
  assert.equal(result.outcome,'done',String(result.reason));
  assert.equal(crossing.server.location.docked_at,home.base_id);
});

// S3: the mood the job was planned under is stale by the time the leg home is flown, and the
// mood is what picks the fuel reserve the leg is quoted against. Fuel short of the planning
// mood's reserve but inside Tired's own is the shape that shows it: a leg quoted on the frozen
// mood refuses the trip home the pilot has the fuel for.
test('the legs are quoted on the mood in force now, not the one the job was planned under',async()=>{
  const f=fixture();
  let mood:GatherPlan['mood']='Cautious';
  const result=await f.run({home,site,mood},{
    moodNow:()=>mood,
    // Fuel spent at the site is what imposes Tired; 45 covers the 20 the leg home costs but
    // not the 30 the Cautious reserve keeps beyond it.
    onStep:step=>{if(step.name==='mine'){f.server.ship.fuel=45;mood='Tired';}},
  });
  assert.equal(result.outcome,'done',String(result.reason));
  assert.deepEqual(result.steps.filter(step=>step.name==='return').map(step=>step.outcome),['done']);
  assert.equal(f.server.location.docked_at,home.base_id);
});
