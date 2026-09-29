import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from './runtime.ts';
import {goTo} from './travel.ts';

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
