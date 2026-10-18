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
import {scriptedBattle,type ScriptedPoll} from '../../test-support/battle-script.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {GameLive,type Game} from '../game.ts';
import {boundRun,bind,stop,unbind,type Pilot,type Run} from '../runtime.ts';
import {FLEE_STALL,disengage,disengageEffect,escapeCost,hunt,huntEffect,pace,shouldRun,type StayRead} from './hunting.ts';

pace.tickMs=1;
const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};

test('the in-fight rule: stay above the line, stay below it while the enemy is closer to dead, run otherwise',()=>{
  const at=(o:Partial<StayRead>):StayRead=>({hull_pct:20,hull:16,line:24,opponent_hull_pct:55,loss_fatal:true,escape_cost:4,...o});
  assert.equal(shouldRun(at({hull_pct:88,hull:70})).run,false,'70/80 is above 24');
  assert.equal(shouldRun(at({opponent_hull_pct:15})).run,false);
  assert.match(shouldRun(at({opponent_hull_pct:15})).why,/closer to dead \(15% against our 20%\)/);
  assert.equal(shouldRun(at({})).run,true);
  assert.equal(shouldRun(at({escape_cost:16})).run,false,'an escape costing all the hull left is not survivable');
  assert.equal(shouldRun(at({escape_cost:Infinity})).why,'the escape is blocked, 16 hull left','not ~Infinity hull');
  assert.equal(shouldRun(at({loss_fatal:false,hull:1,hull_pct:1})).run,false,'the arena never flees');
});
test('the escape is priced from our recent hull loss, the way out, and flee_required; blocked is unpriceable',()=>{
  assert.equal(escapeCost([2,4,6],'inner',3),30,'the worst poll, 6, × (2 to outer + 3)');
  assert.equal(escapeCost([],'mid',3),0);
  assert.equal(escapeCost([4],'engaged',3),20,'engaged is inner');
  assert.equal(escapeCost([9,0,0,0],'outer',3),0,'only the last three polls');
  assert.equal(escapeCost([0],'outer',undefined),Infinity);
});

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

// Live 2026-10-09 (kvothe 15:24Z): a stop mid-battle read "hunt stopped on order" with no detail.fights, and the
// pilot's `out.detail.fights.length` threw; every outcome carries the fights fought so far.
test('a pilot stop mid-battle ends the hunt partial with its detail: the fights so far, ended stopped',async()=>{
  const f=world(action=>{if(action==='spacemolt_battle/status')stop();return undefined;},{wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    const out=await hunt({fights:5});
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why??'',/stopped on order/);
    assert.ok(Array.isArray(out.detail.fights),JSON.stringify(out.detail));
    assert.equal(out.detail.ended,'stopped');
  } finally {f.close();}
  const g=world(action=>{if(action==='spacemolt/hunt')throw new SpacemoltError('invalid_target','that is not a target');return undefined;},
    {wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.status,'refused');
    assert.deepEqual(out.detail.fights,[],'a refusal escaping the loop keeps the detail too');
  } finally {g.close();}
});

