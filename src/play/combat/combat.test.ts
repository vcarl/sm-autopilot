import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {writeFight} from '../../combat-memory.ts';
import {readSightings,recall} from '../../sighting-memory.ts';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,derived,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {disengage,hunt,pace,type TickDecision,type TickView} from './hunting.ts';
import {salvage} from './salvage.ts';

// A tick is ten seconds of real time; the tests take the same loop at a millisecond.
pace.tickMs=1;

function world(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  const who=derived(()=>record,game.account);
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:who,emit:text=>lines.push(text)});
  return {...game,lines,record:who};
}

/** `world`, but `spacemolt_battle/status` answers whatever `tick_duration` the live server
 * really gave (stuck, not counting up): the same number from the second poll on. Only the
 * observe path — never the tick gate — can still catch a hull crossing under this. */
function worldWithStuckTick(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record,polls=0;
  const command:typeof game.command=async(action,params)=>{
    const res=await game.command(action,params);
    if(action==='spacemolt_battle/status'&&++polls>=2)
      (res as {structuredContent?:{tick_duration?:number}}).structuredContent!.tick_duration=1;
    return res;
  };
  bind({account:game.account as unknown as ReadinessAccount,command,
    pilot:()=>who,emit:text=>lines.push(text)});
  return {...game,command,lines,record:()=>who};
}
/** `world`, but the pilot record is REPLACED mid-hunt, the way a re-read of `pilot.json` gives
 * a fresh object: the runner's `pilot()` is the file, so the observer moves the mood under a
 * running loop. Anything that captured the record at the top of the loop keeps the old mood. */
function worldWithMoodMoved(record:Pilot,on:string,to:Pilot['mood'],options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  let who:Pilot=record;
  const command:typeof game.command=async(action,params)=>{
    const res=await game.command(action,params);
    if(action===on)who={...who,mood:to!};
    return res;
  };
  bind({account:game.account as unknown as ReadinessAccount,command,
    pilot:()=>who,emit:()=>{}});
  return {...game,command,record:()=>who};
}
const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};

test('hunt fights a creature through to the wreck and loots it',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:2,damage:1,
    drops:[{item_id:'creature_carapace',quantity:2}]}});
  try {
    const out=await hunt();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.ended,'asked');
    assert.equal(out.detail.fights.length,1);
    const fight=out.detail.fights[0]!;
    assert.equal(fight.outcome,'down');
    assert.equal(fight.wreck?.victim_id,'c1');
    // The loot is the cargo delta, never the loot reply's claim of 99.
    assert.deepEqual(fight.loot,[{item_id:'creature_carapace',quantity:2}]);
    assert.deepEqual(out.gained.items,[{item_id:'creature_carapace',quantity:2}]);
    assert.equal(out.cost.hull,3,'one hull a tick, including the tick the kill resolved on');
    // A line per battle tick, carrying the real tick number, our hull and the quarry's.
    const ticks=f.lines.filter(line=>line.includes(' vs Molt Grazer'));
    assert.equal(ticks.length,2);
    assert.match(ticks[0]!,/tick 1 vs Molt Grazer: hull 95\/100, shield 0%, theirs 100% at inner 2\/2/);
    assert.match(ticks[1]!,/tick 2 vs Molt Grazer/);
    // The stance and the focus are sent at the open, one a tick, and nothing is fired by hand.
    assert.equal(f.count('spacemolt_battle/stance'),1);
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt_battle/stance')?.params,{id:'fire'});
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt_battle/target')?.params,{id:'c1'});
    // In reach at distance 2 against a reach of 2: nothing to close.
    assert.equal(f.count('spacemolt_battle/advance'),0);
    // At most one mutation a tick, which is what the server's rate limit allows.
    const mutations=f.sent.filter(call=>/battle\/(stance|target|advance|retreat)/.test(call.action)).length;
    assert.ok(mutations<=f.count('spacemolt_battle/status'),`${mutations} mutations over ${f.count('spacemolt_battle/status')} reads`);
  } finally {unbind();}
});

test('a quarry that runs is chased, and an escape says what was seen',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:5,damage:0,flees:true}});
  try {
    const out=await hunt();
    const fight=out.detail.fights[0]!;
    assert.equal(fight.outcome,'escaped');
    assert.equal(fight.wreck,undefined,'no wreck: nothing died');
    assert.match(fight.why!,/hull flat at 100% for \d+ tick\(s\) while it opened the range 3→8/);
    const reads=f.count('spacemolt_battle/status');
    // Two ticks open the fight, every later tick closes the range it keeps opening.
    assert.equal(f.count('spacemolt_battle/advance'),4);
    assert.equal(f.count('spacemolt_battle/stance'),1);
    assert.equal(f.count('spacemolt_battle/target'),1);
    const mutations=f.sent.filter(call=>/battle\/(stance|target|advance|retreat)/.test(call.action)).length;
    assert.ok(mutations<=reads,`${mutations} mutations over ${reads} reads`);
    assert.match(f.lines.join('\n'),/fight 1: Molt Grazer escaped \(hull flat at 100%/);
  } finally {unbind();}
});

