import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect,Fiber,Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {gatherJobEffect,type GatherOptions,type GatherOutcome,type GatherPlan} from './gather-job.ts';
import {GameLive} from './play/game.ts';
import type {MineYieldRow} from './mine.ts';

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
    return handlers[action]!(params??{});
  };
  return {server,account,calls,handlers,command,
    // The plan is the caller's own object, so a test may move its mood mid-job the way the
    // runtime does, and hand the job the hooks a runner passes it.
    run:(plan:GatherPlan={home,site,mood:'Cautious'},options?:GatherOptions):Promise<GatherOutcome>=>
      Effect.runPromise(gatherJobEffect(account,plan,options).pipe(Effect.provide(GameLive({send:command}))))};
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

// S2: `imposeTired()` moves the mood between any two commands, and Tired is what lets a script
// force the resupply that ends it — so it may not stop a leg. A job planned under Tired runs,
// and a crossing mid-job flies the rest.
test('Tired flies the job it is planned under, and the one a crossing lands in',async()=>{
  const tired=fixture();
  const planned=await tired.run({home,site,mood:'Tired'});
  assert.equal(planned.outcome,'done',String(planned.reason));
  assert.equal(tired.server.location.docked_at,home.base_id);

  // The same mood, imposed after the dig instead of before the trip: the leg home is flown.
  const crossing=fixture();
  const plan:GatherPlan={home,site,mood:'Cautious'};
  const result=await crossing.run(plan,{onStep:step=>{if(step.name==='mine')plan.mood='Tired';}});
  assert.equal(result.outcome,'done',String(result.reason));
  assert.equal(crossing.server.location.docked_at,home.base_id);
});

