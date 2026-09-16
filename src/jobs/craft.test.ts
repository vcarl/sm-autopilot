import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,journalTrap,type WorldOptions} from '../test-support/bridge-world.ts';
import type {Ctx} from './ctx.ts';
import {craft} from './craft.ts';

/** A pilot docked at a bench with the inputs already in this base's store. */
function fixture(options:WorldOptions={},over:Partial<Ctx>={}) {
  const world=bridgeWorld({services:['refuel','repair','storage','crafting'],
    store:[{item_id:'iron_ore',quantity:20}],...options});
  const trap=journalTrap();
  const ctx:Ctx={account:world.account as unknown as ReadinessAccount,command:world.command,
    mood:'Focused',permissions:{},runtime:trap.runtime,keep:[],jobs:[],
    check:async()=>{},progress:()=>{},resuming:()=>false,...over};
  const calls=(kind:'quote'|'commit')=>world.sent.filter(call=>
    call.action==='spacemolt/craft'&&call.params.id!==undefined
    &&Boolean(call.params.dry_run)===(kind==='quote')).length;
  return {...world,ctx,calls,steps:trap.steps,close:trap.close,
    held:(item:string)=>world.store.find(row=>row.item_id===item)?.quantity??0};
}

test('a craft commits once and the store grows by what the bench produced', async () => {
  const f=fixture();
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual(outcome.yield,[{item_id:'steel_plate',quantity:2}]);
  // One quote, one commit: a craft is not idempotent by re-sending, it is by skipping.
  assert.deepEqual([f.calls('quote'),f.calls('commit')],[1,1]);
  assert.equal(f.held('steel_plate'),2,'the delta across the two store reads, not the reply');
  assert.equal(f.held('iron_ore'),15,'the escrow took the inputs out of this base\'s store');
  const result=outcome.result as any;
  assert.deepEqual([result.recipe_id,result.name,result.runs,result.job_id,result.cost,result.base_id],
    ['refine_steel','Refine Steel',1,'job-1',19,'sol_base']);
  assert.deepEqual(result.produced,[{item_id:'steel_plate',quantity:2}]);
  assert.match(String(outcome.reason),/Refine Steel: 1 run, 2 steel_plate, cost 19 at sol_base/);
  assert.deepEqual(f.ctx.jobs.map(job=>[job.job,job.outcome]),[['craft','done']]);
});

test('inputs the store is short of fail the craft, naming them, with nothing committed', async () => {
  const f=fixture({store:[{item_id:'iron_ore',quantity:2}],craft:{have_inputs:false}});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/iron_ore 2 of 5/);
  assert.match(String(outcome.reason),/sol_base/);
  assert.equal(f.calls('commit'),0);
  assert.equal(f.held('iron_ore'),2,'an unquoted craft escrows nothing');
});

test('a base with no bench fails before any craft call at all', async () => {
  const f=fixture({services:['refuel','repair','storage']});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'failed');
  assert.match(String(outcome.reason),/sol_base/);
  assert.match(String(outcome.reason),/crafting/);
  assert.equal(f.count('spacemolt/craft'),0);
});

test('a cost that would breach the operator\'s reserve blocks before the commit', async () => {
  const f=fixture({craft:{credits_total:400}},{permissions:{credit_reserve:900}});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'blocked');
  // The numbers the operator would need to change are in the sentence: bill, wallet, reserve.
  for(const number of [/400/,/1000/,/900/])assert.match(String(outcome.reason),number);
  assert.deepEqual([f.calls('quote'),f.calls('commit')],[1,0]);
  assert.equal(f.account.server.player.credits,1_000,'a blocked craft spends nothing');
});

test('a resumed run waits on the job it already queued and never commits a second time', async () => {
  // One queue read still answers `queued`, so the job really waits before it confirms.
  const f=fixture({craft:{polls:1}},{resuming:()=>true});
  // The escrow the run made before the restart: inputs gone, output not yet delivered.
  f.store[0]!.quantity=15;
  f.queued.push({base_id:'sol_base',job_id:'job-1',recipe:'Refine Steel',
    produces:[{item_id:'steel_plate',quantity:2}],runs_total:1,status:'queued',eta_ticks:0});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.deepEqual([f.calls('quote'),f.calls('commit')],[0,0],'neither quoted nor committed again');
  assert.deepEqual(outcome.yield,[{item_id:'steel_plate',quantity:2}]);
  assert.equal(f.held('steel_plate'),2);
  assert.equal((outcome.result as any).job_id,'job-1');
});

test('a recipe this bench cannot make fails with the server\'s own text, uncommitted', async () => {
  const refusal="'Refine Steel' is made in a Iron Refinery, and no facility here can make it. "
    +'Nearest public one: Iron Refinery at Horizon Yard (1 jump).';
  const f=fixture({craft:{refusal}});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:2});
  assert.equal(outcome.outcome,'failed');
  assert.equal(outcome.reason,refusal,'the server already named the facility and the nearest one');
  assert.equal(f.calls('commit'),0);
});

test('a bench that quotes fewer than was asked for runs those, and says so', async () => {
  const f=fixture({craft:{quantity:2,runs:1,produces:[{item_id:'steel_plate',quantity:2}]}});
  const outcome=await craft(f.ctx,{recipe_id:'refine_steel',quantity:6});
  assert.equal(outcome.outcome,'done',outcome.reason);
  assert.equal(f.calls('commit'),1,'the smaller run is still run');
  assert.deepEqual(outcome.yield,[{item_id:'steel_plate',quantity:2}]);
  assert.match(String(outcome.reason),/quoted 2 of the 6 asked/);
  assert.equal((outcome.result as any).runs,1);
});

test('a craft that lands writes bench, quote, commit, wait and confirm in order', async () => {
  const f=fixture();
  try {
    assert.equal((await craft(f.ctx,{recipe_id:'refine_steel',quantity:2})).outcome,'done');
    assert.deepEqual(f.steps(),[['craft','bench','done'],['craft','quote','done'],
      ['craft','commit','done'],['craft','wait','done'],['craft','confirm','done']]);
  } finally {f.close();}
});

test('a craft short of inputs stops at the quote and never writes a commit', async () => {
  const f=fixture({store:[{item_id:'iron_ore',quantity:2}],craft:{have_inputs:false}});
  try {
    assert.equal((await craft(f.ctx,{recipe_id:'refine_steel',quantity:2})).outcome,'failed');
    assert.deepEqual(f.steps(),[['craft','bench','done'],['craft','quote','failed']]);
  } finally {f.close();}
});
