import assert from 'node:assert/strict';
import type {Account} from '@spacemolt/lib';
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
import {readPlaces} from '../places.ts';
import {routes,runCall,spreads,tradeRun} from './trading.ts';
import {scoutMarkets} from './scout.ts';

function world(record:Pilot,options:WorldOptions={},runtime?:string) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:text=>lines.push(text),...runtime?{runtime}:{}});
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

test('every book read files the faction ledger once per tick, and the next base reads it back as a far book',async()=>{
  const f=world({mood:'Focused'},{cargo:[{item_id:'ore',quantity:12}],cargoUsed:12,store:[],tradeIntel:[],
    markets:{sol_base:[{item_id:'ore',best_buy:50,best_buy_qty:99,best_sell:60,best_sell_qty:9},{item_id:'unpriced',best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0}],
      range_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:9}]}});
  try {
    await prices();await prices();
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_intel/submit_trade_intel').map(call=>call.params),
      [{stations:[{base_id:'sol_base',items:[{item_id:'ore',best_buy:50,best_sell:60,buy_volume:99,sell_volume:9}]}]}],
      'two reads at one tick file once, and a row with no price is not filed');
    assert.equal((await goTo('range_base')).status,'done');
    const out=await spreads(['ore']);
    const [best]=out.detail.spreads;
    assert.deepEqual([best!.base_id,best!.source,best!.seen,best!.best_buy],['sol_base','faction ledger','0 ticks old',50],
      'filed at this world\'s tick, read back at the same one');
    assert.equal(f.count('spacemolt_intel/submit_trade_intel'),2,'range_base filed on its own first read');
  } finally {unbind();}
});

