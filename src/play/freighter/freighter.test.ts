import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{mock} from 'node:test';
import {Account,ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect,Fiber,Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {check} from '../../run.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../../test-support/bridge-world.ts';
import {assign,reassign,tiedUp} from '../fleet/fleet.ts';
import {journalCommand,quoteNext,readJournal} from '../../run-record.ts';
import {GameLive} from '../game.ts';
import {knownBooks,rememberBook} from '../market.ts';
import {menuEffect,renderMenu} from '../menu.ts';
import {readPlaces} from '../places.ts';
import {acct,bind,onBinding,unbind} from '../runtime.ts';
const menu=(runtime?:string)=>onBinding(menuEffect(runtime));
import {REST_TICKS,routes,type Circuit} from '../trading/trading.ts';
import {markDrained,ring} from './drained.ts';
import {BOOK_TTL_MS,gate,launch,market,mender,readFleet,recallLoop,RECONNECT_MS,REPLAN_TICKS,row,script,scriptPath,stopFreighters,writeFleet,type Entry} from './host.ts';
import {IGNORE_TICKS,lap,STALE_TICKS,type Freighter,type Lap,type Report} from './index.ts';
import {lapEffect} from './lap.ts';

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
  assert.equal(world.count('spacemolt_intel/submit_trade_intel'),0,'no faction in the player state: nothing is filed');
  assert.equal(reports.filter(r=>r.why?.startsWith('trade intel')).length,0);
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

test('a hold full of cargo the circuit never sells that no store takes parks naming that cargo, and the ring is not drained (live: 100 copper_wiring after a recall)',async()=>{
  const {world,f,parked,drained}=freighter(130,['spacemolt_storage/deposit'],{cargo:[{item_id:'copper_wiring',quantity:50}],cargoUsed:50,cargoCapacity:50});
  await world.account.refresh();
  let laps=0,last:Lap;
  do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
  assert.equal(parked(),'hold full of 50 copper_wiring this circuit never sells, no stop on it bids at or above its cost and storage refused it, so it cannot buy; assign it a circuit that sells that cargo');
  assert.equal(drained(),undefined,'not recorded as drained');
});

/** A freighter whose 50-unit hold is full of 50 copper_piping it bought at 30 a unit, sol bidding `bid` for it. */
function leftover(bid:number,holding:Freighter['holding']={copper_piping:{quantity:50,cost:1500}}) {
  const h=freighter(130,[],{cargo:[{item_id:'copper_piping',quantity:50}],cargoUsed:50,cargoCapacity:50,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50},
      {item_id:'copper_piping',best_buy:bid,best_buy_qty:99,best_sell:0,best_sell_qty:0}],
      range_base:[{item_id:'gem',best_buy:130,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}});
  h.f.holding=holding!;
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

test('a new circuit stows leftover it cannot sell at cost at its first stop, for the owner, only down to 40% free, and lap 1 buys a full load and pays (live: 98% of the hold copper, laps of -15 and -44)',async()=>{
  const nets:number[]=[];
  for(const [bid,holding,said,rides] of [[29,undefined,'20 copper_piping (cost 600) at sol_base for B',{quantity:30,cost:900}],[999,{},'20 copper_piping at sol_base for B',undefined]] as const) {
    const {world,f,reports}=leftover(bid,holding);
    await world.account.refresh();
    const done=await lap(f,GEMS);
    assert.equal(done.park,undefined);
    assert.equal(world.count('spacemolt/sell'),1,`bid ${bid}: only the gems at range; under its cost, or never bought, copper is not sold`);
    const trades=world.sent.filter(c=>c.action==='spacemolt/buy'||(c.action==='spacemolt_storage/deposit'&&c.params.item_id)).map(c=>[c.action,c.params]);
    assert.deepEqual(trades,[['spacemolt_storage/deposit',{target:'B',item_id:'copper_piping',quantity:20}],['spacemolt/buy',{id:'gem',quantity:10}]]);
    assert.deepEqual(reports.flatMap(r=>r.stowed??[]),[said]);
    assert.deepEqual(reports.findLast(r=>r.holding)!.holding!.copper_piping,rides,'the 30 it keeps ride on in the holding, at cost');
    nets.push(done.net);
  }
  assert.equal(nets[0],nets[1],'the 600 of copper stowed went to the owner, not a loss of the lap\'s: it nets what a lap stowing untracked cargo nets');
});

test('the owner\'s store refused, the leftover goes to the freighter\'s own',async()=>{
  const {world,f,reports}=leftover(29);
  const send=f.command;
  f.command=async(action,params)=>{
    if(action==='spacemolt_storage/deposit'&&params.item_id&&params.target)throw new SpacemoltError('refused','no gifts here');
    return send(action,params);
  };
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(reports.flatMap(r=>r.stowed??[]),['20 copper_piping (cost 600) at sol_base in its own storage']);
  assert.ok(reports.some(r=>/stow 20 copper_piping for B refused/.test(r.why??'')));
  assert.equal(world.count('spacemolt/buy'),1);
});

test('at a lap\'s end, cargo no stop sells is stowed and leaves holding; the circuit\'s own cargo, unsold under its floor, stays though the hold is short of 40% free',async()=>{
  // Sol sells gems and copper; the circuit buys both, a full hold, but sells only gems, at range, whose 115 bid is under the 120 floor.
  const {world,f,reports}=freighter(115,[],{cargo:[],cargoUsed:0,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50},{item_id:'copper_piping',best_buy:0,best_buy_qty:0,best_sell:20,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:115,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}});
  const both:Circuit={...GEMS,stops:[{at:'sol_base',system_id:'sol',buys:[{item:'gem',qty:40,max_price:110},{item:'copper_piping',qty:10,max_price:30}],sell:[]},GEMS.stops[1]!]};
  await world.account.refresh();
  await lap(f,both);
  const stows=world.sent.filter(c=>c.action==='spacemolt_storage/deposit'&&c.params.item_id);
  assert.deepEqual(stows.map(c=>c.params),[{target:'B',item_id:'copper_piping',quantity:10}],'all the copper, none of the 40 gems');
  assert.equal(world.account.server.location.docked_at,'range_base','at the last stop');
  assert.match(reports.flatMap(r=>r.stowed??[])[0]!,/^10 copper_piping \(cost \d+\) at range_base for B$/);
  assert.deepEqual(Object.keys(reports.findLast(r=>r.holding)!.holding!),['gem'],'the gems stay aboard, the copper is gone');
});

