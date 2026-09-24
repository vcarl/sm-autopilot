import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../../test-support/bridge-world.ts';
import {buy,knownBooks,prices,sell} from '../market.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {goTo} from '../travel.ts';
import {check} from '../../run.ts';
import {routes,runCall,spreads,tradeRun} from './trading.ts';

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
    assert.match(out.next[1]!,/tradeRun\(\{stops:\[\{at:'range_base'\}\]\}\)/);
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

/** A `markets.json` in a fresh runtime dir: books this pilot read at other bases, `age` ticks ago. */
function remembered(books:{base_id:string;age:number;system_id?:string;items:Record<string,unknown>[]}[]):string {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-routes-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify(books.map(({base_id,age,system_id,items})=>
    ({base_id,at:'',tick:TICK-age,...system_id?{system_id}:{},
      items:items.map(row=>({best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[],...row}))}))));
  return runtime;
}
// Ore and gems are sold here; the ore bid a jump away is three levels deep, and thins below the ask.
const HERE={sol_base:[{item_id:'ore',best_buy:8,best_buy_qty:50,best_sell:10,best_sell_qty:50},
  {item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50}]};
const RANGE={base_id:'range_base',age:0,items:[
  {item_id:'ore',best_buy:15,best_buy_qty:4,buy_orders:[{price_each:15,quantity:4},{price_each:12,quantity:4},{price_each:9,quantity:10}]},
  {item_id:'gem',best_buy:110,best_buy_qty:50}]};
/** A route's stops in short: `base+item` where it takes something on. */
const said=(route:{legs:{at:string;buy?:string;bought:number}[]})=>route.legs.map(leg=>leg.buy?`${leg.at}+${leg.buy}`:leg.at).join(' ');
const fills=(visit:{sold:{item_id:string;quantity_sold:number}[]})=>visit.sold.map(fill=>[fill.item_id,fill.quantity_sold]);

