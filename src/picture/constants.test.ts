import assert from 'node:assert/strict';
import test from 'node:test';
import {EPOCH_HUES,GAP,hueOf,KINDS} from './constants.ts';
test('constants match the design report',()=>{
  assert.equal(GAP,24);
  assert.deepEqual([...KINDS],['fights','docked','traded','fuel','creatures']);
  assert.equal(hueOf(0),'#2EC4B6');
  assert.equal(hueOf(EPOCH_HUES.length),'#2EC4B6');
});
