/** What `scout` hands the pilot to paste. A hint the library refuses is worse than no hint: it
 * reads as knowledge, costs a juncture to try, and the refusal arrives too late to act on. */
import type {Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {scout} from './orient.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot) {
  const game=bridgeWorld({services:['refuel','repair','storage']});
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>record,emit:()=>{}});
  return game;
}

test("scout's gather hint names the base the trip settles at, because gatherUntil refuses without one",async()=>{
  // The refusal that cost a live shift, and cost it twice in two files: `gatherUntil` settles the
  // take at a base and falls back to `docked_at`, so out at a POI there is none and the call is
  // `refused` with "no base to return to" before it mines anything (mining.ts). The menu row was
  // fixed on 2026-09-25; this hint kept handing over the broken shape.
  const f=world({mood:'Focused',stance:'Prospector'});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    const out=await scout();
    const gather=(out.next??[]).filter(row=>row.startsWith('gatherUntil'));
    assert.ok(gather.length,`no gather hint at all: ${JSON.stringify(out.next)}`);
    for(const hint of gather)
      assert.match(hint,/base:'[^']+'/,`a gather hint with no base, which the library refuses: ${hint}`);
  } finally {unbind();}
});

test('a system with no station gets no gather hint, because there is nowhere to settle the take',async()=>{
  // Rather than a hint that cannot run. `scout` of a far system is exactly this case: the pilot is
  // reading about somewhere it is not standing, so there is no docked base to fall back on.
  const f=world({mood:'Focused',stance:'Prospector'});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    const out=await scout('deep_range');
    for(const hint of out.next??[])
      if(hint.startsWith('gatherUntil'))
        assert.match(hint,/base:'[^']+'/,`unrunnable hint for a system the ship is not in: ${hint}`);
  } finally {unbind();}
});