test('an empty hold: routes buys here, sells there, and sizes each load where the marginal unit stops paying',async()=>{
  const runtime=remembered([RANGE]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const [gem,ore]=out.detail.routes;
    // 20 gems (the hold) bought at 100 here, sold at 110 there, less 7 fuel for the one jump.
    assert.equal(gem!.next,"tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base'}]})");
    assert.equal(gem!.legs[0]!.bought,20);
    assert.deepEqual(gem!.legs[1]!.sold,[{item_id:'gem',quantity:20,revenue:2200}]);
    assert.equal(gem!.net,2200-2000-7);
    assert.equal(gem!.total_jumps,1);
    assert.deepEqual(gem!.unsold,[]);
    // Ore: 4 at 15 and 4 at 12 beat the ask of 10; the ninth unit fetches 9 and is not moved,
    // though the hold has room for twelve more.
    assert.equal(said(ore!),'sol_base+ore range_base');
    assert.equal(ore!.legs[0]!.bought,8);
    assert.equal(ore!.revenue,4*15+4*12);
    assert.equal(ore!.net,108-80-7);
    assert.equal(ore!.sales_tax,null,'the fake publishes no tax rate');
    assert.match(ore!.why!,/sales tax not known/);
    assert.equal(f.count('spacemolt/find_route'),1,'range_base is placed by one route, which also prices the jump');
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
    assert.equal(said(fresh!),'sol_base+gem range_base');
    assert.equal(said(stale!),'sol_base+gem twin_base');
    assert.ok(stale!.net>fresh!.net,'the stale route nets more on paper');
    assert.equal(stale!.legs[1]!.age,2000);
    assert.ok(stale!.confidence<0.05);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a full hold with a far bid: the top route is one stop there that sells it, like any other route',async()=>{
  const runtime=remembered([{...RANGE,system_id:'deep_range'}]);
  world({mood:'Focused'},{cargo:[{item_id:'gem',quantity:20}],cargoUsed:20,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const [top,near]=out.detail.routes;
    // 20 gems aboard fetch 110 each a jump away; the purchase is sunk, so only the 7 fuel comes off.
    assert.equal(top!.next,"tradeRun({stops:[{at:'range_base'}]})");
    assert.deepEqual(top!.legs[0]!.sold,[{item_id:'gem',quantity:20,revenue:2200}]);
    assert.equal(top!.cost,0);
    assert.equal(top!.net,2200-7);
    // Selling here is the same model with the stop here: 90 each, no trip.
    assert.equal(near!.next,"tradeRun({stops:[{at:'sol_base'}]})");
    assert.equal(near!.net,1800);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

// Scrap sells here and nowhere else; gems fetch more a jump away; ore is cheap here and dear there.
const MIXED_HERE=[{item_id:'scrap',best_buy:50,best_buy_qty:50,best_sell:0,best_sell_qty:0},
  {item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50},
  {item_id:'ore',best_buy:5,best_buy_qty:50,best_sell:10,best_sell_qty:50}];
const MIXED_RANGE=[{item_id:'gem',best_buy:110,best_buy_qty:50,best_sell:0,best_sell_qty:0},
  {item_id:'ore',best_buy:25,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
const MIXED={cargo:[{item_id:'scrap',quantity:10},{item_id:'gem',quantity:5}],cargoUsed:15,cargoCapacity:20,store:[],
  markets:{sol_base:MIXED_HERE,range_base:MIXED_RANGE}};

test('a mixed hold: what pays best here is sold to make room for the buy, what pays more there is carried, and tradeRun does what routes ranked',async()=>{
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:MIXED_RANGE}]);
  const f=world({mood:'Focused'},MIXED,runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const top=out.detail.routes[0]!;
    assert.equal(top.next,"tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})");
    // Scrap is sold here (nobody there bids), which frees 10 for 15 ore; the gems ride to 110.
    assert.deepEqual(top.legs[0]!.sold,[{item_id:'scrap',quantity:10,revenue:500}]);
    assert.equal(top.legs[0]!.bought,15);
    assert.deepEqual(top.legs[1]!.sold,[{item_id:'gem',quantity:5,revenue:550},{item_id:'ore',quantity:15,revenue:375}]);
    assert.deepEqual(top.unsold,[]);
    assert.equal(top.net,500+550+375-150-7);

    // The same inputs, run: each stop does what the plan's leg said, against the live book.
    const run=await tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]});
    assert.equal(run.status,'done',run.why);
    const [here,there]=run.detail.stops;
    assert.deepEqual(fills(here!),top.legs[0]!.sold.map(sale=>[sale.item_id,sale.quantity]));
    assert.equal(here!.bought,top.legs[0]!.bought);
    assert.deepEqual(fills(there!),top.legs[1]!.sold.map(sale=>[sale.item_id,sale.quantity]));
    assert.deepEqual(run.detail.unsold,[]);
    assert.equal(f.account.server.location.docked_at,'range_base');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a three-stop route: the middle stop sells what it was bought for and buys for the last',async()=>{
  const RANGE3=[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0},
    {item_id:'ore',best_buy:0,best_buy_qty:0,best_sell:10,best_sell_qty:50}];
  const TWIN=[{item_id:'ore',best_buy:80,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:RANGE3},
    {base_id:'twin_base',age:0,system_id:'sol',items:TWIN}]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[],pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50}],range_base:RANGE3,twin_base:TWIN}},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const top=out.detail.routes[0]!;
    assert.equal(top.next,"tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base',buy:'ore'},{at:'twin_base'}]})");
    assert.deepEqual(top.legs[1]!.sold,[{item_id:'gem',quantity:10,revenue:1500}]);
    assert.equal(top.legs[1]!.bought,10);
    assert.equal(top.total_jumps,2,'sol → deep_range → sol, counted on the map');
    assert.equal(top.net,1500+800-1000-100-14);
    assert.equal(f.count('spacemolt/get_map'),1);

    const run=await tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base',buy:'ore'},{at:'twin_base'}]});
    assert.equal(run.status,'done',run.why);
    assert.deepEqual(fills(run.detail.stops[1]!),[['gem',10]]);
    assert.equal(run.detail.stops[1]!.bought,10);
    assert.deepEqual(fills(run.detail.stops[2]!),[['ore',10]]);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('tradeRun re-run after a partial carries on from the hold it has: nothing is bought twice',async()=>{
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:MIXED_RANGE}]);
  const f=world({mood:'Focused'},MIXED,runtime);
  // The first jump fails; every other command reaches the fake.
  let jam=true;
  let who:Pilot={mood:'Focused'};
  bind({account:f.account as unknown as ReadinessAccount,runtime,pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{},
    command:async(name,params)=>{
      if(name==='spacemolt/jump'&&jam){jam=false;throw new Error('jump drive offline');}
      return f.command(name,params);
    }});
  const stops=[{at:'sol_base',buy:'ore'},{at:'range_base'}];
  try {
    const first=await tradeRun({stops});
    assert.equal(first.status,'partial');
    assert.match(first.why!,/range_base: .*jump drive offline/);
    assert.equal(first.detail.stops.length,1);
    assert.equal(first.detail.stops[0]!.bought,15);
    assert.deepEqual(first.next,["tradeRun({stops:[{at:'range_base'}]})"]);
    const again=await tradeRun({stops});
    assert.equal(again.status,'done',again.why);
    assert.equal(again.detail.stops[0]!.bought,0,'the hold is already full of ore; the plan buys none');
    assert.equal(f.count('spacemolt/buy'),1);
    assert.deepEqual(fills(again.detail.stops[1]!),[['gem',5],['ore',15]]);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test("tradeRun from:'store' takes the stored goods at the first stop and sells them at the next",async()=>{
  const runtime=remembered([{base_id:'range_base',age:0,items:[{item_id:'ore',best_buy:10,best_buy_qty:99}]}]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[{item_id:'ore',quantity:8}],markets:{sol_base:[]}},runtime);
  try {
    const out=await tradeRun({stops:[{at:'sol_base',buy:'ore',from:'store'},{at:'range_base'}]});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt/buy'),0);
    assert.equal(out.detail.stops[0]!.bought,8);
    assert.deepEqual(fills(out.detail.stops[1]!),[['ore',8]]);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a failed route lookup is a row with a why and a partial, not a throw',async()=>{
  const runtime=remembered([{base_id:'ghost_base',age:0,items:[{item_id:'gem',best_buy:110,best_buy_qty:50}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'partial');
    const row=out.detail.routes[0]!;
    assert.equal(said(row),'sol_base+gem ghost_base');
    assert.equal(row.total_jumps,null);
    assert.equal(row.score,0);
    assert.match(row.why!,/no route to ghost_base: .*fuel not priced/);
    assert.match(out.why!,/sol_base buy 20 gem → ghost_base sell 20 gem: no route to ghost_base/);
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

// Gems at 100 here, 150 a jump away; 250 bps of tax and 28 cr a fuel unit, as live at every station touched.
const GEM_RANGE=[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
const TAXED={cargo:[],cargoUsed:0,cargoCapacity:20,store:[],taxBps:250,fuelPrice:28,
  markets:{sol_base:[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50}],range_base:GEM_RANGE}};

test('a taxed buy reports what the wallet paid: buy() says the tax, and tradeRun spends and nets it (live: 32000 + 800)',async()=>{
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:GEM_RANGE}]);
  const f=world({mood:'Focused'},TAXED,runtime);
  try {
    const bought=await buy('gem',20);
    // The fake prices a buy at 12 each: 240 subtotal, 6 of tax floored from 2.5%.
    assert.match(bought.did,/bought 20 gem for 246 cr \(6 of it tax\)/);
    assert.equal(bought.cost.credits,246);
    assert.equal((await sell([{item_id:'gem'}])).status,'done');

    const before=f.account.server.player.credits,tank=f.account.server.ship.fuel;
    const run=await tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base'}]});
    assert.equal(run.status,'done',run.why);
    assert.equal(run.detail.stops[0]!.bought,20);
    assert.equal(run.detail.stops[0]!.spent,246,'the subtotal is 240; the wallet paid 246');
    const wallet=f.account.server.player.credits-before;
    assert.equal(run.detail.fuel,tank-f.account.server.ship.fuel);
    assert.equal(run.detail.net,wallet-run.detail.fuel*28,'the wallet, less the fuel burned at this base\'s price');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('Route.net and Traded.net count fuel alike: units burned × this base\'s fuel_price_all_in',async()=>{
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:GEM_RANGE}]);
  world({mood:'Focused'},TAXED,runtime);
  try {
    const top=(await routes()).detail.routes[0]!;
    assert.equal(top.next,"tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base'}]})");
    assert.equal(top.fuel,7);
    assert.equal(top.sales_tax,50,'2000 at 250 bps');
    assert.equal(top.net,3000-2000-50-7*28);
    const run=await tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base'}]});
    const earned=run.detail.stops.flatMap(visit=>visit.sold).reduce((sum,fill)=>sum+fill.total_earned,0);
    assert.ok(run.detail.fuel>0);
    assert.equal(run.detail.net,earned-run.detail.stops[0]!.spent-run.detail.fuel*28);
    assert.match(run.did,new RegExp(`after ${run.detail.fuel} fuel at 28 cr`));
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test("a buy at a far stop is taxed at this base's rate, and the row says it is an estimate (live: 250 bps at all 4 stations)",async()=>{
  const runtime=remembered([{base_id:'twin_base',age:0,system_id:'sol',items:[{item_id:'gem',best_sell:100,best_sell_qty:50}]},
    {base_id:'range_base',age:0,system_id:'deep_range',items:GEM_RANGE}]);
  world({mood:'Focused'},{...TAXED,pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'ore',best_buy:8,best_buy_qty:50,best_sell:10,best_sell_qty:50}]}},runtime);
  try {
    const out=await routes({items:['gem']});
    const far=out.detail.routes.find(row=>row.next==="tradeRun({stops:[{at:'twin_base',buy:'gem'},{at:'range_base'}]})")!;
    assert.ok(far,out.detail.routes.map(row=>row.next).join('\n'));
    assert.equal(far.legs[0]!.sales_tax,50,'2000 at the 250 bps read here');
    assert.equal(far.sales_tax,50);
    assert.match(far.why!,/tax at twin_base estimated at sol_base's 250 bps/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test("a done run's next is pasteable: routes() after a sell-only route, and the route call itself compiles",async()=>{
  const runtime=remembered([{...RANGE,system_id:'deep_range'}]);
  world({mood:'Focused'},{cargo:[{item_id:'gem',quantity:20}],cargoUsed:20,cargoCapacity:20,store:[],
    markets:{...HERE,range_base:[{item_id:'gem',best_buy:110,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}},runtime);
  let next:string[];
  try {
    const run=await tradeRun({stops:[{at:'range_base'}]});
    assert.equal(run.status,'done',run.why);
    next=run.next;
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  assert.deepEqual(next,['routes()'],'a sell-only route has nothing to repeat');
  const pilot=mkdtempSync(join(tmpdir(),'trade-next-'));
  mkdirSync(join(pilot,'pilot'));
  writeFileSync(join(pilot,'pilot','index.ts'),`import {routes, tradeRun} from 'play';
export default async function main() {
  ${[...next,runCall([{at:'sol_base',buy:'gem'},{at:'range_base'}])].map(call=>`await ${call};`).join('\n  ')}
  return routes();
}
`);
  const gate=await check(pilot);
  rmSync(pilot,{recursive:true,force:true});
  assert.deepEqual(gate.ok?[]:gate.errors,[]);
});

test('a held good is not dumped for 1 cr while a base off the route bids 445 for it (live: 27 null_matter at nexus)',async()=>{
  const runtime=remembered([{base_id:'twin_base',age:0,system_id:'sol',items:[{item_id:'null_matter',best_buy:445,best_buy_qty:30}]}]);
  const f=world({mood:'Focused'},{cargo:[{item_id:'null_matter',quantity:27}],cargoUsed:27,cargoCapacity:100,store:[],
    pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'null_matter',best_buy:1,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.routes.map(row=>row.next),["tradeRun({stops:[{at:'twin_base'}]})"],
      'selling here at 1 is not a route: the stop would only be a dump');
    assert.equal(out.detail.routes[0]!.net,27*445);

    const run=await tradeRun({stops:[{at:'sol_base'}]});
    assert.equal(run.status,'done',run.why);
    assert.equal(f.count('spacemolt/sell'),0);
    assert.deepEqual(run.detail.unsold,[{item_id:'null_matter',quantity:27,why:'twin_base bids 445, off this route'}]);
    assert.match(run.did,/unsold: 27 null_matter \(twin_base bids 445, off this route\)/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a circuit is read off the middle of three laps: the steady state sells what the last lap carried back',async()=>{
  // Gems go out from sol at 100 and fetch 150 at range; ore comes back from range at 10 and fetches 30 at sol.
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:[
    {item_id:'gem',best_buy:150,best_buy_qty:50},{item_id:'ore',best_sell:10,best_sell_qty:50}]}]);
  world({mood:'Focused'},{cargo:[{item_id:'scrap',quantity:5}],cargoUsed:5,cargoCapacity:50,store:[],
    markets:{sol_base:[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50},
      {item_id:'ore',best_buy:30,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}},runtime);
  try {
    const out=await routes({circuit:{hold:20}});
    assert.equal(out.status,'done',out.why);
    const top=out.detail.routes[0]!,lap=top.circuit!;
    // Lap one starts empty and sells no ore at sol; the middle lap does: 20×30 + 20×150 − 20×100 − 20×10 − 2 jumps × 7 fuel.
    assert.equal(lap.lap_net,600+3000-2000-200-14);
    assert.equal(top.net,lap.lap_net);
    assert.equal(lap.lap_jumps,2,'sol → deep_range and back, the return leg counted');
    assert.equal(top.score,lap.lap_net/2);
    assert.deepEqual(lap.stops,[
      {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:20,max_price:110},sell:[{item:'ore',min_price:27}]},
      {at:'range_base',system_id:'deep_range',buy:{item:'ore',qty:20,max_price:11},sell:[{item:'gem',min_price:135}]}]);
    assert.equal(lap.hold,20,'planned for the hold asked for, not the 5 scrap aboard');
    assert.equal(out.detail.routes.filter(row=>row.circuit).length,out.detail.routes.length,'every row is a circuit');
    assert.deepEqual(out.detail.routes.map(row=>row.net),[1386,986,386],
      'gems one way and ore one way rank under the round trip, and range→sol is not listed again: it is the same circuit turned round');
    assert.match(top.next,/^assign\('freighter', \{closed:true,hold:20,/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
