import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {productionFixture} from './production-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {productionReceipt,productionExperiments} from './shared-production.ts';

test('shared production quotes, sources, settles and stops with receipt accounting and no mining fit',async t=>{
  for(const buyInputs of [false,true]) {
    const f=productionFixture(t,{buyInputs});
    const discovery:any=await f.execution.dispatch('assess',{});
    assert.ok(discovery.income_candidates.some((row:any)=>row.recipe_id==='refine'));
    assert.equal(f.execution.context.home,undefined);
    assert.equal(f.calls.some(call=>['spacemolt/buy','spacemolt/sell','spacemolt_storage/withdraw'].includes(call.key)),false);
    await f.choose();
    const source=buyInputs?'buy':'inventory';
    const quote:any=await f.execution.dispatch('assess',{recipe_id:'refine',source});
    assert.equal(quote.evaluation.feasible,true);assert.equal(f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,0);
    const job:any=await f.execution.dispatch('produce',{recipe_id:'refine',source});
    assert.equal(job.status,'completed');assert.equal(job.result.production.status,'complete');
    assert.equal(job.result.production.spent,buyInputs?7:3);assert.equal(job.result.production.earned,40);
    assert.equal(job.spending.gross_spend,buyInputs?7:3);assert.equal(job.result.production.realized_credit_delta,buyInputs?33:37);
    assert.ok(job.cash_delta>job.result.production.realized_credit_delta,'unrelated income remains separate from realized production');
    assert.equal(f.state.location.docked_at,'base');assert.equal(f.state.ship.fuel,f.state.ship.max_fuel);
    assert.equal(f.state.skills.crafting.xp,10);assert.equal(f.state.skills.trading.xp,2);
    assert.deepEqual(f.stock(),{ore:0,metal:0});assert.deepEqual(f.state.cargo,[{item_id:'original',quantity:1,size:1}]);
    assert.equal(f.calls.some(call=>['spacemolt/mine','spacemolt/install_mod','spacemolt/hunt'].includes(call.key)),false);
    const persisted=JSON.parse(readFileSync(f.store.path,'utf8'));
    assert.equal(persisted.jobs.at(-1).result.production.experiment_id,job.result.production.experiment_id);
    assert.match(job.stopping_reason,/one_job produce/);
    await assert.rejects(f.execution.dispatch('produce',{recipe_id:'refine',source}),/Stop latched/);
  }
  const constrained=productionFixture(t,{buyInputs:true});await constrained.choose();
  constrained.execution.context.limits.max_spend=9;constrained.state.ship.fuel--;
  const blocked:any=await constrained.execution.dispatch('produce',{recipe_id:'refine',source:'buy'});
  assert.equal(blocked.status,'blocked');assert.equal(blocked.spending.gross_spend,3);
  assert.equal(constrained.calls.some(call=>call.key==='spacemolt/buy'),false,'Preparation consumes the same production allocation');
  assert.equal(constrained.state.ship.fuel,120);
});

test('pending and partial production resume only settlement in a new run while unknown acceptance never replays',async t=>{
  for(const scenario of ['queued','partialSale','missingCraftCost','missingSaleProceeds'] as const) {
    const f=productionFixture(t,{[scenario]:true});await f.choose();
    const first:any=await f.execution.dispatch('produce',{recipe_id:'refine',max_wait_seconds:0});
    const production=productionReceipt(first.result)!;
    const unknown=scenario.startsWith('missing');
    assert.equal(first.status,unknown?'needs_reconciliation':'blocked');
    assert.equal(production.job_id,'craft-job');assert.notEqual(production.status,'complete');
    assert.equal(f.state.location.docked_at,'base');
    const crafts=()=>f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length;
    assert.equal(crafts(),1);
    const restored=new ExecutionStore(f.directory,'pilot');
    if(unknown) {
      assert.ok(production.pending_action||production.accounting_unverified);
      await assert.rejects(restored.startNewRun(f.account),/reconciled/);
      const recovery=new Execution(f.account,restored,f.execution.context,f.execution.deps);
      const reconciled:any=await recovery.reconcile();
      assert.equal(reconciled.status,'needs_reconciliation');
      await assert.rejects(restored.startNewRun(f.account),/reconciled/);
      assert.equal(crafts(),1);assert.ok(productionExperiments(restored.data.jobs)[0]?.pending_action||productionExperiments(restored.data.jobs)[0]?.accounting_unverified);
      continue;
    }
    f.finish();await restored.startNewRun(f.account);
    const resumed=new Execution(f.account,restored,f.execution.context,f.execution.deps);
    const result:any=await resumed.dispatch('produce',{experiment_id:production.experiment_id,max_wait_seconds:0});
    assert.equal(result.status,'completed');assert.equal(result.result.production.status,'complete');assert.equal(crafts(),1);
    assert.equal(result.budget_owner_id,first.id);assert.equal(result.budget_spending.gross_spend,3);
    assert.equal(result.result.production.earned,40);assert.equal(f.stock().metal,0);
  }
  for(const stop of [false,true]) {
    const f=productionFixture(t,{queued:true});await f.choose();
    if(stop)f.onSleep(()=>f.execution.signal('Tired during production wait'));
    const result:any=await f.execution.dispatch('produce',{recipe_id:'refine'});
    assert.equal(result.status,'blocked');assert.equal(productionReceipt(result.result)?.status,'pending');
    assert.equal(f.state.location.docked_at,'base');
    assert.ok(f.sleeps.length>0&&f.sleeps.every(ms=>ms<=2000));
    assert.ok(f.sleeps.reduce((sum,ms)=>sum+ms,0)<=120000);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,1);
    assert.equal(f.calls.some(call=>call.key==='spacemolt/sell'),false);
    const restored=new ExecutionStore(f.directory,'pilot');await restored.startNewRun(f.account);
    const next=new Execution(f.account,restored,f.execution.context,f.execution.deps);
    const refused:any=await next.dispatch('produce',{recipe_id:'refine'});
    assert.equal(refused.status,'blocked');assert.match(refused.error,/Unfinished production/);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,1);
  }
});
