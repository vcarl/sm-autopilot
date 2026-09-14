import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {productionFixture} from './production-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {productionReceipt,productionExperiments} from './shared-production.ts';
import {ExecutionHost} from './execution-host.ts';

test('accepted unpriced craft resumes only from durable counter evidence, without replay or duplicate accounting',async t=>{
  for(const historical of [false,true]) {
    const f=productionFixture(t,{queued:true,missingCraftCost:true,noDemand:true});
    const host=new ExecutionHost(f.account,f.directory,f.execution.deps);
    await host.dispatch('execution/configure',{stance:'Industry',mood:'Focused',objective:'Retain owned production'});
    await host.dispatch('job/observe');
    await host.dispatch('job/plan',{home_base_id:'base',home_rationale:'Observed workshop and services'});
    await host.dispatch('execution/handoff');
    const send=f.account.send.bind(f.account),refresh=f.account.refresh.bind(f.account);
    let accepted=false,failed=false;
    f.account.send=async(tool,action,params:any)=>{const reply=await send(tool,action,params);if(action==='craft'&&params?.id&&!params.dry_run)accepted=true;return reply;};
    f.account.refresh=async()=>{if(accepted&&!failed){failed=true;throw new Error('Refresh lost after accepted craft');}return refresh();};
    const first:any=await host.dispatch('job/produce',{recipe_id:'refine',disposition:'retain',max_wait_seconds:0});
    const production=productionReceipt(first.result)!;
    assert.equal(first.status,'needs_reconciliation');
    const saved=new ExecutionStore(f.directory,'pilot');
    if(historical) {
      const craft=saved.data.jobs.find(job=>job.id===first.id)!.actions.find(entry=>entry.action==='spacemolt/craft'&&(entry.params as any).id&&!(entry.params as any).dry_run)!;
      delete (craft.accepted_result as any).structuredContent._hermes_spending;
      saved.save();
    }
    // Another debit in the unknown interval must count, even alongside unrelated income.
    f.state.player.stats.credits_spent+=2;f.state.player.credits+=98;
    const recovery=new ExecutionHost(f.account,f.directory,f.execution.deps);
    await recovery.dispatch('execution/configure',{stance:'Industry',mood:'Focused',objective:'Reconcile existing retained craft'});
    const recovered:any=await recovery.dispatch('execution/reconcile');
    const crafts=()=>f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length;
    assert.equal(crafts(),1);
    if(historical) {assert.equal(recovered.status,'needs_reconciliation');assert.equal(recovered.spending.gross_spend,null);continue;}
    assert.equal(recovered.spending.gross_spend,5);
    assert.equal(productionReceipt(recovered.result)!.spent,5);
    assert.equal(productionReceipt(recovered.result)!.pending_action,undefined);
    await recovery.dispatch('execution/reconcile');
    const restored=new ExecutionStore(f.directory,'pilot');
    assert.equal(productionExperiments(restored.data.jobs)[0]!.spent,5);
    f.finish();await restored.startNewRun(f.account);
    const resumed=new Execution(f.account,restored,f.execution.context,f.execution.deps);
    const result:any=await resumed.dispatch('produce',{experiment_id:production.experiment_id,max_wait_seconds:0});
    assert.equal(result.result.production.status,'complete');
    assert.equal(result.result.production.spent,5);assert.equal(result.budget_spending.gross_spend,5);
    assert.equal(result.budget_owner_id,first.id);assert.deepEqual(result.result.production.retained,{metal:2});
    assert.equal(crafts(),1);assert.equal(f.calls.some(call=>call.key==='spacemolt/sell'),false);
  }
});

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

test('multi-run output quantity is aggregated once through sale and queued retained settlement',async t=>{
  const large=productionFixture(t);await large.choose();
  const largeQuote:any=await large.execution.dispatch('assess',{recipe_id:'refine',quantity:1001,disposition:'retain'});
  assert.equal(largeQuote.craft.runs,501);assert.deepEqual(largeQuote.evaluation.outputs,[{item_id:'metal',quantity:1002}]);
  assert.equal(large.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,0);

  const sold=productionFixture(t,{buyInputs:true});await sold.choose();
  const sale:any=await sold.execution.dispatch('produce',{recipe_id:'refine',quantity:3,source:'buy'});
  assert.equal(sale.status,'completed');assert.equal(sale.result.production.spent,14);assert.equal(sale.result.production.earned,80);
  assert.equal(sale.result.production.quote.quantity,3);assert.equal(sale.result.production.quote.craft.runs,2);assert.deepEqual(sale.result.production.quote.craft.produces,[{item_id:'metal',quantity:2}]);
  assert.deepEqual(sale.result.production.quote.evaluation.outputs.map((row:any)=>({item_id:row.item_id,quantity:row.quantity,sale_credits:row.sale.credits})),[{item_id:'metal',quantity:4,sale_credits:80}]);
  assert.equal(sold.state.skills.crafting.xp,20);assert.equal(sold.state.skills.trading.xp,4);assert.deepEqual(sold.stock(),{ore:0,metal:0});

  const retained=productionFixture(t,{queued:true,noDemand:true,startingOre:4});await retained.choose();
  const pending:any=await retained.execution.dispatch('produce',{recipe_id:'refine',quantity:4,disposition:'retain',max_wait_seconds:0});
  assert.equal(pending.status,'blocked');assert.equal(productionReceipt(pending.result)!.status,'pending');
  assert.deepEqual(productionReceipt(pending.result)!.quote.evaluation.outputs,[{item_id:'metal',quantity:4}]);
  retained.finish();const store=new ExecutionStore(retained.directory,'pilot');await store.startNewRun(retained.account);
  const resumed=new Execution(retained.account,store,retained.execution.context,retained.execution.deps);
  const settled:any=await resumed.dispatch('produce',{experiment_id:productionReceipt(pending.result)!.experiment_id,max_wait_seconds:0});
  assert.equal(settled.status,'completed');assert.equal(settled.result.production.spent,6);
  assert.deepEqual(settled.result.production.retained,{metal:4});assert.deepEqual(retained.stock(),{ore:0,metal:4});
  assert.equal(retained.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,1);
});

