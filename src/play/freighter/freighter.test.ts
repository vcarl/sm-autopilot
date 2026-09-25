import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{mock} from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {check} from '../../run.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../../test-support/bridge-world.ts';
import {assign,reassign,tiedUp} from '../fleet/fleet.ts';
import {menu,renderMenu} from '../menu.ts';
import {acct,bind,unbind} from '../runtime.ts';
import {REST_TICKS,routes,type Circuit} from '../trading/trading.ts';
import {markDrained,ring} from './drained.ts';
import {gate,launch,readFleet,recallLoop,REPLAN_TICKS,script,scriptPath,writeFleet,type Entry} from './host.ts';
import {lap,type Freighter,type Lap,type Report} from './index.ts';

// Gems bought at sol for at most 110, sold at range for at least 120.
const GEMS:Circuit={closed:true,hold:10,lap_jumps:2,lap_net:500,stops:[
  {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:10,max_price:110},sell:[]},
  {at:'range_base',system_id:'deep_range',sell:[{item:'gem',min_price:120}]}]};

/** A freighter over the fake world, its deposits and reports recorded. `refuse` names commands the game refuses. */
function freighter(rangeBid:number,refuse:string[]=[],options:WorldOptions={}) {
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[{item_id:'ore',quantity:5}],cargoUsed:5,cargoCapacity:50,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:rangeBid,best_buy_qty:50,best_sell:0,best_sell_qty:0},
        {item_id:'ore',best_buy:999,best_buy_qty:99,best_sell:0,best_sell_qty:0}]},...options});
  world.account.server.player.credits=50_000;
  const deposits:{credits:number;wallet:number}[]=[],reports:Report[]=[];
  const command:ReadinessCommand=async(action,params)=>{
    if(refuse.includes(action))throw new SpacemoltError('refused',`${action} refused`);
    if(action==='spacemolt_storage/deposit'&&params.credits!==undefined) {
      deposits.push({credits:Number(params.credits),wallet:world.account.server.player.credits});
      world.account.server.player.credits-=Number(params.credits);
      return {delta:{details:{action:'send_gift'}}};
    }
    return world.command(action,params);
  };
  let parked:string|undefined,drained:number|undefined;
  const f:Freighter={name:'hauler',account:world.account as unknown as ReadinessAccount,command,owner:'B',float:5_000,
    recalled:()=>false,park:(why,tick)=>{parked=why;drained=tick;return {park:why,net:0};},report:fields=>{reports.push(fields);}};
  return {world,f,deposits,reports,parked:()=>parked,drained:()=>drained};
}

test('a lap sells only the listed items at their floors, buys within the cap, and sends home exactly what is above the float',async()=>{
  const {world,f,deposits,reports}=freighter(115);
  await world.account.refresh();
  const done=await lap(f,GEMS);
  assert.equal(done.park,undefined,reports.map(r=>r.why).filter(Boolean).join('; '));
  assert.equal(world.count('spacemolt/sell'),0,'gems bid 115 under the 120 floor, and the ore bid 999 is not on the list');
  assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/buy').map(c=>c.params),[{id:'gem',quantity:10}]);
  assert.equal(world.account.server.location.docked_at,'range_base');
  assert.equal(deposits.length,1,'sent home from sol; at range nothing sold and the refuel left it under the float');
  assert.equal(deposits[0]!.credits,deposits[0]!.wallet-f.float);
  assert.ok(world.account.server.player.credits<=f.float);
  assert.equal(reports.filter(r=>r.lapped!==undefined).length,1);
  assert.equal(world.count('spacemolt_intel/submit_trade_intel'),2,'no faction: filing is tried at each stop, one failure disables nothing');
  assert.deepEqual(reports.filter(r=>r.why?.startsWith('trade intel')).map(r=>r.why),
    ['trade intel not filed at sol_base: You are not in a faction'],'said once');
});

test('a lap sells at a bid over the floor',async()=>{
  const {world,f,deposits}=freighter(130);
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/sell').map(c=>c.params),[{id:'gem',quantity:10}]);
  assert.equal(deposits.length,2,'the sale at range goes home too');
  for(const {credits,wallet} of deposits)assert.equal(credits,wallet-f.float);
});

