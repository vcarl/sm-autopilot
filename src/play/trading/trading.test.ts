import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../../test-support/bridge-world.ts';
import {prices} from '../market.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {goTo} from '../travel.ts';
import {spreads,tradeRun} from './trading.ts';

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
  const first=world({mood:'Focused',home:'sol_base'},{cargo:[],cargoUsed:0,store:[],
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
