import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import {Effect} from 'effect';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {readJournal} from '../run-record.ts';
import {bridgeWorld,derived} from '../test-support/bridge-world.ts';
import {travelToEffect} from '../travel.ts';
import {onWorldClock} from '../test-support/travel.ts';
import {acct,bind,edge,jobEffect,stop,unbind,type Pilot} from './runtime.ts';
import {goTo} from './travel.ts';

test('goTo refuses a name that is not a place',async()=>{
  const game=bridgeWorld({services:['refuel','repair']});
  bind({account:game.account as unknown as Account,command:game.command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
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
  bind({account:game.account as unknown as Account,command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/cannot send on a closed socket/);
  } finally {unbind();}
});

/** A world where one command answers as the server does when it refuses (or loses the reply), and the sends are counted. */
function worldFailing(action:string,failure:SpacemoltError,opts:{mood?:Pilot['mood'];fuel?:number}={}) {
  const game=bridgeWorld({services:['refuel','repair']});
  if(opts.fuel!==undefined)game.account.server.ship.fuel=opts.fuel;
  const sent:string[]=[];
  const command:typeof game.command=async(name,params)=>{
    sent.push(name);
    if(name===action)throw failure;
    return game.command(name,params);
  };
  const who=derived(()=>({mood:opts.mood??'Focused'}),game.account);
  bind({account:game.account as unknown as Account,command,pilot:who,emit:()=>{}});
  return {game,sent,count:(name:string)=>sent.filter(entry=>entry===name).length};
}

test('goTo ends refused with the server\'s own code when a jump is refused, and flew nothing',async()=>{
  const w=worldFailing('spacemolt/jump',new SpacemoltError('no_route','No route to that place'));
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt\/jump: no_route/);
    assert.equal(w.count('spacemolt/jump'),1,'a refusal is not retried');
  } finally {unbind();}
});

test('a jump whose reply is lost is never re-sent: the trip fails and the ship is read, not assumed',async()=>{
  const w=worldFailing('spacemolt/jump',new SpacemoltError('mutation_timeout','no reply in time'));
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/reply lost on spacemolt\/jump/);
    assert.equal(w.count('spacemolt/jump'),1,'a mutation whose reply is lost is never re-sent');
    assert.equal(out.now.location?.system_id,'sol','the outcome is the ship as the game reports it');
  } finally {unbind();}
});

test('a Tired pilot short of fuel at a counter is resupplied by the trip itself, then flies',async()=>{
  const w=worldFailing('never',new SpacemoltError('x','unused'),{mood:'Tired',fuel:3});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'done',`${out.did}: ${out.why}`);
    assert.ok(w.count('spacemolt/refuel')>=1,'the tank was bought up before the jump');
    assert.ok(w.sent.indexOf('spacemolt/refuel')<w.sent.indexOf('spacemolt/jump'));
    assert.equal(w.game.account.server.location.system_id,'deep_range');
  } finally {unbind();}
});

test('a refuel the counter refuses is said, and the fuel check decides: the trip is refused with the shortfall',async()=>{
  const w=worldFailing('spacemolt/refuel',new SpacemoltError('insufficient_credits','not enough credits'),{mood:'Tired',fuel:3});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/fuel 3, the route needs 7/);
    assert.equal(w.count('spacemolt/jump'),0);
  } finally {unbind();}
});

/** A world whose jump does `onJump` first, bound to a temporary runtime so its journal can be read for defects. */
function worldJournalled(onJump:(game:ReturnType<typeof bridgeWorld>)=>'skip'|void) {
  const game=bridgeWorld({services:['refuel','repair']});
  const command:typeof game.command=async(name,params)=>{
    if(name==='spacemolt/jump'&&onJump(game)==='skip')return {};
    return game.command(name,params);
  };
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-travel-'));
  bind({account:game.account as unknown as Account,command,runtime,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  return {game,defects:()=>readJournal(runtime).filter(row=>row.event==='defect'),
    close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}

test('a pilot stop mid-trip ends partial, and is not a defect',async()=>{
  const w=worldJournalled(()=>{stop();});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why??'',/stopped by pilot/);
    assert.deepEqual(w.defects(),[]);
  } finally {w.close();}
});

test('a ship that changes under a trip fails naming it, and is not a defect',async()=>{
  const w=worldJournalled(game=>{game.account.server.ship.id='another_ship';});
  try {
    const out=await goTo('deep_range');
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why??'',/Ship changed during travel/);
    assert.deepEqual(w.defects(),[]);
  } finally {w.close();}
});

test('an arrival the game never confirms fails naming itself, and is not a defect',async()=>{
  // The jump is answered and the ship never moves: the wait runs out on its own clock.
  const w=worldJournalled(()=>'skip');
  let at=0;
  try {
    const out=await edge(jobEffect('goTo','deep_range',onWorldClock(travelToEffect(acct(),{system_id:'deep_range'},
      {maxJumps:null,maxWaitMs:5000}),{now:()=>at,sleep:async ms=>{at+=ms;}}).pipe(Effect.as({status:'done' as const,did:'flew',detail:{}}))));
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why??'',/Arrival not verified/);
    assert.deepEqual(w.defects(),[]);
  } finally {w.close();}
});