/** A 100-hold freighter on GEMS carrying `cargo` (none of it gems), its holding `holding`; `range` rows added to range's book. */
function roomy(cargo:{item_id:string;quantity:number}[],holding:Freighter['holding'],range:object[]=[]) {
  const h=freighter(130,[],{cargo,cargoUsed:cargo.reduce((sum,row)=>sum+row.quantity,0),cargoCapacity:100,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:130,best_buy_qty:50,best_sell:0,best_sell_qty:0},...range] as never}});
  h.f.holding=holding!;
  return h;
}
const stowsOf=(world:ReturnType<typeof freighter>['world'])=>world.sent.filter(c=>c.action==='spacemolt_storage/deposit'&&c.params.item_id).map(c=>c.params);

test('90 unplanned units in a 100 hold: stowed cheapest a unit first, never-bought first, only to 40 free',async()=>{
  const {world,f}=roomy([{item_id:'copper_piping',quantity:40},{item_id:'gold_ore',quantity:30},{item_id:'rock',quantity:20}],
    {copper_piping:{quantity:40,cost:1600},gold_ore:{quantity:30,cost:300}});
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(stowsOf(world),[{target:'B',item_id:'rock',quantity:20},{target:'B',item_id:'gold_ore',quantity:10}],
    '10 free to 40: 20 rock (cost 0), then 10 of the 10-a-unit gold, the 40-a-unit copper kept');
  assert.equal(world.count('spacemolt/buy'),1);
});

test('a full 100 hold of unplanned cargo stows exactly 40, to 40 free',async()=>{
  const {world,f}=roomy([{item_id:'copper_piping',quantity:90},{item_id:'rock',quantity:10}],{copper_piping:{quantity:90,cost:2700}});
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(stowsOf(world),[{target:'B',item_id:'rock',quantity:10},{target:'B',item_id:'copper_piping',quantity:30}]);
});

test('50 unplanned units in a 100 hold, already 40% free or more: nothing is stowed',async()=>{
  const {world,f}=roomy([{item_id:'copper_piping',quantity:50}],{copper_piping:{quantity:50,cost:1500}});
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(stowsOf(world),[]);
});

