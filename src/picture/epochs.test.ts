/** Epoch rule, merging and level assignment (`epochs.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {Interval} from './activity.ts';
import {assignLevels,makeEpochs} from './epochs.ts';

const base=+new Date('2026-10-16T00:00:00Z');
const at=(min:number)=>new Date(base+min*60_000);
/** Intervals from `[system,startMin,endMin]` triples. */
const ivs=(...rows:[string,number,number][]):Interval[]=>rows.map(([system,s,e])=>({system,start:at(s),end:at(e),focus:true}));
const span=(end:number)=>({start:at(0),end:at(end)});

test('a long stay in a new system opens an epoch once the current one is long enough',()=>{
  // a 0-60, b 60-70 (short), a 70-130, c 130-200; span 200 so the share is 25 min
  const rows=ivs(['a',0,60],['b',60,70],['a',70,130],['c',130,200]);
  const got=makeEpochs(rows,span(200));
  assert.deepEqual(got.map(e=>e.systems),[['a','b'],['c']]);
  assert.deepEqual(got.map(e=>[e.index,e.start,e.end]),[[0,at(0),at(130)],[1,at(130),at(200)]]);
  assert.deepEqual(got.map(e=>[e.levels,e.pitch]),[[{},0],[{},0]]);
  // the same walk over a span of 2000 min: 130 min is under the 250 min share, so c does not open an epoch
  assert.deepEqual(makeEpochs(rows,span(2000)).map(e=>e.systems),[['a','b','c']]);
});
test('adjacent epochs with equal system sets merge',()=>{
  // a 0-60, b 60-70, a 70-75, b 75-115 (long, new system: splits), a 115-120; both halves are {a,b}
  const got=makeEpochs(ivs(['a',0,60],['b',60,70],['a',70,75],['b',75,115],['a',115,120]),span(120));
  assert.equal(got.length,1);
  assert.deepEqual(got[0]!.systems.slice().sort(),['a','b']);
  assert.equal(got[0]!.intervals.length,5);
  assert.deepEqual([got[0]!.start,got[0]!.end],[at(0),at(120)]);
});
test('levels rank by presence and keep previous level for carried systems',()=>{
  // epoch 1: a 60 min, b 20 min. epoch 2: b 70, a 10, c 10; b ranks first but keeps level 1
  const got=assignLevels(makeEpochs(ivs(['a',0,60],['b',60,80],['b',80,150],['a',150,160],['c',160,170]),span(170)),128);
  assert.deepEqual(got.map(e=>e.systems),[['a','b'],['b','a','c']]);
  assert.deepEqual(got[0]!.levels,{a:0,b:1});
  assert.deepEqual(got[1]!.levels,{b:1,a:0,c:2});
});
test('a single-system window yields one epoch, one level, pitch capped',()=>{
  const e=assignLevels(makeEpochs(ivs(['a',0,100]),span(100)),128);
  assert.equal(e.length,1);
  assert.deepEqual(e[0]!.levels,{a:0});
  assert.equal(e[0]!.pitch,17);
  assert.equal(e[0]!.dense,false);
  assert.equal(e[0]!.hue,'#2EC4B6');
});
test('dense flag flips below the pitch threshold',()=>{
  // 32 short stays of 5 min each: one epoch of 32 systems; (128-6)/32 = 3.81 < 9
  const rows=ivs(...Array.from({length:32},(_,i):[string,number,number]=>[`s${i}`,i*5,i*5+5]));
  const e=assignLevels(makeEpochs(rows,span(160)),128);
  assert.equal(e.length,1);
  assert.equal(e[0]!.pitch,(128-6)/32);
  assert.equal(e[0]!.dense,true);
});