test('a refused buy is skipped, not thrown, and three stops in a row with no trade park the circuit',async()=>{
  const {world,f,reports,parked,drained}=freighter(130,['spacemolt/buy']);
  await world.account.refresh();
  let laps=0,last:Lap;
  do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
  assert.match(last.park!,/^circuit dead/);
  assert.equal(parked(),last.park);
  assert.equal(laps,2,'sol, range, then sol again');
  assert.equal(drained(),TICK,'parked as drained, on the tick of the book it last read');
  assert.ok(reports.some(r=>/buy 10 gem refused/.test(r.why??'')));
});

test('a genuine no-price circuit (every ask over the cap) still parks as drained',async()=>{
  const {world,f,parked,drained}=freighter(130,[],{markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:200,best_sell_qty:50}]}});
  await world.account.refresh();
  let laps=0,last:Lap;
  do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
  assert.match(parked()!,/^circuit dead/);
  assert.equal(drained(),TICK);
});

test('a hold full of cargo the circuit never sells parks naming that cargo, and the ring is not drained (live: 100 copper_wiring after a recall)',async()=>{
  const {world,f,parked,drained}=freighter(130,[],{cargo:[{item_id:'copper_wiring',quantity:50}],cargoUsed:50,cargoCapacity:50});
  await world.account.refresh();
  let laps=0,last:Lap;
  do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
  assert.equal(parked(),'hold full of 50 copper_wiring this circuit never sells and no stop on it bids at or above its cost, so it cannot buy; assign it a circuit that sells that cargo');
  assert.equal(drained(),undefined,'not recorded as drained');
});

/** A freighter whose 50-unit hold is full of 50 copper_piping it bought at 30 a unit, sol bidding `bid` for it. */
function leftover(bid:number,holding:Freighter['holding']={copper_piping:{quantity:50,cost:1500}}) {
  const h=freighter(130,[],{cargo:[{item_id:'copper_piping',quantity:50}],cargoUsed:50,cargoCapacity:50,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50},
      {item_id:'copper_piping',best_buy:bid,best_buy_qty:99,best_sell:0,best_sell_qty:0}],
      range_base:[{item_id:'gem',best_buy:130,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}});
  h.f.holding=holding;
  return h;
}

test('leftover cargo the circuit never sells is sold where the bid covers its cost, before the buys, which then fit (live: 98 copper_piping on a ring without it)',async()=>{
  const {world,f,reports}=leftover(36);
  await world.account.refresh();
  const done=await lap(f,GEMS);
  assert.equal(done.park,undefined);
  const trades=world.sent.filter(c=>c.action==='spacemolt/sell'||c.action==='spacemolt/buy').map(c=>[c.action,c.params]);
  assert.deepEqual(trades.slice(0,2),[['spacemolt/sell',{id:'copper_piping',quantity:50}],['spacemolt/buy',{id:'gem',quantity:10}]]);
  assert.deepEqual(reports.flatMap(r=>r.cleared??[]),['cleared 50 copper_piping at 36 (cost 30)']);
  assert.equal(reports.at(-1)!.holding?.copper_piping,undefined,'gone from the holding');
});

test('leftover cargo is kept where the bid is under its cost, and cargo it never bought is never sold',async()=>{
  for(const [bid,holding] of [[29,undefined],[999,{}]] as const) {
    const {world,f,parked}=leftover(bid,holding);
    await world.account.refresh();
    let laps=0,last:Lap;
    do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
    assert.equal(world.count('spacemolt/sell'),0,`bid ${bid}`);
    assert.match(parked()!,/^hold full of 50 copper_piping this circuit never sells and no stop on it bids at or above its cost/);
  }
});

test('a recalled freighter buys nothing more at the stop it parks after',async()=>{
  const {world,f,parked}=freighter(130);
  f.recalled=()=>true;
  await world.account.refresh();
  await lap(f,GEMS);
  assert.equal(parked(),'recalled');
  assert.equal(world.count('spacemolt/buy'),0);
});