test('leftover kept aboard past the stow is cleared at a later stop whose bid covers its cost',async()=>{
  const {world,f,reports}=roomy([{item_id:'copper_piping',quantity:100}],{copper_piping:{quantity:100,cost:3000}},
    [{item_id:'copper_piping',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]);
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(stowsOf(world),[{target:'B',item_id:'copper_piping',quantity:40}]);
  assert.deepEqual(reports.flatMap(r=>r.cleared??[]),['cleared 60 copper_piping at 40 (cost 30)'],'at range, not sol, which bids nothing for it');
  assert.equal(reports.findLast(r=>r.holding)!.holding!.copper_piping,undefined);
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
  bind({account:world.account as unknown as Account,command:world.command,pilot:()=>({mood:'Focused'}),
    emit:()=>{},runtime});
  try {
    await world.account.refresh();
    // Past every check, cargo included: only the operator's login is missing (a start would fly live).
    assert.match((await assign('hauler',GEMS,{float:5_000})).why!,/^no login at /);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  assert.equal(tiedUp({copper_wiring:{quantity:4,cost:40}},GEMS),
"carrying 4 copper_wiring the circuit never sells (4 of 10 hold); it's sold at the first stop if the bid there covers its cost, else stowed there for you only down to 40% free; the rest rides along and sells at cost where a bid covers it");
  assert.equal(tiedUp({gem:{quantity:10,cost:900}},GEMS),undefined,'a circuit that sells it all says nothing');
});

test('assign refuses an open path, and writes nothing',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-assign-'));
  const world=bridgeWorld({});
  bind({account:world.account as unknown as Account,command:world.command,pilot:()=>({mood:'Focused'}),
    emit:()=>{},runtime});
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
  bind({account:world.account as unknown as Account,command:world.command,pilot:()=>({mood:'Focused'}),
    emit:()=>{},runtime});
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
  bind({account:world.account as unknown as Account,command:world.command,pilot:()=>({mood:'Focused',stance:'Trader'}),
    emit:()=>{},runtime});
  try {
    await world.account.refresh();
    const look=await routes({circuit:{hold:10}});
    assert.deepEqual(look.detail.routes.map(row=>row.circuit!.stops.map(stop=>stop.at)),[['sol_base','twin_base']]);
    assert.match(look.did,new RegExp(`skipped 1 ring\\(s\\) a freighter drained within ${REST_TICKS} ticks: range_base sol_base$`));

    const built=await menu(runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('reassign')),'a freighter re-plans itself; the menu offers no reassign');

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
  bind({account:sold.world.account as unknown as Account,command:sold.world.command,pilot:()=>({mood:'Focused'}),
    emit:()=>{},runtime});
  try {
    await sold.world.account.refresh();
    // Past every check: only the operator's login is missing (a start would fly live).
    assert.match((await assign('hauler',GEMS,{float:5_000})).why!,/^no login at /);
  } finally {unbind();}
  const entry=readFleet(runtime).hauler!;
  rmSync(runtime,{recursive:true,force:true});
  // What the host hands the loop: the entry's holding, as assign wrote it.
  sold.f.holding=entry.holding!;
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
  bind({account:pilot.account as unknown as Account,command:pilot.command,pilot:()=>({mood:'Focused'}),emit:()=>{},runtime});
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
    if(action==='spacemolt_market/view_market'&&jam){jam=false;throw new SpacemoltError('not_in_system','You are not in a system');}
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

/** `lap`s flown under mocked timers, a minute passing whenever one waits, until a park or `max` laps. */
async function flown(f:Freighter,circuit:Circuit,max=5):Promise<{last:Lap;laps:number}> {
  mock.timers.enable({apis:['setTimeout']});
  try {
    let laps=0,last:Lap;
    do {
      let done=false;
      const running=lap(f,circuit).finally(()=>{done=true;});
      while(!done){await new Promise(resolve=>setImmediate(resolve));mock.timers.tick(60_000);}
      last=await running;laps++;
    } while(!last.park&&laps<max);
    return {last,laps};
  } finally {mock.timers.reset();}
}
// Range remembered in Sol: where a mobile station was when the circuit was planned.
const STALE:Circuit={...GEMS,stops:[GEMS.stops[0]!,{...GEMS.stops[1]!,system_id:'sol'}]};
const GONE="It's called a Mobile Capital for a reason — it's not here right now. Jump to The Telescope to find it.";

test('a stop that fails STOP_TRIES times is skipped for the lap, the lap goes on, and three idle stops park the ring as drained (live: frontier_station retried for hours)',async()=>{
  const {world,f,reports,parked,drained}=freighter(130);
  const send=f.command;
  let tries=0;
  f.command=async(action,params)=>{
    if(action==='spacemolt/find_route'&&params.id==='range_base'){tries++;throw new SpacemoltError('unreachable','range unreachable');}
    return send(action,params);
  };
  await world.account.refresh();
  const {last,laps}=await flown(f,GEMS);
  assert.equal(laps,2,'lap 1: sol buys, range skipped; lap 2: sol has nothing to buy, range skipped');
  assert.equal(last.park,'circuit dead: 3 stops in a row with no trade');
  assert.equal(parked(),last.park);
  assert.equal(drained(),TICK,'drained, so the host re-plans it');
  assert.equal(tries,6,'three tries a lap, no more');
  assert.equal(reports.filter(r=>r.why==='range_base: skipped this lap after 3 tries: range unreachable').length,2);
  assert.equal(reports.filter(r=>r.lapped!==undefined).length,1,'the skipping lap still ends');
});

test('a base away from its circuit system is flown to where find_route places it now, and a "not here right now" is retried and visited (live: Mobile Capital)',async()=>{
  const {world,f,reports}=freighter(130);
  const send=f.command;
  let jam=true;
  f.command=async(action,params)=>{
    if(action==='spacemolt/travel'&&jam){jam=false;throw new SpacemoltError('not_here',GONE);}
    return send(action,params);
  };
  await world.account.refresh();
  const circuit=structuredClone(STALE);
  const {last}=await flown(f,circuit,1);
  assert.equal(last.park,undefined,reports.map(r=>r.why).filter(Boolean).join('; '));
  assert.deepEqual(reports.flatMap(r=>r.moved??[]),[{at:'range_base',system_id:'deep_range'},{at:'range_base'}]);
  assert.equal(circuit.stops[1]!.system_id,'deep_range','the circuit in memory follows it');
  assert.equal(world.account.server.location.docked_at,'range_base');
  assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/sell').map(c=>c.params),[{id:'gem',quantity:10}]);
});

// The host's loop, as it flies live but on the fake world's account, and never bound: any call to
// the play runtime singleton throws, and the loop would park with "the loop broke".
const memory=(base_id:string,system_id:string,row:Record<string,number>)=>({base_id,at:'',tick:TICK,system_id,
  items:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[],...row}]});
const SOL=memory('sol_base','sol',{best_sell:100,best_sell_qty:50}),TWIN=memory('twin_base','sol',{best_buy:130,best_buy_qty:50});
const RANGE=memory('range_base','deep_range',{best_buy:150,best_buy_qty:50});
/** `hauler` assigned GEMS over a world where range bids `rangeBid`, sol asks 100 and twin (in Sol) bids 130.
 * `known` is the owner's market memory; `hook` sees every command the freighter sends. */
function hosted(rangeBid:number,known:object[],entry:Partial<Entry>={},options:WorldOptions={},hook:(action:string,params:Record<string,unknown>)=>void=()=>{}) {
  const runtime=mkdtempSync(join(tmpdir(),'freighter-host-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify(known));
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[],cargoUsed:0,cargoCapacity:50,pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:rangeBid,best_buy_qty:50,best_sell:0,best_sell_qty:0}],
      twin_base:[{item_id:'gem',best_buy:130,best_buy_qty:50,best_sell:0,best_sell_qty:0}]},...options});
  world.account.server.player.credits=50_000;
  const command:ReadinessCommand=async(action,params)=>{
    hook(action,params);
    if(action!=='spacemolt_storage/deposit'||params.item_id)return world.command(action,params);
    world.account.server.player.credits-=Number(params.credits);
    return {delta:{details:{action:'send_gift'}}};
  };
  writeFleet(runtime,{hauler:{state:'running',circuit:GEMS,float:5_000,owner:'B',lap:0,returned:0,at:'',...entry}});
  mkdirSync(join(runtime,'freighters'));
  writeFileSync(scriptPath(runtime,'hauler'),script(entry.circuit??GEMS));
  return {runtime,world,now:()=>readFleet(runtime).hauler!,
    fly:async(opts:Parameters<typeof launch>[4]={},account=world.account as unknown as ReadinessAccount)=>{
      await world.account.refresh();return launch(runtime,'hauler',account,command,opts);},
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
    // Every base within SCOUT_JUMPS has a fresh book and every system a placed base: nothing to scout.
    assert.equal(h.now().scouted,undefined);
    assert.ok(!readJournal(h.runtime,4000).some(e=>e.scouting),'no hop flown');
    assert.equal(h.world.account.server.location.docked_at,'range_base','docked where it parked');
    // Twin's book turns up; nothing moves until the next re-plan.
    rememberBook(h.runtime,TWIN.base_id,TWIN.system_id,TWIN.items as never,TICK);
    mock.timers.tick(60_000);await settle();
    assert.equal(h.now().state,'waiting');
    for(let waited=60_000;waited<REPLAN_TICKS*10_000;waited+=60_000){mock.timers.tick(60_000);await settle();}
    await flying;
    assert.equal(h.now().reassigned?.ring,'sol_base twin_base');
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
  } finally {mock.timers.reset();h.done();}
});

/** The ring drained and the lap parked: from here the host's re-plan is what sends. */
const drainedYet=(runtime:string)=>readJournal(runtime,4000).some(line=>line.parked!==undefined&&line.drained!==undefined);
const settleAll=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));};
test('a re-plan whose routes read the server refuses waits with that refusal in its why and the journal, and writes no defect line',async()=>{
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE],{},{},action=>{
    if(action==='spacemolt_market/view_market'&&drainedYet(h.runtime))throw new SpacemoltError('rate_limited','slow down');
  });
  mock.timers.enable({apis:['setTimeout']});
  try {
    const flying=h.fly();
    for(let i=0;i<1000&&h.now().state!=='waiting';i++)await settleAll();
    assert.equal(h.now().state,'waiting');
    assert.match(h.now().why!,/rate_limited/,'the code is in the why');
    const journal=readJournal(h.runtime,4000);
    assert.deepEqual(journal.filter(line=>line.event==='defect'),[]);
    assert.ok(journal.some(line=>line.freighter==='hauler'&&/rate_limited/.test(String(line.candidates_unread))),'the unread scout list is journalled under its name');
    stopFreighters();
    mock.timers.tick(REPLAN_TICKS*10_000);await settleAll();
    await flying;
  } finally {mock.timers.reset();h.done();}
});

