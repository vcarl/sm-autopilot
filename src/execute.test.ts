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