test('hunt breaks off at the walk-away line, which is also what imposes Tired',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:20,damage:4}});
  try {
    // Focused walks away at 0.90 of 100 max hull; 96 less three ticks of 4 is 84.
    const out=await hunt({fights:2});
    assert.equal(out.status,'partial');
    assert.equal(out.detail.ended,'tired');
    assert.equal(out.detail.fights[0]!.outcome,'broke off');
    assert.equal(out.detail.fights.length,1,'the second fight never starts');
    assert.ok(out.now.ship.hull<90,`hull ${out.now.ship.hull} is under the line`);
    assert.equal(f.record().mood,'Tired');
    // The exit is the flee stance, never a retreat: `retreat` only opens the range.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params).at(-1),{id:'flee'});
    assert.equal(f.count('spacemolt_battle/retreat'),0);
    assert.match(out.why!,/Tired/);
  } finally {unbind();}
});

// A retreat is not an exit at all — it is the range maneuver `backOff`. On 2026-09-24 the walk-away fired correctly at
// 22:14:16 (hull 61/80 under the Aggressive line 64), sent one `battle/retreat`, took the
// server's "Retreating from the enemy." as done and returned — and the battle carried on for
// two and a half minutes while every move the pilot then tried was refused `in_battle` and a
// Slag-Tortoise took the hull from 61 to 29. Three ships were lost that way, all uninsured.
// Breaking off means holding the flee stance until the battle itself says it is over.
test('breaking off at the hull line waits for the battle to actually end, not for the first accepted stance',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:20,damage:4,retreatTicks:99,fleeTicks:3}});
  try {
    const out=await hunt({fights:2});
    assert.equal(out.detail.fights[0]!.outcome,'broke off');
    // One flee, held for the four ticks the escape took: a stance stays set, so it is not re-sent.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params).filter(p=>p.id==='flee'),
      [{id:'flee'}],'the flee stance is set once and held until the battle ends');
    assert.equal(f.count('spacemolt_battle/retreat'),0,'a retreat would have opened the range and left the ship in it');
    // The whole point: the ship can move again. A live battle refuses travel with `in_battle`.
    await f.command('spacemolt/travel',{id:'belt'});
    assert.equal(f.account.server.location.poi_id,'belt');
  } finally {unbind();}
});

// The same wait on its own, for a pilot that finds a move refused `in_battle`.
test('disengage reports whether the battle ended, and says so when the bound ran out with it still on',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:2}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(),true);
    await f.command('spacemolt/travel',{id:'belt'});
    assert.equal(f.account.server.location.poi_id,'belt');
  } finally {unbind();}
  const g=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:99}});
  try {
    await g.command('spacemolt/hunt',{id:'c1'});
    // A bound of one tick: the battle is still on when it runs out, and that is the answer.
    assert.equal(await disengage(1),false);
  } finally {unbind();}
});

// S4: the walk-away line is the mood's, and the loop read it once at the top — one number for
// the whole hunt and for every fight inside it. The mood moves under a running loop, so the
// line has to be read where it is checked: a hunt that opened under Cautious (0.95) and was
// loosened to Aggressive (0.80) before a shot was fired broke off against a line the pilot had
// already left, and stopped after one fight of the two it was asked for.
test('the walk-away line follows the mood the pilot is in now, not the one the hunt opened under',async()=>{
  const second={creature_id:'c2',species:'molt_grazer',name:'Molt Grazer'};
  const f=worldWithMoodMoved({mood:'Cautious'},'spacemolt/hunt','Aggressive',
    {wildlife:{creatures:[grazer,second],polls:1,damage:2}});
  try {
    // Two fights of two ticks at 2 hull a tick: 96 down to 88, under Cautious's 95 from the
    // first tick and never near Aggressive's 80.
    const out=await hunt({fights:2});
    assert.equal(f.record().mood,'Aggressive','no crossing: 88 hull is well inside the Aggressive line');
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.ended,'asked');
    assert.equal(out.detail.fights.length,2,'both fights were taken against the line in force');
    assert.deepEqual(out.detail.fights.map(fight=>fight.outcome),['down','down']);
    assert.equal(f.count('spacemolt_battle/retreat'),0,'nothing broke off; the line was never crossed');
    assert.equal(out.now.ship.hull,88);
  } finally {unbind();}
});

