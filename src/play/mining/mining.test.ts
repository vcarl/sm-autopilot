import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sellStowed,tripLabel} from './mining.ts';

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