test('the bridge stopping in the middle of a re-plan ends the loop there: no wait, no scouting, no defect line, no "loop broke"',async()=>{
  let stopped=false;
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE],{},{},action=>{
    if(action==='spacemolt_market/view_market'&&!stopped&&drainedYet(h.runtime)){stopped=true;stopFreighters();}
  });
  try {
    await h.fly();
    assert.equal(stopped,true,'the stop was raised from inside the re-plan');
    assert.ok(!/waiting for a circuit/.test(h.now().why??''),'it did not go on to wait: '+h.now().why);
    assert.ok(!/the loop broke/.test(h.now().why??''),h.now().why);
    const journal=readJournal(h.runtime,4000);
    assert.deepEqual(journal.filter(line=>line.event==='defect'),[]);
    assert.ok(!journal.some(line=>line.waiting!==undefined||line.scouting!==undefined));
  } finally {h.done();}
});

test('a session taken elsewhere in the middle of a re-plan parks that freighter for good, unbound: the host settles, no defect line',async()=>{
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE],{},{},action=>{
    if(action==='spacemolt_market/view_market'&&drainedYet(h.runtime))throw new Error('session_replaced or disconnected: kicked');
  });
  assert.throws(()=>acct(),/not bound/);
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.match(h.now().why??'',/^the loop broke: session_replaced or disconnected/);
    const journal=readJournal(h.runtime,4000);
    assert.deepEqual(journal.filter(line=>line.event==='defect'),[]);
    assert.ok(!journal.some(line=>line.loop_broke!==undefined),'not retried: another login owns the account');
  } finally {h.done();}
});

test('a bug in the middle of a re-plan breaks only that loop, journalled under its name, unbound and with no defect line; it is launched again',async()=>{
  let thrown=0;
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE],{},{},action=>{
    if(action==='spacemolt_market/view_market'&&drainedYet(h.runtime)&&thrown++===0)throw new TypeError('not a game error');
  });
  assert.throws(()=>acct(),/not bound/);
  mock.timers.enable({apis:['setTimeout']});
  try {
    const flying=h.fly();
    const broke=()=>readJournal(h.runtime,4000).find(line=>line.loop_broke!==undefined);
    for(let i=0;i<1000&&!broke();i++)await settleAll();
    assert.equal(broke()?.freighter,'hauler');
    assert.equal(broke()?.loop_broke,'not a game error');
    assert.match(h.now().why??'',/^the loop broke: not a game error; again in/);
    assert.notEqual(h.now().state,'parked','left as it was, to be launched again');
    for(let waited=0;waited<=REPLAN_TICKS*10_000&&h.now().state!=='waiting';waited+=60_000){mock.timers.tick(60_000);await settleAll();}
    assert.equal(h.now().state,'waiting','launched again, it re-plans and waits');
    assert.deepEqual(readJournal(h.runtime,4000).filter(line=>line.event==='defect'),[]);
    stopFreighters();
    mock.timers.tick(REPLAN_TICKS*10_000);await settleAll();
    await flying;
  } finally {mock.timers.reset();h.done();}
});

test('a scouting hop whose filing reply is lost never files again in that hop: the host sends a mutation once',async()=>{
  let filings=0;
  const h=scouting({reach_base:'far_reach'},(h,action,params)=>{
    if(action==='spacemolt_intel/submit_trade_intel'&&h.now().state==='scouting'&&JSON.stringify(params).includes('reach_base')) {
      filings++;
      throw new ConnectionClosedError('WebSocket connection closed');
    }
    reassignedOnce(h);
  });
  try {
    await ticking(()=>h.fly({reconnect:async()=>{}}));
    assert.equal(filings,1,'the lost filing was not sent again');
    assert.deepEqual(scoutedAt(h),['reach_base']);
    assert.equal(h.now().reassigned?.ring,'reach_base sol_base',h.now().why);
  } finally {h.done();}
});

test('a freighter scheduled to stop after its lap finishes the lap, selling, and parks without re-planning',async()=>{
  // Range's book known: a buy is sized by what a later stop is known to take.
  const h=hosted(130,[SOL,TWIN,RANGE],{stop_after_lap:true});
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
    assert.equal(h.now().lap,1);
    assert.equal(h.world.count('spacemolt/sell'),1,'the lap sold at range');
    assert.equal(h.now().reassigned,undefined);
  } finally {h.done();}
});

test('a base found moved is recorded mobile, and placed where it is now, for the owner\'s routes()',async()=>{
  const h=hosted(130,[SOL,TWIN],{stop_after_lap:true,circuit:STALE});
  try {
    await h.fly();
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
    assert.deepEqual(JSON.parse(readFileSync(join(h.runtime,'mobile.json'),'utf8')),['range_base']);
    assert.equal(JSON.parse(readFileSync(join(h.runtime,'places.json'),'utf8')).range_base,'deep_range');
  } finally {h.done();}
});

