import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect} from 'effect';
import {mineToFullEffect} from './mine.ts';
import {dig,mineLive,mineTwin as twin,mineWorld as world} from './test-support/mine-world.ts';

const refusing=(code:string,message='no')=>world(()=>{throw new SpacemoltError(code,message);});

test('mining ticks until the hold is full, and yields what the reads measured',async()=>{
  const w=world(fake=>{dig(fake,5);return {ok:true};});
  assert.deepEqual(await twin(w),{outcome:'full',cycles:2,yield:[{item_id:'ore',quantity:10}]});
  assert.equal(w.mines(),2);
});

test('a hold already full sends nothing',async()=>{
  const w=world(()=>({ok:true}));
  w.fake.server.ship.cargo_used=10;
  assert.equal((await twin(w)).outcome,'full');
  assert.equal(w.mines(),0);
});

test('the Depleted tag and every untagged depletion code end the step depleted, in the refusal\'s words',async()=>{
  for(const code of ['depleted','resource_depleted','deposit_too_sparse','no_common_ores','no_resources']) {
    const w=refusing(code,'the rock is bare');
    assert.deepEqual(await twin(w),{outcome:'depleted',cycles:0,yield:[],reason:`mine rejected: ${code}: the rock is bare`});
    assert.equal(w.mines(),1);
  }
});

test('cargo_full (HoldFull) and hold_full (Rejected) end the step full',async()=>{
  for(const code of ['cargo_full','hold_full']) {
    const w=refusing(code,'hold is full');
    assert.deepEqual(await twin(w),{outcome:'full',cycles:0,yield:[],reason:`mine rejected: ${code}: hold is full`});
    assert.equal(w.mines(),1);
  }
});

// A depletion or full code on a command still pending is a lost reply first (classify): reconciled by the read, never re-sent.
test('a depletion or full code on a pending command is reconciled as a lost reply, not read by its code',async()=>{
  for(const code of ['depleted','cargo_full','no_resources']) {
    const w=world(()=>{throw new SpacemoltError(code,'x',{pendingCommand:'mine'});});
    assert.deepEqual(await twin(w),{outcome:'failed',cycles:0,yield:[],reason:`${code}: x`});
    assert.equal(w.mines(),1);
  }
});

// Live F-U02 (testpilot-cv, 2026-10-02): `no_mining` came back `failed`, its why "mine failed: mine failed: no_mining: …".
test('any other refusal stays in the error channel as its tag, with its code and message',async()=>{
  for(const [code,tag] of [['no_mining','Rejected'],['in_battle','InBattle'],['no_base','Rejected']] as const) {
    const w=refusing(code,'cannot');
    const error=await Effect.runPromise(Effect.flip(mineToFullEffect(w.fake)).pipe(Effect.provide(mineLive(w))));
    assert.equal(error._tag,tag);
    assert.ok('code' in error&&error.code===code&&error.message==='cannot');
    assert.equal(w.mines(),1);
  }
});

test('a reply lost after the hold filled is reconciled by the read, and sent once',async()=>{
  for(const lost of [new ConnectionClosedError('closed'),new SpacemoltError('mutation_timeout','no result')]) {
    const w=world(fake=>{dig(fake,10);throw lost;});
    const out=await twin(w);
    assert.equal(out.outcome,'full');
    assert.equal(out.reason,`reconciled after ${lost instanceof SpacemoltError?lost.code:lost.name}: ${lost.message}`);
    assert.deepEqual(out.yield,[{item_id:'ore',quantity:10}]);
    assert.equal(w.mines(),1);
  }
});

test('a reply lost that left room in the hold fails the step and is not re-sent',async()=>{
  const w=world(fake=>{dig(fake,4);throw new SpacemoltError('action_pending','queued',{pendingCommand:'mine'});});
  assert.deepEqual(await twin(w),{outcome:'failed',cycles:0,yield:[{item_id:'ore',quantity:4}],reason:'action_pending: queued'});
  assert.equal(w.mines(),1);
});

test('a reply lost after the ship was displaced is not reconciled as full',async()=>{
  const w=world(fake=>{dig(fake,10);fake.server.location.docked_at='sol_base';throw new ConnectionClosedError('closed');});
  const out=await twin(w);
  assert.equal(out.outcome,'failed');
  assert.equal(out.reason,'ConnectionClosedError: closed');
});

test('a tick whose reply says it is full, or that moved no cargo, ends the step',async()=>{
  const said=world(fake=>{dig(fake,3);return {structuredContent:{cargo_full:true}};});
  assert.deepEqual(await twin(said),{outcome:'full',cycles:1,yield:[{item_id:'ore',quantity:3}],reason:'mine reported a full hold'});
  const empty=world(()=>({ok:true}));
  assert.deepEqual(await twin(empty),{outcome:'depleted',cycles:1,yield:[],reason:'mine reply showed no cargo change'});
});

test('a ship that is not at a POI is refused before anything is sent',async()=>{
  const w=world(()=>({ok:true}),{system_id:'sol'});
  assert.deepEqual(await twin(w),{outcome:'failed',cycles:0,yield:[],reason:'cannot mine: not at a POI'});
  assert.equal(w.mines(),0);
});

test('stop is asked before every tick',async()=>{
  const w=world(fake=>{dig(fake,1);return {ok:true};});
  assert.equal((await twin(w,{stop:()=>'tired'})).reason,'tired');
  assert.equal(w.mines(),0);
});

test('a non-game error from the seam is a defect that goes up raw, and is sent once',async()=>{
  const raised=new Error('socket logic bug');
  const w=world(()=>{throw raised;});
  assert.equal(await twin(w).then(()=>undefined,e=>e),raised);
  assert.equal(w.mines(),1);
});