test('with no faction, a book read files nothing',async()=>{
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,store:[]});
  try {
    assert.equal((await prices(['ore'])).status,'done');
    assert.equal((await prices(['ore'])).status,'done');
    assert.equal((await goTo('range_base')).status,'done');
    assert.equal((await prices(['ore'])).status,'done');
    assert.equal(f.count('spacemolt_intel/submit_trade_intel'),0,'no faction in the player state: nothing is sent to be refused');
    assert.equal(f.lines.filter(line=>line.includes('trade intel not filed')).length,0);
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
    assert.equal(second.count('spacemolt_intel/query_trade_intel'),0,'no faction in the player state: never asked');
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
const said=(route:{legs:{at:string;buys:{item_id:string}[]}[]})=>route.legs.map(leg=>[leg.at,...leg.buys.map(row=>row.item_id)].join('+')).join(' ');
const fills=(visit:{sold:{item_id:string;quantity_sold:number}[]})=>visit.sold.map(fill=>[fill.item_id,fill.quantity_sold]);

test('an empty hold: routes buys here, sells there, and sizes each load where the marginal unit stops paying',async()=>{
  const runtime=remembered([RANGE]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE},runtime);
  try {
    const out=await routes({maxStops:2});
    assert.equal(out.status,'done',out.why);
    const [gem]=out.detail.routes;
    // 20 gems (the hold) bought at 100 here, sold at 110 there, less 7 fuel for the one jump.
    assert.equal(gem!.next,"tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'range_base'}]})");
    assert.equal(gem!.legs[0]!.bought,20);
    assert.deepEqual(gem!.legs[1]!.sold,[{item_id:'gem',quantity:20,revenue:2200}]);
    assert.equal(gem!.net,2200-2000-7);
    assert.equal(gem!.total_jumps,1);
    assert.deepEqual(gem!.unsold,[]);
    // Ore, when only ore may be taken on: 4 at 15 and 4 at 12 beat the ask of 10; the ninth unit
    // fetches 9 and is not moved, though the hold has room for twelve more.
    const [ore]=(await routes({items:['ore'],maxStops:2})).detail.routes;
    assert.equal(said(ore!),'sol_base+ore range_base');
    assert.equal(ore!.legs[0]!.bought,8);
    assert.equal(ore!.revenue,4*15+4*12);
    assert.equal(ore!.net,108-80-7);
    assert.equal(ore!.sales_tax,null,'the fake publishes no tax rate');
    assert.match(ore!.why!,/sales tax not known/);
    assert.equal(f.count('spacemolt/find_route'),2,'range_base is placed once and kept; the second call routes only to price the jump');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('spreads lists every buyer an item has, ranked as routes ranks them: a stale fat bid does not hide a fresh thin one (live: sirius wiring)',async()=>{
  // Live: 100 copper_wiring, no bid here; grand_exchange bid 15 on a 4806-tick-old book was the only
  // row, and confederacy_central_command, bid 8 a jump away at confidence 0.94, was never listed.
  const runtime=remembered([{base_id:'range_base',age:4806,items:[{item_id:'copper_wiring',best_buy:15,best_buy_qty:100}]},
    {base_id:'twin_base',age:20,system_id:'sol',items:[{item_id:'copper_wiring',best_buy:8,best_buy_qty:100}]}]);
  world({mood:'Focused'},{cargo:[{item_id:'copper_wiring',quantity:100}],cargoUsed:100,store:[],markets:{sol_base:[]},
    pois:[{id:'twin',base_id:'twin_base'}]},runtime);
  try {
    const out=await spreads();
    assert.equal(out.status,'done',out.why);
    const [fresh,stale]=out.detail.spreads;
    assert.deepEqual([fresh!.base_id,fresh!.net,fresh!.jumps],['twin_base',800,0]);
    assert.deepEqual([stale!.base_id,stale!.net,stale!.jumps],['range_base',1500-7,1]);
    assert.ok(fresh!.score>stale!.score&&stale!.confidence<0.001,JSON.stringify(out.detail.spreads));
    assert.match(out.next[0]!,/twin_base/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('routes ranks a stale fat bid below a fresh thin one',async()=>{
  // twin_base is in Sol, so its trip is 0 jumps and its bid is higher: only its age sinks it.
  const runtime=remembered([RANGE,{base_id:'twin_base',age:2000,items:[{item_id:'gem',best_buy:130,best_buy_qty:50}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE,
    pois:[{id:'twin',base_id:'twin_base'}]},runtime);
  try {
    const out=await routes({items:['gem'],maxStops:2});
    assert.equal(out.status,'done',out.why);
    const [fresh,stale]=out.detail.routes;
    assert.equal(said(fresh!),'sol_base+gem range_base');
    assert.equal(said(stale!),'sol_base+gem twin_base');
    assert.ok(stale!.net>fresh!.net,'the stale route nets more on paper');
    assert.equal(stale!.legs[1]!.age,2000);
    assert.ok(stale!.confidence<0.05);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('when every book is hours old, rows still rank by net per jump, not by which near-zero confidence is least near zero',async()=>{
  // Both in Sol, 0 jumps. old_base pays ten times the net, but its book is 2000 ticks older:
  // unfloored, 0.5^(6000/360) × 2000 ≈ 0.02 sank it under 0.5^(4000/360) × 200 ≈ 0.09.
  const runtime=remembered([{base_id:'old_base',age:6000,system_id:'sol',items:[{item_id:'gem',best_buy:200,best_buy_qty:50}]},
    {base_id:'less_old_base',age:4000,system_id:'sol',items:[{item_id:'gem',best_buy:110,best_buy_qty:50}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE,
    pois:[{id:'old',base_id:'old_base'},{id:'less_old',base_id:'less_old_base'}]},runtime);
  try {
    const [top,next]=(await routes({items:['gem'],maxStops:2})).detail.routes;
    assert.equal(said(top!),'sol_base+gem old_base');
    assert.equal(said(next!),'sol_base+gem less_old_base');
    assert.ok(top!.confidence<next!.confidence&&next!.confidence<0.001,'age still reads as distrust on the row');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('placements are kept: each routes() places up to 5 new bases, and a base placed once is never looked up again',async()=>{
  const bases=['b1','b2','b3','b4','b5','b6','b7'];
  const runtime=remembered(bases.map(base_id=>({base_id,age:0,items:[{item_id:'gem',best_buy:110,best_buy_qty:50}]})));
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE,
    pois:bases.map(base_id=>({id:`poi_${base_id}`,base_id}))},runtime);
  const looked=()=>f.sent.filter(call=>call.action==='spacemolt/find_route').map(call=>String(call.params.id));
  try {
    const first=await routes({items:['gem'],maxStops:2});
    assert.deepEqual(looked(),bases.slice(0,5));
    assert.match(first.did,/2 base\(s\) could not be placed.*\(2 past this call's 5 lookups/);
    const second=await routes({items:['gem'],maxStops:2});
    assert.deepEqual(looked().slice(5),['b6','b7'],'only the two left over are looked up');
    assert.doesNotMatch(second.did,/could not be placed/);
    assert.deepEqual(readPlaces(runtime),{sol_base:'sol',...Object.fromEntries(bases.map(base=>[base,'sol']))});
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a base flagged mobile is placed by a live find_route every time, never by its remembered system (live: frontier_station)',async()=>{
  // Remembered in Sol, where it no longer is; find_route places range_base in deep_range, a jump away.
  // twin_base, placed in Sol and first, is what a jump would be priced off were range_base trusted.
  const runtime=remembered([{base_id:'twin_base',age:0,system_id:'sol',items:[{item_id:'ore',best_buy:1,best_buy_qty:1}]},{...RANGE,system_id:'sol'}]);
  writeFileSync(join(runtime,'mobile.json'),JSON.stringify(['range_base']));
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:20,store:[],markets:HERE,pois:[{id:'twin',base_id:'twin_base'}]},runtime);
  try {
    for(let i=0;i<2;i++) {
      const [gem]=(await routes({items:['gem'],maxStops:2})).detail.routes;
      assert.equal(said(gem!),'sol_base+gem range_base');
      assert.equal(gem!.total_jumps,1,'placed where find_route says, not the remembered sol');
    }
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt/find_route').map(call=>call.params.id),['range_base','range_base'],'looked up on every search');
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

test('routes reads the ledger whole, page past page, and places a filed base by the memory\'s system',async()=>{
  // 24 other stations fill the first page; the gem bid is filed on the second. Live, the ledger
  // answers no system for an entry: range_base's comes from a stale, empty memory of it.
  const filler=Array.from({length:24},(_,i)=>({base_id:`filler_${i}`,submitted_at_tick:TICK,items:[{item_id:'junk',best_buy:1,buy_volume:1}]}));
  const runtime=remembered([{base_id:'range_base',age:5000,system_id:'deep_range',items:[]}]);
  const f=world({mood:'Focused'},{cargo:[{item_id:'gem',quantity:20}],cargoUsed:20,cargoCapacity:20,store:[],markets:HERE,
    tradeIntel:[...filler,{base_id:'range_base',submitted_at_tick:TICK,items:[{item_id:'gem',best_buy:110,buy_volume:50}]}]},runtime);
  try {
    const out=await routes();
    assert.equal(out.status,'done',out.why);
    const top=out.detail.routes[0]!;
    assert.equal(top.next,"tradeRun({stops:[{at:'range_base'}]})");
    assert.deepEqual([top.legs[0]!.source,top.legs[0]!.age,top.total_jumps,top.net],['faction ledger',0,1,2200-7]);
    assert.equal(f.count('spacemolt_intel/query_trade_intel'),2,'two pages of 20 hold 25 stations');
    assert.ok(f.sent.every(call=>call.action!=='spacemolt_intel/query_trade_intel'||call.params.item_id===undefined),'never filtered by item');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a base both remembered and on the ledger is read from the fresher copy, whichever pays more: routes and spreads alike',async()=>{
  // range_base bids 110 in one copy and 200 in the other; only one copy is the book as it now stands.
  for(const [memoryAge,ledgerAge,bid,source] of [[0,500,110,'remembered'],[500,0,200,'faction ledger']] as const) {
    const runtime=remembered([{base_id:'range_base',age:memoryAge,system_id:'deep_range',items:[{item_id:'gem',best_buy:110,best_buy_qty:50}]}]);
    world({mood:'Focused'},{cargo:[{item_id:'gem',quantity:20}],cargoUsed:20,cargoCapacity:20,store:[],markets:HERE,
      tradeIntel:[{base_id:'range_base',submitted_at_tick:TICK-ledgerAge,items:[{item_id:'gem',best_buy:200,buy_volume:50}]}]},runtime);
    try {
      const top=(await routes()).detail.routes[0]!;
      assert.equal(top.next,"tradeRun({stops:[{at:'range_base'}]})");
      assert.deepEqual([top.legs[0]!.source,top.legs[0]!.age,top.revenue],[source,0,20*bid]);
      const far=(await spreads(['gem'])).detail.spreads.find(row=>row.base_id==='range_base')!;
      assert.deepEqual([far.best_buy,far.source],[bid,source]);
    } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  }
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
  bind({account:f.account as unknown as Account,runtime,pilot:()=>who,emit:()=>{},
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
  let next='';
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
      {at:'sol_base',system_id:'sol',buys:[{item:'gem',qty:20,max_price:110}],sell:[{item:'ore',min_price:27}]},
      {at:'range_base',system_id:'deep_range',buys:[{item:'ore',qty:20,max_price:11}],sell:[{item:'gem',min_price:135}]}]);
    assert.equal(lap.hold,20,'planned for the hold asked for, not the 5 scrap aboard');
    assert.equal(out.detail.routes.filter(row=>row.circuit).length,out.detail.routes.length,'every row is a circuit');
    assert.deepEqual(out.detail.routes.map(row=>row.net),[1386],
      'gems one way and ore one way are the same ring of bases as the round trip, and range→sol is it turned round: one row');
    assert.match(top.next,/^assign\('freighter', \{closed:true,hold:20,/);
    next=top.next;
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  // The row's call is pasted into a pilot file as it is: it has to get through the gate.
  const pilot=mkdtempSync(join(tmpdir(),'circuit-next-'));
  mkdirSync(join(pilot,'pilot'));
  writeFileSync(join(pilot,'pilot','index.ts'),`import {assign} from 'play';\nexport default async function main() {\n  return ${next};\n}\n`);
  const gate=await check(pilot);
  rmSync(pilot,{recursive:true,force:true});
  assert.deepEqual(gate.errors,[]);
});

test('a circuit counts only what a lap both buys and sells: the carry lap one bought is not the middle lap\'s revenue (live: 521 predicted, -10 to -32 flown)',async()=>{
  // markets.json as the trial planned from: nexus (here) bids steel 19 and asks neon 1; beta asks steel 18 and bids neon 2.
  // At 50 deep the middle lap sold 50 steel and bought none (908); at 71 it sold 50 and bought 21 (521). Balanced, 21 steel
  // and 14 neon: 21×19 + 14×2 − 21×18 − 14×1 − 9 tax − 2 jumps × 7 fuel × 4 cr = −30, so neither is a circuit.
  for(const depth of [50,71]) {
    const runtime=remembered([{base_id:'range_base',age:1257,system_id:'deep_range',items:[
      {item_id:'neon_gas',best_buy:2,best_buy_qty:64,buy_orders:[{price_each:2,quantity:64},{price_each:1,quantity:320}],best_sell:5,best_sell_qty:11},
      {item_id:'steel_plate',best_sell:18,best_sell_qty:142928,sell_orders:[{price_each:18,quantity:142928},{price_each:100,quantity:13}]}]}]);
    world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:1200,store:[],taxBps:250,fuelPrice:4,
      markets:{sol_base:[{item_id:'neon_gas',best_sell:1,best_sell_qty:155972,sell_orders:[{price_each:1,quantity:155972},{price_each:15,quantity:52906}],best_buy:0,best_buy_qty:0},
        {item_id:'steel_plate',best_sell:180,best_sell_qty:9118,best_buy:19,best_buy_qty:depth,
          buy_orders:[{price_each:19,quantity:depth},{price_each:18,quantity:202},{price_each:12,quantity:332}]}]}},runtime);
    try {
      const out=await routes({circuit:{hold:50}});
      assert.deepEqual(out.detail.routes.map(row=>[row.net,row.circuit!.stops]),[],`${depth} deep: the steel and neon lap loses money`);
    } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
  }
});

test('a circuit never sells what its lap does not buy (live: 16,681 from 2 targeting computers the lap never bought)',async()=>{
  // The scout's books (tick 1971711), cut to the three goods that ranked. central_nexus is sol_base (here) and
  // node_alpha is range_base, the far base this world's find_route can place. Nexus bids targeting_computer 8360 and
  // asks soma 85; alpha asks targeting_computer 8144 × 2 and bids soma 110 × 10 then 105 × 2, steel 20 × 15 then 19;
  // beta asks steel 18 and bids soma 110 × 1. Lap one takes alpha's two computers, so the steady lap takes none: the
  // next is 8443, over nexus's 8360. Beta ↔ alpha (one system, 0 jumps): 50 steel at 19, the 20s gone in lap one:
  // 950 − 900 − floor(900 × 2.5%) = 28. Beta → alpha → nexus (2 jumps × 7 fuel × 1 cr): beta sells the 1 soma it bids
  // 110 for and buys 39 steel (the 11 soma lap one over-bought still ride to alpha), alpha takes the 39 at 19, nexus
  // buys 1 soma at 85: 110 + 741 − 702 − 17 − 85 − 2 − 14 = 31.
  const runtime=remembered([
    {base_id:'range_base',age:46,system_id:'deep_range',items:[
      {item_id:'targeting_computer',best_sell:8144,best_sell_qty:2,sell_orders:[{price_each:8144,quantity:2},{price_each:8443,quantity:1},{price_each:8610,quantity:1}]},
      {item_id:'voidborn_neural_soma',best_buy:110,best_buy_qty:10,buy_orders:[{price_each:110,quantity:10},{price_each:105,quantity:2},{price_each:73,quantity:4}]},
      {item_id:'steel_plate',best_buy:20,best_buy_qty:15,buy_orders:[{price_each:20,quantity:15},{price_each:19,quantity:1072},{price_each:13,quantity:1824}],
        best_sell:100,best_sell_qty:78792}]},
    {base_id:'node_beta_industrial_station',age:17,system_id:'deep_range',items:[
      {item_id:'targeting_computer',best_buy:35,best_buy_qty:667},
      {item_id:'voidborn_neural_soma',best_buy:110,best_buy_qty:1,buy_orders:[{price_each:110,quantity:1},{price_each:73,quantity:31}],best_sell:464,best_sell_qty:12},
      {item_id:'steel_plate',best_sell:18,best_sell_qty:140298,sell_orders:[{price_each:18,quantity:140298},{price_each:66,quantity:417}]}]}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:1200,store:[],taxBps:250,fuelPrice:1,
    markets:{sol_base:[
      {item_id:'targeting_computer',best_buy:8360,best_buy_qty:7,buy_orders:[{price_each:8360,quantity:7},{price_each:7600,quantity:15}],best_sell:0,best_sell_qty:0},
      {item_id:'voidborn_neural_soma',best_buy:0,best_buy_qty:0,best_sell:85,best_sell_qty:4440,sell_orders:[{price_each:85,quantity:4440},{price_each:89,quantity:31264}]},
      {item_id:'steel_plate',best_buy:12,best_buy_qty:58,buy_orders:[{price_each:12,quantity:58}],best_sell:180,best_sell_qty:9118}]}},runtime);
  try {
    const out=await routes({circuit:{hold:50}});
    assert.equal(out.status,'done',out.why);
    for(const row of out.detail.routes) {
      const bought=new Set(row.circuit!.stops.flatMap(stop=>stop.buys!.map(buy=>buy.item)));
      for(const stop of row.circuit!.stops)for(const sale of stop.sell)
        assert.ok(bought.has(sale.item),`${stop.at} sells ${sale.item}, which no stop on the lap buys`);
    }
    // Sol → alpha → beta, the ring the other way round, now that a stop's buys are the plan's: beta's
    // 48 steel ride through sol to alpha beside the 1 soma sol's two free units take (46).
    assert.deepEqual(out.detail.routes.map(row=>[row.net,row.circuit!.stops.map(stop=>stop.at)]),[
      [28,['node_beta_industrial_station','range_base']],
      [46,['sol_base','range_base','node_beta_industrial_station']],
      [31,['node_beta_industrial_station','range_base','sol_base']]],
      'one row per ring of bases, steel the only thing either repeats');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a stop buys two items when that beats one, and tradeRun buys exactly what routes ranked',async()=>{
  // Sol asks gems at 100, only 10 deep, and ore at 10; range bids 150 and 25. Gems first (50 a unit), then ore (15).
  const RANGE2=[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0},{item_id:'ore',best_buy:25,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
  const runtime=remembered([{base_id:'range_base',age:0,system_id:'deep_range',items:RANGE2}]);
  const f=world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:30,store:[],
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:10},
      {item_id:'ore',best_buy:0,best_buy_qty:0,best_sell:10,best_sell_qty:50}],range_base:RANGE2}},runtime);
  try {
    const top=(await routes({maxStops:2})).detail.routes[0]!;
    assert.equal(top.next,"tradeRun({stops:[{at:'sol_base',buy:['gem','ore']},{at:'range_base'}]})");
    assert.deepEqual(top.legs[0]!.buys,[{item_id:'gem',quantity:10,cost:1000},{item_id:'ore',quantity:20,cost:200}]);
    assert.equal(top.net,1500+500-1000-200-7,'10 gems alone would net 493');

    const run=await tradeRun({stops:[{at:'sol_base',buy:['gem','ore']},{at:'range_base'}]});
    assert.equal(run.status,'done',run.why);
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt/buy').map(call=>call.params),[{id:'gem',quantity:10},{id:'ore',quantity:20}]);
    assert.equal(run.detail.stops[0]!.bought,top.legs[0]!.bought);
    assert.deepEqual(fills(run.detail.stops[1]!),top.legs[1]!.sold.map(sale=>[sale.item_id,sale.quantity]));
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

// Gems at 100 here and 120 at twin, in Sol; twin asks ore at 10 and range, a jump away, bids 60 for it.
const SCOPE_TWIN=[{item_id:'gem',best_buy:120,best_buy_qty:10},{item_id:'ore',best_sell:10,best_sell_qty:10}];
const SCOPE_RANGE=[{item_id:'ore',best_buy:60,best_buy_qty:10}];
function scoped() {
  const runtime=remembered([{base_id:'twin_base',age:0,system_id:'sol',items:SCOPE_TWIN},{base_id:'range_base',age:0,system_id:'deep_range',items:SCOPE_RANGE}]);
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:10,store:[],pois:[{id:'twin',base_id:'twin_base'}],
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}]}},runtime);
  return runtime;
}

test('maxLegJumps leaves out a leg longer than it: at 0, nothing crosses to Deep Range',async()=>{
  const runtime=scoped();
  try {
    const wide=await routes({maxStops:2});
    assert.ok(wide.detail.routes.some(row=>row.legs.some(leg=>leg.at==='range_base')),wide.did);
    const near=await routes({maxStops:2,maxLegJumps:0});
    assert.equal(near.status,'done',near.why);
    assert.ok(near.detail.routes.length,near.did);
    assert.ok(near.detail.routes.every(row=>row.legs.every(leg=>leg.at!=='range_base')&&row.total_jumps===0),near.detail.routes.map(row=>row.next).join('\n'));
    assert.equal((await routes({maxStops:11})).status,'refused');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a larger maxStops finds the longer tour that pays better: gems to twin, then twin ore to range',async()=>{
  const runtime=scoped();
  try {
    const short=(await routes({maxStops:2})).detail.routes[0]!;
    assert.equal(short.next,"tradeRun({stops:[{at:'twin_base',buy:'ore'},{at:'range_base'}]})");
    const long=(await routes({maxStops:3})).detail.routes[0]!;
    assert.equal(long.next,"tradeRun({stops:[{at:'sol_base',buy:'gem'},{at:'twin_base',buy:'ore'},{at:'range_base'}]})");
    assert.equal(long.net,10*120-10*100+10*60-10*10-7,'the ore run alone nets 493');
    assert.ok(long.score>short.score,`${long.score} over ${short.score}`);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a route search lets the event loop run: the bridge\'s freighters and commands wait a slice, not the whole search',async()=>{
  // 25 bases in Sol, each asking and bidding 50 goods at staggered prices: a 5-stop circuit search plans a few thousand laps.
  const goods=(base:number)=>Array.from({length:50},(_,i)=>({item_id:`good_${i}`,best_sell:100+(base*7+i*3)%40,best_sell_qty:50,
    best_buy:120+(base*11+i*5)%40,best_buy_qty:50}));
  const runtime=remembered(Array.from({length:24},(_,b)=>({base_id:`base_${b}`,age:0,system_id:'sol',items:goods(b+1)})));
  world({mood:'Focused'},{cargo:[],cargoUsed:0,cargoCapacity:50,store:[],markets:{sol_base:goods(0)}},runtime);
  // Count turns the loop got, not milliseconds it waited: each yield in the search lets exactly one tick run, so a search that
  // never yields leaves ticks at 0 or 1 however slow or loaded the machine is (the timing version flaked under parallel load, 2026-10-02).
  let running=true,ticks=0;
  const tick=()=>{ticks++;if(running)setImmediate(tick);};
  setImmediate(tick);
  try {
    const out=await routes({circuit:{hold:50},maxStops:5});
    running=false;
    assert.equal(out.status,'done',out.why);
    assert.ok(ticks>=3,`the event loop ran ${ticks} time(s) during the search`);
  } finally {running=false;unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('scoutMarkets reads the nearest unread books, one hop at a time, files them, and says what is left',async()=>{
  // Deep Range's bases were never listed; reach_base, two jumps out, is known by place only.
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-scout-'));
  writeFileSync(join(runtime,'places.json'),JSON.stringify({reach_base:'far_reach'}));
  const f=world({mood:'Focused'},{tradeIntel:[],systems:[{id:'far_reach',connections:['deep_range'],pois:[{id:'reach_dock',base_id:'reach_base'}]}]},runtime);
  const filed=()=>f.sent.filter(c=>c.action==='spacemolt_intel/submit_trade_intel').map(c=>(c.params.stations as {base_id:string}[])[0]!.base_id);
  try {
    const first=await scoutMarkets({max:1});
    assert.equal(first.status,'done',first.why);
    assert.deepEqual(first.detail,{filed:['range_base'],explored:[{system_id:'deep_range',bases:['range_base']}],left:1},first.did);
    assert.match(first.did,/read and filed 1 book\(s\): range_base; listed the bases of deep_range \(1\); 1 more within 4 jumps/);
    assert.equal(first.next[0],'scoutMarkets() again for the next ones');
    const second=await scoutMarkets();
    assert.equal(second.status,'done',second.why);
    assert.deepEqual(second.detail,{filed:['reach_base'],explored:[],left:0},second.did);
    assert.deepEqual(knownBooks(runtime).map(book=>book.base_id).sort(),['range_base','reach_base','sol_base']);
    assert.deepEqual(filed(),['sol_base','range_base','reach_base'],'each book filed to the ledger as it was read');
    const third=await scoutMarkets();
    assert.equal(third.status,'done');
    assert.match(third.did,/filed no book; nothing to scout within 4 jumps/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
