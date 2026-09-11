import test from 'node:test';
import assert from 'node:assert/strict';
import {productionFixture} from './production-fixture.ts';
import {ExecutionHost} from './execution-host.ts';
import {ExecutionStore} from './execution-store.ts';

test('shared purchases retain tax-inclusive spending through production settlement and failed-refresh recovery',async t=>{
  for(const loseRefresh of [false,true]) {
    const f=productionFixture(t,{buyInputs:true,buyTax:1});
    const host=new ExecutionHost(f.account,f.directory,f.execution.deps);
    await host.dispatch('execution/configure',{stance:'Industry',mood:'Focused',objective:'Produce with accounted purchase tax'});
    await host.dispatch('job/observe');
    await host.dispatch('job/plan',{home_base_id:'base',home_rationale:'Observed factory and service'});
    await host.dispatch('execution/handoff');
    const send=f.account.send.bind(f.account),refresh=f.account.refresh.bind(f.account);
    let bought=false,failed=false;
    f.account.send=async(tool,action,params)=>{const reply=await send(tool,action,params);if(action==='buy')bought=true;return reply;};
    f.account.refresh=async()=>{if(loseRefresh&&bought&&!failed){failed=true;throw new Error('Lost refresh after accepted taxed buy');}return refresh();};
    const first:any=await host.dispatch('job/produce',{recipe_id:'refine',source:'buy'});
    const persisted=new ExecutionStore(f.directory,'pilot');
    const original=persisted.data.jobs.find(job=>job.id===first.id)!;
    const purchase=original.actions.find(row=>row.action==='spacemolt/buy')!;
    assert.equal((purchase.accepted_result as any).delta.details.total_cost,4,'Server market receipt omits tax');
    assert.equal(original.spending?.gross_spend,loseRefresh?5:8);
    assert.ok(first.cash_delta>0,'Unrelated income does not offset gross purchase cost');
    if(loseRefresh) {
      assert.equal(first.status,'needs_reconciliation');
      const recoveredHost=new ExecutionHost(f.account,f.directory,f.execution.deps);
      await recoveredHost.dispatch('execution/configure',{stance:'Industry',mood:'Focused',objective:'Reconcile taxed purchase'});
      const recovered:any=await recoveredHost.dispatch('execution/reconcile');
      assert.equal(recovered.spending.gross_spend,5);
      assert.equal(recovered.status,'needs_reconciliation','Accepted purchase does not prove production completion');
    } else {
      assert.equal(first.status,'completed');
      assert.equal(first.result.production.spent,8);
      assert.equal(first.result.production.earned,40);
    }
    assert.equal(f.calls.filter(row=>row.key==='spacemolt/buy').length,1);
    assert.equal(f.calls.filter(row=>row.key==='spacemolt/craft'&&row.params.id&&!row.params.dry_run).length,loseRefresh?0:1);
  }
});
