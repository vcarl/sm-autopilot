import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {hunt} from './hunting.ts';
import {salvage} from './salvage.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text)});
  return {...game,lines,record:()=>who};
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
    // A line per round, carrying our hull and theirs.
    const rounds=f.lines.filter(line=>line.includes('round '));
    assert.equal(rounds.length,2);
    assert.match(rounds[0]!,/round 1 vs Molt Grazer: hull 95\/100, shield 0%, theirs 100%/);
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
