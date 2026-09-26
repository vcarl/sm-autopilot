/** Rest is a play action — put in and bring the ship up — and it gates nothing. */
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
    pilot:()=>who,emit:()=>{}});
  return {...game,runtime,who:()=>who,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
test('rest brings the ship up at the counter and leaves the record alone',async()=>{
  const f=world({name:'kvothe',objective:'learn the trade'});
  try {
    f.account.server.ship.fuel=10;
    const out=await rest();
    assert.equal(out.status,'done',out.why);
    assert.equal(f.account.server.ship.fuel,f.account.server.ship.max_fuel);
    assert.ok(out.detail.issued.includes('spacemolt/refuel'),JSON.stringify(out.detail));
    assert.deepEqual(f.who(),{name:'kvothe',objective:'learn the trade'},'rest wrote nothing');
  } finally {f.close();}
});

test('rest away from a counter says so rather than pretending',async()=>{
  const f=world({});
  try {
    f.account.server.location.docked_at=null;
    await f.account.refresh();
    const out=await rest();
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/not docked/);
  } finally {f.close();}
});

test('a script can read the reflection material before it chooses',async()=>{
  // The cost of moving the choice into a script: the script was authored before the shift ran, so it
  // cannot reason about how the shift went. Exposing the report at least lets it BRANCH on what it
  // finds — stagnation, the skills that would move, what is owed — rather than choose blind.
  const f=world({name:'kvothe',objective:'learn the trade',stance:'Prospector',mood:'Focused'});
  try {
    const seen=await reflection();
    assert.equal(seen.status,'done',seen.why);
    assert.ok(Array.isArray(seen.detail.stagnation),'no stagnation signals to branch on');
    assert.ok(Array.isArray(seen.detail.stances)&&seen.detail.stances.length>0,'no stances to choose from');
    assert.ok(seen.detail.ship.max_fuel>0,'no ship to judge against');
  } finally {f.close();}
});
