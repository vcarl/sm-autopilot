import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sellStowed,tripLabel} from './mining.ts';

test('the next move names the stowed items as a paste-able sale from the store',()=>{
  assert.deepEqual(sellStowed([{item_id:'aluminum_ore',quantity:112},{item_id:'iridium_ore',quantity:8}]),
    ["sell([{item_id:'aluminum_ore',quantity:112}, {item_id:'iridium_ore',quantity:8}], {from:'store'})"]);
  assert.deepEqual(sellStowed([]),[]);
});

test('a trip cap is named only when it is in force, because maxTrips without until does nothing',()=>{
  // The live pilot's own index.ts calls `gatherUntil({poi, then:'sell', maxTrips: loops})` with no
  // `until`. That is the documented single-trip form — trips loop only towards an `until` target —
  // but the run label said "≤3 trips" anyway, so the journal advertised a cap that was not in force
  // and a count that never applied. A pilot reading its own record learns the wrong lesson.
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3}),'belt → sol_base');
  assert.equal(tripLabel({poi:'belt',maxTrips:3,then:'sell'}),'belt then sell');
  // With `until` the cap is real, so it is named.
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3,until:{item:'ore',quantity:99}}),
    'belt → sol_base until ore ≥ 99 ≤3 trips');
  // And the default cap is not invented into the label when it was not asked for.
  assert.equal(tripLabel({poi:'belt',until:{item:'ore',quantity:99}}),'belt until ore ≥ 99');
});