// Time comes from the clock the loop sleeps on: five minutes of ten-second ticks pass in a test that sleeps for none of them.
// Live 2026-10-15 (kvothe 19:20Z): a hunt handed back a live battle and every move after it was refused in_battle.
test('a fight that never ends is given up on at the ceiling, on the TestClock, said unresolved, and broken off',async()=>{
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
    assert.match(out.why??'',/no end by the ceiling; broken off, flee held until the battle ended/);
    await assert.rejects(f.command('spacemolt_battle/status',{}),/No active battle/,'the hunt does not hand back a live battle');
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
const clocked=<A,E>(f:Pick<ReturnType<typeof world>,'command'|'account'>,effect:Effect.Effect<A,E,Game|Run>,seconds=60)=>Effect.runPromise(Effect.gen(function*() {
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

// Live 2026-10-15 (kvothe 19:15–19:21Z): the hull line broke a Crusher-Mantis fight off from inner range; three ticks
// of flee, then brace, which resets the flee counter and never ends a creature's battle. 26 braced ticks later the
// bound ran out, hunt returned with the battle live, goTo/service were refused in_battle, and the ship was lost.
// Two hull a poll keeps the escape (2 × (2 to outer + 7)) under the 28 left at the danger line, so the rule runs.
test('a hunt broken off at the hull line holds the flee until the battle ends, however long the escape takes',async()=>{
  const f=world(()=>undefined,{wildlife:{creatures:[grazer],polls:Number.MAX_SAFE_INTEGER,damage:2,fleeTicks:6}});
  try {
    const out=await clocked(f,huntEffect(),400);
    assert.equal(out.detail.fights[0]?.outcome,'broke off',JSON.stringify(out));
    // The one brace comes on the line's approach (hull 34, within 5 of 30), never after the flee.
    // Our row already holds `fire`, so the open sends no stance.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params?.id),['brace','fire','flee'],
      'flee set once and held: any other stance resets the escape');
    await assert.rejects(f.command('spacemolt_battle/status',{}),/No active battle/);
    assert.match(f.lines.join('\n'),/flee: the battle has not ended yet \(flee 3\/7\)/);
  } finally {f.close();}
});

test('a command refused mid-fight ends the hunt in its words, and the battle is broken off, not handed back live',async()=>{
  let refused=1;
  // The focus is the open's first mutation (our row already holds `fire`).
  const f=world(action=>{if(action==='spacemolt_battle/target'&&refused-->0)throw new SpacemoltError('rate_limited','one mutation a tick');return undefined;},
    {wildlife:{creatures:[grazer],polls:Number.MAX_SAFE_INTEGER,damage:0,fleeTicks:2}});
  try {
    const out=await clocked(f,huntEffect());
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why??'',/rate_limited/);
    await assert.rejects(f.command('spacemolt_battle/status',{}),/No active battle/);
  } finally {f.close();}
});

/** A Veil-Ray fight answered from `polls`, then from `onFlee` once a flee is sent (`scriptedBattle`), on an 80-hull ship
 * launching at 25: above the danger line 24, so the hunt starts. */
function scripted(polls:ScriptedPoll[],onFlee:ScriptedPoll[]) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,
    wildlife:{creatures:[{creature_id:'c1',species:'veil_ray',name:'Veil-Ray'}]}});
  Object.assign(game.account.server.ship,{max_hull:80,hull:25});
  const script=scriptedBattle(game,polls,{onFlee});
  const lines:string[]=[];
  bind({account:game.account as unknown as Account,command:script.command,pilot:():Pilot=>({mood:'Focused'}),emit:text=>lines.push(text)});
  return {...game,...script,lines:()=>lines.join('\n'),
    stances:()=>script.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params?.id)};
}
// Hull 22 of 80 is under the line 24, theirs 90% is not closer to dead than our 28%, and 3 lost × (2 to outer + 3) = 15
// is survivable: the rule runs on the first poll.
const under:ScriptedPoll={hull:22,theirs:90,zone:'inner',distance:2,stance:'fire'};
const blocked:ScriptedPoll={...under,stance:'flee',flee_required:null};

