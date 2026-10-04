/** Rest is a play action — put in and bring the ship up — and it gates nothing. */
import {SpacemoltError,type Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld, type WorldOptions} from '../test-support/bridge-world.ts';
import {reflection, rest} from './rest.ts';
import {bind, unbind, type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={},before:(action:string)=>void=()=>{}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-rest-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  let who:Pilot=record;
  // The game refuses an action it does not serve; the shared world asserts instead, which is a defect.
  const command:typeof game.command=async(action,params)=>{
    before(action);
    try {return await game.command(action,params);}
    catch(error) {
      if(error instanceof assert.AssertionError&&/^Unexpected command/.test(error.message))throw new SpacemoltError('unknown_action',error.message);
      throw error;
    }
  };
  bind({account:game.account as unknown as Account,command,runtime,
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
    // Out at a POI with no base: undocked at a station, service() would dock itself.
    f.account.server.location={...f.account.server.location,poi_id:'belt',docked_at:null};
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

const refuse=(on:string,code:string)=>(action:string)=>{if(action===on)throw new SpacemoltError(code,`${action} refused`);};

test('rest to a base the game will not route to is refused, and says it did not get there',async()=>{
  const f=world({},{},refuse('spacemolt/find_route','no_route'));
  try {
    const out=await rest('deep_range');
    assert.equal(out.status,'refused');
    assert.equal(out.did,'did not reach deep_range');
    assert.match(out.why??'',/no_route/);
    assert.deepEqual(out.detail.issued,[]);
  } finally {f.close();}
});

test('rest whose refuel the game refuses is refused, naming the action and the code; nothing is re-sent',async()=>{
  let sent=0;
  const refused=refuse('spacemolt/refuel','insufficient_credits');
  const f=world({},{},action=>{if(action==='spacemolt/refuel')sent++;refused(action);});
  try {
    f.account.server.ship.fuel=10;
    const out=await rest();
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/spacemolt\/refuel: insufficient_credits/);
    assert.equal(sent,1);
  } finally {f.close();}
});

test('a reflection whose skills read is refused still reads, naming it missing',async()=>{
  const f=world({name:'kvothe'},{},refuse('spacemolt/get_skills','not_available'));
  try {
    const seen=await reflection();
    assert.equal(seen.status,'done',seen.why);
    assert.ok(seen.detail.missing.includes('skills'),JSON.stringify(seen.detail.missing));
  } finally {f.close();}
});

test('a reflection whose account re-read loses its reply fails, naming the action',async()=>{
  const f=world({name:'kvothe'});
  try {
    f.account.refresh=async()=>{throw new SpacemoltError('connection_closed','the socket dropped');};
    const seen=await reflection();
    assert.equal(seen.status,'failed');
    assert.match(seen.why??'',/reply lost on refresh/);
  } finally {f.close();}
});
