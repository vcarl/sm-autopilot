import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sellStowed} from './mining.ts';

test('the next move names the stowed items as a paste-able sale from the store',()=>{
  assert.deepEqual(sellStowed([{item_id:'aluminum_ore',quantity:112},{item_id:'iridium_ore',quantity:8}]),
    ["sell([{item_id:'aluminum_ore',quantity:112}, {item_id:'iridium_ore',quantity:8}], {from:'store'})"]);
  assert.deepEqual(sellStowed([]),[]);
});
