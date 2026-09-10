import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessEngagement, type CombatantEstimate, type ContactEstimate} from './threat-assessment.ts';
import {assessNearby, type WildlifeIntel} from './combat-assessment.ts';
import type {Account} from '@spacemolt/lib';
const self:CombatantEstimate={id:'self',hull:105,maxHull:105,shield:35,shieldRecharge:1,speed:2,durability:1,
  shieldBypass:false,evidence:'fixture',weapons:[{damage:10,cooldown:1,reach:2,rounds:500}]};
const enemy=(id:string):ContactEstimate=>({id,participation:'target',capability:{...self,id,hull:55,maxHull:55,
  shield:0,shieldRecharge:0,weapons:[{damage:4,cooldown:1,reach:3}]}});

test('aggregate threats consume shared damage, time, ammunition and escape reserves; stronger ships expand viable encounters',()=>{
  const a=enemy('a'),b=enemy('b');
  assert.equal(assessEngagement(self,[a]).decision,'engage');
  assert.equal(assessEngagement(self,[b]).decision,'engage');
  const group=assessEngagement(self,[a,b]);
  assert.equal(group.decision,'avoid');
  assert.ok(group.estimates!.projectedDamage!>assessEngagement(self,[a]).estimates!.projectedDamage!);
  const strong={...self,hull:1000,maxHull:1000,shield:500,weapons:[{damage:100,cooldown:1,reach:3,rounds:500}]};
  assert.equal(assessEngagement(strong,[a,b]).decision,'engage');
  assert.equal(assessEngagement(strong,[{...a,capability:{...a.capability!,hull:250,maxHull:250}}]).decision,'engage');
  assert.equal(assessEngagement({...self,hull:84},[a]).decision,'avoid');
  assert.equal(assessEngagement({...self,weapons:[{...self.weapons[0]!,rounds:2}]},[a]).decision,'avoid');
  assert.equal(assessEngagement(self,[{...a,capability:{...a.capability!,speed:10}}]).decision,'avoid');
  assert.equal(assessEngagement(self,[a,{id:'unknown',participation:'possible'}]).decision,'need_intelligence');
  assert.equal(assessEngagement(self,[a,{id:'neutral',participation:'bystander'}]).decision,'engage');
  assert.equal(assessEngagement(self,[a,a]).decision,'avoid');
  assert.equal(assessEngagement({...self,shield:NaN},[a]).decision,'need_intelligence');
});

test('wildlife adapter uses evidenced capability, not role, and includes possible attackers without counting passive herds',()=>{
  const account={state:{player:{id:'self'},modules:[{type_id:'weapon',slot:'weapon',stats:{damage:10,cooldown:1,reach:2}}]},
    ship:{hull:105,max_hull:105,shield:35,shield_recharge:1,speed:2,armor:3}} as unknown as Account;
  const profile:WildlifeIntel={passive:false,maxHullObserved:55,damagePerTick:4,durability:1,speedEstimate:2,
    minimumOwnArmor:3,weaponTypes:['weapon'],evidence:'Test evidence'};
  const creature={creature_id:'a',species:'known',role:'predator',hull:55,max_hull:55,in_combat:false,name:'Known predator'};
  const intel={known:profile};
  assert.equal(assessNearby(account,{creatures:[creature]},['a'],{},intel).decision,'engage');
  const herd={...creature,creature_id:'herd',species:'unknown',role:'grazer'};
  assert.equal(assessNearby(account,{creatures:[creature,herd]},['a'],{},intel).decision,'engage');
  assert.equal(assessNearby(account,{creatures:[creature,herd]},['a','herd'],{},intel).decision,'need_intelligence');
  assert.equal(assessNearby(account,{creatures:[creature,{...herd,role:'predator'}]},['a'],{},intel).decision,'need_intelligence');
  assert.equal(assessNearby(account,{creatures:[creature,{...creature,creature_id:'b'}]},['a'],{},intel).decision,'avoid');
  assert.equal(assessNearby(account,{creatures:[{...creature,branded:true}]},['a'],{},intel).decision,'avoid');
  assert.equal(assessNearby(account,{creatures:[creature],pirate_count:1,pirates:[]},['a'],{},intel).decision,'need_intelligence');
  assert.equal(assessNearby(account,{creatures:[creature]},['missing'],{},intel).decision,'need_intelligence');
  assert.equal(assessNearby(account,{creatures:[{...creature,species:'unknown',role:'grazer'}]},['a'],{},intel).decision,'need_intelligence');
});
