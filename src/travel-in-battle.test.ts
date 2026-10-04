import assert from 'node:assert/strict';
import test from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessCommand} from './readiness.ts';
import {battleEnded,InBattle} from './travel.ts';
import {travelTo} from './test-support/travel.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

/** One local hop, with the server free to refuse it `in_battle` the way the live one does:
 * "cannot perform this action while in combat. Use the 'battle' command to fight or flee."
 * (gameplay.jsonl, 2026-09-24 22:14:16 and eight more over the two and a half minutes after). */
function fixture(refusals:number) {
  const destination={system_id:'a',poi_id:'belt'};
  const initial={location:{system_id:'a',poi_id:'a_gate',docked_at:null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  let left=refusals,attempts=0;
  const account:FakeLibGoalAccount<typeof initial>=new FakeLibGoalAccount(initial,{spacemolt:{
    find_route:()=>({found:true,target_system:'a',target_poi:'belt',total_jumps:0,estimated_fuel:10,
      fuel_per_jump:0,fuel_available:account.server.ship.fuel,cargo_used:account.server.ship.cargo_used,
      route:[{system_id:'a',jumps:0}]}),
    travel:()=>{
      attempts++;
      if(left-->0)throw new SpacemoltError('in_battle',
        "cannot perform this action while in combat. Use the 'battle' command to fight or flee.");
      account.server.ship.fuel-=10;account.server.location.poi_id='belt';
      return {};
    },
  }},()=>0);
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool!,action!,payload);
  };
  return {account,destination,command,attempts:()=>attempts,
    run:()=>travelTo(account,command,destination,{now:()=>0,sleep:async()=>{}})};
}

test('a move refused in_battle refuses with the battle named, and is never re-issued until the battle ends',async()=>{
  battleEnded();
  const f=fixture(Infinity);
  // First attempt: the server's refusal is classified, not thrown on as an opaque failure.
  await assert.rejects(f.run(),error=>{
    assert.ok(error instanceof InBattle,`${(error as Error).name}: ${(error as Error).message}`);
    assert.match((error as Error).message,/in_battle: a battle holds the ship/);
    assert.match((error as Error).message,/disengage\(\)/,'the refusal names the call that ends it');
    return true;
  });
  assert.equal(f.attempts(),1);
  // Nine of these went on the wire on 2026-09-24 while a Slag-Tortoise shot the hull from 61
  // to 29. Re-asking without the battle ending must not reach the server at all.
  for(let n=0;n<8;n++)await assert.rejects(f.run(),InBattle);
  assert.equal(f.attempts(),1,'the refusal is re-answered from the seam, never re-issued');
  // What ends it: a confirmed disengage, or a `battle_ended`/`player_died` push.
  battleEnded();
  await assert.rejects(f.run(),InBattle);
  assert.equal(f.attempts(),2,'the state changing buys exactly one more attempt');
});

test('an ordinary move with no battle is unchanged, and clears a stale battle refusal',async()=>{
  battleEnded();
  const f=fixture(0);
  const result=await f.run();
  assert.equal(f.attempts(),1);
  assert.deepEqual(result.location,{system_id:'a',poi_id:'belt',docked_at:null,in_transit:false});
  assert.equal(f.account.server.ship.fuel,90);
  // A move the server took is the battle demonstrably over: the next one is not pre-refused.
  const again=fixture(0);
  await again.run();
  assert.equal(again.attempts(),1);
});