// S3: a leg is admitted on its route cost alone; no mood's reserve rides on it (operator,
// 2026-09-26). Fuel short of the planning mood's reserve but covering the route is the shape that
// shows it: the reserve made the pilot Tired, and the trip home is flown on the fuel it needs.
test('the leg home needs only its route, whatever reserve the job was planned under',async()=>{
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

// S4: the mood also picks the service spend margin, and the `service` step still quoted it on
// the mood the job was planned under. Tired's row is "service only" — an unbounded budget —
// where the planning mood keeps a 500 credit ceiling, so here the frozen value is the TIGHTER
// one: the job flies home for a resupply and then refuses to pay for it.
test('the service at the end is quoted on the mood in force now, not the planning mood',async()=>{
  const f=fixture();
  let mood:GatherPlan['mood']='Cautious';
  const result=await f.run({home,site,mood},{
    moodNow:()=>mood,
    // 30 covers the 20 the leg home costs against Tired's own reserve of 0 and leaves 10 in the
    // tank: a 110 unit fill at 5 credits a unit is 550, over Cautious's 500 and inside Tired's.
    onStep:step=>{if(step.name==='mine'){f.server.ship.fuel=30;mood='Tired';}},
  });
  assert.equal(result.outcome,'done',String(result.reason));
  assert.deepEqual(result.steps.filter(step=>step.name==='service').map(step=>step.outcome),['done']);
  assert.equal(result.serviced?.spent,550);
  assert.equal(f.server.ship.fuel,TANK);
});

// A deposit the server refuses is a world the pilot can answer: the take stays aboard, the
// server's own words reach the gap, and nothing is sent twice.
test('a refused deposit ends the settle step blocked with the server\'s message, sent once',async()=>{
  const f=fixture();
  f.handlers['spacemolt_storage/deposit']=()=>{throw new SpacemoltError('storage_full','the store is full');};
  const result=await f.run();
  assert.equal(result.outcome,'blocked');
  assert.equal(result.steps.at(-1)?.name,'settle');
  assert.match(result.reason??'',/settle blocked: ore: the store is full/);
  assert.deepEqual(result.settled?.unsettled.map(row=>row.gap),['the store is full']);
  assert.equal(f.calls.filter(call=>call.action==='spacemolt_storage/deposit').length,1);
});

// A lost reply is not an outcome: the read says nothing moved, so it is reported unsettled. A
// mutation is never re-sent on ReplyLost (docs/EFFECT.md), so the deposit goes out exactly once.
test('a deposit whose reply is lost and moved nothing is sent once and left unsettled',async()=>{
  const f=fixture();
  f.handlers['spacemolt_storage/deposit']=()=>{throw new SpacemoltError('mutation_timeout','no reply in time');};
  const result=await f.run();
  assert.equal(result.outcome,'blocked');
  assert.deepEqual(result.settled?.unsettled.map(row=>row.gap),
    ['deposit did not clear: cargo -0 after no reply in time']);
  assert.equal(f.calls.filter(call=>call.action==='spacemolt_storage/deposit').length,1);
});

test('a refused storage view means no store: the take is held, not a failure',async()=>{
  const f=fixture();
  f.handlers['spacemolt_storage/view']=()=>{throw new SpacemoltError('no_storage','no storage at this station');};
  const result=await f.run();
  assert.equal(result.outcome,'done',result.reason);
  assert.deepEqual(result.settled?.held,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(f.calls.filter(call=>call.action==='spacemolt_storage/deposit'),[]);
});

// A lost reply on the store probe is not "no store": the read is retried and the take stowed.
test('a lost storage view is read again, not taken for no store',async()=>{
  const f=fixture();
  const view=f.handlers['spacemolt_storage/view']!;
  let lost=1;
  f.handlers['spacemolt_storage/view']=params=>{if(lost-->0)throw new SpacemoltError('query_timeout','no reply in time');return view(params);};
  const views=()=>f.calls.filter(call=>call.action==='spacemolt_storage/view').length;
  // The backoff runs on the TestClock: time moves only when the test moves it.
  const result:GatherOutcome=await Effect.runPromise(Effect.gen(function*() {
    const fiber=yield* Effect.forkChild(gatherJobEffect(f.account,{home,site,mood:'Cautious'}));
    for(let tick=0;views()<2&&tick<10;tick++) {
      yield* TestClock.adjust('1 second');
      yield* Effect.promise(()=>new Promise(resolve=>setImmediate(resolve)));
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(Layer.mergeAll(GameLive({send:f.command}),TestClock.layer()))));
  assert.equal(result.outcome,'done',result.reason);
  assert.deepEqual(result.settled?.deposited,[{item_id:'ore',quantity:4}]);
  assert.equal(views(),2);
});

// Live F-U02 (TestPilot.cv, 2026-10-02): `no_mining` read as a broken script, and its why said
// "mine failed: mine failed: no_mining: …". A refusal is a world the pilot can answer: the job is
// blocked (gatherUntil's `refused`), named once, in the server's code.
test('a mine refusal blocks the job in the server\'s code, naming the step once',async()=>{
  const f=fixture();
  f.handlers['spacemolt/mine']=()=>{throw new SpacemoltError('no_mining','No mining equipment');};
  const result=await f.run();
  assert.equal(result.outcome,'blocked');
  assert.deepEqual(result.steps.at(-1),{name:'mine',outcome:'blocked',reason:'no_mining: No mining equipment'});
  assert.equal(result.reason,'mine blocked: no_mining: No mining equipment');
});

// The journal must show what landed: a refusal after two ticks keeps their measured ore.
test('a mine refusal after ticks that landed keeps their ore in the job\'s yield',async()=>{
  const f=fixture();
  const mine=f.handlers['spacemolt/mine']!;
  let ticks=0;
  f.server.ship.cargo_capacity=30; // room for a third tick, which is refused
  f.handlers['spacemolt/mine']=params=>{if(ticks++<2)return mine(params);throw new SpacemoltError('in_battle','You are in battle');};
  const moved:MineYieldRow[][]=[];
  const result=await f.run(undefined,{onStep:(step,rows)=>{if(step.name==='mine')moved.push(rows.yield);}});
  assert.equal(result.outcome,'blocked');
  assert.equal(result.reason,'mine blocked: in_battle: You are in battle');
  assert.deepEqual(result.yield,[{item_id:'ore',quantity:4}]);
  assert.deepEqual(moved,[[{item_id:'ore',quantity:4}]]);
});

test('a reply lost to a read mid-mine fails the job, naming the read',async()=>{
  const f=fixture();
  const mine=f.handlers['spacemolt/mine']!;
  f.handlers['spacemolt/mine']=params=>{f.account.refresh=async()=>{throw new ConnectionClosedError('socket closed');};return mine(params);};
  const result=await f.run();
  assert.equal(result.outcome,'failed');
  assert.equal(result.reason,'mine failed: refresh: ConnectionClosedError: socket closed');
});
