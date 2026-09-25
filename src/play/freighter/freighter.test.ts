import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{mock} from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {check} from '../../run.ts';
import {bridgeWorld,TICK} from '../../test-support/bridge-world.ts';
import {assign,reassign} from '../fleet/fleet.ts';
import {menu,renderMenu} from '../menu.ts';
import {bind,unbind} from '../runtime.ts';
import {REST_TICKS,routes,type Circuit} from '../trading/trading.ts';
import {markDrained,ring} from './drained.ts';
import {gate,script,scriptPath,writeFleet} from './host.ts';
import {lap,type Freighter,type Lap,type Report} from './index.ts';

// Gems bought at sol for at most 110, sold at range for at least 120.
const GEMS:Circuit={closed:true,hold:10,lap_jumps:2,lap_net:500,stops:[
  {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:10,max_price:110},sell:[]},
  {at:'range_base',system_id:'deep_range',sell:[{item:'gem',min_price:120}]}]};

/** A freighter over the fake world, its deposits and reports recorded. `refuse` names commands the game refuses. */
function freighter(rangeBid:number,refuse:string[]=[]) {
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[{item_id:'ore',quantity:5}],cargoUsed:5,cargoCapacity:50,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:rangeBid,best_buy_qty:50,best_sell:0,best_sell_qty:0},
        {item_id:'ore',best_buy:999,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}});
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

test('a drained ring rests: routes passes over it and says so, the menu offers reassign, and reassign assigns the next ring',async()=>{
  // Gems are asked 100 at sol (here); range bids 150 and twin, in Sol itself, bids 130. Freighter a
  // parked on sol ↔ range, which it drained 10 ticks ago, with 5 ore aboard that no gem ring sells.
  const runtime=mkdtempSync(join(tmpdir(),'freighter-rest-'));
  const book=(base_id:string,system_id:string,bid:number)=>({base_id,at:'',tick:TICK,system_id,
    items:[{item_id:'gem',best_buy:bid,best_buy_qty:50,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[]}]});
  writeFileSync(join(runtime,'markets.json'),JSON.stringify([book('range_base','deep_range',150),book('twin_base','sol',130)]));
  writeFleet(runtime,{a:{state:'parked',circuit:GEMS,float:20_000,owner:'B',lap:3,returned:0,
    holding:{ore:{quantity:5,cost:50}},why:'circuit dead: 3 stops in a row with no trade',at:''}});
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
    const move=built.moves.find(m=>m.call==="reassign('a')");
    assert.ok(move,renderMenu(built));
    assert.match(move.why,/parked \(circuit dead.*routes\(\{circuit:\{hold:10\}\}\).*5 ore \(50 cr\) aboard rides along/);
    const pilot=mkdtempSync(join(tmpdir(),'reassign-next-'));
    mkdirSync(join(pilot,'pilot'));
    writeFileSync(join(pilot,'pilot','index.ts'),`import {reassign} from 'play';\nexport default async function main() {\n  return ${move.call};\n}\n`);
    const typed=await check(pilot);
    rmSync(pilot,{recursive:true,force:true});
    assert.deepEqual(typed.errors,[]);

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