// Spec D2 hazard 1: breakOff was disengageEffect(Infinity) — a blocked flee held forever at 0% dealt, 100% taken.
test('a flee whose flee_required goes missing returns to fire and fights on to the end',async()=>{
  const f=scripted([under],[blocked,blocked,{...under,theirs:0}]);
  try {
    const out=await clocked(f,huntEffect());
    assert.deepEqual(f.stances(),['flee','fire'],'back to fire once, and not fled again while blocked');
    assert.match(f.lines(),/flee blocked \(flee_required absent\): back to fire, the rule re-applied/);
    assert.match(f.lines(),/fighting on — the escape is blocked, 22 hull left/);
    assert.equal(out.detail.fights[0]!.outcome,'escaped'); // the world lists no wreck; the point is the loop ran to the end
  } finally {unbind();}
});
test('a flee whose counter has not risen for four polls is abandoned, and the escape is not tried again that fight',async()=>{
  const f=scripted([under],Array.from({length:6},()=>({...under,stance:'flee',flee_counter:0})));
  try {
    const out=await clocked(f,huntEffect());
    assert.equal(f.stances().filter(id=>id==='flee').length,1);
    assert.deepEqual(f.stances(),['flee','fire']);
    assert.match(f.lines(),/flee stalled at 0\/3 for 4 polls: back to fire/);
    assert.equal(out.detail.fights[0]!.outcome,'escaped');
  } finally {unbind();}
});
test('brace never follows flee',async()=>{
  // After the abandoned flee: shield 0, theirs 90% against our 28%, hull 22 within 5 of the line — the brace rung's
  // conditions, which held no brace before the flee because the flee came first.
  const f=scripted([under],Array.from({length:8},()=>({...under,stance:'flee',flee_counter:0,shield:0})));
  try {
    await clocked(f,huntEffect());
    assert.ok(!f.stances().includes('brace'),JSON.stringify(f.stances()));
  } finally {unbind();}
});
// Brace takes 25% of the damage, evade 50%: a loss under either is priced at full damage, since the flee holds neither.
// Live 2026-10-15 (kvothe 19:21Z): braced polls ran ~4 hull against ~16 at full; priced braced, 4×5=20 < 72 fled
// and died, at full 16×5=80 ≥ 72 keeps firing.
test('a loss under brace or evade prices the escape at full damage',async()=>{
  // 25→23 braced is 8 a poll at full, × (2 + 3) = 40 ≥ 23; 23→20 under evade is 6, × 5 = 30 ≥ 20. Neither flees.
  const f=scripted([{...under,hull:23,stance:'brace'},{...under,hull:20,stance:'evade'},{...under,hull:20,theirs:0}],[]);
  try {
    await clocked(f,huntEffect());
    assert.ok(!f.stances().includes('flee'),JSON.stringify(f.stances()));
    assert.match(f.lines(),/fighting on — the escape would cost ~40 hull of the 23 left/);
  } finally {unbind();}
});
test('a status with no combat_state is not a blocked escape: the line still flees',async()=>{
  const bare:ScriptedPoll={...under,combat_state:false};
  const f=scripted([bare],[bare,bare,bare]);
  try {
    const out=await clocked(f,huntEffect());
    assert.deepEqual(f.stances(),['flee'],'sent once and held');
    assert.doesNotMatch(f.lines(),/flee blocked/);
    assert.equal(out.detail.fights[0]!.outcome,'broke off');
    assert.match(out.detail.fights[0]!.why??'',/hull 22 under the danger line 24/);
  } finally {unbind();}
});
test('an agent disengage that cannot get away is bounded the same way',async()=>{
  const above:ScriptedPoll={...under,hull:25};
  const f=scripted([above,above],[{...blocked,hull:25},{...blocked,hull:25},{...above,theirs:0}]);
  let asked=0;
  try {
    const out=await clocked(f,huntEffect({onTick:()=>asked++===0?{disengage:true}:undefined}));
    assert.deepEqual(f.stances(),['flee','fire']);
    assert.match(f.lines(),/flee blocked/);
    assert.equal(out.detail.fights[0]!.outcome,'escaped');
  } finally {unbind();}
});

test('a stateless disengage against a blocked escape flees at most once, and says it fights on once',async()=>{
  const pinned:ScriptedPoll={...under,hull:25,can_escape:false},polls=[pinned,pinned,pinned,pinned,{...pinned,theirs:0}];
  const f=scripted(polls,polls);
  try {
    await clocked(f,huntEffect({onTick:()=>({disengage:true})}));
    assert.ok(f.stances().filter(id=>id==='flee').length<=1,JSON.stringify(f.stances()));
    assert.ok(f.stances().filter(id=>id==='fire').length<=1,JSON.stringify(f.stances()));
    assert.equal(f.lines().match(/onTick asked to disengage; the escape is blocked this fight: fighting on/g)?.length,1,f.lines());
  } finally {unbind();}
});
test('an agent stance flee is the flee state: neither brace nor the close follows it',async()=>{
  // Above the line at 25, out of reach 3/2, shields flat and theirs 90% against our 31%: brace and close conditions both.
  const out:ScriptedPoll={...under,hull:25,distance:3,reach:2,shield:0};
  const f=scripted([out,out],[1,2,2,2].map(flee_counter=>({...out,stance:'flee',flee_counter})));
  let asked=0;
  try {
    await clocked(f,huntEffect({onTick:()=>asked++===0?{stance:'flee'}:undefined}));
    assert.ok(!f.stances().includes('brace'),JSON.stringify(f.stances()));
    assert.ok(!f.sent.some(call=>call.action==='spacemolt_battle/advance'),'no advance after the flee');
  } finally {unbind();}
});

