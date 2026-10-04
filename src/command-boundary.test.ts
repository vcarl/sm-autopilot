import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect} from 'effect';
import {mineToFullEffect} from './mine.ts';
import {ReplyLost} from './play/game.ts';
import {mineLive,mineTwin,mineWorld as world} from './test-support/mine-world.ts';

// The error channel is the latch: a lost reply to a send, or a read that fails after a send, ends
// the composite, so nothing after it is sent. These ran against CommandBoundary before.

test('a lost reply to a mutation is reconciled by a read, and no further mutation is sent',async()=>{
  for(const lost of [new ConnectionClosedError('socket closed',1006),new SpacemoltError('mutation_timeout','no result'),
    new SpacemoltError('facility_required','Request rejected while another command is pending',{pendingCommand:'buy'})]) {
    const w=world(()=>{throw lost;});
    assert.equal((await mineTwin(w)).outcome,'failed');
    assert.equal(w.mines(),1);
  }
});

test('a plain Error from the seam is a defect and also halts, raw',async()=>{
  const raised=new Error('transport failure');
  const w=world(()=>{throw raised;});
  assert.equal(await mineTwin(w).then(()=>undefined,e=>e),raised);
  assert.equal(w.mines(),1);
});

test('a known rejection is handled by its tag and ends the composite cleanly',async()=>{
  const w=world(()=>{throw new SpacemoltError('no_resources','depleted');});
  assert.equal((await mineTwin(w)).outcome,'depleted');
  assert.equal(w.mines(),1);
});

test('a refresh that fails after a send fails the composite, with no further send',async()=>{
  const lost=new ConnectionClosedError('canonical refresh lost');
  const w=world(fake=>{fake.refresh=async()=>{throw lost;};return {ok:true};});
  const failed=await Effect.runPromise(Effect.flip(mineToFullEffect(w.fake)).pipe(Effect.provide(mineLive(w))));
  assert.ok(failed instanceof ReplyLost&&failed.cause===lost);
  assert.equal(w.mines(),1);
  const defect=new Error('canonical refresh broke');
  const d=world(fake=>{fake.refresh=async()=>{throw defect;};return {ok:true};});
  assert.equal(await mineTwin(d).then(()=>undefined,e=>e),defect);
  assert.equal(d.mines(),1);
});