test('nothing to hunt at a POI is done, not blocked',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[]}});
  try {
    const out=await hunt({poi:'belt'});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.did,'nothing to hunt at belt');
    assert.deepEqual(out.detail.fights,[]);
    assert.equal(out.detail.ended,'nothing here');
    assert.equal(f.count('spacemolt/hunt'),0,'nothing was engaged');
    assert.doesNotMatch(out.next.join(),/<another poi id>/,'names real POIs');
    assert.match(out.next.join(),/look:\['/);
  } finally {unbind();}
});

test('hunt fails (does not silently skip the stop) on a real find_route error, e.g. a dropped connection',async()=>{
  // The per-stop fuel quote in `hunt`'s search loop swallows `TravelBlocked` ("not a place")
  // and skips that stop; anything else — a socket drop, a real server error — must surface as
  // `failed` instead of being treated as an unplaceable POI.
  const game=bridgeWorld({services:['refuel','repair'],wildlife:{creatures:[grazer]}});
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt/find_route')throw new Error('cannot send on a closed socket');
    return game.command(action,params);
  };
  bind({account:game.account as unknown as ReadinessAccount,command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  try {
    const out=await hunt({poi:'belt'});
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/cannot send on a closed socket/);
  } finally {unbind();}
});

test('a hunt with no species named prefers the quarry an active mission names',async()=>{
  const beltGrazer={creature_id:'c2',species:'belt_grazer',name:'Belt Grazer'};
  // The Molt Grazer is first in the habitat; the mission's own words point at the other one.
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer,beltGrazer],polls:2,damage:1,
    drops:[{item_id:'creature_carapace',quantity:1}]}});
  f.taken.push({mission_id:'m9',title:'Cull the herd',type:'hunt',difficulty:1,
    description:'Hunt 3 Belt-Grazer for the ranchers',accepted_at:new Date().toISOString(),
    expires_in_ticks:500,percent_complete:0,issuing_base:'sol_base',rewards:{credits:100},
    objectives:[{description:'3 Belt-Grazer culled',completed:false,current:0,required:3}]});
  try {
    const out=await hunt();
    const fight=out.detail.fights[0]!;
    assert.equal(fight.target.name,'Belt Grazer',
      'the mission named the quarry; the pilot cannot read a species id off it, but the fight can still find it');
    assert.equal(f.count('spacemolt/hunt'),1);
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt/hunt')?.params,{id:'c2'});
  } finally {unbind();}
});

test('hunt is refused without a loaded weapon',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],weapon:null}});
  try {
    const out=await hunt();
    assert.equal(out.status,'refused');
    assert.match(out.why!,/no module of type weapon is fitted/);
    assert.equal(f.count('spacemolt/get_nearby'),0,'nothing was sent past the fit check');
  } finally {unbind();}
});

test('a hull crossing the walk-away line is caught even while tick_duration is stuck',async()=>{
  // Aggressive walks away at 0.80 of 100 max hull: 96 less 5 a poll crosses 80 on the fourth.
  const f=worldWithStuckTick({mood:'Aggressive'},{wildlife:{creatures:[grazer],polls:8,damage:5}});
  try {
    const out=await hunt();
    const fight=out.detail.fights[0]!;
    assert.equal(fight.outcome,'broke off','the line was crossed; the fight was not won');
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params).at(-1),{id:'flee'},
      'the tick sat still, but the hull was still read every poll');
    // One poll past the line (80), plus the tick the escape itself took: `flee` takes 100% of
    // the incoming damage, which is the price of the only exit the game has.
    assert.equal(fight.hull_after,71,'stopped one poll past the line, not run down while blind to it');
  } finally {unbind();}
});

test('salvage empties the wrecks here into the hold, and no wreck is done',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:10});
  try {
    const empty=await salvage();
    assert.equal(empty.status,'done',empty.why);
    assert.deepEqual(empty.detail.wrecks,[]);
    // Five units in the wreck, room for two in the hold: three stay in the wreck.
    f.wrecks.push({id:'w1',victim_id:'c1',type:'creature',poi_id:'station',
      cargo:[{item_id:'creature_carapace',quantity:5}],modules:[],salvage_value:40});
    const out=await salvage();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.looted,[{wreck_id:'w1',items:[{item_id:'creature_carapace',quantity:2}],modules:[]}]);
    assert.deepEqual(out.detail.left,[{wreck_id:'w1',cargo:[{item_id:'creature_carapace',quantity:3}]}]);
    assert.deepEqual(out.gained.items,[{item_id:'creature_carapace',quantity:2}]);
    assert.match(out.next.join(' '),/hold filled/);
  } finally {unbind();}
});