test('fighting on under the line is said once per reason, however its numbers move',async()=>{
  const f=scripted([20,15,10,0].map(theirs=>({...under,theirs})),[]);
  try {
    await clocked(f,huntEffect());
    assert.equal(f.lines().match(/fighting on — the enemy is closer to dead/g)?.length,1,f.lines());
  } finally {unbind();}
});
test('a hunt an agent disengage broke off above the line says the disengage, not the hull line',async()=>{
  const above:ScriptedPoll={...under,hull:25};
  const f=scripted([above],[1,2].map(flee_counter=>({...above,stance:'flee',flee_counter})));
  let asked=0;
  try {
    const out=await clocked(f,huntEffect({onTick:()=>asked++===0?{disengage:true}:undefined}));
    assert.equal(out.detail.fights[0]!.outcome,'broke off');
    assert.equal(out.why,'onTick asked to disengage');
  } finally {unbind();}
});

// The lib: an incapacitated crew reads can_escape false and the ship cannot fire or move. The ceiling's flee is sent, and
// the poll that sent it sends nothing more: one mutation a poll.
test('an incapacitated ship starts the flee and sends exactly one stance that poll',async()=>{
  const pinned:ScriptedPoll={...under,hull:25,can_escape:false};
  const f=scripted([pinned,pinned],[pinned,pinned]);
  f.account.server.ship.incapacitated=true;
  try {
    await clocked(f,huntEffect());
    let stances=0;
    for(const call of f.sent) {
      if(call.action==='spacemolt_battle/status')stances=0;
      else if(call.action==='spacemolt_battle/stance')assert.ok(++stances<=1,`two stances in one poll: ${JSON.stringify(f.stances())}`);
    }
    assert.deepEqual(f.stances(),['flee','fire'],'the flee once, then back to fire on the next poll');
    assert.match(f.lines(),/flee blocked \(can_escape false\)/);
  } finally {unbind();}
});

// Live 2026-10-15 (kvothe 19:15Z): broke off from Crusher-Mantis at 99%, inner 2/2; 3 flee polls, then 27 braced polls
// that never ended the battle (hull 184→72 of 259), and the second flee at 72 died 27s later. The counter was not logged.
test('replay 2026-10-15: a flee from Crusher-Mantis that never got away no longer stalls',async()=>{
  const at:ScriptedPoll={hull:72,theirs:99,zone:'inner',distance:2,reach:2,stance:'fire'};
  const f=scripted([at],Array.from({length:8},(_,i)=>({...at,hull:68-4*i,stance:'flee',flee_counter:0})));
  Object.assign(f.account.server.ship,{max_hull:259,hull:80});
  try {
    await clocked(f,huntEffect());
    const calls=f.sent.filter(call=>call.action==='spacemolt_battle/status'||call.action==='spacemolt_battle/stance');
    const fled=calls.findIndex(call=>call.params?.id==='flee'),fire=calls.findIndex(call=>call.params?.id==='fire');
    assert.ok(fled>=0&&fire>fled,JSON.stringify(f.stances()));
    assert.ok(calls.slice(fled,fire).filter(call=>call.action==='spacemolt_battle/status').length<=FLEE_STALL,'back to fire within FLEE_STALL polls');
    assert.ok(!f.stances().includes('brace'));
    assert.match(f.lines(),/breaking off: hull 72 under the danger line 78/);
  } finally {unbind();}
});
