import assert from 'node:assert/strict';
import type {Account} from '@spacemolt/lib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readCombat} from '../../combat-memory.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {arena,duel} from './arena.ts';
import {fightBattle,pace} from './hunting.ts';

pace.tickMs=1;

function world(options:WorldOptions={},runtime?:string) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  bind({account:game.account as unknown as Account,command:game.command,...runtime?{runtime}:{},
    pilot:():Pilot=>({mood:'Focused'}),emit:text=>lines.push(text)});
  return {...game,lines};
}
const MUTATIONS=new Set(['spacemolt_battle/stance','spacemolt_battle/target','spacemolt_battle/advance','spacemolt_battle/retreat','spacemolt_battle/reload']);
const stances=(f:ReturnType<typeof world>)=>f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params?.id);

// Live (kvothe, programs/17cc87c935f3.ts): the pilot's loop advanced on OUR row's zone_distance, stopped at 2 while the
// Ring Levy held 3 against a reach of 2, and dealt nothing — enemy shield 14→100, its hull 98%.
test('fightBattle measures range from the opponent\'s row, not ours, and stops advancing once in reach',async()=>{
  const f=world({arena:{challenges:[{challenge_id:'first_blood'}],enemies:[{id:'npc-1',name:'Ring Levy',distance:3}],ourDistance:2,polls:8}});
  try {
    await f.command('spacemolt_arena/fight',{id:'first_blood'});
    const out=await fightBattle({floor:0});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt_battle/advance'),1,'one advance closes 3 to 2, and none after');
    assert.equal(f.count('spacemolt/attack'),0,'a battle already under way is not opened with an attack');
    assert.match(f.lines.join('\n'),/vs Ring Levy: .* 3\/2 — OUT OF REACH/);
    assert.equal(out.detail.dealt! > 0,true,'in reach, it dealt damage');
  } finally {unbind();}
});

// Fights 1-3 of the live arena record opened with empty magazines, and no program ever sent battle/reload.
test('fightBattle reloads an empty weapon from the hold, once',async()=>{
  const f=world({cargo:[{item_id:'autocannon',quantity:3}],cargoUsed:3,
    wildlife:{weapon:{ammo_type:'autocannon',current_ammo:0}},arena:{challenges:[{challenge_id:'first_blood'}],polls:6}});
  try {
    await f.command('spacemolt_arena/fight',{id:'first_blood'});
    await fightBattle({floor:0});
    assert.equal(f.count('spacemolt_battle/reload'),1);
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt_battle/reload')?.params,{id:'w1'});
    assert.equal(f.account.server.modules[0]!.current_ammo,50);
  } finally {unbind();}
});

// Five live loops had no pacing: 60-148 commands in seconds. The server takes one mutation a tick.
test('fightBattle sends at most one command between status reads, and none spams',async()=>{
  const f=world({arena:{challenges:[{challenge_id:'first_blood'}],enemies:[{id:'npc-1',name:'Ring Levy',distance:4}],polls:10}});
  try {
    await f.command('spacemolt_arena/fight',{id:'first_blood'});
    await fightBattle({floor:0});
    let since=0;
    for(const call of f.sent.slice(1)) {
      if(call.action==='spacemolt_battle/status')since=0;
      else if(MUTATIONS.has(call.action))assert.ok(++since<=1,`two commands in one tick: ${JSON.stringify(f.sent.map(row=>row.action))}`);
    }
  } finally {unbind();}
});

test('an opponent holding out of reach while it hits us is met with evade, and fire again once the range moves',async()=>{
  const f=world({arena:{challenges:[{challenge_id:'first_blood'}],enemies:[{id:'npc-1',name:'Ring Levy',distance:3,holds:3}],damage:1,polls:8}});
  try {
    await f.command('spacemolt_arena/fight',{id:'first_blood'});
    await fightBattle({floor:0});
    assert.deepEqual(stances(f),['fire','evade'],'it stays evading while the range stands still');
    assert.match(f.lines.join('\n'),/stance evade: Ring Levy has held 3 against our reach 2/);
  } finally {unbind();}
  const g=world({arena:{challenges:[{challenge_id:'first_blood'}],enemies:[{id:'npc-1',name:'Ring Levy',distance:4,holds:2}],damage:1,polls:10}});
  try {
    await g.command('spacemolt_arena/fight',{id:'first_blood'});
    await fightBattle({floor:0});
    // 4 out of reach while hit: fire, focus, evade at 4, then the advance moves it to 3 and fire returns.
    assert.deepEqual(stances(g).slice(0,3),['fire','evade','fire']);
  } finally {unbind();}
});