test('assign proceeds with cargo the new circuit never sells, and says what it ties up of the hold',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-tied-'));
  const world=bridgeWorld({tradeIntel:[{base_id:'sol_base',items:[{item_id:'gem',best_buy:0,best_sell:100,sell_volume:50}]},
    {base_id:'range_base',items:[{item_id:'gem',best_buy:130,buy_volume:50}]}]});
  (world.account.server.player as {username?:string}).username='B';
  writeFleet(runtime,{hauler:{state:'parked',circuit:GEMS,float:5_000,owner:'B',lap:3,returned:0,
    holding:{copper_wiring:{quantity:4,cost:40}},why:'recalled',at:''}});
  bind({account:world.account as unknown as ReadinessAccount,command:world.command,pilot:()=>({mood:'Focused'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    await world.account.refresh();
    // Past every check, cargo included: only the operator's login is missing (a start would fly live).
    assert.match((await assign('hauler',GEMS,{float:5_000})).why!,/^no login at /);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  assert.equal(tiedUp({copper_wiring:{quantity:4,cost:40}},GEMS),
"carrying 4 copper_wiring the circuit never sells; it fills 4 of 10 hold, so it's sold at cost or better wherever the circuit meets a bid for it; until then the circuit buys into 6");
  assert.equal(tiedUp({copper_wiring:{quantity:10,cost:40}},GEMS),
"carrying 10 copper_wiring the circuit never sells; it fills 10 of 10 hold, so it's sold at cost or better wherever the circuit meets a bid for it; until then the circuit buys into 0");
  assert.equal(tiedUp({gem:{quantity:10,cost:900}},GEMS),undefined,'a circuit that sells it all says nothing');
});

test('assign refuses an open path, and writes nothing',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-assign-'));
  const world=bridgeWorld({});
  bind({account:world.account as unknown as ReadinessAccount,command:world.command,pilot:()=>({mood:'Focused'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    const open={...GEMS,closed:false} as unknown as Circuit;
    const out=await assign('hauler',open,{float:20_000});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/an open path would strand a freighter that repeats it; use routes\(\{circuit:\{hold\}\}\)/);
    const oneWay=await assign('hauler',{...GEMS,stops:[GEMS.stops[0]!]},{float:20_000});
    assert.match(oneWay.why!,/fewer than 2 distinct stops/);
    assert.equal(existsSync(scriptPath(runtime,'hauler')),false);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('assign takes a circuit whose bases are known only from the faction ledger, and refuses a base known nowhere as of no known system',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-ledger-'));
  const world=bridgeWorld({tradeIntel:[{base_id:'sol_base',items:[{item_id:'gem',best_buy:0,best_sell:100,sell_volume:50}]},
    {base_id:'range_base',items:[{item_id:'gem',best_buy:130,buy_volume:50}]}]});
  (world.account.server.player as {username?:string}).username='B';
  bind({account:world.account as unknown as ReadinessAccount,command:world.command,pilot:()=>({mood:'Focused'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    await world.account.refresh();
    const out=await assign('hauler',GEMS,{float:20_000});
    // Past every check on the circuit: only the operator's login is missing.
    assert.match(out.why!,/^no login at /);
    assert.deepEqual(gate(scriptPath(runtime,'hauler')),[]);
    const written=readFileSync(scriptPath(runtime,'hauler'),'utf8');
    assert.ok(written.includes('"buys": [')&&!written.includes('"buy":'),'a one-buy circuit is written as buys');
    const stray={...GEMS,stops:[GEMS.stops[0]!,{...GEMS.stops[1]!,at:'nowhere_base'}]};
    const lost=await assign('hauler',stray,{float:20_000});
    assert.equal(lost.status,'refused');
    assert.match(lost.why!,/^nowhere_base: no book for it remembered or on the faction ledger, so its system is unknown/);
    assert.doesNotMatch(lost.why!,/open path/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a generated freighter script passes the gate: tsc, and play/freighter as its only import',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-script-'));
  try {
    mkdirSync(join(runtime,'freighters'));
    writeFileSync(scriptPath(runtime,'hauler'),script(GEMS));
    assert.deepEqual(gate(scriptPath(runtime,'hauler')),[]);
    mkdirSync(join(runtime,'pilot'));
    writeFileSync(join(runtime,'pilot','index.ts'),script(GEMS));
    const typed=await check(runtime);
    assert.deepEqual(typed.errors,[]);
    writeFileSync(scriptPath(runtime,'hauler'),`import {lap} from 'play/freighter';\nimport {goTo} from 'play';\nexport default async function main() {}\n`);
    assert.match(gate(scriptPath(runtime,'hauler')).join(),/imports "play"; a freighter script imports only 'play\/freighter'/);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('three laps in a row that lose money park the freighter, the why naming the last lap against the prediction',async()=>{
  // Gems cost 100 at sol and sell for 100 at range: every lap pays out its fuel and repairs and makes nothing.
  const {world,f,parked,drained}=freighter(100);
  await world.account.refresh();
  const flat:Circuit={...GEMS,stops:[GEMS.stops[0]!,{...GEMS.stops[1]!,sell:[{item:'gem',min_price:90}]}]};
  const laps:Lap[]=[];
  do laps.push(await lap(f,flat)); while(!laps.at(-1)!.park&&laps.length<5);
  assert.equal(laps.length,3);
  assert.ok(laps.every(one=>one.net<=0),laps.map(one=>one.net).join());
  assert.equal(parked(),`3 laps lost money: last ${laps[2]!.net} vs predicted 500`);
  assert.equal(drained(),TICK);
  assert.equal(world.account.server.location.docked_at,'range_base','parked docked at the last stop');
});

test('a lap that keeps its load values it at cost: the live lap 3 reads its fuel, not -1190, and holding says what is aboard',async()=>{
  // Live: 40 copper_piping bought at procyon for 1120 + 28 tax; nova's bid fell under the 36 floor
  // and the load stayed aboard. Here gems stand in for copper, and range's 115 bid is under the 120 floor.
  const {world,f,deposits,reports}=freighter(115);
  const send=f.command;
  f.command=async(action,params)=>{
    const reply=await send(action,params);
    // The fake charges 12 a unit: make it the live 28 a unit and 2.5% tax, 1148 for 40.
    if(action==='spacemolt/buy')world.account.server.player.credits-=Number(params.quantity)*16+Math.floor(Number(params.quantity)*28*0.025);
    return reply;
  };
  world.account.server.player.credits=23_000;
  f.float=23_000;
  const copper:Circuit={...GEMS,stops:[{...GEMS.stops[0]!,buy:{item:'gem',qty:40,max_price:110}},GEMS.stops[1]!]};
  await world.account.refresh();
  const done=await lap(f,copper);
  assert.deepEqual(reports.findLast(r=>r.holding)!.holding,{gem:{quantity:40,cost:1148}});
  const home=deposits.reduce((sum,row)=>sum+row.credits,0);
  assert.equal(world.account.server.player.credits+home-23_000,done.net-1148,'the wallet fell by the load and the fuel');
  assert.ok(done.net<0&&done.net>-100,`${done.net}: the refuels, not the load`);
  assert.equal(reports.find(r=>r.lapped!==undefined)!.lapped,done.net);
});

test('a drained ring rests: routes passes over it and says so, and reassign assigns the next ring',async()=>{
  // Gems are asked 100 at sol (here); range bids 150 and twin, in Sol itself, bids 130. Freighter a
  // parked on sol ↔ range, which it drained 10 ticks ago, with 5 ore aboard that no gem ring sells.
  const runtime=mkdtempSync(join(tmpdir(),'freighter-rest-'));
  const book=(base_id:string,system_id:string,bid:number)=>({base_id,at:'',tick:TICK,system_id,
    items:[{item_id:'gem',best_buy:bid,best_buy_qty:50,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[]}]});
  writeFileSync(join(runtime,'markets.json'),JSON.stringify([book('range_base','deep_range',150),book('twin_base','sol',130)]));
  writeFleet(runtime,{a:{state:'parked',circuit:GEMS,float:20_000,owner:'B',lap:3,returned:0,
    holding:{ore:{quantity:5,cost:50}},why:'circuit dead: 3 stops in a row with no trade',at:''},
    b:{state:'running',circuit:GEMS,float:20_000,owner:'B',lap:1,returned:0,at:''}});
  markDrained(runtime,ring([...GEMS.stops].reverse()),TICK-10);
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[],cargoUsed:0,cargoCapacity:50,
    pois:[{id:'twin',base_id:'twin_base'}],markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}]}});
  (world.account.server.player as {username?:string}).username='B';
  bind({account:world.account as unknown as ReadinessAccount,command:world.command,pilot:()=>({mood:'Focused',stance:'Trader'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    await world.account.refresh();
    const look=await routes({circuit:{hold:10}});
    assert.deepEqual(look.detail.routes.map(row=>row.circuit!.stops.map(stop=>stop.at)),[['sol_base','twin_base']]);
    assert.match(look.did,new RegExp(`skipped 1 ring\\(s\\) a freighter drained within ${REST_TICKS} ticks: range_base sol_base$`));

    const built=await menu(runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('reassign')),'a freighter re-plans itself; the menu offers no reassign');
    assert.deepEqual(built.not_now.filter(row=>row.move.startsWith('recall')),[{move:"recall('b', {after:'lap'})",
      why:'b flies and re-plans on a drained ring by itself; this stops one after the lap it is on'}],renderMenu(built));

    // Past routes and assign's every check on the circuit: only the operator's login is missing.
    const out=await reassign('a');
    assert.match(out.why!,/^no login at /);
    const written=readFileSync(scriptPath(runtime,'a'),'utf8');
    assert.ok(written.includes('twin_base')&&!written.includes('range_base'),written);

    // Rested: the ring is planned again.
    markDrained(runtime,ring(GEMS.stops),TICK-REST_TICKS);
    const again=await routes({circuit:{hold:10}});
    assert.ok(again.detail.routes.some(row=>row.circuit!.stops.some(stop=>stop.at==='range_base')),again.did);
    assert.doesNotMatch(again.did,/skipped/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a holding sold off by hand while parked is not stock: lap 1 nets what a clean start nets, not 413 less',async()=>{
  // Live: the stored holding said 58 copper_wiring (413 cr), sold by hand while the freighter was parked.
  const clean=freighter(130),stale=freighter(130);
  stale.f.holding={copper_wiring:{quantity:58,cost:413}};
  await clean.world.account.refresh();await stale.world.account.refresh();
  const want=await lap(clean.f,GEMS),got=await lap(stale.f,GEMS);
  assert.equal(got.net,want.net);
  assert.deepEqual(Object.keys(stale.reports.findLast(r=>r.holding)!.holding!),[]);
});

test('parked, cargo sold by hand, then assigned: lap 1 counts no phantom stock, and the stale holding is corrected before stop 1 (live: 100 copper_wiring, 714 cr)',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-reassigned-'));
  const intel={tradeIntel:[{base_id:'sol_base',items:[{item_id:'gem',best_buy:0,best_sell:100,sell_volume:50}]},
    {base_id:'range_base',items:[{item_id:'gem',best_buy:130,buy_volume:50}]}]};
  const clean=freighter(130,[],intel),sold=freighter(130,[],intel);
  // Parked holding 100 copper_wiring; sold by hand since, so the hold (5 ore) has none of it.
  writeFleet(runtime,{hauler:{state:'parked',circuit:GEMS,float:5_000,owner:'B',lap:3,returned:0,
    holding:{copper_wiring:{quantity:100,cost:714}},why:'recalled',at:''}});
  (sold.world.account.server.player as {username?:string}).username='B';
  bind({account:sold.world.account as unknown as ReadinessAccount,command:sold.world.command,pilot:()=>({mood:'Focused'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    await sold.world.account.refresh();
    // Past every check: only the operator's login is missing (a start would fly live).
    assert.match((await assign('hauler',GEMS,{float:5_000})).why!,/^no login at /);
  } finally {unbind();}
  const entry=readFleet(runtime).hauler!;
  rmSync(runtime,{recursive:true,force:true});
  // What the host hands the loop: the entry's holding, as assign wrote it.
  sold.f.holding=entry.holding;
  await clean.world.account.refresh();
  const want=await lap(clean.f,GEMS),got=await lap(sold.f,GEMS);
  assert.equal(got.net,want.net,'lap 1 nets what a clean start nets, not 714 less');
  assert.deepEqual(sold.reports[0],{holding:{}},'the stale holding is said away before the first stop');
});

test('the approach to stop 1 is reported on its own and kept out of the lap net and the losing-laps count',async()=>{
  // Docked at sol, assigned a ring that starts at range: the flight to range is the approach, not lap 1.
  const {world,f,deposits,reports}=freighter(130);
  await world.account.refresh();
  const start=world.account.server.player.credits;
  const reversed:Circuit={...GEMS,stops:[GEMS.stops[1]!,GEMS.stops[0]!]};
  const done=await lap(f,reversed);
  const approach=reports.find(r=>r.approach)!.approach!;
  assert.ok(approach.jumps>0&&approach.credits>0,JSON.stringify(approach));
  const home=deposits.reduce((sum,row)=>sum+row.credits,0),stocked=reports.findLast(r=>r.holding)!.holding!.gem!.cost;
  assert.equal(world.account.server.player.credits+home-start,done.net-approach.credits-stocked,'the approach is outside the net');
  await lap(f,reversed);
  assert.equal(reports.filter(r=>r.approach).length,1,'lap 2 has no approach: sol → range is on the ring');
});

test('a lap buys and sells every item of a multi-buy stop exactly as routes ranked it',async()=>{
  // Sol asks gems at 100 and ore at 10, deep. Range bids gems 150 × 30, then 140 × 10, then 105; ore 25.
  // Lap one takes the thirty at 150; the middle lap, the one read, takes 10 gems for 140 and fills with 20 ore.
  const runtime=mkdtempSync(join(tmpdir(),'freighter-multi-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify([{base_id:'range_base',at:'',tick:TICK,system_id:'deep_range',items:[
    {item_id:'gem',best_buy:150,best_buy_qty:30,best_sell:0,best_sell_qty:0,sell_orders:[],
      buy_orders:[{price_each:150,quantity:30},{price_each:140,quantity:10},{price_each:105,quantity:1000}]},
    {item_id:'ore',best_buy:25,best_buy_qty:1000,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[]}]}]));
  const markets={sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:1000},
    {item_id:'ore',best_buy:0,best_buy_qty:0,best_sell:10,best_sell_qty:1000}],
    range_base:[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0},{item_id:'ore',best_buy:25,best_buy_qty:50,best_sell:0,best_sell_qty:0}]};
  const pilot=bridgeWorld({services:['refuel','repair','storage'],cargo:[],cargoUsed:0,cargoCapacity:30,markets});
  bind({account:pilot.account as unknown as ReadinessAccount,command:pilot.command,pilot:()=>({mood:'Focused'}),setPilot:()=>{},emit:()=>{},runtime});
  let top;
  try {
    await pilot.account.refresh();
    top=(await routes({circuit:{hold:30}})).detail.routes[0]!;
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  assert.deepEqual(top.circuit!.stops.map(stop=>[stop.at,stop.buys,stop.sell]),[
    ['sol_base',[{item:'gem',qty:10,max_price:110},{item:'ore',qty:20,max_price:11}],[]],
    ['range_base',[],[{item:'gem',min_price:126},{item:'ore',min_price:22}]]]);
  assert.equal(top.circuit!.scope?.maxStops,4,'the scope it was planned in rides on the circuit');

  const {world,f,reports}=freighter(150,[],{cargo:[],cargoUsed:0,cargoCapacity:30,markets});
  await world.account.refresh();
  const done=await lap(f,top.circuit!);
  assert.equal(done.park,undefined,reports.map(r=>r.why).filter(Boolean).join('; '));
  const sent=(action:string)=>world.sent.filter(c=>c.action===action).map(c=>[c.params.id,c.params.quantity]);
  assert.deepEqual(sent('spacemolt/buy'),top.legs[0]!.buys.map(buy=>[buy.item_id,buy.quantity]),'one command per item, as planned');
  assert.deepEqual(sent('spacemolt/sell'),top.legs[1]!.sold.map(sale=>[sale.item_id,sale.quantity]));
});

test('an entry written before buys (one buy per stop) still loads and flies, and its script passes the gate',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-old-'));
  try {
    // As the live freighters.json has it: `buy`, no `buys`, no `scope`.
    writeFileSync(join(runtime,'freighters.json'),JSON.stringify({old:{state:'running',float:5000,owner:'B',lap:2,returned:0,at:'',
      circuit:{closed:true,hold:10,lap_jumps:2,lap_net:500,stops:[
        {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:10,max_price:110},sell:[]},
        {at:'range_base',system_id:'deep_range',sell:[{item:'gem',min_price:120}]}]}}}));
    const entry=readFleet(runtime).old!;
    const {world,f}=freighter(130);
    await world.account.refresh();
    const done=await lap(f,entry.circuit);
    assert.equal(done.park,undefined);
    assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/buy').map(c=>c.params),[{id:'gem',quantity:10}]);
    assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/sell').map(c=>c.params),[{id:'gem',quantity:10}]);
    mkdirSync(join(runtime,'freighters'));
    writeFileSync(scriptPath(runtime,'old'),script(entry.circuit));
    assert.deepEqual(gate(scriptPath(runtime,'old')),[],'the old script passes the gate the host runs at restart');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a why said for a retried stop clears once the retry gets through (live: "You are not in a system" lingered for laps)',async()=>{
  const {world,f,reports}=freighter(130);
  const send=f.command;
  let jam=true;
  f.command=async(action,params)=>{
    if(action==='spacemolt_market/view_market'&&jam){jam=false;throw new Error('You are not in a system');}
    return send(action,params);
  };
  await world.account.refresh();
  mock.timers.enable({apis:['setTimeout']});
  try {
    const running=lap(f,GEMS);
    while(!reports.some(r=>/again in a minute/.test(r.why??'')))await new Promise(resolve=>setImmediate(resolve));
    mock.timers.tick(60_000);
    const done=await running;
    assert.equal(done.park,undefined);
  } finally {mock.timers.reset();}
  // The host keeps the last why a report set; the retry's arrival sets it to nothing.
  const said=reports.findIndex(r=>/not in a system/.test(r.why??''));
  assert.ok(reports.slice(said+1).some(r=>'why' in r&&r.why===undefined),JSON.stringify(reports.slice(said)));
});

// The host's loop, as it flies live but on the fake world's account, and never bound: any call to
// the play runtime singleton throws, and the loop would park with "the loop broke".
const memory=(base_id:string,system_id:string,row:Record<string,number>)=>({base_id,at:'',tick:TICK,system_id,
  items:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[],...row}]});
const SOL=memory('sol_base','sol',{best_sell:100,best_sell_qty:50}),TWIN=memory('twin_base','sol',{best_buy:130,best_buy_qty:50});
const RANGE=memory('range_base','deep_range',{best_buy:150,best_buy_qty:50});
/** `hauler` assigned GEMS over a world where range bids `rangeBid`, sol asks 100 and twin (in Sol) bids 130.
 * `known` is the owner's market memory; `hook` sees every command the freighter sends. */
function hosted(rangeBid:number,known:object[],entry:Partial<Entry>={},options:WorldOptions={},hook:(action:string)=>void=()=>{}) {
  const runtime=mkdtempSync(join(tmpdir(),'freighter-host-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify(known));
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[],cargoUsed:0,cargoCapacity:50,pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:rangeBid,best_buy_qty:50,best_sell:0,best_sell_qty:0}],
      twin_base:[{item_id:'gem',best_buy:130,best_buy_qty:50,best_sell:0,best_sell_qty:0}]},...options});
  world.account.server.player.credits=50_000;
  const command:ReadinessCommand=async(action,params)=>{
    hook(action);
    if(action!=='spacemolt_storage/deposit')return world.command(action,params);
    world.account.server.player.credits-=Number(params.credits);
    return {delta:{details:{action:'send_gift'}}};
  };
  writeFleet(runtime,{hauler:{state:'running',circuit:GEMS,float:5_000,owner:'B',lap:0,returned:0,at:'',...entry}});
  mkdirSync(join(runtime,'freighters'));
  writeFileSync(scriptPath(runtime,'hauler'),script(GEMS));
  return {runtime,world,now:()=>readFleet(runtime).hauler!,
    fly:async()=>{await world.account.refresh();return launch(runtime,'hauler',world.account as unknown as ReadinessAccount,command);},
    done:()=>rmSync(runtime,{recursive:true,force:true})};
}
/** Once it is on a new ring, stop it after that lap: how a test ends a loop that would fly on. */
const stopOnceReassigned=(h:()=>ReturnType<typeof hosted>)=>()=>{
  if(h().now().reassigned&&!h().now().stop_after_lap)recallLoop(h().runtime,'hauler','lap');
};

test('a drained park re-plans on the freighter\'s own connection, unbound, and it flies the next ring',async()=>{
  // Range bids 115, under the 120 floor: sol ↔ range drains. Sol ↔ twin pays.
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,TWIN,RANGE],{},{},stopOnceReassigned(()=>h));
  assert.throws(()=>acct(),/not bound/,'the play runtime is not bound for this');
  try {
    await h.fly();
    const entry=h.now();
    assert.deepEqual(entry.reassigned,{count:1,ring:'sol_base twin_base',lap_net:entry.circuit.lap_net},entry.why);
    assert.equal(entry.state,'parked');
    assert.equal(entry.why,'stopped after its lap, as scheduled');
    assert.equal(entry.lap,1,'a whole lap flown on the new ring');
    assert.ok(readFileSync(scriptPath(h.runtime,'hauler'),'utf8').includes('twin_base'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.runtime,'drained.json'),'utf8'))),['range_base sol_base']);
  } finally {h.done();}
});

