import assert from 'node:assert/strict';
import test from 'node:test';
import {ofTheRun,prose} from './prose.ts';
import type {Call} from './runtime.ts';
import type {Outcome} from './types.ts';

const base:Outcome<{}>={fn:'service',status:'done',did:'serviced at frontier_station',
  cost:{credits:9,fuel:0,hull:0,minutes:1},gained:{credits:0,items:[],xp:{}},
  now:{ship:{fuel:120,max_fuel:120,hull:105,max_hull:105,cargo_used:0,cargo_capacity:120} as any,
    location:{docked_at:'frontier_station',system_name:'The Telescope'} as any,cargo:[],credits:221_615,
    skills:{mining:{level:5} as any},mood:'Focused'},next:[],detail:{}};

test('prose answers the four questions in order and drops empty rows',()=>{
  assert.equal(prose(base),
    'Done: serviced at frontier_station.\nCost this flight: 9 cr, 1 min.\n'+
    'Now: docked at frontier_station (The Telescope), fuel 120/120, hull 105/105, hold 0/120 (fuel cells 0/6), 221,615 cr, mood Focused.');
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
  // One cost, from the calls: the returned Outcome measures only from its own mark.
  assert.match(text,/^Done: serviced at frontier_station\.\nCost this flight: 18 fuel, 13\.7 min\.\n/);
  assert.match(text,/\nThis flight: 2 calls, gained \+26 items, \+540 xp\.\n/);
  assert.match(text,/\n {2}- gatherUntil done mined 26 iridium_ore over 2 trips\n {2}- service done already serviced$/);
  // One call is the returned Outcome's own; no block.
  assert.equal(prose(base,[noop]).includes('This flight:'),false);
  // Older calls are elided so the block stays eight lines.
  const many=prose({...base,next:['rest']},Array.from({length:12},(_,i)=>({...trip,did:`trip ${i}`})));
  const block=many.split('This flight:')[1]!.split('Consider:')[0]!;
  assert.equal(block.split('\n').filter(line=>line.startsWith('  - ')).length,8);
  assert.match(many,/ {2}- \(5 earlier call\(s\)\)\n {2}- gatherUntil done trip 5\n/);
  assert.match(many,/Consider:\n {2}- rest$/);
});

test('the cost is said once, from the run and not from the returned call\'s own mark',()=>{
  // The fight cost 28 hull; the no-op it returned after measured nothing since its mark, and
  // the report said "Cost: nothing" over it.
  const fight:Call={fn:'hunt',arg:'',status:'done',did:'killed 3',credits:0,items:0,xp:60,
    cost:{credits:0,fuel:4,hull:28,minutes:9}};
  const noop:Call={fn:'service',arg:'',status:'done',did:'already serviced',
    credits:0,items:0,xp:0,cost:{credits:0,fuel:0,hull:0,minutes:0}};
  const text=prose({...base,cost:{credits:0,fuel:0,hull:0,minutes:0}},[fight,noop]);
  assert.match(text,/\nCost this flight: 4 fuel, 28 hull, 9 min\.\n/);
  assert.equal(text.includes('Cost: nothing'),false);
  assert.equal(/cost /.test(text.split('This flight:')[1]!),false,'the run block does not say it again');
});

test('a call that did not end done carries its why, so the reason is not dropped from the report',()=>{
  const refused:Call={fn:'goTo',arg:'node_alpha_station',status:'refused',
    did:'could not route to node_alpha_station',
    why:'no system, POI or base is named node_alpha_station; nearest: node_alpha (system Node Alpha)',
    credits:0,items:0,xp:0,cost:{credits:0,fuel:0,hull:0,minutes:0}};
  const noop:Call={fn:'service',arg:'',status:'done',did:'already serviced',
    credits:0,items:0,xp:0,cost:{credits:0,fuel:0,hull:0,minutes:0}};
  const text=prose(base,[refused,noop]);
  assert.match(text,/\n {2}- goTo refused could not route to node_alpha_station: no system, POI or base is named node_alpha_station; nearest: node_alpha \(system Node Alpha\)\n/);
  // A done line has nothing to explain and gains no colon.
  assert.match(text,/\n {2}- service done already serviced$/);
});

test('the run reads from its work, not its last call',()=>{
  // Live 2026-10-01 (kvothe 15:25Z): two tradeRun calls earned 5,071 and 2,452 cr, the third lap was
  // cut at the cap, and the run read "confederacy_central_command: nothing; did not reach nova_terra_central".
  const zero={credits:0,fuel:0,hull:0,minutes:0};
  const lap=(credits:number,items:number):Call=>({fn:'tradeRun',arg:'ccc',status:'done',did:`lap +${credits}`,credits,items,xp:0,cost:zero,
    gained:{credits,items:[{item_id:'circuit_board',quantity:items}],xp:{trading:10}}});
  const cut:Call={fn:'tradeRun',arg:'ccc',status:'partial',did:'ccc: nothing; did not reach ntc',why:'ntc: stopped by pilot',
    credits:0,items:0,xp:0,cost:zero,gained:{credits:0,items:[],xp:{navigation:13}}};
  const last={...base,fn:'tradeRun',status:'partial' as const,did:cut.did,why:'ntc: stopped by pilot',gained:cut.gained!};
  const run=ofTheRun(last,[lap(5071,1),lap(2452,1),cut]);
  assert.equal(run.status,'done');
  assert.equal(run.did,'2 calls gained +7,523 cr, +2 items: lap +5071; last call tradeRun partial: ccc: nothing; did not reach ntc: ntc: stopped by pilot');
  assert.equal(run.why,undefined);
  assert.deepEqual(run.gained,{credits:7523,items:[{item_id:'circuit_board',quantity:2}],xp:{trading:20,navigation:13}});
  assert.match(prose(run),/^Done: 2 calls gained \+7,523 cr/);
  // 09-30 run 8e0abef8: 27 items mined, then service() refused off a station; the run read `refused`.
  const trip:Call={fn:'gatherUntil',arg:'belt',status:'partial',did:'mined 27 units',why:'mine blocked: stopped by pilot',
    credits:0,items:27,xp:68,cost:zero};
  const refused:Call={fn:'service',arg:'',status:'refused',did:'serviced nothing',why:'not docked',credits:0,items:0,xp:0,cost:zero};
  const mined=ofTheRun({...base,status:'refused',did:'serviced nothing',why:'not docked'},[trip,refused]);
  assert.equal(mined.status,'partial');
  assert.equal(mined.did,'gatherUntil gained +27 items: mined 27 units (mine blocked: stopped by pilot); last call service refused: serviced nothing: not docked');
  // Left alone: an outcome main() composed, a run that earned nothing, the returned call as the only earner.
  const own={...base,fn:'pilot'};
  assert.equal(ofTheRun(own,[trip,refused]),own);
  assert.equal(ofTheRun(base,[refused]),base);
  assert.equal(ofTheRun(base,[refused,trip]),base);
});
