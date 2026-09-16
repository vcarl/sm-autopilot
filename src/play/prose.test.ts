import assert from 'node:assert/strict';
import test from 'node:test';
import {prose} from './prose.ts';
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
