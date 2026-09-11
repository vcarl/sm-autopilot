import test from 'node:test';
import assert from 'node:assert/strict';
import {sendAndRefresh} from './execute.ts';
import {commandSpend} from './spending.ts';

test('accepted purchase counter evidence survives refresh loss and concurrent income without changing raw receipt',async()=>{
  const raw={delta:{player:{stats:{credits_spent:37559}},details:{total_cost:3819}}};
  const account={state:{player:{credits:198487,stats:{credits_spent:33721}}},
    async send(){this.state.player.credits+=10000-3838;this.state.player.stats.credits_spent=37559;return raw;},
    async refresh(){throw new Error('refresh lost');}};
  let accepted:any;
  await assert.rejects(()=>sendAndRefresh(account,'spacemolt/buy',{id:'life_support_unit',quantity:2},reply=>{accepted=reply;}),/refresh lost/);
  assert.equal(commandSpend('spacemolt/buy',accepted),3838);
  assert.equal(commandSpend('spacemolt/buy',accepted.delta.details),3838);
  assert.equal(accepted.delta.details.total_cost,3819);
  assert.deepEqual(raw.delta.details,{total_cost:3819});
  assert.equal(account.state.player.credits,204649);
});

test('craft missing escrow prices use refreshed actual debit evidence and preserve accepted evidence on refresh failure',async()=>{
  for(const [before,after,fail,expected] of [[100,100,false,0],[100,107,false,7],[100,99,false,null],[undefined,100,false,null],[100,undefined,false,null],[100,100,true,null]] as const) {
    const raw={delta:{details:{kind:'job',job_id:'craft-job',escrowed:{inputs:[{item_id:'metal',quantity:2}]}}}};
    const account={state:{player:{credits:1000,stats:{credits_spent:before as number|undefined}}},
      async send(){this.state.player.credits+=100;return raw;},
      async refresh(){if(fail)throw new Error('refresh lost');this.state.player.stats.credits_spent=after;}};
    const accepted:any[]=[];
    const promise=sendAndRefresh(account,'spacemolt/craft',{id:'cabin'},reply=>accepted.push(reply));
    if(fail)await assert.rejects(()=>promise,/refresh lost/);else await promise;
    assert.equal(commandSpend('spacemolt/craft',accepted.at(-1),{id:'cabin'}),expected);
    assert.equal(accepted[0].delta.details._hermes_spending.before,before);
    assert.equal(accepted[0].delta.details._hermes_spending.phase,'accepted');
    assert.equal(commandSpend('spacemolt/craft',accepted[0],{id:'cabin'}),null);
    assert.equal(accepted.length,fail?1:2);
    assert.deepEqual(raw.delta.details.escrowed,{inputs:[{item_id:'metal',quantity:2}]});
  }
});
