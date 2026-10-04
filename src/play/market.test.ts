import assert from 'node:assert/strict';
import type {Account} from '@spacemolt/lib';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {sell} from './market.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-market-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  bind({account:game.account as unknown as Account,command:game.command,pilot:()=>record,runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}

test('a store sell over several hold-loads is summed by item in did, not one clause per fill',async()=>{
  // 30 ore out of a 12-capacity hold takes three withdraw-and-sell loads (12, 12, 6), so the
  // fake bridge answers three `spacemolt/sell` fills for the one row — the shape that produced
  // "sold 12 ore, 12 ore, 6 ore" instead of "sold 30 ore".
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{store:[{item_id:'ore',quantity:30}]});
  try {
    const out=await sell([{item_id:'ore'}],{from:'store'});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt/sell'),3,'three fills went into one summed row');
    assert.match(out.did,/^sold 30 ore at sol_base for 300 cr$/);
  } finally {f.close();}
});

test('a fill well under a remembered bid elsewhere is flagged in did, not this book\'s ask',async()=>{
  // The fake bridge always pays a fixed 10/unit. A wide local spread (ask 180) must NOT flag
  // this on its own — only a remembered book elsewhere bidding materially more than the fill.
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'steel_plate',quantity:4}],
    markets:{sol_base:[{item_id:'steel_plate',best_buy:1,best_buy_qty:99,best_sell:180,best_sell_qty:5}]}});
  try {
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'frontier_station',at:'earlier',
      tick:TICK-5683,items:[{item_id:'steel_plate',best_buy:37,best_buy_qty:9,best_sell:0,best_sell_qty:0}]}]));
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/sold 4 steel_plate at 10 \(frontier_station bid 37, 5683 ticks ago\) at sol_base for 40 cr/);
  } finally {f.close();}
});

test('a wide local spread alone, with no better remembered bid, is not flagged',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'steel_plate',quantity:4}],
    markets:{sol_base:[{item_id:'steel_plate',best_buy:10,best_buy_qty:99,best_sell:180,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^sold 4 steel_plate at sol_base for 40 cr$/);
  } finally {f.close();}
});

test('a fill near the live bid is not flagged',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'ore',quantity:4}],
    markets:{sol_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^sold 4 ore at sol_base for 40 cr$/);
  } finally {f.close();}
});