test('with no ring that qualifies it waits docked, re-planning every REPLAN_TICKS, and flies once one appears',async()=>{
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE],{},{},stopOnceReassigned(()=>h));
  mock.timers.enable({apis:['setTimeout']});
  try {
    const flying=h.fly();
    const settle=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));};
    for(let i=0;i<1000&&h.now().state!=='waiting';i++)await settle();
    assert.equal(h.now().state,'waiting');
    assert.match(h.now().why!,/^waiting for a circuit: no route pays .*skipped 1 ring\(s\) a freighter drained/);
    // Twin's book turns up; nothing moves until the next re-plan.
    writeFileSync(join(h.runtime,'markets.json'),JSON.stringify([SOL,TWIN,RANGE]));
    mock.timers.tick(60_000);await settle();
    assert.equal(h.now().state,'waiting');
    for(let waited=60_000;waited<REPLAN_TICKS*10_000;waited+=60_000){mock.timers.tick(60_000);await settle();}
    await flying;
    assert.equal(h.now().reassigned?.ring,'sol_base twin_base');
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
  } finally {mock.timers.reset();h.done();}
});

test('a freighter scheduled to stop after its lap finishes the lap, selling, and parks without re-planning',async()=>{
  const h=hosted(130,[SOL,TWIN],{stop_after_lap:true});
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
    assert.equal(h.now().lap,1);
    assert.equal(h.world.count('spacemolt/sell'),1,'the lap sold at range');
    assert.equal(h.now().reassigned,undefined);
  } finally {h.done();}
});

test('a plain recall parks after the stop and never re-plans, on a ring that would drain',async()=>{
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,TWIN],{},{},action=>{if(action==='spacemolt_market/view_market')recallLoop(h.runtime,'hauler');});
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.equal(h.now().why,'recalled');
    assert.equal(h.now().reassigned,undefined);
    assert.ok(readFileSync(scriptPath(h.runtime,'hauler'),'utf8').includes('range_base'),'the script is the one assigned');
  } finally {h.done();}
});

test('a hold full of cargo no circuit sells tries one re-plan, then stays parked with the blocking why, without looping',async()=>{
  const h=hosted(130,[SOL,TWIN],{},{cargo:[{item_id:'copper_wiring',quantity:50}],cargoUsed:50,cargoCapacity:50});
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.match(h.now().why!,/^hold full of 50 copper_wiring this circuit never sells/);
    assert.equal(h.now().reassigned,undefined);
    assert.equal(h.world.count('spacemolt/get_map'),1,'planned once');
    assert.equal(existsSync(join(h.runtime,'drained.json')),false,'the ring is not drained');
  } finally {h.done();}
});
