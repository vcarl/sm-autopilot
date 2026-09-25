/** Ending a shift and naming the next one are one call.
 *
 * They were two, and the seam between them was where a pilot got lost: `rest()` cleared the record
 * and the pilot then had to be asked, in a fresh model turn, to say what came next. A pilot that
 * talked itself out of answering sat at rest with an empty record, and on 2026-09-25 that burned a
 * whole juncture on 38 refusals. If ending a shift requires naming the next one, the normal path
 * cannot reach that state at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld, type WorldOptions} from '../test-support/bridge-world.ts';
import {reflection, rest} from './rest.ts';
import {bind, unbind, type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-rest-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,runtime,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  return {...game,runtime,who:()=>who,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const serviced=(f:ReturnType<typeof world>)=>{
  f.account.server.ship.fuel=f.account.server.ship.max_fuel;
  f.account.server.ship.hull=f.account.server.ship.max_hull;
};

test('rest ends the shift and opens the next one in the same call',async()=>{
  const f=world({name:'kvothe',objective:'learn the trade',goal:'three loads',
    stance:'Prospector',mood:'Focused'});
  try {
    serviced(f);
    const out=await rest({goal:'walk a price circuit',stance:'Scout',mood:'Cautious'});
    assert.equal(out.status,'done',out.why);
    // The record does not pass through the empty state that cost us a juncture: one write.
    assert.equal(f.who().stance,'Scout');
    assert.equal(f.who().mood,'Cautious');
    assert.equal(f.who().goal,'walk a price circuit');
    // And the objective is carried, not lost with the shift.
    assert.equal(f.who().objective,'learn the trade');
    assert.deepEqual(out.detail.opened,{goal:'walk a price circuit',stance:'Scout',mood:'Cautious'});
    assert.match(out.did,/Scout/);
  } finally {f.close();}
});

test('rest refuses a stance or a mood the rules do not know, and the shift stays open',async()=>{
  const f=world({name:'kvothe',stance:'Prospector',mood:'Focused',goal:'three loads'});
  try {
    serviced(f);
    const wrong=await rest({goal:'go fast',stance:'Cowboy' as never,mood:'Cautious'});
    assert.equal(wrong.status,'refused');
    assert.match(wrong.why??'',/Prospector/,`the refusal does not name the stances: ${wrong.why}`);
    assert.equal(f.who().stance,'Prospector','the shift was ended on an unusable stance');

    // Relaxed and Tired are not initial moods: a shift cannot open in one.
    const tired=await rest({goal:'go fast',stance:'Scout',mood:'Tired' as never});
    assert.equal(tired.status,'refused');
    assert.match(tired.why??'',/Cautious/,tired.why);
    assert.equal(f.who().stance,'Prospector','the shift was ended on an unusable mood');

    const empty=await rest({goal:'   ',stance:'Scout',mood:'Cautious'});
    assert.equal(empty.status,'refused');
    assert.equal(f.who().stance,'Prospector');
  } finally {f.close();}
});

test('rest retires a finished objective alongside the goal that replaces it',async()=>{
  const f=world({name:'kvothe',objective:'reach 10,000 credits',goal:'sell the ore',
    stance:'Trader',mood:'Opportunistic'});
  try {
    serviced(f);
    const out=await rest({goal:'raise mining by two levels',stance:'Prospector',mood:'Focused',
      objective_done:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.who().objective,undefined,'a retired objective was handed back to the pilot');
    assert.equal(out.detail.retired,'reach 10,000 credits');
    assert.equal(f.who().goal,'raise mining by two levels');
  } finally {f.close();}
});

test('a script can read the same reflection material the juncture shows, before it chooses',async()=>{
  // The cost of moving the choice into a script: the script was authored before the shift ran, so it
  // cannot reason about how the shift went. Exposing the report at least lets it BRANCH on what it
  // finds — stagnation, the skills that would move, what is owed — rather than choose blind.
  const f=world({name:'kvothe',objective:'learn the trade',stance:'Prospector',mood:'Focused'});
  try {
    const seen=await reflection();
    assert.equal(seen.status,'done',seen.why);
    assert.equal(seen.detail.at_rest,true);
    assert.ok(Array.isArray(seen.detail.stagnation),'no stagnation signals to branch on');
    assert.ok(Array.isArray(seen.detail.stances)&&seen.detail.stances.length>0,'no stances to choose from');
    assert.ok(seen.detail.ship.max_fuel>0,'no ship to judge against');
  } finally {f.close();}
});
