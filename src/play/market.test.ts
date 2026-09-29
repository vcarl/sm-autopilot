import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {sell} from './market.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:()=>record,emit:()=>{}});
  return game;
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
  } finally {unbind();}
});

test('a fill priced well under this book\'s live ask is flagged in did',async()=>{
  // The fake bridge always pays a fixed 10/unit; a book asking 180 here makes that fill land
  // under half the live ask, which is the threshold the did note fires on.
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'steel_plate',quantity:4}],
    markets:{sol_base:[{item_id:'steel_plate',best_buy:10,best_buy_qty:99,best_sell:180,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/sold 4 steel_plate at 10 \(asks 180 here\) at sol_base for 40 cr/);
  } finally {unbind();}
  void f;
});

test('a fill near the live ask is not flagged',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'ore',quantity:4}],
    markets:{sol_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^sold 4 ore at sol_base for 40 cr$/);
  } finally {unbind();}
  void f;
});
