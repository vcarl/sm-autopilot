import assert from 'node:assert/strict';
import test from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import type {ReadinessCommand} from './readiness.ts';
import {GameLive,Rejected,ReplyLost,type Game} from './play/game.ts';
import {battleEnded,battleNowEffect,battleStirred,InBattle,TravelBlocked,travelToEffect} from './travel.ts';
import {onWorldClock,travelTo} from './test-support/travel.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

/** One local hop from a dock, where each command the server may refuse answers the way the live one
 * does: a thrown `SpacemoltError` (in_battle: gameplay.jsonl 2026-09-24 22:14) or a lost reply
 * (`mutation_timeout`, an uncertain code). */
function world(refuse:{undock?:SpacemoltError;travel?:SpacemoltError;status?:SpacemoltError|object;route?:object[]}={}) {
  const destination={system_id:'a',poi_id:'belt'};
  const initial={location:{system_id:'a',poi_id:'a_station',docked_at:'a_base' as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,cargo_used:0}};
  const account:FakeLibGoalAccount<typeof initial>=new FakeLibGoalAccount(initial,{
    spacemolt:{
      find_route:()=>({found:true,target_system:'a',target_poi:'belt',total_jumps:0,estimated_fuel:10,
        fuel_per_jump:0,fuel_available:account.server.ship.fuel,cargo_used:account.server.ship.cargo_used,
        route:refuse.route??[{system_id:'a',jumps:0}]}),
      undock:()=>{if(refuse.undock)throw refuse.undock;account.server.location.docked_at=null;return {};},
      travel:()=>{if(refuse.travel)throw refuse.travel;account.server.ship.fuel-=10;account.server.location.poi_id='belt';return {};},
    },
    spacemolt_battle:{status:()=>{if(refuse.status instanceof SpacemoltError)throw refuse.status;return refuse.status??{};}},
  },()=>0);
  const command:ReadinessCommand=(name,payload)=>{const [tool,action]=name.split('/');return account.send(tool!,action!,payload);};
  const sent=(action:string)=>account.calls.filter(call=>`${call.tool}/${call.action}`===action).length;
  const opts={now:()=>0,sleep:async()=>{}};
  return {account,destination,command,sent,opts,
    run:()=>travelTo(account,command,destination,opts),
    effect:()=>Effect.runPromise(onWorldClock(Effect.result(travelToEffect(account,destination,{})),opts).pipe(Effect.provide(GameLive({send:command}))))};
}
const inBattle=()=>new SpacemoltError('in_battle',"cannot perform this action while in combat. Use the 'battle' command to fight or flee.");

test('an undock refused in_battle ends in travel\'s InBattle, and the next move never touches the wire',async()=>{
  battleEnded();
  const w=world({undock:inBattle()});
  await assert.rejects(w.run(),error=>{
    assert.ok(error instanceof InBattle);
    assert.match(error.message,/in_battle: a battle holds the ship/);
    assert.match(error.message,/cannot perform this action while in combat/,'the server\'s own words ride along');
    return true;
  });
  assert.equal(w.sent('spacemolt/undock'),1);
  const before=w.account.calls.length;
  await assert.rejects(w.run(),InBattle);
  assert.equal(w.account.calls.length,before,'the remembered refusal is answered without a command');
  battleEnded();
});

test('a jump or travel refused with another code reaches the Promise caller as the raw SpacemoltError',async()=>{
  battleEnded();
  const w=world({travel:new SpacemoltError('no_route','No route to that place')});
  await assert.rejects(w.run(),error=>{
    assert.ok(error instanceof SpacemoltError&&!(error instanceof InBattle));
    assert.equal(error.code,'no_route');
    return true;
  });
  // The twin keeps it a value, a named tag with the server's code, never an unnamed Error.
  const tried=await world({travel:new SpacemoltError('no_route','No route to that place')}).effect();
  assert.ok(Result.isFailure(tried));
  assert.ok(tried.failure instanceof Rejected&&tried.failure.code==='no_route');
});