/** `world`, but bound with a runtime dir, so `hunt` can read the combat memory and hand it to
 * the callback: the link between what the last fight measured and what this one does about it. */
function worldWithMemory(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[],runtime=mkdtempSync(join(tmpdir(),'spacemolt-ontick-'));
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,runtime,
    pilot:()=>who,emit:text=>lines.push(text)});
  return {...game,lines,runtime,record:()=>who};
}

test('a per-tick callback decides the stance, the range and the exit, and hunt says what it sent',async()=>{
  // RED before this commit: `hunt` took no `onTick` at all — `hunt({onTick})` did not typecheck,
  // and `hunting.ts:175` set `stance:'fire'` once at the open and never revisited it, so
  // `f.count('spacemolt_battle/stance')` was 1 however the fight went.
  const f=worldWithMemory({mood:'Aggressive'},{wildlife:{creatures:[grazer],polls:6,damage:1,retreatTicks:0}});
  // A fight already in memory: the callback is handed the measured record, not a blank.
  writeFight(f.runtime,{opponent:'Molt Grazer',ship_class:'shuttle',ticks:4,dealt:20,taken:40,
    by_range:{inner:{at_us:{shots:4,hits:3},at_them:{shots:4,hits:2}}},
    stances:['fire'],flee_ticks:0,ending:'stalemate',at:new Date().toISOString()});
  const seen:TickView[]=[];
  const plan:(TickDecision|undefined)[]=[{stance:'brace'},undefined,{move:'closeIn'},
    {focus:'c1'},{disengage:true}];
  try {
    const out=await hunt({onTick:view=>{seen.push(view);return plan[view.tick-1];}});
    assert.equal(out.detail.fights[0]!.outcome,'broke off','the callback asked to leave and hunt left');
    // Every field the view promises, measured on the tick it was read.
    assert.deepEqual(seen.map(view=>view.tick),[1,2,3,4,5]);
    assert.equal(seen[0]!.hull,95,'the world launches at 96 hull and the first tick costs one');
    assert.equal(seen[0]!.max_hull,100);
    assert.equal(seen[0]!.opponent,'Molt Grazer');
    assert.equal(seen[0]!.opponent_hull,1);
    assert.equal(seen[0]!.range,'inner');
    assert.deepEqual([seen[0]!.distance,seen[0]!.reach],[2,2]);
    assert.equal(seen[0]!.damage_taken,1,'the first tick measures against the hull the fight opened on');
    assert.equal(seen[1]!.damage_taken,1,'one hull a tick, measured against the tick before');
    assert.equal(seen[0]!.floor,80,'Aggressive walks away at 0.80 of 100');
    assert.equal(seen[0]!.stance,undefined,'no stance in force until one is set');
    assert.equal(seen[1]!.stance,'brace','the stance the callback set is the stance it is told about');
    // The remembered record rides along, and says out loud that one fight is not a rate.
    assert.equal(seen[0]!.stats?.taken_per_tick,10);
    assert.deepEqual(seen[0]!.stats?.accuracy.inner,{at_us:0.75,at_us_shots:4,at_them:0.5,at_them_shots:4});
    assert.equal(seen[0]!.stats?.thin,true);
    assert.equal(seen[0]!.stats?.win_chance,undefined);
    // Each decision applied, one mutation a tick, and never a command the callback sent itself.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),
      [{id:'brace'},{id:'flee'}],'the brace the callback asked for, then the flee that left the battle');
    assert.equal(f.count('spacemolt_battle/advance'),1,'closeIn is advance, and it is not an exit');
    // Twice: the `undefined` tick fell back to the default ladder, which still owed the focus,
    // and the callback asked for it again on its own tick. `undefined` is "no change", which is
    // how a pilot deciding every third tick is written — and it costs the open nothing.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/target').map(call=>call.params),
      [{id:'c1'},{id:'c1'}]);
    assert.match(f.lines.join('\n'),/onTick asked \{"stance":"brace"\}; sent stance brace/);
    assert.match(f.lines.join('\n'),/onTick asked \{"move":"closeIn"\}; sent closeIn/);
    assert.match(f.lines.join('\n'),/onTick asked \{"disengage":true\}; sent disengage/);
  } finally {unbind();}
});

