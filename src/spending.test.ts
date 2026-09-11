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
  assert.equal(commandSpend('spacemolt/buy',{delta:{details:{total_cost:21,tax:3}}}),null);
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

test('purchase subtotals never establish all-in spending without a valid accepted counter interval',()=>{
  const receipt={total_cost:3819};
  for(const [before,after,expected] of [[33721,37559,3838],[33721,37540,3819],[33721,37659,3938],[undefined,37559,null],[33721,undefined,null],[33721,33720,null],[33721,37539,null],[NaN,37559,null],[33721,Infinity,null]]) {
    const result={...receipt,_hermes_spending:{source:'lifetime_credits_spent_interval',before,after,market_subtotal:3819}};
    assert.equal(commandSpend('spacemolt/buy',result),expected);
    const job:any={id:'buy',actions:[{action:'spacemolt/buy',params:{id:'life_support_unit',quantity:2},status:'uncertain',accepted_result:{delta:{details:result}},result:{error:'refresh failed'}}]};
    assert.equal(jobSpending(job).gross_spend,expected);
  }
  for(const invalid of [{source:'wallet_delta'}, {market_subtotal:3818}])
    assert.equal(commandSpend('spacemolt/buy',{...receipt,_hermes_spending:{source:'lifetime_credits_spent_interval',before:33721,after:37559,market_subtotal:3819,...invalid}}),null);
  assert.equal(commandSpend('spacemolt/buy',receipt),null);
});

test('craft reads are free while accepted enqueue escrow remains priced exactly once across recovery',()=>{
  const action='spacemolt/craft',params={id:'metal',quantity:1};
  const receipt={kind:'job',job_id:'craft-job',escrowed:{labor:7,fee:2}};
  assert.equal(commandSpend(action,{kind:'quote',credits_total:9},{...params,dry_run:true}),0);
  assert.equal(commandSpend(action,{kind:'queue',jobs:[]},{}),0);
  assert.equal(commandSpend(action,receipt,params),9);
  const job:any={id:'production',actions:[
    {action,params:{},status:'confirmed',result:{kind:'queue',jobs:[]}},
    {action,params:{...params,dry_run:true},status:'confirmed',result:{kind:'quote',credits_total:9}},
    {action,params,status:'uncertain',accepted_result:receipt,result:{error:'refresh lost'}},
  ]};
  assert.equal(jobSpending(job).gross_spend,9);
  job.actions[2].status='confirmed';job.actions[2].result=receipt;
  assert.equal(jobSpending(job).gross_spend,9);
  for(const escrowed of [{labor:7},{fee:2},{labor:-1,fee:2},{labor:7,fee:NaN}]) {
    job.actions[2].accepted_result={...receipt,escrowed};
    assert.equal(jobSpending(job).gross_spend,null);
    assert.equal(jobSpending(job).unpriced_actions[0]?.action_index,2);
  }
  assert.equal(commandSpend(action,{kind:'quote',credits_total:9},params),null);
});
