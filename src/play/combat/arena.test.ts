import assert from 'node:assert/strict';
import type {Account} from '@spacemolt/lib';
import test from 'node:test';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {fightBattle,pace} from './hunting.ts';

pace.tickMs=1;

function world(options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  bind({account:game.account as unknown as Account,command:game.command,pilot:():Pilot=>({mood:'Focused'}),emit:text=>lines.push(text)});
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