test('fightBattle with no battle holding the ship is done with no rounds',async()=>{
  world({arena:{}});
  try {
    const out=await fightBattle();
    assert.equal(out.status,'done');
    assert.equal(out.detail.polls,0);
  } finally {unbind();}
});

// Live: `rule_ship_tier` refused a tier-2 hull once the fight had been sent. The rule is on the challenge row.
test('arena() refuses a hull above the challenge\'s tier rule, naming it, and never sends fight',async()=>{
  const f=world({arena:{challenges:[{challenge_id:'first_blood',max_ship_tier:1}]}});
  try {
    f.account.server.ship.class_id='hauler_ii';
    const out=await arena();
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/rule_ship_tier: hauler_ii is tier 2, and first_blood takes tier 0-1/);
    assert.equal(f.count('spacemolt_arena/fight'),0);
  } finally {unbind();}
});

// 11 of 13 live matches were forfeited by a flee. A Focused walk-away line (90 of 100) is crossed here on the first
// round; the arena fights through it, because losing costs nothing and fleeing forfeits.
test('arena() fights to the end through the walk-away line, never flees, and scores the match from the record',async()=>{
  const f=world({arena:{challenges:[{challenge_id:'first_blood'}],damage:10,polls:8,record:{wins:2,losses:5}}});
  try {
    const out=await arena();
    assert.equal(out.status,'done',out.why);
    assert.equal(f.sent.some(call=>call.action==='spacemolt_battle/stance'&&call.params?.id==='flee'),false);
    assert.equal(out.detail.result,'win');
    assert.deepEqual(out.detail.record,{before:{wins:2,losses:5},after:{wins:3,losses:5}});
    assert.ok(out.detail.battle.dealt!>0&&out.detail.battle.taken!>0,JSON.stringify(out.detail.battle));
    assert.ok(f.account.server.ship.hull<90,'it fought under the line');
  } finally {unbind();}
  const g=world({arena:{challenges:[{challenge_id:'first_blood'}],enemies:[{id:'npc-1',name:'Ring Levy',distance:3,holds:3}],polls:4}});
  try {
    const out=await arena({challenge:'first_blood'});
    assert.equal(out.detail.result,'loss');
    assert.match(out.did,/first_blood: loss \(arena record 0-1\)/);
    assert.equal(g.count('spacemolt_arena/fight'),1);
  } finally {unbind();}
});

test('duel() fights once the challenge is accepted, and withdraws one never answered',async()=>{
  const f=world({arena:{acceptOn:3,polls:6}});
  try {
    const out=await duel({player:'Rival',max_side_size:1});
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt_arena/challenge')?.params,{id:'Rival',max_side_size:1});
    assert.equal(out.detail.result,'win');
  } finally {unbind();}
  const g=world({arena:{}});
  try {
    const out=await duel({player:'Rival',waitMs:3});
    assert.equal(out.status,'partial');
    assert.match(out.why??'',/not accepted in .*; withdrawn/);
    assert.equal(g.count('spacemolt_arena/cancel'),1);
  } finally {unbind();}
});

test('arena() folds the match into combat.json beside the hunts, marked with its challenge and the record delta',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-arena-'));
  world({arena:{challenges:[{challenge_id:'first_blood',enemies:[{name:'Ring Levy',is_boss:true}]}],polls:8}},runtime);
  try {
    const out=await arena();
    const [fight]=readCombat(runtime);
    assert.deepEqual([fight?.battle_id,fight?.arena,fight?.arena_result,fight?.opponent,fight?.dealt],
      ['arena-1','first_blood',out.detail.result,'Ring Levy',out.detail.battle.dealt]);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
