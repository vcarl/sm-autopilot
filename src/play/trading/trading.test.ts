import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../../test-support/bridge-world.ts';
import {knownBooks,prices} from '../market.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {goTo} from '../travel.ts';
import {routes,spreads,tradeRun} from './trading.ts';

function world(record:Pilot,options:WorldOptions={},runtime?:string) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text),...runtime?{runtime}:{}});
  return {...game,lines,record:()=>who};
}

// Scrap sells here and ore does not; the faction ledger says ore sells a jump away.
const SCRAP_ONLY={sol_base:[{item_id:'scrap',best_buy:400,best_buy_qty:10,best_sell:450,best_sell_qty:2}]};
const LEDGER=[{base_id:'range_base',submitted_at_tick:900,
  items:[{item_id:'ore',best_buy:50,buy_volume:99}]}];

test('spreads ranks by net, netting the fuel to the far buyer against the near one',async()=>{
  const f=world({mood:'Focused'},{cargo:[{item_id:'ore',quantity:12}],cargoUsed:12,
    store:[{item_id:'scrap',quantity:2}],markets:SCRAP_ONLY,tradeIntel:LEDGER});
  try {
    const out=await spreads();
    assert.equal(out.status,'done',out.why);
    const [first,second]=out.detail.spreads;
    // 400 × 2 stored scrap, sold at this counter: no fuel to net.
    assert.equal(first!.item_id,'scrap');
    assert.equal(first!.base_id,'sol_base');
    assert.equal(first!.source,'here');
    assert.equal(first!.fuel,0);
    assert.equal(first!.net,800);
    // 50 × 12 held ore a jump away, less 7 fuel at fuel_price_all_in 1.
    assert.equal(second!.item_id,'ore');
    assert.equal(second!.base_id,'range_base');
    assert.equal(second!.source,'faction ledger');
    assert.equal(second!.fuel,7);
    assert.equal(second!.net,600-7,'gross less the fuel bill, which is what ranks it second');
    assert.equal(second!.seen,`${TICK-900} ticks old`,'the filed tick is reported as an age, not a tick number');
    assert.deepEqual(out.detail.sources,['here','faction ledger']);
    assert.match(out.next[1]!,/goTo\('range_base'\)/);
    assert.equal(f.count('spacemolt/find_route'),1,'one route per far base, not per item');
  } finally {unbind();}
});

test('with no faction ledger, a book read on an earlier visit survives a new runtime binding',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-markets-'));
  // Trip one: fly to the far base and read its counter. Nothing else learns the price.
  const first=world({mood:'Focused'},{cargo:[],cargoUsed:0,store:[],
    markets:{sol_base:[],range_base:[{item_id:'ore',best_buy:50,best_buy_qty:99,best_sell:60,best_sell_qty:9}]}},runtime);
  try {
    assert.equal((await goTo('range_base')).status,'done');
    assert.equal((await prices(['ore'])).status,'done');
  } finally {unbind();}
  assert.equal(first.lines.length>0,true);

  // A whole new binding — new process, as far as the library is concerned — at the near base.
  const second=world({mood:'Focused'},{cargo:[{item_id:'ore',quantity:12}],cargoUsed:12,store:[],
    markets:{sol_base:[]}},runtime);
  try {
    const out=await spreads(['ore']);
    assert.equal(out.status,'done',out.why);
    const row=out.detail.spreads[0]!;
    assert.equal(row.base_id,'range_base','the memory of the first visit is the only price there is');
    assert.equal(row.source,'remembered');
    // The book was tagged with the tick it was read on, so a book read this tick reads as new —
    // not as the 20 ticks an untagged pre-ageing entry is assumed to be.
    assert.equal(row.seen,'0 ticks old');
    assert.equal(row.net,600-7);
    assert.deepEqual(out.detail.sources,['here','remembered'],'no faction, so no ledger');
    assert.match(out.did,/the best buyer for 1 of them is not sol_base/);
    assert.equal(second.count('spacemolt_intel/query_trade_intel'),1,'asked once, refused, not asked again');
  } finally {unbind();}
  rmSync(runtime,{recursive:true,force:true});
});