test('a travel refused in_battle is a tag in the twin and travel\'s InBattle for the Promise caller',async()=>{
  battleEnded();
  const w=world({travel:inBattle()});
  await assert.rejects(w.run(),InBattle);
  battleEnded();
  const tried=await world({travel:inBattle()}).effect();
  assert.ok(Result.isFailure(tried)&&tried.failure instanceof InBattle,'travel\'s own refusal is a failure value in the twin');
  battleEnded();
});

test('a lost reply on travel is not re-sent, and the caller sees the lost reply itself',async()=>{
  battleEnded();
  const w=world({travel:new SpacemoltError('mutation_timeout','no reply in time')});
  await assert.rejects(w.run(),error=>error instanceof SpacemoltError&&error.code==='mutation_timeout');
  assert.equal(w.sent('spacemolt/travel'),1,'a mutation whose reply is lost is never re-sent');
  const tried=await world({travel:new SpacemoltError('mutation_timeout','no reply in time')}).effect();
  assert.ok(Result.isFailure(tried)&&tried.failure instanceof ReplyLost);
});

test('a lost reply that carries a retryable code is still never re-sent',async()=>{
  battleEnded();
  // "in_transit" alone is retried once; with a pending command the reply is lost, so the move may have landed.
  const w=world({travel:new SpacemoltError('in_transit','already moving',{pendingCommand:'travel'})});
  await assert.rejects(w.run(),error=>error instanceof SpacemoltError&&error.pendingCommand==='travel');
  assert.equal(w.sent('spacemolt/travel'),1);
});

const run=<A,E>(effect:Effect.Effect<A,E,Game>,w:ReturnType<typeof world>)=>Effect.runPromise(effect.pipe(Effect.provide(GameLive({send:w.command}))));

test('battleNow: a refusal or a lost reply is no battle and clears the remembered one; a battle names its opponent and tick',async()=>{
  battleEnded();
  const held=world({undock:inBattle()});
  await assert.rejects(held.run(),InBattle);
  // The server refuses battle/status: no battle, so the next move is not pre-refused.
  const refused=world({status:new SpacemoltError('not_in_battle','you are not in a battle')});
  assert.equal(await run(battleNowEffect(),refused),undefined);
  const free=world();
  await free.run();
  assert.equal(free.sent('spacemolt/travel'),1);
  // The server's "not in a battle" is remembered: with no battle frame since, it is not asked again.
  const again=world();
  assert.equal(await run(battleNowEffect(),again),undefined);
  assert.equal(again.sent('spacemolt_battle/status'),0);
  // A battle frame (or a dropped socket) sends the next read to the wire. A lost reply is no battle,
  // but proves nothing, so the read after it goes to the wire too.
  battleStirred();
  const lost=world({status:new SpacemoltError('mutation_timeout','no reply in time')});
  assert.equal(await run(battleNowEffect(),lost),undefined);
  assert.equal(lost.sent('spacemolt_battle/status'),1);
  // A battle: the first non-player or NPC participant, and the tick.
  const fight=world({status:{battle_id:'b1',tick_duration:10,participants:[
    {kind:'player',player_id:'me',is_npc:false},{kind:'npc',username:'Slag-Tortoise',is_npc:true}]}});
  assert.deepEqual(await run(battleNowEffect(),fight),{opponent:'Slag-Tortoise',tick:10});
  // And it is remembered: the move is refused without a command.
  const after=world();
  await assert.rejects(after.run(),InBattle);
  assert.equal(after.account.calls.length,0);
  battleEnded();
});

test('a quoted route through a wormhole, however the flag is typed, is refused before any move',async()=>{
  battleEnded();
  for(const via_wormhole of [true,'yes']) {
    const w=world({route:[{system_id:'a',jumps:0,via_wormhole}]});
    await assert.rejects(w.run(),error=>error instanceof TravelBlocked&&/wormhole/.test(error.message));
    assert.equal(w.sent('spacemolt/undock')+w.sent('spacemolt/travel'),0);
  }
});
