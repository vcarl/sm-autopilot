import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import type {Ctx} from './ctx.ts';
import {withdraw} from './withdraw.ts';

/** A job is handed a ctx, not a runner: this is the smallest honest one. */
function fixture(options:WorldOptions={}) {
  const world=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const ctx:Ctx={account:world.account as unknown as ReadinessAccount,command:world.command,
    mood:'Focused',permissions:{},runtime:undefined,keep:[],jobs:[],
    check:async()=>{},progress:()=>{},resuming:()=>false};
  return {...world,ctx,withdrawals:()=>world.count('spacemolt_storage/withdraw')};
}

test('withdraw moves the rows it was asked for, and the hold grows by exactly that', async () => {
  const f=fixture({store:[{item_id:'ore',quantity:9},{item_id:'scrap',quantity:4}]});
  const outcome=await withdraw(f.ctx,{items:[{item_id:'ore',quantity:5},{item_id:'scrap',quantity:2}]});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'ore',quantity:5},{item_id:'scrap',quantity:2}]);
  assert.deepEqual(f.account.server.cargo,[{item_id:'ore',quantity:5},{item_id:'scrap',quantity:2}]);
  assert.equal(f.account.server.ship.cargo_used,7);
  assert.deepEqual(f.store,[{item_id:'ore',quantity:4},{item_id:'scrap',quantity:2}]);
  const result=outcome.result as any;
  assert.deepEqual([result.base_id,result.withdrawn,result.cargo_free],['sol_base',2,5]);
  assert.deepEqual(result.short,[]);
  // One withdraw per row moved, and the job is the run's own record of it.
  assert.equal(f.withdrawals(),2);
  assert.deepEqual(f.ctx.jobs.map(job=>[job.job,job.outcome]),[['withdraw','done']]);
});

test('a request larger than the store moves what is there and says it was not in store', async () => {
  const f=fixture({store:[{item_id:'ore',quantity:3}]});
  const outcome=await withdraw(f.ctx,{items:[{item_id:'ore',quantity:8}]});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'ore',quantity:3}]);
  assert.deepEqual((outcome.result as any).short,
    [{item_id:'ore',requested:8,moved:3,why:'not in store'}]);
  assert.deepEqual(f.store,[]);
});

test('a request past the hold\'s room stops at the room and says there was none', async () => {
  // Twelve of capacity twelve is a full hold; four aboard leaves room for eight.
  const f=fixture({cargoUsed:4,store:[{item_id:'scrap',quantity:30}]});
  const outcome=await withdraw(f.ctx,{items:[{item_id:'scrap',quantity:20}]});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'scrap',quantity:8}]);
  assert.equal(f.account.server.ship.cargo_used,12);
  assert.deepEqual((outcome.result as any).short,
    [{item_id:'scrap',requested:20,moved:8,why:'no room'}]);
  assert.equal((outcome.result as any).cargo_free,0);
});

test('an empty store is done having sent nothing, and says why', async () => {
  const f=fixture({store:[]});
  const outcome=await withdraw(f.ctx,{items:[{item_id:'ore',quantity:4}]});
  assert.equal(outcome.outcome,'done');
  assert.deepEqual(outcome.yield,[]);
  assert.deepEqual((outcome.result as any).short,
    [{item_id:'ore',requested:4,moved:0,why:'not in store'}]);
  assert.match(String(outcome.reason),/nothing to withdraw at sol_base/);
  assert.match(String(outcome.reason),/not in store/);
  assert.equal(f.withdrawals(),0);
});

test('a base with no store fails before anything is sent, naming the base', async () => {
  const f=fixture({services:['refuel','repair']});
  const outcome=await withdraw(f.ctx,{items:[{item_id:'ore',quantity:1}]});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/sol_base/);
  assert.match(String(outcome.reason),/storage/);
  assert.equal(f.withdrawals(),0);
});

test('withdraw is a counter, not a trip: undocked, or asked for another base, it fails', async () => {
  const f=fixture();
  f.account.server.location.docked_at=null;
  const adrift=await withdraw(f.ctx,{items:[{item_id:'ore',quantity:1}]});
  assert.equal(adrift.outcome,'failed');
  assert.match(String(adrift.reason),/docked/);
  assert.equal(f.withdrawals(),0);

  const g=fixture();
  const elsewhere=await withdraw(g.ctx,{items:[{item_id:'ore',quantity:1}],base_id:'outpost'});
  assert.equal(elsewhere.outcome,'failed');
  assert.match(String(elsewhere.reason),/outpost/);
  assert.match(String(elsewhere.reason),/sol_base/);
  assert.equal(g.withdrawals(),0);
});

test('one withdraw per row moved, never one per row asked for', async () => {
  const f=fixture({store:[{item_id:'ore',quantity:2},{item_id:'ice',quantity:1}]});
  const outcome=await withdraw(f.ctx,
    {items:[{item_id:'ore',quantity:2},{item_id:'ghost',quantity:5},{item_id:'ice',quantity:1}]});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal((outcome.yield??[]).length,2);
  assert.equal(f.withdrawals(),2,'the row the store never held sent nothing');
  assert.deepEqual((outcome.result as any).short,
    [{item_id:'ghost',requested:5,moved:0,why:'not in store'}]);
});