test('a callback that throws is logged and the fight carries on under the default loop',async()=>{
  // RED before this commit: there was no callback to throw, so nothing caught one — a throw
  // inside the tick loop would have propagated out of `engage` and left the ship in the battle.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[grazer],polls:2,damage:1,
    drops:[{item_id:'creature_carapace',quantity:2}]}});
  try {
    const out=await hunt({onTick:()=>{throw new Error('the pilot wrote a bug');}});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights[0]!.outcome,'down','the fight was still won');
    assert.match(f.lines.join('\n'),/onTick threw \(the pilot wrote a bug\); the default loop continues/);
    // The default ladder ran exactly as it does with no callback at all.
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),[{id:'fire'}]);
    assert.deepEqual(f.sent.find(call=>call.action==='spacemolt_battle/target')?.params,{id:'c1'});
  } finally {unbind();}
});

test('the walk-away floor overrides a reckless callback and names what it refused',async()=>{
  // RED before this commit: no callback could ask to keep firing, so there was no override to
  // log — and the operator's bound had never been tested against a decision that fights it.
  // Cautious walks away at 0.95 of 100: 96 less one a poll sits on 95, then crosses it.
  const f=worldWithMemory({mood:'Cautious'},{wildlife:{creatures:[grazer],polls:8,damage:1,retreatTicks:0}});
  try {
    const out=await hunt({onTick:()=>({stance:'fire'})});
    const fight=out.detail.fights[0]!;
    assert.equal(fight.outcome,'broke off','the floor won');
    assert.equal(fight.hull_after,93,'one poll past the line plus the tick the flee took, not run down by the callback');
    assert.match(f.lines.join('\n'),
      /override: onTick asked \{"stance":"fire"\}, and the Cautious walk-away line 95 wins/);
    assert.match(f.lines.join('\n'),/breaking off: hull 94 under the line 95/);
    assert.match(f.lines.join('\n'),/breaking off: stance flee, which auto-retreats to escape/);
  } finally {unbind();}
});

test('no callback fights exactly as it did before, and braces only once the line is in sight',async()=>{
  // The default must not regress: one `stance fire`, one focus, no chase in reach — and the
  // brace is reachable only when shields are flat, their hull is above ours and the walk-away
  // line is within 5% of max, which a healthy fight never is.
  const healthy=worldWithMemory({mood:'Aggressive'},{wildlife:{creatures:[grazer],polls:3,damage:1}});
  try {
    const out=await hunt();
    assert.equal(out.detail.fights[0]!.outcome,'down',out.why);
    assert.deepEqual(healthy.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),
      [{id:'fire'}],'one stance, as before');
    assert.equal(healthy.count('spacemolt_battle/advance'),0,'in reach, nothing to close');
    assert.equal(healthy.lines.join('\n').includes('stance brace'),false);
  } finally {unbind();}
  // Aggressive walks away at 80 of 100, so the brace window is hull 80..85: three hull a poll
  // reaches 85 on the fifth, with the grazer still at 100% against our 85%.
  const losing=worldWithMemory({mood:'Aggressive'},{wildlife:{creatures:[grazer],polls:9,damage:3,flees:true}});
  try {
    await hunt();
    assert.match(losing.lines.join('\n'),/stance brace: shields flat, theirs 100% against ours, and the line 80 is close/);
    assert.deepEqual(losing.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),
      [{id:'fire'},{id:'brace'},{id:'fire'},{id:'flee'}],'one brace a fight, back to firing, and the flee it broke off on');
  } finally {unbind();}
});

// `spacemolt_battle/retreat` is a RANGE maneuver, not an exit: `BattleResponse.action` lists it
// beside `advance`, and the live server answers "Retreating from the enemy." while the battle
// carries on. Re-issuing it is what the 2026-09-25 23:39 log did — one "breaking off" and
// fourteen "the battle has not ended yet" in ninety seconds, waiting for an end no retreat
// could bring. The exit is `stance flee`, which auto-retreats to escape. Because flee takes
// 100% of incoming damage and a faster opponent can kite it, a flee that is not escaping falls
// back to `brace` (0% dealt, 25% taken, shields regen 2×) and waits the battle out there.
test('breaking off sets the flee stance, and braces when the flee cannot escape',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:8,damage:0,retreatTicks:99,fleeTicks:99}});
  try {
    await f.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(),true,'the battle ended on its own, as every observed one does');
    assert.equal(f.count('spacemolt_battle/retreat'),0,'retreat is a range maneuver, never the exit');
    assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),
      [{id:'flee'},{id:'brace'}],'flee first, then brace once it is plainly not getting away');
  } finally {unbind();}
  // The flee that works: one stance, no fallback, and the ship can move again.
  const g=world({mood:'Focused'},{wildlife:{creatures:[grazer],polls:20,damage:0,fleeTicks:1}});
  try {
    await g.command('spacemolt/hunt',{id:'c1'});
    assert.equal(await disengage(),true);
    assert.deepEqual(g.sent.filter(call=>call.action==='spacemolt_battle/stance').map(call=>call.params),
      [{id:'flee'}],'the flee escaped; nothing else was needed');
    await g.command('spacemolt/travel',{id:'belt'});
    assert.equal(g.account.server.location.poi_id,'belt');
  } finally {unbind();}
});

