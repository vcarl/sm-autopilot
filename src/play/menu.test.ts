import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from '../readiness.ts';
import {journalRun} from '../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {menu,menuDue,renderMenu,type RunSummary} from './menu.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-menu-'));
  const game=bridgeWorld({services:['refuel','repair','storage','shipyard'],...options});
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:()=>record,setPilot:()=>{},runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const gather=(over:Partial<RunSummary>={}):RunSummary=>({fn:'gatherUntil',arg:'belt',status:'done',credits:0,items:12,xp:0,at:'sol_base',...over});
const ended=(runtime:string,work:RunSummary)=>journalRun(runtime,{phase:'ended',script:'index.ts',outcome:work.status,work});

test('four identical gathers: the stagnation line names them and the top move is not another gather',async()=>{
  const f=world({mood:'Focused',stance:'Prospector',home:'sol_base',objective:'obtain credits'},{cargoUsed:6});
  try {
    for(let i=0;i<4;i++)ended(f.runtime,gather());
    const built=await menu(f.runtime);
    assert.equal(built.stagnation,'4 runs of gatherUntil at belt, credits flat');
    assert.ok(built.moves.length>0&&built.moves.length<=5);
    assert.ok(!built.moves[0]!.call.startsWith('gatherUntil'),built.moves[0]!.call);
    assert.ok(built.moves.some(m=>m.call==="sell([{item_id:'ore',quantity:6}])"),JSON.stringify(built.moves));
    // The belt is still admissible (hold half free, fuel over the reserve): ranked under the
    // five that break the repetition, never refused.
    assert.ok(!built.not_now.some(row=>row.move==='gatherUntil'),JSON.stringify(built.not_now));
    assert.match(renderMenu(built),/^Menu — 4 runs of gatherUntil at belt, credits flat:\n  - `sell\(/);
  } finally {f.close();}
});

test('an unfitted module in the hold with no free slot is under not_now with the slot reason, not a move',async()=>{
  const f=world({mood:'Focused',stance:'Prospector',home:'sol_base'},{cargoUsed:0,
    hangar:{fitted:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility',cpu_usage:3,power_usage:4},
      {module_id:'m2',type_id:'mining_laser_i',slot:'utility',cpu_usage:3,power_usage:4}]}});
  try {
    f.account.server.cargo.push({item_id:'cargo_expander_ii',quantity:1});
    f.account.server.ship.cargo_used=1;
    const built=await menu(f.runtime);
    const refused=built.not_now.find(row=>row.move==="refit({install:['cargo_expander_ii']})");
    assert.match(refused!.why,/no free utility slot: 2 of 2 fitted/);
    assert.ok(!built.moves.some(m=>m.call.startsWith('refit')));
  } finally {f.close();}
});

test('Tired offers only service here, or the nearest serviced base when out',async()=>{
  const f=world({mood:'Tired',stance:'Prospector',home:'sol_base'});
  try {
    const docked=await menu(f.runtime);
    assert.deepEqual(docked.moves.map(m=>m.call),['service()']);
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const out=await menu(f.runtime);
    assert.deepEqual(out.moves.map(m=>m.call),["goTo('sol_base')"]);
  } finally {f.close();}
});

test('the trigger fires on repetition, on two runs not done, on a run that gained nothing, and not after one productive run',()=>{
  assert.equal(menuDue([gather({credits:120})]),null);
  assert.equal(menuDue([gather(),gather(),gather({credits:5})]),'3 runs of gatherUntil at belt, credits +5');
  assert.equal(menuDue([gather({credits:1}),gather({fn:'sell',arg:'12',status:'refused'}),gather({status:'partial'})]),'last 2 runs ended refused, partial (sell, gatherUntil)');
  assert.equal(menuDue([gather({fn:'goTo',arg:'belt',items:0})]),'the last run (goTo belt) gained nothing');
  assert.equal(menuDue([],true),'Tired cleared: the mood before it is back');
  assert.equal(menuDue([]),null);
});
