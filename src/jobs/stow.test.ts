import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import type {Ctx} from './ctx.ts';
import {stow} from './stow.ts';

/** A job is handed a ctx, not a runner: this is the smallest honest one. */
function fixture(options:WorldOptions={},keep:string[]=[]) {
  const world=bridgeWorld({services:['refuel','repair','storage'],...options});
  const ctx:Ctx={account:world.account as unknown as ReadinessAccount,command:world.command,
    mood:'Focused',permissions:{},runtime:undefined,keep,jobs:[],
    check:async()=>{},progress:()=>{},resuming:()=>false};
  return {...world,ctx,deposits:()=>world.count('spacemolt_storage/deposit')};
}

test('stow deposits the whole hold but the pilot\'s own, and says what moved', async () => {
  const f=fixture({cargoUsed:0,store:[]},['cabin']);
  f.account.server.cargo=[{item_id:'ore',quantity:8},{item_id:'cabin',quantity:1}];
  f.account.server.ship.cargo_used=9;
  const outcome=await stow(f.ctx,{});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'ore',quantity:8}]);
  assert.deepEqual(f.store,[{item_id:'ore',quantity:8}]);
  assert.deepEqual(f.account.server.cargo,[{item_id:'cabin',quantity:1}],'the keep never moves');
  const result=outcome.result as any;
  assert.deepEqual([result.base_id,result.stowed,result.cargo_free],['sol_base',1,11]);
  assert.deepEqual(result.remaining,[{item_id:'cabin',quantity:1}]);
  // One deposit per row stowed, and the job is the run's own record of it.
  assert.equal(f.deposits(),1);
  assert.deepEqual(f.ctx.jobs.map(job=>[job.job,job.outcome]),[['stow','done']]);
});

test('stow moves only the items it was named, and nothing else', async () => {
  const f=fixture({cargoUsed:0,store:[]});
  f.account.server.cargo=[{item_id:'ore',quantity:4},{item_id:'scrap',quantity:2}];
  f.account.server.ship.cargo_used=6;
  const outcome=await stow(f.ctx,{items:['scrap']});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'scrap',quantity:2}]);
  assert.equal(f.deposits(),1,'one deposit, for the one item named');
  assert.deepEqual(f.account.server.cargo,[{item_id:'ore',quantity:4}]);
});

test('a hold with nothing to stow is done, having sent no deposit', async () => {
  const f=fixture({cargoUsed:0,store:[]});
  const outcome=await stow(f.ctx,{});
  assert.equal(outcome.outcome,'done');
  assert.deepEqual(outcome.yield,[]);
  assert.match(String(outcome.reason),/nothing to stow at sol_base/);
  assert.equal(f.deposits(),0);
  // The pilot's own hold is not stowable either: re-running on it stays a no-op.
  const own=fixture({cargoUsed:12},['ore']);
  assert.equal((await stow(own.ctx,{})).outcome,'done');
  assert.equal(own.deposits(),0);
});

test('a base with no store fails before anything is sent, naming the base', async () => {
  const f=fixture({services:['refuel','repair']});
  const outcome=await stow(f.ctx,{});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/sol_base/);
  assert.match(String(outcome.reason),/storage/);
  assert.equal(f.deposits(),0);
});

test('stow is a counter, not a trip: undocked, or asked for another base, it fails', async () => {
  const f=fixture();
  f.account.server.location.docked_at=null;
  const adrift=await stow(f.ctx,{});
  assert.equal(adrift.outcome,'failed');
  assert.match(String(adrift.reason),/docked/);
  assert.equal(f.deposits(),0);

  const g=fixture();
  const elsewhere=await stow(g.ctx,{base_id:'outpost'});
  assert.equal(elsewhere.outcome,'failed');
  assert.match(String(elsewhere.reason),/outpost/);
  assert.match(String(elsewhere.reason),/sol_base/);
  assert.equal(g.deposits(),0);
});

test('one deposit per row stowed, never one per item in the hold', async () => {
  const f=fixture({cargoUsed:0,store:[]});
  f.account.server.cargo=[{item_id:'ore',quantity:3},{item_id:'scrap',quantity:2},
    {item_id:'ice',quantity:1}];
  f.account.server.ship.cargo_used=6;
  const outcome=await stow(f.ctx,{});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal((outcome.yield??[]).length,3);
  assert.equal(f.deposits(),3);
  assert.deepEqual(f.account.server.cargo,[]);
});