test('what a freighter stows is kept on its entry and said by freighters(), for the owner to find',async()=>{
  const h=hosted(130,[SOL,TWIN],{stop_after_lap:true,holding:{copper_wiring:{quantity:4,cost:40}}},{cargo:[{item_id:'copper_wiring',quantity:4}],cargoUsed:4,cargoCapacity:4});
  try {
    await h.fly();
    assert.deepEqual(h.now().stowed,['2 copper_wiring (cost 20) at sol_base for B'],'a full 4 hold stows down to 2 free');
    assert.deepEqual(h.now().holding?.copper_wiring,{quantity:2,cost:20});
    assert.deepEqual(row('hauler',h.now()).stowed,['2 copper_wiring (cost 20) at sol_base for B']);
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

test('a hold full of cargo no circuit sells and no store takes tries one re-plan, then stays parked with the blocking why, without looping',async()=>{
  const h=hosted(130,[SOL,TWIN],{},{cargo:[{item_id:'copper_wiring',quantity:50}],cargoUsed:50,cargoCapacity:50},
    (action,params)=>{if(action==='spacemolt_storage/deposit'&&params.item_id)throw new SpacemoltError('refused','storage full');});
  try {
    await h.fly();
    assert.equal(h.now().state,'parked');
    assert.match(h.now().why!,/^hold full of 50 copper_wiring this circuit never sells/);
    assert.equal(h.now().reassigned,undefined);
    assert.equal(h.world.count('spacemolt/get_map'),1,'planned once');
    assert.equal(existsSync(join(h.runtime,'drained.json')),false,'the ring is not drained');
  } finally {h.done();}
});

// Sizing against the books the host knows. Sol asks gems at 100, deep; the ledger has range's bid.
const LEDGER=(rangeTick:number,depth:number,bid=130)=>[{base_id:'sol_base',submitted_at_tick:TICK,items:[{item_id:'gem',best_buy:0,best_sell:100,sell_volume:100}]},
  {base_id:'range_base',submitted_at_tick:rangeTick,items:[{item_id:'gem',best_buy:bid,buy_volume:depth}]}];
const SIZED=(rangeTick:number,depth:number,bid=130):WorldOptions=>({cargo:[],cargoUsed:0,cargoCapacity:100,tradeIntel:LEDGER(rangeTick,depth,bid),
  markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:100}],
    range_base:[{item_id:'gem',best_buy:bid,best_buy_qty:depth,best_sell:0,best_sell_qty:0}]}});
// The live circuit's fixed qty: 83 coolant_fluid for unknown_edge.
const DEEP:Circuit={...GEMS,hold:100,stops:[{...GEMS.stops[0]!,buy:{item:'gem',qty:83,max_price:110}},GEMS.stops[1]!]};
/** A freighter flown with a host's market over `options`, in a runtime of its own. */
function marketed(options:WorldOptions,name='hauler',runtime=mkdtempSync(join(tmpdir(),'freighter-market-'))) {
  const h=freighter(130,[],options);
  h.f.market=market(runtime,name,h.f.account,h.f.command);
  return {...h,runtime,bought:()=>h.world.sent.filter(c=>c.action==='spacemolt/buy').map(c=>c.params.quantity)};
}

