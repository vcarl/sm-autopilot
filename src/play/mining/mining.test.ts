import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {gatherUntil,sellStowed,tripLabel} from './mining.ts';

test('the next move names the stowed items as a paste-able sale from the store',()=>{
  assert.deepEqual(sellStowed([{item_id:'aluminum_ore',quantity:112},{item_id:'iridium_ore',quantity:8}]),
    ["sell([{item_id:'aluminum_ore',quantity:112}, {item_id:'iridium_ore',quantity:8}], {from:'store'})"]);
  assert.deepEqual(sellStowed([]),[]);
});

test('a trip cap is named whenever it was passed, because maxTrips is now honored without until',()=>{
  // The live pilot's own index.ts calls `gatherUntil({poi, then:'sell', maxTrips: loops})` with no
  // `until` and expected `loops` trips (report: maxTrips:2 with no until made only one trip). The
  // label now names the cap whenever it was asked for, whether or not `until` is also given.
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3}),'belt → sol_base ≤3 trips');
  assert.equal(tripLabel({poi:'belt',maxTrips:3,then:'sell'}),'belt ≤3 trips then sell');
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3,until:{item:'ore',quantity:99}}),
    'belt → sol_base until ore ≥ 99 ≤3 trips');
  // And the default cap is not invented into the label when it was not asked for.
  assert.equal(tripLabel({poi:'belt',until:{item:'ore',quantity:99}}),'belt until ore ≥ 99');
  assert.equal(tripLabel({poi:'belt',base:'sol_base'}),'belt → sol_base');
});

test('maxTrips with no until still makes that many trips (regression for the report: maxTrips:2 made one)',async()=>{
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0});
  const who:Pilot={mood:'Focused'};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:()=>who,emit:()=>{}});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',maxTrips:2});
    assert.equal(out.detail.trips,2,JSON.stringify(out));
    // Each trip mines, comes home and stows: two trips means two settle/mine cycles ran.
    assert.equal(game.count('spacemolt/mine')>=2,true,'at least one mine call per trip');
    assert.equal(game.count('spacemolt/dock'),2,'one dock per return leg, one per trip');
  } finally {unbind();}
});
