import assert from 'node:assert/strict';
import test from 'node:test';
import {prose} from './prose.ts';
import type {Call} from './runtime.ts';
import type {Outcome} from './types.ts';

const base:Outcome<{}>={fn:'service',status:'done',did:'serviced at frontier_station',
  cost:{credits:9,fuel:0,hull:0,minutes:1},gained:{credits:0,items:[],xp:{}},
  now:{ship:{fuel:120,max_fuel:120,hull:105,max_hull:105,cargo_used:0,cargo_capacity:120} as any,
    location:{docked_at:'frontier_station',system_name:'The Telescope'} as any,cargo:[],credits:221_615,
    skills:{mining:{level:5} as any},mood:'Focused'},next:[],detail:{}};

test('prose answers the four questions in order and drops empty rows',()=>{
  assert.equal(prose(base),
    'Done: serviced at frontier_station.\nCost this run: 9 cr, 1 min.\n'+
    'Now: docked at frontier_station (The Telescope), fuel 120/120, hull 105/105, hold 0/120, 221,615 cr, mood Focused.');
  const rich=prose({...base,status:'partial',why:'Tired',fn:'gatherUntil',did:'2 trips',
    cost:{credits:0,fuel:0,hull:0,minutes:0},gained:{credits:8589,items:[{item_id:'iridium_ore',quantity:26}],xp:{mining:540}},
    now:{...base.now,mood:'Tired',tired_by:'fuel 3 under the Focused reserve 24'},next:['sell the iridium']});
  assert.match(rich,/^Partial: 2 trips: Tired\.\nCost: nothing\.\nGained: \+8,589 cr; 26 iridium_ore; mining \+540 xp \(level 5\)\.\n/);
  assert.match(rich,/mood Tired \(Tired: fuel 3 under the Focused reserve 24\)\.\nConsider:\n  - sell the iridium$/);
});

test('a trailing no-op cannot erase the trip: the run block names every call it was returned after',()=>{
  const trip:Call={fn:'gatherUntil',arg:'belt',status:'done',did:'mined 26 iridium_ore over 2 trips',
    credits:0,items:26,xp:540,cost:{credits:0,fuel:18,hull:0,minutes:13.7}};
  const noop:Call={fn:'service',arg:'',status:'done',did:'already serviced',
    credits:0,items:0,xp:0,cost:{credits:0,fuel:0,hull:0,minutes:0}};
  const text=prose(base,[trip,noop]);
  assert.match(text,/^Done: serviced at frontier_station\.\nCost this run: 9 cr, 1 min\.\n/);
  assert.match(text,/\nThis run: 2 calls, cost 18 fuel, 13\.7 min, gained \+26 items, \+540 xp\.\n/);
  assert.match(text,/\n {2}- gatherUntil done mined 26 iridium_ore over 2 trips\n {2}- service done already serviced$/);
  // One call is the returned Outcome's own; no block.
  assert.equal(prose(base,[noop]).includes('This run:'),false);
  // Older calls are elided so the block stays eight lines.
  const many=prose({...base,next:['rest']},Array.from({length:12},(_,i)=>({...trip,did:`trip ${i}`})));
  const block=many.split('This run:')[1]!.split('Consider:')[0]!;
  assert.equal(block.split('\n').filter(line=>line.startsWith('  - ')).length,8);
  assert.match(many,/ {2}- \(5 earlier call\(s\)\)\n {2}- gatherUntil done trip 5\n/);
  assert.match(many,/Consider:\n {2}- rest$/);
});