// ---- A prey and a range of places to look ----------------------------------------------
// "If we're telling the player where to hunt, then it's our fault if they find nothing
// huntable there." Fauna is not knowable before arrival — POI rows carry no fauna field and
// there is no per-species query — so the honest shape is a prey and an ordered list of places
// to try, with the looking bounded by fuel and every look remembered.

const tortoise={creature_id:'c2',species:'slag_tortoise',name:'Slag Tortoise'};

test('a hunt given several places to look flies past the empty ones and fights where the prey is',async()=>{
  // RED before this commit: `hunt` took a single `poi` and fought whatever was standing there.
  // Told to go to a belt with nothing in it, it reported `nothing here` and stopped — the pilot
  // was sent somewhere on our guess and had no support in finding its quarry.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[{...grazer,poi:'far_belt'}],polls:1,damage:1}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const out=await hunt({species:'molt_grazer',look:['belt','far_belt']});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights.length,1,`fought at the wrong place or not at all: ${JSON.stringify(out.detail.looked)}`);
    assert.equal(out.detail.poi_id,'far_belt','the fight happened where the prey was');
    // The trail is reported, in order, so the pilot can read what the search actually cost.
    assert.deepEqual(out.detail.looked.map(row=>row.poi_id),['belt','far_belt']);
    assert.equal(out.detail.looked[0]!.saw,0,'the first belt held none of the prey');
    assert.equal(out.detail.looked[1]!.saw,1);
  } finally {unbind();}
});

test('a search that finds nothing anywhere is done, and names every place it looked',async()=>{
  // The failure the operator called ours: sending the pilot somewhere on a guess dressed as
  // knowledge. A search that comes back empty has to say so as a fact learned, not a refusal,
  // and it must name the places so the next juncture is not told the same guess again.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[]}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const out=await hunt({species:'molt_grazer',look:['belt','far_belt']});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.ended,'nothing found');
    assert.deepEqual(out.detail.fights,[]);
    assert.equal(f.count('spacemolt/hunt'),0,'nothing was engaged');
    assert.deepEqual(out.detail.looked.map(row=>row.poi_id),['belt','far_belt']);
    assert.match(out.did,/belt/,`the places looked are not in the sentence: ${out.did}`);
    assert.match(out.did,/far_belt/,out.did);
  } finally {unbind();}
});

test('a search stops at the first place the fuel cannot reach, and never departs on the hop',async()=>{
  // The tank is the bound on a hop, and the search ends rather than skipping on — a pilot
  // that cannot afford the second POI cannot afford the third either.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[{...grazer,poi:'far_belt'}],polls:1}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    // The route quotes 7, so 6 is one unit short.
    f.account.server.ship.fuel=6;
    const out=await hunt({species:'molt_grazer',look:['belt','far_belt']});
    assert.equal(out.detail.ended,'fuel',JSON.stringify(out.detail));
    assert.equal(f.count('spacemolt/jump'),0,'the hop it could not afford was flown anyway');
    assert.match(out.why??'',/fuel/,out.why);
    assert.match(out.why??'',/far_belt/,`the POI that stopped the search is not named: ${out.why}`);
    assert.equal(out.now.ship.fuel,6,'the search spent fuel it had refused to spend');
  } finally {unbind();}
});