test('a buy is sized to what the later stop\'s fresh book takes above cost, not the circuit\'s qty (live: 83 coolant_fluid for a bid about 10 deep)',async()=>{
  const {world,f,reports,bought,runtime}=marketed(SIZED(TICK,10));
  try {
    await world.account.refresh();
    const done=await lap(f,DEEP);
    assert.equal(done.park,undefined);
    assert.deepEqual(bought(),[10]);
    assert.ok(reports.some(r=>r.why==='sol_base: sized gem to 10 of 83, what the later stops take above cost: range_base\'s book is 0 ticks old'),
      reports.map(r=>r.why).filter(Boolean).join('\n'));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a later book past STALE_TICKS counts at half its depth; past IGNORE_TICKS it justifies no buy, the lap scouts on and is not dead',async()=>{
  const stale=marketed(SIZED(TICK-STALE_TICKS-1,10));
  const ignored=marketed(SIZED(TICK-IGNORE_TICKS-1,10));
  try {
    await stale.world.account.refresh();await ignored.world.account.refresh();
    await lap(stale.f,DEEP);
    assert.deepEqual(stale.bought(),[5]);
    assert.ok(stale.reports.some(r=>/range_base's book is 181 ticks old, half its depth counted/.test(r.why??'')));
    const done=await lap(ignored.f,DEEP);
    assert.equal(done.park,undefined,'buying nothing for want of a book is scouting, not a dead stop');
    assert.deepEqual(ignored.bought(),[]);
    assert.ok(ignored.reports.some(r=>r.why===`sol_base: sized gem to 0 of 83, what the later stops take above cost: range_base's book is 1081 ticks old, past ${IGNORE_TICKS}: no buy for a sale there`));
  } finally {rmSync(stale.runtime,{recursive:true,force:true});rmSync(ignored.runtime,{recursive:true,force:true});}
});

test('two freighters on one bid: the second buys only what the first has not claimed, and the first\'s sale releases its claim',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-claims-'));
  const a=marketed(SIZED(TICK,16),'a',runtime),b=marketed(SIZED(TICK,16),'b',runtime);
  // a flies range first, so its lap ends at sol with its load aboard, claimed on range's bid.
  const out:Circuit={...GEMS,stops:[GEMS.stops[1]!,GEMS.stops[0]!]};
  const seen:number[]=[];
  const report=a.f.report;
  a.f.report=fields=>{if(fields.stop)seen.push(b.f.market!.claimed('range_base','gem'));report(fields);};
  try {
    await a.world.account.refresh();await b.world.account.refresh();
    await lap(a.f,out);
    assert.deepEqual(a.bought(),[10]);
    assert.equal(b.f.market!.claimed('range_base','gem'),10);
    await lap(b.f,GEMS);
    assert.deepEqual(b.bought(),[6],'16 deep, 10 of it claimed');
    assert.equal(a.f.market!.claimed('range_base','gem'),0,'b sold its 6 at range, releasing them');
    await lap(a.f,out);
    assert.deepEqual(seen,[0,0,10,0],'claimed while carried to range; released by the sale there');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a lap that plans at 0 or less on fresh books parks drained before it flies',async()=>{
  // Range bids 95, under the 120 floor: nothing the circuit buys sells anywhere on it.
  const {world,f,parked,drained,runtime}=marketed(SIZED(TICK,50,95));
  try {
    f.market!.saw('elsewhere',{tick:TICK,items:[]});
    await world.account.refresh();
    const done=await lap(f,GEMS);
    assert.equal(done.park,'lap planned at 0 on fresh books (two laps ahead); circuit drained');
    assert.equal(parked(),done.park);
    assert.equal(drained(),TICK,'drained, so the host re-plans it');
    assert.equal(world.count('spacemolt_market/view_market')+world.count('spacemolt/buy'),0,'not flown');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('one ledger fetch serves every freighter of the host within BOOK_TTL_MS',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-cache-'));
  let asked=0;
  const command:ReadinessCommand=async action=>{
    assert.equal(action,'spacemolt_intel/query_trade_intel');asked++;
    return {structuredContent:{entries:[{base_id:'range_base',submitted_at_tick:TICK,items:[{item_id:'gem',best_buy:130,buy_volume:10,best_sell:0,sell_volume:0}]}]}};
  };
  mock.timers.enable({apis:['Date'],now:1_000_000});
  try {
    const member={state:{player:{faction_id:'guild'}}};
    const a=market(runtime,'a',member,command),b=market(runtime,'b',member,command);
    const [x,y]=await Promise.all([a.book('range_base'),b.book('range_base')]);
    await b.book('range_base');
    assert.equal(asked,1);
    assert.equal(x!.tick,TICK);assert.equal(y,x);
    mock.timers.tick(BOOK_TTL_MS);
    await a.book('range_base');
    assert.equal(asked,2,'fetched again once the minute is up');
  } finally {mock.timers.reset();rmSync(runtime,{recursive:true,force:true});}
});

// Scouting while it waits. Sol ↔ range drains (range bids 115, under the 120 floor), and Reach, two
// jumps out past Deep Range, bids 150 for gems in a book nobody has read.
const REACH:WorldOptions={systems:[{id:'far_reach',connections:['deep_range'],pois:[{id:'reach_dock',base_id:'reach_base'}]}],tradeIntel:[],
  markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
    range_base:[{item_id:'gem',best_buy:115,best_buy_qty:50,best_sell:0,best_sell_qty:0}],
    reach_base:[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}};
const RANGE_115=memory('range_base','deep_range',{best_buy:115,best_buy_qty:50});
/** `hauler` over the Reach world; `placed`, the owner's places.json, is how it knows of reach_base. */
function scouting(placed:Record<string,string>,hook:(h:ReturnType<typeof hosted>,action:string,params:Record<string,unknown>)=>void=()=>{}) {
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,RANGE_115],{},REACH,(action,params)=>hook(h,action,params));
  writeFileSync(join(h.runtime,'places.json'),JSON.stringify(placed));
  return h;
}
const scoutedAt=(h:ReturnType<typeof hosted>)=>readJournal(h.runtime,4000).filter(e=>e.scouted).map(e=>e.scouted);
const reassignedOnce=(h:ReturnType<typeof hosted>)=>{if(h.now().reassigned&&!h.now().stop_after_lap)recallLoop(h.runtime,'hauler','lap');};

test('a waiting freighter scouts an unknown base two jumps away, files its book, re-plans and flies the ring the new book made',async()=>{
  const h=scouting({reach_base:'far_reach'},reassignedOnce);
  try {
    await h.fly();
    const entry=h.now();
    assert.equal(entry.reassigned?.ring,'reach_base sol_base',entry.why);
    assert.equal(entry.scouted,1);
    assert.equal(row('hauler',entry).scouted,1,'freighters() says it');
    assert.deepEqual(scoutedAt(h),['reach_base']);
    assert.ok(knownBooks(h.runtime).some(book=>book.base_id==='reach_base'&&book.system_id==='far_reach'),'remembered for the owner');
    assert.ok(h.world.sent.some(c=>c.action==='spacemolt_intel/submit_trade_intel'&&JSON.stringify(c.params).includes('reach_base')),'filed');
    assert.equal(h.world.count('spacemolt/buy'),1,'the lap bought; the scouting hop never did');
    assert.equal(entry.why,'stopped after its lap, as scheduled');
  } finally {h.done();}
});

test('a system never listed is flown to for its bases, and the base it lists is read next and flown',async()=>{
  const h=scouting({},reassignedOnce);
  try {
    await h.fly();
    assert.equal(h.now().reassigned?.ring,'reach_base sol_base',h.now().why);
    assert.deepEqual(scoutedAt(h),['far_reach','reach_base']);
    assert.deepEqual(JSON.parse(readFileSync(join(h.runtime,'explored.json'),'utf8')),['far_reach']);
    assert.equal(readPlaces(h.runtime).reach_base,'far_reach');
  } finally {h.done();}
});

test('a recall or a stop after the lap during scouting parks it after the hop, never re-planned',async()=>{
  for(const [after,why] of [[undefined,'recalled'],['lap','stopped after its lap, as scheduled']] as const) {
    const h=scouting({reach_base:'far_reach'},(h,action)=>{
      if(action==='spacemolt_market/view_market'&&h.world.account.server.location.docked_at==='reach_base')recallLoop(h.runtime,'hauler',after);});
    try {
      await h.fly();
      assert.equal(h.now().state,'parked');
      assert.equal(h.now().why,why);
      assert.equal(h.now().scouted,1,'the hop it was on is finished');
      assert.equal(h.now().reassigned,undefined);
    } finally {h.done();}
  }
});

test('a scouting hop that fails STOP_TRIES times is skipped for the wait, and it waits docked',async()=>{
  let tries=0;
  const h=scouting({reach_base:'far_reach'},(_,action,params)=>{
    if(action==='spacemolt/find_route'&&params.id==='reach_base'){tries++;throw new SpacemoltError('unreachable','reach unreachable');}});
  mock.timers.enable({apis:['setTimeout']});
  try {
    const flying=h.fly();
    const settle=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));};
    for(let i=0;i<200&&h.now().state!=='waiting';i++){await settle();mock.timers.tick(60_000);}
    assert.equal(h.now().state,'waiting',h.now().why);
    assert.equal(tries,3);
    assert.equal(h.now().scouted,undefined);
    assert.equal(h.world.account.server.location.docked_at,'sol_base');
    assert.ok(readJournal(h.runtime,4000).some(e=>e.scouted==='reach_base'&&e.why==='skipped after 3 tries: reach unreachable'));
    recallLoop(h.runtime,'hauler');
    for(let i=0;i<10;i++){mock.timers.tick(60_000);await settle();}
    await flying;
    assert.equal(h.now().why,'recalled');
    assert.equal(tries,3,'not tried again this wait');
  } finally {mock.timers.reset();h.done();}
});

/** Mocked timers ticked a minute at a time while `work` runs. */
async function ticking<T>(work:()=>Promise<T>):Promise<T> {
  mock.timers.enable({apis:['setTimeout']});
  try {
    let done=false;
    const running=work().finally(()=>{done=true;});
    while(!done){await new Promise(resolve=>setImmediate(resolve));mock.timers.tick(60_000);}
    return await running;
  } finally {mock.timers.reset();}
}

