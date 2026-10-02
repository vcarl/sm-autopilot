import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount} from '../readiness.ts';
import {readJournal} from '../run-record.ts';
import {menu} from './menu.ts';
import {readDockRefusals} from './places.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from './runtime.ts';
import {destination,goTo} from './travel.ts';

test('goTo refuses a name that is not a place',async()=>{
  const game=bridgeWorld({services:['refuel','repair']});
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  try {
    const out=await goTo('nowhere_at_all');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/no system, POI or base is named/);
  } finally {unbind();}
});

test('goTo fails (does not refuse) a real command error out of find_route, e.g. a dropped connection',async()=>{
  // "not a place" is `find_route` throwing "Target system not found", which `destination`
  // turns into a `TravelBlocked` and is meant to be refused. Anything else it throws — a
  // socket drop, a real server error — is not that, and must surface as `failed` so the run is
  // reported honestly instead of telling the pilot it named something wrong.
  const game=bridgeWorld({services:['refuel','repair']});
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt/find_route')throw new Error('cannot send on a closed socket');
    return game.command(action,params);
  };
  bind({account:game.account as unknown as ReadinessAccount,command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/cannot send on a closed socket/);
  } finally {unbind();}
});

test('a base that denies the dock: goTo is partial in the game\'s words, and the refusal is remembered, journalled and named in the menu',async()=>{
  // Live 2026-10-02 (kvothe 16:37Z): an `Access denied` dock broke the whole run after the flight
  // had landed, and the same bases were retried hours apart because nothing remembered it.
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-dock-'));
  const game=bridgeWorld({services:['refuel','repair']});
  let deny=true;
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt/dock'&&deny)throw new SpacemoltError('access_denied','Access denied');
    return game.command(action,params);
  };
  bind({account:game.account as unknown as ReadinessAccount,command,pilot:():Pilot=>({mood:'Focused'}),runtime,emit:()=>{}});
  try {
    const out=await goTo('range_base');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.did,/^arrived at range_base after 1 jump\(s\); docking refused: Access denied$/);
    assert.equal(readDockRefusals(runtime).range_base?.message,'Access denied');
    const line=readJournal(runtime).find(entry=>entry.event==='dock_refused');
    assert.equal(line?.base_id,'range_base');
    assert.equal(line?.system_id,'deep_range');
    assert.deepEqual((await menu(runtime)).places?.refused.map(row=>row.base_id),['range_base']);
    // Nothing refuses the next try; a dock that takes clears the memory.
    deny=false;
    assert.equal((await goTo('range_base')).status,'done');
    assert.deepEqual(readDockRefusals(runtime),{});
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

// Live 2026-10-02 (kvothe): a hex-id base reads `Kestrel Yard (b495…)` to the pilot now, so the
// name is what it may write back; goTo resolves it through the kept names, from anywhere.
test('goTo resolves a far opaque base by the name kept for it',async()=>{
  const base='b495c6003fc83e18f6d8cecbe6929133',game=bridgeWorld({services:['refuel','repair']});
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-names-'));
  writeFileSync(join(runtime,'names.json'),JSON.stringify({[base]:'Kestrel Yard'}));
  const command:typeof game.command=async(action,params)=>action==='spacemolt/find_route'&&params?.id===base
    ?{found:true,target_system:'dheneb',target_poi:base,total_jumps:2,estimated_fuel:14,route:[]}:game.command(action,params);
  bind({account:game.account as unknown as ReadinessAccount,command,pilot:():Pilot=>({mood:'Focused'}),runtime,emit:()=>{}});
  try {assert.equal((await destination('Kestrel Yard')).id,base);}
  finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
