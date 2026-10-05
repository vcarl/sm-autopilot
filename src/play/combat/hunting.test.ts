import assert from 'node:assert/strict';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Effect,Fiber,Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {ReadinessCommand} from '../../readiness.ts';
import {readJournal} from '../../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {GameLive,type Game} from '../game.ts';
import {boundRun,bind,stop,unbind,type Pilot,type Run} from '../runtime.ts';
import {disengage,disengageEffect,hunt,huntEffect,pace} from './hunting.ts';

pace.tickMs=1;
const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};

/** A bridge world bound to a temporary runtime (so its journal can be read for defects), whose command seam may
 * intercept: a refusal or a lost reply on one action. Every send is counted before the interception. */
function world(fault:(action:string,real:()=>ReturnType<ReadinessCommand>)=>ReturnType<ReadinessCommand>|undefined,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const tries:string[]=[],lines:string[]=[];
  const command:typeof game.command=(action,params)=>{tries.push(action);return fault(action,()=>game.command(action,params))??game.command(action,params);};
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-hunting-'));
  bind({account:game.account as unknown as Account,command,runtime,pilot:():Pilot=>({mood:'Focused'}),emit:text=>lines.push(text)});
  return {...game,command,lines,tries:(action:string)=>tries.filter(one=>one===action).length,
    defects:()=>readJournal(runtime).filter(row=>row.event==='defect'),
    close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const lostReply=()=>new SpacemoltError('mutation_timeout','No action_result');

test('an attack the game refuses ends the hunt refused in the server\'s code, sent once, with no defect',async()=>{
  const f=world(action=>{if(action==='spacemolt/hunt')throw new SpacemoltError('invalid_target','that is not a target');return undefined;},
    {wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why??'',/spacemolt\/hunt: invalid_target — that is not a target/);
    assert.equal(f.tries('spacemolt/hunt'),1);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('an attack whose reply is lost is sent once: the hunt fails saying so, and the battle is not opened twice',async()=>{
  const f=world(action=>{if(action==='spacemolt/hunt')throw lostReply();return undefined;},{wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why??'',/reply lost on spacemolt\/hunt/);
    assert.equal(f.tries('spacemolt/hunt'),1,'never re-sent');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

// A stance is the one mutation `disengage` repeats, so what a lost reply means for it has to be decided: it may have landed,
// so it is not sent again, and the status read that follows is what says whether the battle is over.
test('a break-off stance whose reply is lost is not re-sent; a refused one is, since nothing landed',async()=>{
  let lost=1;
  // The flee lands in the world and only the reply is lost, as it is live.
  const f=world((action,real)=>action==='spacemolt_battle/stance'&&lost-->0?real().then(()=>{throw lostReply();}):undefined,
    {wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:1}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(),true);
    assert.equal(f.tries('spacemolt_battle/stance'),1,'the lost flee was held, not repeated');
    assert.match(f.lines.join('\n'),/stance flee: reply lost on spacemolt_battle\/stance; not re-sent/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
  let refused=1;
  const g=world(action=>{if(action==='spacemolt_battle/stance'&&refused-->0)throw new SpacemoltError('rate_limited','one mutation a tick');return undefined;},
    {wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:1}});
  try {
    await g.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(),true);
    const flees=(game:typeof g)=>game.sent.filter(call=>call.action==='spacemolt_battle/stance'&&call.params?.id==='flee').length;
    assert.equal(flees(g),1,'a refusal landed nothing, so the flee was sent again and landed');
  } finally {g.close();}
});

test('a pilot stop between fights ends the hunt partial, and is not a defect',async()=>{
  const f=world(action=>{if(action==='spacemolt/get_nearby')stop();return undefined;},{wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why??'',/stopped on order/);
    assert.equal(f.tries('spacemolt/hunt'),0,'no fight was started under a stop');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

// Time comes from the clock the loop sleeps on: five minutes of ten-second ticks pass in a test that sleeps for none of them.
test('a fight that never ends is given up on at the ceiling, on the TestClock, and is said unresolved',async()=>{
  const f=world(()=>undefined,{wildlife:{creatures:[grazer],polls:10_000,damage:0}});
  const was=pace.tickMs;
  pace.tickMs=10_000;
  try {
    const out=await Effect.runPromise(Effect.gen(function*() {
      const fiber=yield* Effect.forkChild(huntEffect());
      for(let tick=0;tick<45;tick++) {
        yield* TestClock.adjust('10 seconds');
        yield* Effect.promise(()=>new Promise(resolve=>setImmediate(resolve)));
      }
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(Layer.mergeAll(GameLive({send:f.command,refresh:()=>f.account.refresh()}),TestClock.layer(),boundRun()))));
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.equal(out.detail.fights[0]?.outcome,'unresolved');
    assert.equal(out.detail.ended,'hull');
    assert.deepEqual(f.defects(),[]);
  } finally {pace.tickMs=was;f.close();}
});

// Live 2026-10-03 (F-U17, TestPilot.cv): a kill's wreck came with `cargo: null`; the wreck was skipped, so a won fight read `escaped`.
test('a won fight whose wreck is listed with null cargo reads down, not escaped',async()=>{
  const f=world((action,real)=>{
    if(action!=='spacemolt_salvage/wrecks')return undefined;
    return real().then(reply=>{
      const body=(reply as {structuredContent:{wrecks:{cargo:unknown}[]}}).structuredContent;
      for(const row of body.wrecks)row.cargo=null;
      return reply;
    });
  },{wildlife:{creatures:[grazer],polls:2,damage:1,drops:[{item_id:'creature_carapace',quantity:2}]}});
  try {
    const out=await hunt();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights[0]?.outcome,'down');
    assert.equal(out.detail.fights[0]?.why,undefined);
    assert.equal(out.detail.fights[0]?.wreck?.victim_id,'c1');
  } finally {f.close();}
});

test('a loot of the kill\'s wreck whose reply is lost is sent once, and the hunt fails saying so',async()=>{
  const f=world(action=>{if(action==='spacemolt_salvage/loot')throw lostReply();return undefined;},
    {wildlife:{creatures:[grazer],polls:2,damage:1,drops:[{item_id:'creature_carapace',quantity:2}]}});
  try {
    const out=await hunt();
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why??'',/reply lost on spacemolt_salvage\/loot/);
    assert.equal(f.tries('spacemolt_salvage/loot'),1,'never re-sent');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a nearby creature row without a name is dropped and said, and the rest are still hunted',async()=>{
  const f=world(()=>undefined,{wildlife:{creatures:[{creature_id:'c0',species:7 as never},grazer],polls:1,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights[0]?.target.name,'Molt Grazer');
    assert.ok(f.lines.some(line=>line.includes('creature c0 did not read, skipped')),f.lines.join('\n'));
  } finally {f.close();}
});

/** Run one Effect against the world on the TestClock, moving it a second at a time: the status re-read backs off on it. */
const clocked=<A,E>(f:ReturnType<typeof world>,effect:Effect.Effect<A,E,Game|Run>,seconds=60)=>Effect.runPromise(Effect.gen(function*() {
  const fiber=yield* Effect.forkChild(effect);
  for(let second=0;second<seconds;second++) {
    yield* TestClock.adjust('1 second');
    yield* Effect.promise(()=>new Promise(resolve=>setImmediate(resolve)));
  }
  return yield* Fiber.join(fiber);
}).pipe(Effect.provide(Layer.mergeAll(GameLive({send:f.command,refresh:()=>f.account.refresh()}),TestClock.layer(),boundRun()))));

// A lost read is not evidence the battle ended (combat is where a ship is lost): it is re-read, and the fight goes on.
test('a battle/status read whose reply is lost once is re-read, and the fight goes on to the kill rather than reading escaped',async()=>{
  let lost=1;
  const f=world(action=>{if(action==='spacemolt_battle/status'&&lost-->0)throw lostReply();return undefined;},
    {wildlife:{creatures:[grazer],polls:3,damage:1,drops:[{item_id:'creature_carapace',quantity:1}]}});
  try {
    const out=await clocked(f,huntEffect());
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.equal(out.detail.fights[0]?.outcome,'down');
    assert.doesNotMatch(f.lines.join('\n'),/; read as the battle's end/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

// The quarry's row is the fight's only view of it: one that does not read is not the quarry gone.
test('a status whose quarry row does not read is not the fight\'s end: it goes on to the kill rather than reading escaped',async()=>{
  let bad=1;
  const f=world((action,real)=>action==='spacemolt_battle/status'&&bad-->0?real().then(reply=>{
    for(const row of (reply as {structuredContent:{participants:{player_id:string;stance?:unknown}[]}}).structuredContent.participants)
      if(row.player_id==='c1')row.stance=null;
    return reply;
  }):undefined,{wildlife:{creatures:[grazer],polls:3,damage:1,drops:[{item_id:'creature_carapace',quantity:1}]}});
  try {
    const out=await hunt();
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.equal(out.detail.fights[0]?.outcome,'down');
    assert.match(f.lines.join('\n'),/participant c1 did not read/);
  } finally {f.close();}
});

test('a break-off whose every status read is lost never reports the battle over; it says the end was not read',async()=>{
  const f=world(action=>{if(action==='spacemolt_battle/status')throw lostReply();return undefined;},
    {wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:100}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    const end=await clocked(f,disengageEffect(5_000));
    assert.equal(end,'unknown');
    assert.ok(f.tries('spacemolt_battle/status')>=3,'re-read before giving up');
    assert.match(f.lines.join('\n'),/reply lost on spacemolt_battle\/status, three reads; not read as the battle's end/);
    assert.equal(f.tries('spacemolt_battle/stance'),1,'the flee was sent once and held');
  } finally {f.close();}
});

test('a break-off whose status reply does not read returns false from disengage and says the status is unread',async()=>{
  const f=world((action,real)=>action==='spacemolt_battle/status'?real().then(()=>({structuredContent:{battle_id:7}})):undefined,
    {wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:100}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(0),false);
    assert.match(f.lines.join('\n'),/the reply did not read; not read as the battle's end/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a refused status read (no_active_battle) is the battle\'s end: disengage reports it over',async()=>{
  const f=world(action=>{if(action==='spacemolt_battle/status')throw new SpacemoltError('no_active_battle','No active battle.');return undefined;},
    {wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:100}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(0),true);
    assert.equal(f.tries('spacemolt_battle/status'),1,'a refusal is an answer, not re-read');
  } finally {f.close();}
});
