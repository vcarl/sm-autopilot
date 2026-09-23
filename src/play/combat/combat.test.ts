import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {hunt,pace} from './hunting.ts';
import {salvage} from './salvage.ts';

// A tick is ten seconds of real time; the tests take the same loop at a millisecond.
pace.tickMs=1;

function world(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text)});
  return {...game,lines,record:()=>who};
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
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text)});
  return {...game,command,lines,record:()=>who};
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
    assert.equal(f.count('spacemolt_battle/retreat'),1);
    assert.match(out.why!,/Tired/);
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
    assert.equal(f.count('spacemolt_battle/retreat'),1,'the tick sat still, but the hull was still read every poll');
    assert.equal(fight.hull_after,76,'stopped one poll past the line (80), not run down while blind to it');
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