test('spreads says so when nothing aboard has a known buyer anywhere',async()=>{
  world({mood:'Focused'},{cargo:[{item_id:'ore',quantity:12}],cargoUsed:12,store:[],markets:{sol_base:[]}});
  try {
    const out=await spreads();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.spreads,[]);
    assert.match(out.did,/no buyer known anywhere for ore/);
  } finally {unbind();}
});

test('tradeRun buys here, flies, sells there, and reports the realised net',async()=>{
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[]});
  try {
    const out=await tradeRun({item:'ore',sellAt:'range_base',quantity:10});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.leg,'sold');
    assert.equal(out.detail.bought,10);
    // Bought at 12 each, sold at 10 each, tank full enough that the flight cost no credits:
    // a losing run, reported as one rather than as a spread that "worked".
    assert.equal(out.detail.net,100-120,'sales less purchase less what the flight took');
    assert.match(out.did,/net -20 cr/);
    assert.equal(f.count('spacemolt/sell'),1);
    assert.equal(f.account.server.location.docked_at,'range_base');
  } finally {unbind();}
});

test('tradeRun delivers goods already aboard instead of buying more',async()=>{
  const f=world({mood:'Focused'},{cargo:[{item_id:'ore',quantity:5}],cargoUsed:5,cargoCapacity:10,store:[],markets:{sol_base:[]}});
  try {
    const out=await tradeRun({item:'ore',sellAt:'range_base'});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt/buy'),0,'nothing bought: the goods were aboard');
    assert.equal(out.detail.carried,5);
    assert.equal(out.detail.bought,0);
    assert.equal(out.detail.net,50,'5 sold at 10, nothing spent');
    assert.match(out.did,/^carried 5 ore, flew to range_base/);
  } finally {unbind();}
});

test("tradeRun from:'store' withdraws what is stored here, carries it, and sells it there",async()=>{
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[{item_id:'ore',quantity:8}],markets:{sol_base:[]}});
  try {
    const out=await tradeRun({item:'ore',sellAt:'range_base',from:'store'});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt/buy'),0);
    assert.equal(out.detail.carried,8);
    assert.equal(out.detail.leg,'sold');
    assert.equal(f.account.server.location.docked_at,'range_base');
  } finally {unbind();}
  // Nothing stored and nothing aboard: the end state holds, nothing is bought and nothing flies.
  const g=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[]});
  try {
    const out=await tradeRun({item:'ore',sellAt:'range_base',from:'store'});
    assert.equal(out.status,'done',out.why);
    assert.equal(g.count('spacemolt/buy'),0);
    assert.equal(g.account.server.location.docked_at,'sol_base');
  } finally {unbind();}
});

/** A `markets.json` in a fresh runtime dir: books this pilot read at other bases, `age` ticks ago. */
function remembered(books:{base_id:string;age:number;items:Record<string,unknown>[]}[]):string {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-routes-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify(books.map(({base_id,age,items})=>
    ({base_id,at:'',tick:TICK-age,items:items.map(row=>({best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[],...row}))}))));
  return runtime;
}
// Ore and gems are sold here; the ore bid a jump away is three levels deep, and thins below the ask.
const HERE={sol_base:[{item_id:'ore',best_buy:8,best_buy_qty:50,best_sell:10,best_sell_qty:50},
  {item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50}]};
const RANGE={base_id:'range_base',age:0,items:[
  {item_id:'ore',best_buy:15,best_buy_qty:4,buy_orders:[{price_each:15,quantity:4},{price_each:12,quantity:4},{price_each:9,quantity:10}]},
  {item_id:'gem',best_buy:110,best_buy_qty:50}]};

