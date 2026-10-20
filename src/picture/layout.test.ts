/** Time axis, label fitting, buckets and sizing (`layout.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {ActivityEvent} from './activity.ts';
import type {Kind} from './constants.ts';
import type {Epoch} from './epochs.ts';
import {buckets,columnHeight,donutRadius,fitLabels,timeAxis} from './layout.ts';

const base=+new Date('2026-10-16T00:00:00Z');
const at=(min:number)=>new Date(base+min*60_000);
const epoch=(index:number,s:number,e:number,over:Partial<Epoch>={}):Epoch=>({index,start:at(s),end:at(e),systems:[],intervals:[],levels:{},pitch:0,dense:false,hue:'#000',focus:true,...over});
const ev=(min:number,kind:Kind,count=1):ActivityEvent=>({at:at(min),system:'a',kind,count});

test('timeAxis gives every epoch a gap and a duration-proportional share',()=>{
  const axis=timeAxis([epoch(0,0,60),epoch(1,60,240)],0,724);
  const [a,b]=axis.spans;
  assert.deepEqual(axis.spans.map(s=>s.epoch),[0,1]);
  assert.deepEqual([a?.gapX,a?.x0,b?.gapX],[0,24,193]);
  assert.ok(Math.abs((a?.x1??0)-(a?.x0??0)-169)<=1);
  assert.ok(Math.abs((b?.x1??0)-(b?.x0??0)-507)<=1);
  assert.equal(b?.x1,724);
  assert.equal(axis.toX(at(0)),a?.x0);
  assert.equal(axis.toX(at(30)),((a?.x0??0)+(a?.x1??0))/2);
  assert.equal(axis.toX(at(240)),724);
  assert.equal(timeAxis([],10,100).toX(at(5)),10);
  // outside or between epochs: nearest edge
  const gapped=timeAxis([epoch(0,10,20),epoch(1,50,60)],0,100);
  const [g,h]=gapped.spans;
  assert.equal(gapped.toX(at(0)),g?.x0);
  assert.equal(gapped.toX(at(30)),g?.x1);
  assert.equal(gapped.toX(at(99)),h?.x1);
});
test('timeAxis keeps a single epoch of no length finite',()=>{
  const axis=timeAxis([epoch(0,10,10)],40,740),[s]=axis.spans;
  assert.deepEqual([s?.gapX,s?.x0,s?.x1],[40,64,64]);
  assert.equal(axis.toX(at(10)),64);
  assert.ok([at(0),at(10),at(99)].every(t=>Number.isFinite(axis.toX(t))));
});
test('fitLabels shows all levels when not dense and skips overlaps when dense',()=>{
  const names=['a','b','c','d'];
  const levels=Object.fromEntries(names.map((s,i)=>[s,i]));
  const flat=fitLabels(epoch(0,0,60,{systems:names,levels,pitch:15}),0,100);
  assert.deepEqual(flat.map(l=>[l.system,l.level,l.y,l.shown,l.font]),names.map((s,i)=>[s,i,94-i*15,true,10]));
  const many=Array.from({length:10},(_,i)=>`s${i}`);
  const dense=fitLabels(epoch(0,0,60,{systems:many,levels:Object.fromEntries(many.map((s,i)=>[s,i])),pitch:3.8,dense:true}),0,100);
  assert.ok(dense.every(l=>l.font===8));
  const shown=dense.filter(l=>l.shown);
  assert.deepEqual(shown.map(l=>l.level),[0,3,6,9]);
  shown.slice(1).forEach((l,i)=>assert.ok((shown[i]?.y??0)-l.y>=8));
});
test('buckets are 20 minutes and sum kinds; the last one takes an event exactly at the end',()=>{
  const got=buckets([ev(25,'fights'),ev(5,'docked',2),ev(10,'docked'),ev(15,'fuel'),ev(60,'traded'),ev(-1,'fights'),ev(61,'fights')],at(0),at(60));
  assert.deepEqual(got.map(b=>[b.t0,b.t1]),[[at(0),at(20)],[at(20),at(40)],[at(40),at(60)]]);
  assert.deepEqual(got[0]?.counts,{fights:0,docked:3,traded:0,fuel:1,creatures:0});
  assert.deepEqual(got[1]?.counts,{fights:1,docked:0,traded:0,fuel:0,creatures:0});
  assert.deepEqual(got[2]?.counts,{fights:0,docked:0,traded:1,fuel:0,creatures:0});
  // a range that is not a whole number of steps ends in a shorter bucket, and one of no length still holds its events
  const odd=buckets([ev(45,'fuel')],at(0),at(45));
  assert.deepEqual(odd.map(b=>[b.t0,b.t1]),[[at(0),at(20)],[at(20),at(40)],[at(40),at(45)]]);
  assert.equal(odd[2]?.counts.fuel,1);
  const point=buckets([ev(5,'fuel'),ev(6,'fuel')],at(5),at(5));
  assert.equal(point.length,1);
  assert.equal(point[0]?.counts.fuel,1);
});
test('donutRadius and columnHeight follow the formulas with floor and cap',()=>{
  assert.equal(donutRadius(0),7);
  assert.equal(donutRadius(10_000),22);
  assert.equal(donutRadius(9),7+1.6*3);
  assert.equal(columnHeight(0,10,36),0);
  assert.equal(columnHeight(10,10,36),36);
  assert.equal(columnHeight(1,4,36),4+32*0.5);
});
