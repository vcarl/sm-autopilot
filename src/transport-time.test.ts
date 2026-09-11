import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTransportTime} from './transport-time.ts';

test('observed movement overrun preserves the original elapsed allocation across continuation',()=>{
  const initial=checkTransportTime(100,5,undefined,true);
  assert.equal(initial.status,'ready');
  const resumed=checkTransportTime(107,20,initial.budget,false);
  assert.equal(resumed.status,'blocked');assert.equal(resumed.start_tick,100);
  assert.equal(resumed.elapsed_ticks,7);assert.equal(resumed.max_ticks,5);assert.equal(resumed.overrun_ticks,2);
  const tighter=checkTransportTime(103,2,initial.budget,false);
  assert.equal(tighter.status,'blocked');assert.equal(tighter.budget!.max_ticks,5);
});

test('unknown, regressed and legacy tick evidence cannot create a fresh transport allowance',()=>{
  const started=checkTransportTime(100,5,undefined,true);
  const observed=checkTransportTime(103,5,started.budget,false);
  for(const current of [undefined,0,NaN,Infinity,102]) {
    const result=checkTransportTime(current,5,observed.budget,false);
    assert.equal(result.status,'blocked');assert.deepEqual(result.budget,observed.budget);
  }
  assert.equal(checkTransportTime(200,20,undefined,false).status,'blocked');
  assert.equal(checkTransportTime(200,20,undefined,false).budget,undefined);
});