test('routes ranks by net per jump and sizes each load where the marginal unit stops paying',async()=>{
  const runtime=remembered([RANGE]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const [gem,ore]=out.detail.routes;
    // 20 gems (the hold) bought at 100 here, sold at 110 there, less 7 fuel for the one jump.
    assert.equal(gem!.item_id,'gem');
    assert.equal(gem!.quantity,20);
    assert.equal(gem!.net,2200-2000-7);
    assert.equal(gem!.total_jumps,1);
    assert.equal(gem!.next,"tradeRun({item:'gem', sellAt:'range_base', quantity:20})");
    // Ore: 4 at 15 and 4 at 12 beat the ask of 10; the ninth unit fetches 9 and is not moved,
    // though the hold has room for twelve more.
    assert.equal(ore!.item_id,'ore');
    assert.equal(ore!.quantity,8);
    assert.equal(ore!.revenue,4*15+4*12);
    assert.equal(ore!.cost,80);
    assert.equal(ore!.net,108-80-7);
    assert.equal(ore!.sales_tax,null,'the fake publishes no tax rate');
    assert.match(ore!.why!,/sales tax at sol_base not known/);
    assert.equal(f.count('spacemolt/find_route'),1,'one route per far base');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('routes ranks a stale fat bid below a fresh thin one',async()=>{
  // twin_base is in Sol, so its trip is 0 jumps and its bid is higher: only its age sinks it.
  const runtime=remembered([RANGE,{base_id:'twin_base',age:2000,items:[{item_id:'gem',best_buy:130,best_buy_qty:50}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE,
    pois:[{id:'twin',base_id:'twin_base'}]},runtime);
  try {
    const out=await routes({items:['gem']});
    assert.equal(out.status,'done',out.why);
    const [fresh,stale]=out.detail.routes;
    assert.equal(fresh!.sellAt,'range_base');
    assert.equal(stale!.sellAt,'twin_base');
    assert.ok(stale!.net>fresh!.net,'the stale route nets more on paper');
    assert.equal(stale!.sellAge,2000);
    assert.ok(stale!.confidence<0.05);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a full hold is routed: what is aboard sells at the far bid for the sale less fuel, and ranks first',async()=>{
  const runtime=remembered([RANGE]);
  world({mood:'Focused'},{cargo:[{item_id:'gem',quantity:20}],cargoUsed:20,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const [held]=out.detail.routes;
    // 20 gems aboard fetch 110 each a jump away; the purchase is sunk, so only the 7 fuel comes off.
    assert.equal(held!.buyAt,'held');
    assert.equal(held!.sellAt,'range_base');
    assert.equal(held!.quantity,20);
    assert.equal(held!.cost,0);
    assert.equal(held!.net,2200-7);
    assert.equal(held!.next,"tradeRun({item:'gem', sellAt:'range_base'})");
    // A buy route is sized to the space selling frees, and says so.
    const bought=out.detail.routes.find(row=>row.buyAt==='sol_base')!;
    assert.equal(bought.quantity,20);
    assert.match(bought.why!,/the hold is full: sell what is aboard first/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a failed route lookup is a row with a why and a partial, not a throw',async()=>{
  const runtime=remembered([{base_id:'ghost_base',age:0,items:[{item_id:'gem',best_buy:110,best_buy_qty:50}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'partial');
    const row=out.detail.routes[0]!;
    assert.equal(row.sellAt,'ghost_base');
    assert.equal(row.total_jumps,null);
    assert.match(row.why!,/no route: .*ghost_base/);
    assert.match(out.why!,/no route for gem sol_base→ghost_base/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('the market memory drops a book older than a day at the next read, whatever the count',async()=>{
  const runtime=remembered([{base_id:'range_base',age:100,items:[]},{base_id:'old_base',age:9000,items:[]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,store:[],markets:HERE},runtime);
  try {
    assert.equal((await prices(['ore'])).status,'done');
    assert.deepEqual(knownBooks(runtime).map(row=>row.base_id),['sol_base','range_base']);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
