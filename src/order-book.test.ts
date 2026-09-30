/** Ported from spacemolt-lib PR #53 `tests/order-book.test.ts`, adapted to
 * node:test; to be replaced by the lib export once it ships. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {OrderLevel} from '@spacemolt/lib';
import {walkBook} from './order-book.ts';

/** Real depth from frontier_station fuel cells: 12 levels, 993 units total. */
const bids:OrderLevel[]=[
  {price_each:3119,quantity:126},
  {price_each:3103,quantity:56},
  {price_each:3084,quantity:17},
];

test('walkBook fills within the top level at the top price',()=>{
  assert.deepEqual(walkBook(bids,100),{filled:100,gross:311_900,average:3119,unfilled:0});
});

test('walkBook eats through levels, so the average drops below the best price',()=>{
  const walk=walkBook(bids,150);
  assert.equal(walk.filled,150);
  assert.equal(walk.gross,126*3119+24*3103);
  assert.ok(walk.average<3119);
  assert.equal(walk.unfilled,0);
});

test('walkBook reports what the book could not absorb',()=>{
  const walk=walkBook(bids,500);
  assert.equal(walk.filled,199);
  assert.equal(walk.unfilled,301);
});

test('an empty book fills nothing and prices nothing',()=>{
  assert.deepEqual(walkBook([],10),{filled:0,gross:0,average:0,unfilled:10});
});