test('a hop the tank covers but that crosses the reserve is flown, and the search ends Tired before any fight',async()=>{
  // The reserve is where Tired begins, not a margin on the hop (operator, 2026-09-26): Focused
  // keeps 24, the route quotes 7, and 30 flies it and lands under the line.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[{...grazer,poi:'far_belt'}],polls:1}});
  // Tired is derived from the ship, as the bridge binds it.
  bind({account:f.account as unknown as ReadinessAccount,command:f.command,runtime:f.runtime,
    pilot:derived(()=>({mood:'Focused'}),f.account),emit:()=>{}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    f.account.server.ship.fuel=30;
    const out=await hunt({species:'molt_grazer',look:['belt','far_belt']});
    assert.equal(out.detail.ended,'tired',JSON.stringify(out.detail));
    assert.equal(out.detail.fights.length,0,'a Tired pilot started a fight');
    assert.equal(out.status,'partial');
    assert.ok(out.now.ship.fuel<24,`fuel ${out.now.ship.fuel}`);
  } finally {unbind();}
});

test('every look is remembered, the empty ones included, and a remembered absence carries its age',async()=>{
  // `markets.json` and `combat.json` keep what the server will not answer twice. A look is the
  // same: `get_nearby` answers only "here, now", so an empty belt is knowledge that has to be
  // written down or it is paid for again next shift.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[{...grazer,poi:'far_belt'}],polls:1}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    await hunt({species:'molt_grazer',look:['belt','far_belt']});
    const rows=readSightings(f.runtime);
    assert.ok(rows.some(row=>row.poi_id==='belt'),`the empty look was not remembered: ${JSON.stringify(rows)}`);
    assert.ok(rows.some(row=>row.poi_id==='far_belt'&&row.species==='molt_grazer'),JSON.stringify(rows));
    // The empty belt reads as an absence, not as "never looked": that is the whole value of it.
    const empty=recall(rows,'belt','molt_grazer');
    assert.equal(empty.state,'seen');
    assert.equal(empty.state==='seen'&&empty.count,0);
    assert.equal(recall(rows,'far_belt','molt_grazer').state,'seen');
    assert.equal(recall(rows,'a_belt_never_visited','molt_grazer').state,'unlooked');
  } finally {unbind();}
});

test('species narrows the search as well as the fight, under strict: the wrong species at the first POI is left alone',async()=>{
  // `strict` narrows the search as well as the fight. A search that engaged whatever stood at
  // the first stop would make the prey argument a lie and spend the hull on the wrong animal.
  // (Unset, `species` is a preference and this same habitat would fight the tortoise at `belt`
  // instead of flying on — see the `species`/`strict` tests below.)
  const f=worldWithMemory({mood:'Focused'},
    {wildlife:{creatures:[{...tortoise,poi:'belt'},{...grazer,poi:'far_belt'}],polls:1,damage:1}});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const out=await hunt({species:'molt_grazer',strict:true,look:['belt','far_belt']});
    assert.equal(out.detail.fights.length,1,JSON.stringify(out.detail.looked));
    assert.equal(out.detail.fights[0]!.target.name,'Molt Grazer','the tortoise was fought instead');
    // And the tortoise it declined is still remembered as having been there.
    assert.ok(readSightings(f.runtime).some(row=>row.poi_id==='belt'&&row.species==='slag_tortoise'),
      'a look records what was there, not only what was wanted');
  } finally {unbind();}
});

// ---- `species` as a list, and `strict` --------------------------------------------------
// One evening cost 48 declines and 0 fights: `species: 'rime_grazer'` named a species that
// was never present, and every legal creature standing there was turned down for being the
// wrong one. `species` now takes several names, and unless `strict` is asked for, a named
// species is a preference — fought first if present — not a filter that empties the habitat.

test('a species list counts any of them as named, even the one not first in the habitat',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[tortoise],polls:1,damage:1}});
  try {
    const out=await hunt({species:['molt_grazer','slag_tortoise']});
    assert.equal(out.detail.fights.length,1,JSON.stringify(out.detail));
    assert.equal(out.detail.fights[0]!.target.name,'Slag Tortoise');
  } finally {unbind();}
});

test('strict:false falls back to a legal creature of any species when none named is here',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[tortoise],polls:1,damage:1}});
  try {
    const out=await hunt({species:'molt_grazer',strict:false});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights.length,1,'the named species was absent, but a legal one stood here');
    assert.equal(out.detail.fights[0]!.target.name,'Slag Tortoise');
    // Nothing was declined for the wrong species: the fallback is not a refusal in disguise.
    assert.equal(out.detail.looked[0]!.legal,1);
  } finally {unbind();}
});

test('strict:false still prefers a named species over another legal one standing here',async()=>{
  // The tortoise is first in the habitat; the preference has to look past it for the named one.
  const f=world({mood:'Focused'},{wildlife:{creatures:[tortoise,grazer],polls:1,damage:1}});
  try {
    const out=await hunt({species:'molt_grazer',strict:false});
    assert.equal(out.detail.fights.length,1);
    assert.equal(out.detail.fights[0]!.target.name,'Molt Grazer','the preference lost to the first-legal fallback');
  } finally {unbind();}
});

