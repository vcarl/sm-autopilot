import test from 'node:test';
import assert from 'node:assert/strict';
import {gatherFixture} from './gather-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {commandSpend,jobSpending} from './spending.ts';
import {ensureReadiness} from './readiness.ts';

test('accepted service costs survive recovery exactly once; missing prices cannot authorize later spending or a new run',async t=>{
  for(const missing of [false,true]) {
    const f=gatherFixture(t);await f.choose();f.state.ship.fuel=116;
    const send=f.account.send.bind(f.account),refresh=f.account.refresh.bind(f.account);
    let paid=false,failed=false;
    f.account.send=async(tool,action,params)=>{
      const reply=await send(tool,action,params);
      if(action==='refuel') {
        paid=true;f.state.player.credits+=100;
        return {structuredContent:missing?{fuel:120}:{cost:12,market_cost:8,tax:4,fuel:120}} as any;
      }
      return reply;
    };
    f.account.refresh=async()=>{if(paid&&!failed){failed=true;throw new Error('Refresh lost after accepted service');}return refresh();};
    const first:any=await f.execution.dispatch('prepare');
    assert.equal(first.status,'needs_reconciliation');
    const store=new ExecutionStore(f.directory,'pilot');
    const resumed=new Execution(f.account,store,f.execution.context,f.execution.deps);
    const recovered:any=await resumed.reconcile();
    assert.equal(recovered.status,missing?'needs_reconciliation':'interrupted');
    assert.equal(recovered.spending.gross_spend,missing?null:12);
    assert.equal(recovered.spending.known_gross_spend,missing?0:12);
    assert.equal(f.calls.filter(c=>c.key==='spacemolt/refuel').length,1);
    assert.equal(recovered.cash_delta,88);
    assert.equal(jobSpending(store.data.jobs[0]!).gross_spend,recovered.spending.gross_spend);
    if(missing) {
      await assert.rejects(()=>store.startNewRun(f.account));
      f.state.ship.fuel=119;
      const again:any=await resumed.reconcile();
      assert.equal(again.status,'needs_reconciliation');
      assert.equal(f.calls.filter(c=>c.key==='spacemolt/refuel').length,1);
    }
  }
});

test('service totals include tax once and an overquote stops further service despite concurrent income',async t=>{
  assert.equal(commandSpend('spacemolt/buy',{delta:{details:{total_cost:21,tax:3}}}),21);
  assert.equal(commandSpend('spacemolt/refuel',{structuredContent:{cost:12,market_cost:8,tax:4}}),12);
  assert.equal(commandSpend('spacemolt/repair',{structuredContent:{cost:0}}),0);
  const f=gatherFixture(t);f.state.ship.fuel=116;f.state.ship.hull=104;
  const actions:string[]=[];
  await assert.rejects(()=>ensureReadiness(f.account,async(action)=>{
    actions.push(action);f.state.player.credits+=100-12;f.state.ship.fuel=120;
    return {structuredContent:{cost:12,market_cost:8,tax:4}};
  },{minFuel:120,maxServiceSpend:12,serviceQuotes:{refuel:9,repair:3}},true),/spending breached/);
  assert.deepEqual(actions,['spacemolt/refuel']);
});