test('a socket closed mid-lap is reconnected and the stop redone: no try counted, no skip, the lap ends (live 2026-09-26: an hour of closed sockets parked the ring)',async()=>{
  let closes=3,reconnects=0;
  const h=hosted(150,[SOL,RANGE],{stop_after_lap:true},{},action=>{
    if(action==='spacemolt/find_route'&&closes>0){closes--;throw new ConnectionClosedError('WebSocket connection closed');}
  });
  try {
    await ticking(()=>h.fly({reconnect:async()=>{reconnects++;}}));
    assert.equal(reconnects,3);
    assert.equal(h.now().lap,1,h.now().why);
    assert.notEqual(h.now().last_lap_net,undefined);
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
    assert.ok(!readJournal(h.runtime,4000).some(e=>/skipped/.test(String(e.why??''))),'no stop skipped');
  } finally {h.done();}
});

test('a reconnect that keeps failing backs off, doubling from RECONNECT_MS, and the lap goes on once it holds',async()=>{
  let closed=true,fails=4;
  const h=hosted(150,[SOL,RANGE],{stop_after_lap:true},{},action=>{
    if(action==='spacemolt/find_route'&&closed)throw new ConnectionClosedError('cannot send on a closed socket');
  });
  try {
    await ticking(()=>h.fly({reconnect:async()=>{if(fails-->0)throw new Error('refused');closed=false;}}));
    assert.deepEqual(readJournal(h.runtime,4000).flatMap(e=>e.again_ms===undefined||!e.reconnect_failed?[]:[e.again_ms]),
      [RECONNECT_MS,2*RECONNECT_MS,4*RECONNECT_MS,8*RECONNECT_MS]);
    assert.equal(h.now().lap,1,h.now().why);
  } finally {h.done();}
});

test('a loop broken by a lost connection outside a stop is launched again, not parked for a human',async()=>{
  const h:ReturnType<typeof hosted>=hosted(115,[SOL,TWIN,RANGE],{state:'waiting'},{},stopOnceReassigned(()=>h));
  let drop=true;
  const account:ReadinessAccount={get state(){return h.world.account.state as never;},
    refresh:async()=>{if(drop){drop=false;throw new ConnectionClosedError('WebSocket connection closed');}return h.world.account.refresh();}};
  try {
    await ticking(()=>h.fly({reconnect:async()=>{}},account));
    assert.ok(readJournal(h.runtime,4000).some(e=>e.loop_broke==='WebSocket connection closed'));
    assert.equal(h.now().reassigned?.ring,'sol_base twin_base');
    assert.equal(h.now().why,'stopped after its lap, as scheduled');
  } finally {h.done();}
});

/** The lib's own Account over sockets that answer a welcome, a login and get_status; `close()` does
 * nothing (a half-open socket), `kick(code)` is the server closing it. */
function fakeGame() {
  const sockets:EventTarget[]=[];let logins=0;
  class FakeSocket extends EventTarget {
    constructor() {
      super();sockets.push(this);
      setImmediate(()=>{this.dispatchEvent(new Event('open'));this.frame({type:'welcome',payload:{current_tick:1,game_info:'',help_text:'',
        release_date:'',release_notes:[],server_time:0,terms:'',tick_rate:10,version:'',website:''}});});
    }
    send(text:string) {
      const f=JSON.parse(text) as {tool:string;request_id:string};
      if(f.tool==='spacemolt_auth'){logins++;this.frame({type:'logged_in',request_id:f.request_id,payload:{}});}
      else this.frame({type:'result',request_id:f.request_id,payload:{result:'ok',structuredContent:{}}});
    }
    close() {}
    frame(frame:object) {setImmediate(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)})));}
  }
  const kick=(socket:EventTarget,code:number)=>socket.dispatchEvent(Object.assign(new Event('close'),{code,reason:'session_replaced'}));
  const account=new Account({url:'ws://fake',reconnect:true,seedState:false,webSocketFactory:()=>new FakeSocket() as never,
    credentials:()=>({kind:'login',username:'a',password:'p'})});
  return {account,sockets,kick,logins:()=>logins};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,50));

test('a forced reconnect cuts the stale socket loose: its late 4001 neither parks nor logs in again, and commands go on (live 2026-09-26: a "session taken elsewhere" nobody took)',async()=>{
  const {account,sockets,kick,logins}=fakeGame();
  const {reconnect,gone}=mender(account);
  await account.connect();await account.authenticate({kind:'login',username:'a',password:'p'});
  await reconnect(new Error('No action_result for mutation r13 within 600000ms of its ack'));
  assert.equal(logins(),2);
  kick(sockets[0]!,4001);
  await settle();
  assert.equal(gone(),undefined);
  assert.equal(account.authenticated,true);
  assert.equal(logins(),2,'no second login from the lib');
  await account.refresh();
  account.close();
});

test('a 4001 on the current connection whose status read fails too parks: session taken elsewhere',async()=>{
  const {account,sockets,kick}=fakeGame();
  const {reconnect,gone}=mender(account);
  await account.connect();await account.authenticate({kind:'login',username:'a',password:'p'});
  kick(sockets[0]!,4001);
  await settle();
  assert.match(String(gone()?.message),/^session_replaced or disconnected/);
  await assert.rejects(reconnect(new ConnectionClosedError('WebSocket connection closed')),/^Error: session_replaced or disconnected/);
  account.close();
});

/** `lapEffect` over the freighter's world on the TestClock, a minute passing at a time, and the runtime bound to a
 * temporary directory so its journal can be read for defects. */