test('strict:true keeps the old refusals: only the named species is fought',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[tortoise],polls:1,damage:1}});
  try {
    const out=await hunt({species:'molt_grazer',strict:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.fights.length,0,'the only creature here is the wrong species');
    assert.equal(out.detail.ended,'nothing here');
    assert.equal(out.detail.looked[0]!.legal,0,'declined for species under strict, not counted legal');
    assert.equal(f.count('spacemolt/hunt'),0,'nothing was engaged');
  } finally {unbind();}
});

test('omitting strict is the same as strict:false',async()=>{
  const f=world({mood:'Focused'},{wildlife:{creatures:[tortoise],polls:1,damage:1}});
  try {
    const out=await hunt({species:'molt_grazer'});
    assert.equal(out.detail.fights.length,1,'no strict given: the fallback still applies');
    assert.equal(out.detail.fights[0]!.target.name,'Slag Tortoise');
  } finally {unbind();}
});

test('a decision component already in force is not a mutation, so the tick goes to the next one',async()=>{
  // Observed twice in one live fight: `onTick asked {"stance":"fire","move":"closeIn"}; sent stance
  // fire`. The stance was ALREADY fire — `BattleParticipant.stance` says so on our own row — and
  // because the server takes one mutation a tick and the applier runs
  // disengage → stance → move → focus, the `closeIn` was dropped and the tick achieved nothing.
  //
  // It cost the fight, not just a tick: the opening was spent at `outer` with zone_distance 6
  // against max_weapon_reach 3, firing from outside our own reach and dealing zero, and the
  // quarry's hull only began to fall once the range closed. Closing it was the whole decision.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[grazer],polls:4,damage:1}});
  try {
    const out=await hunt({onTick:()=>({stance:'fire',move:'closeIn'})});
    assert.equal(out.status,'done',out.why);
    // The world reports our stance as `fire` from the first status read, so every one of these
    // asks is a no-op on the stance and the move is what the tick is for.
    assert.ok(f.count('spacemolt_battle/advance')>0,
      `the move was never sent: ${JSON.stringify(f.sent.map(c=>c.action))}`);
    // And the redundant stance is not re-sent. The default open sends `fire` once before any
    // callback runs, so one is expected; more than that is the bug.
    assert.ok(f.count('spacemolt_battle/stance')<=1,
      `a stance already in force was re-sent ${f.count('spacemolt_battle/stance')} times`);
    // The journal says what it skipped, so a pilot can see why its decision was reshaped.
    assert.match(f.lines.join('\n'),/already/,`nothing said about the skipped component: ${f.lines.join(' | ')}`);
  } finally {unbind();}
});

test('being outside our own weapon reach is said in the fight line, not left to be inferred',async()=>{
  // `zone_distance` against `combat_state.max_weapon_reach` is the API's own comparison — "compare
  // against your combat_state.max_weapon_reach to see if you can fire". Live, we spent the opening
  // at 6 against a reach of 3, dealing nothing, and the prose said only "outer 6/3": the one fact
  // that explained the zero damage was there but never spelled out.
  const f=worldWithMemory({mood:'Focused'},{wildlife:{creatures:[grazer],polls:2,damage:1}});
  try {
    await hunt({onTick:()=>undefined});
    const said=f.lines.join('\n');
    // The world puts us at zone_distance 2 with reach 2, which is within reach, so the warning must
    // NOT appear — the line only fires when the range actually explains a miss.
    assert.doesNotMatch(said,/out of reach/,said);
  } finally {unbind();}
});

test('the callback sees every round, even while the battle tick number stands still',async()=>{
  // The API documents `GetBattleStatusResponse.tick_duration` as "Ticks the battle has been
  // running", but live it stalls and was observed going BACKWARDS — 0,1,2,1,1,1,1,1,2 across nine
  // successive polls of one continuous fight, while the quarry's hull fell 100 → 80 → 60 → 40 → 20
  // and our shield fell monotonically. Real rounds were resolving under a number that did not move.
  //
  // The loop skipped its whole action phase on a repeated number, so `onTick` fired about once for
  // every several rounds. The pace is the tick — `pace.tickMs` is the documented tick length — so
  // the poll is the round, and the unreliable counter no longer gates whether the pilot gets a say.
  const f=worldWithStuckTick({mood:'Focused'},{wildlife:{creatures:[grazer],polls:5,damage:1}});
  try {
    const seen:number[]=[];
    await hunt({onTick:view=>{seen.push(view.tick);return undefined;}});
    assert.ok(seen.length>=4,
      `the callback saw ${seen.length} of about 5 rounds; a stalled counter still silences it`);
  } finally {unbind();}
});
