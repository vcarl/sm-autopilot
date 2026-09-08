import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotSkills,skillProgress,productionMarginPolicy} from './progression.ts';
import {viableSpend} from './industry.ts';

test('canonical same-level XP gains are distinct from level-ups and missing/reset counters',()=>{
  const before=snapshotSkills({skills:{crafting:{level:1,xp:8},refining:{level:0,xp:90},trading:{level:2,xp:20}}});
  const after=snapshotSkills({skills:{crafting:{level:1,xp:11},refining:{level:1,xp:5},trading:{level:2,xp:3},engineering:{level:1}}});
  const changes=skillProgress(before,after);
  assert.equal(changes.find(row=>row.skill_id==='crafting')!.verified_xp_gain,3);
  const levelup=changes.find(row=>row.skill_id==='refining')!;
  assert.equal(levelup.level_gain,1);assert.equal(levelup.verified_xp_gain,null);
  assert.equal(changes.find(row=>row.skill_id==='trading')!.verified_xp_gain,null);
  assert.equal(changes.find(row=>row.skill_id==='engineering')!.verified_xp_gain,null);
  assert.deepEqual(skillProgress(before,before),[]);
  assert.deepEqual(snapshotSkills({player:{skills:{mining:2},skill_xp:{mining:6}}}),{mining:{level:2,xp:6}});
});

test('learning loss requires an explicit goal and does not relax spend or wallet reserves',()=>{
  assert.equal(productionMarginPolicy({}).minimum_economic_margin,1);
  assert.equal(productionMarginPolicy({learning_goal:'practice refining'}).minimum_economic_margin,1);
  assert.throws(()=>productionMarginPolicy({max_learning_loss:10}),/learning_goal/);
  assert.throws(()=>productionMarginPolicy({learning_goal:' ',max_learning_loss:10}),/learning_goal/);
  const learning=productionMarginPolicy({learning_goal:'measure refining XP',max_learning_loss:5});
  assert.equal(learning.mode,'learning');assert.equal(learning.minimum_economic_margin,-5);
  const plan={spent:0,remaining:10,labor:2,revenue:8,opportunity:0,wallet:100,reserve:50,maxSpend:20,minProfit:learning.minimum_economic_margin};
  assert.equal(viableSpend(plan),true);
  assert.equal(viableSpend({...plan,minProfit:1}),false);
  assert.equal(viableSpend({...plan,revenue:6}),false);
  assert.equal(viableSpend({...plan,wallet:60}),false);
  assert.equal(viableSpend({...plan,maxSpend:11}),false);
});