async function clockedLap(h:ReturnType<typeof freighter>,minutes=3) {
  const runtime=mkdtempSync(join(tmpdir(),'freighter-clocked-'));
  bind({account:h.world.account as unknown as Account,command:h.world.command,runtime,pilot:()=>({mood:'Focused'}),emit:()=>{}});
  try {
    await h.world.account.refresh();
    const done=await Effect.runPromise(Effect.gen(function*() {
      const fiber=yield* Effect.forkChild(lapEffect(h.f,GEMS));
      for(let minute=0;minute<minutes;minute++) {
        yield* TestClock.adjust('1 minute');
        yield* Effect.promise(()=>new Promise(resolve=>setImmediate(resolve)));
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(GameLive({send:h.f.command,refresh:()=>h.f.account.refresh()}),TestClock.layer()))));
    return {done,defects:readJournal(runtime).filter(row=>row.event==='defect')};
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
}

test('a buy the game refuses is said with the server\'s code, and writes no defect line',async()=>{
  const h=freighter(130);
  const send=h.f.command;
  h.f.command=async(action,params)=>{
    if(action==='spacemolt/buy')throw new SpacemoltError('insufficient_funds','not enough credits');
    return send(action,params);
  };
  const {done,defects}=await clockedLap(h);
  assert.equal(done.park,undefined);
  assert.ok(h.reports.some(r=>/^sol_base: buy 10 gem refused: not enough credits \(insufficient_funds\)$/.test(r.why??'')),JSON.stringify(h.reports));
  assert.equal(h.world.count('spacemolt/buy'),0,'the refused buy landed nothing');
  assert.deepEqual(defects,[]);
});

test('a buy whose reply is lost is never re-sent: the account re-read finds the gems aboard, kept at what they cost and carried to the sale',async()=>{
  const h=freighter(130);
  const send=h.f.command;
  let lost=true;
  h.f.command=async(action,params)=>{
    const reply=await send(action,params);
    if(action==='spacemolt/buy'&&lost){lost=false;throw new ConnectionClosedError('WebSocket connection closed');}
    return reply;
  };
  const {done,defects}=await clockedLap(h);
  assert.equal(done.park,undefined,JSON.stringify(h.reports));
  assert.equal(h.world.count('spacemolt/buy'),1,'the buy that landed was not sent again');
  assert.ok(!h.reports.some(r=>/again in a minute/.test(r.why??'')),'judged by the hold, not redone');
  assert.ok(!h.reports.some(r=>/refused/.test(r.why??'')));
  assert.deepEqual(h.world.sent.filter(c=>c.action==='spacemolt/sell').map(c=>c.params),[{id:'gem',quantity:10}],'the units it bought are carried to the sale');
  const gem=h.reports.find(r=>r.holding?.gem)?.holding?.gem;
  // The fake world bills a buy 12 a unit plus tax, whatever the ask.
  assert.ok(gem&&gem.quantity===10&&gem.cost>=120,`kept at what it cost: ${JSON.stringify(gem)}`);
  assert.equal(done.net,(await clockedLap(freighter(130))).done.net,'the lap nets what the same lap with every reply nets');
  assert.deepEqual(defects,[]);
});

test('a flight short of fuel with no credits to buy it parks as no credits for fuel, docked where it is',async()=>{
  const h=freighter(130);
  Object.assign(h.world.account.server.ship,{fuel:3});
  h.world.account.server.player.credits=0;
  await h.world.account.refresh();
  const done=await lap(h.f,{...GEMS,stops:[GEMS.stops[1]!,GEMS.stops[0]!]});
  assert.match(done.park??'',/^no credits for fuel: /,JSON.stringify(h.reports));
  assert.equal(h.world.account.server.location.docked_at,'sol_base');
  assert.equal(h.world.count('spacemolt/jump'),0);
});

test('a bug goes up to the host as it was thrown, never retried as if it were the game',async()=>{
  const h=freighter(130);
  const send=h.f.command;
  let reads=0;
  h.f.command=async(action,params)=>{
    if(action==='spacemolt_market/view_market'){reads++;throw new TypeError('a bug');}
    return send(action,params);
  };
  await h.world.account.refresh();
  await assert.rejects(lap(h.f,GEMS),(error:unknown)=>error instanceof TypeError&&error.message==='a bug');
  assert.equal(reads,1);
  assert.ok(!h.reports.some(r=>/again in a minute/.test(r.why??'')));
});

test('a lap with no pilot run bound flies on its own account: a lost buy, a stow and a refused deposit reach nothing of the pilot\'s',async()=>{
  unbind();
  assert.throws(()=>acct(),'nothing is bound');
  const h=freighter(130,['spacemolt_storage/deposit'],{cargo:[{item_id:'ore',quantity:45}],cargoUsed:45});
  const send=h.f.command;
  let lost=true;
  h.f.command=async(action,params)=>{
    const reply=await send(action,params);
    if(action==='spacemolt/buy'&&lost){lost=false;throw new ConnectionClosedError('WebSocket connection closed');}
    return reply;
  };
  await h.world.account.refresh();
  const done=await lap(h.f,GEMS);
  assert.equal(done.park,undefined,JSON.stringify(h.reports));
  assert.equal(h.world.count('spacemolt/buy'),1);
  assert.ok(h.reports.some(r=>/stow \d+ ore.*refused/.test(r.why??'')),JSON.stringify(h.reports));
  assert.throws(()=>acct(),'still nothing bound');
});

test('a sale whose reply is lost is never sold again: the account re-read finds the gems gone',async()=>{
  const h=freighter(130,[],{cargo:[{item_id:'gem',quantity:10}],cargoUsed:10});
  const send=h.f.command;
  let lost=true;
  h.f.command=async(action,params)=>{
    const reply=await send(action,params);
    if(action==='spacemolt/sell'&&lost){lost=false;throw new ConnectionClosedError('WebSocket connection closed');}
    return reply;
  };
  const {done,defects}=await clockedLap(h);
  assert.equal(done.park,undefined,JSON.stringify(h.reports));
  assert.equal(h.world.count('spacemolt/sell'),1,'the sale that landed was not sent again');
  assert.ok(!h.reports.some(r=>/again in a minute|refused/.test(r.why??'')),JSON.stringify(h.reports));
  assert.equal(done.net,(await clockedLap(freighter(130,[],{cargo:[{item_id:'gem',quantity:10}],cargoUsed:10}))).done.net,'the lap nets what the same lap with every reply nets');
  assert.deepEqual(defects,[]);
});

// The quote a trade line carries was one module global: a freighter's refuel in the shared bridge
// overwrote the pilot's held quote, so the pilot's next sell went out with none.
test('a freighter refuel between the pilot\'s quote and its trade leaves the pilot\'s trade line its quote',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-quote-'));
  try {
    const {world,f,reports}=freighter(115);
    await world.account.refresh();
    quoteNext('spacemolt/sell','gem',{bid:150});
    const done=await lap(f,GEMS);
    assert.equal(done.park,undefined,reports.map(r=>r.why).filter(Boolean).join('; '));
    assert.ok(world.count('spacemolt/refuel')>0,'the lap refuelled');
    journalCommand(runtime,'spacemolt/sell',{id:'gem',quantity:1},true,{delta:{details:{action:'sell',item_id:'gem',quantity_sold:1,total_earned:150}}});
    journalCommand(runtime,'spacemolt/refuel',{},true,{delta:{details:{action:'refuel',cost:5}}});
    const trades=readJournal(runtime).filter(line=>line.event==='trade');
    assert.deepEqual(trades.map(line=>line.quote),[{bid:150},undefined],'the sell keeps its quote; the pilot\'s refuel takes none of the freighter\'s');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});