test('pending and partial production resume only settlement in a new run while unknown acceptance never replays',async t=>{
  for(const scenario of ['queued','partialSale','missingCraftCost','missingSaleProceeds'] as const) {
    const f=productionFixture(t,{[scenario]:true});await f.choose();
    if(scenario==='missingCraftCost')delete f.state.player.stats.credits_spent;
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

test('unknown recipe assessment supplies exposed discovery recovery with actual candidates or blockers',async t=>{
  for(const demand of [true,false]) {
    const f=productionFixture(t);
    if(!demand) {
      const send=f.account.send.bind(f.account);
      f.account.send=async(tool,action,params)=>{
        const reply=await send(tool,action,params);
        if(tool==='spacemolt_market'&&action==='view_market')return {structuredContent:{items:[{item_id:'ore',buy_orders:[{price_each:1,quantity:100}],sell_orders:[{price_each:2,quantity:100}]},{item_id:'metal',buy_orders:[],sell_orders:[]}]}} as any;
        return reply;
      };
    }
    const result:any=await f.execution.dispatch('assess',{recipe_id:'guessed_recipe'});
    assert.equal(result.status,'blocked');assert.equal(result.requested_recipe_id,'guessed_recipe');
    assert.deepEqual(result.next_action,{action:'assess',params:{}});
    const discovered:any=await f.execution.dispatch(result.next_action.action,result.next_action.params);
    assert.equal(discovered.decision,demand?'candidates_available':'no_profitable_candidate');
    assert.equal(result.discovery.decision,discovered.decision);
    const rows=demand?result.discovery.income_candidates:result.discovery.ranked;
    assert.ok(rows.some((row:any)=>row.recipe_id==='refine'&&(demand||row.blockers.length>0)));
    assert.equal(f.calls.some(call=>call.key==='spacemolt/craft'&&call.params.id==='guessed_recipe'),false);
    assert.equal(f.calls.some(call=>['spacemolt/buy','spacemolt/sell','spacemolt_storage/withdraw'].includes(call.key)||call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run),false);
  }
});

test('retained output ignores absent sale demand and queued settlement preserves disposition and original budget',async t=>{
  for(const queued of [false,true]) {
    const f=productionFixture(t,{noDemand:true,queued});await f.choose();
    const quote:any=await f.execution.dispatch('assess',{recipe_id:'refine',disposition:'retain'});
    assert.equal(quote.evaluation.feasible,true);
    assert.equal(quote.next_action.action,'produce');
    assert.equal(quote.next_action.params.experiment_id,undefined);
    const first:any=await f.execution.dispatch(quote.next_action.action,{...quote.next_action.params,max_wait_seconds:0});
    let finished=first;
    if(queued) {
      assert.equal(first.status,'blocked');assert.equal(productionReceipt(first.result)?.status,'pending');
      const restored=new ExecutionStore(f.directory,'pilot');f.finish();await restored.startNewRun(f.account);
      const next=new Execution(f.account,restored,f.execution.context,f.execution.deps);
      const experimentId=productionReceipt(first.result)!.experiment_id;
      const callsBefore=f.calls.length;
      await assert.rejects(next.dispatch('produce',{experiment_id:experimentId,disposition:'sell'}),/only experiment_id/);
      assert.equal(f.calls.length,callsBefore);
      finished=await next.dispatch('produce',{experiment_id:experimentId,max_wait_seconds:0});
      assert.equal(finished.budget_owner_id,first.id);
      assert.equal(finished.budget_spending.gross_spend,first.spending.gross_spend);
    }
    const output=productionReceipt(finished.result)!;
    assert.equal(finished.status,'completed');assert.equal(output.disposition,'retain');
    assert.deepEqual(output.retained,{metal:2});assert.equal(output.retained_location.base_id,'base');
    assert.equal(output.earned,0);assert.equal(output.realized_credit_delta,-output.spent);
    assert.equal(output.incremental_profit_after_input_opportunity,null);
    assert.deepEqual(f.stock(),{ore:0,metal:2});
    assert.deepEqual(f.state.cargo,[{item_id:'original',quantity:1,size:1}]);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/craft'&&call.params.id&&!call.params.dry_run).length,1);
    assert.equal(f.calls.some(call=>['spacemolt/sell','spacemolt_storage/withdraw'].includes(call.key)),false);
  }
});
