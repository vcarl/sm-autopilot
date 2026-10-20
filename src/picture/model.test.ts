/** Composing the window, epochs, geometry and layout into one model (`model.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalRun} from '../run-record.ts';
import type {Galaxy} from './galaxy.ts';
import {buildModel} from './model.ts';

const runtime=()=>{const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-model-')),'runtime');mkdirSync(dir,{recursive:true});return dir;};
const at=(h:number,m=0)=>`2026-10-16T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`;
const sys=(id:string,x:number,y:number,connections:string[])=>[id,{id,name:id.toUpperCase(),x,y,connections}] as const;
const galaxy:Galaxy={fetched_at:'',systems:Object.fromEntries([sys('a',0,0,['b']),sys('b',100,0,['a','c']),sys('c',100,50,['b'])])};

test('buildModel composes a model from a small synthetic runtime',async()=>{
  const dir=runtime();
  try{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(8),started:at(8),start_state:{system:'a'}},'run');
    journalRun(dir,{run_id:'r1',at:at(8,10),tool:'spacemolt',action:'jump',params:{id:'b'},ok:true,summary:'x'},'command');
    journalRun(dir,{phase:'ended',run_id:'r1',started:at(8),at:at(9),outcome:'done',end_state:{system:'b'}},'run');
    journalRun(dir,{phase:'started',run_id:'r2',at:at(10),started:at(10),start_state:{system:'b'}},'run');
    journalRun(dir,{phase:'ended',run_id:'r2',started:at(10),at:at(11,30),outcome:'done',end_state:{system:'b'}},'run');
    const m=await buildModel(dir,{galaxy});
    assert.ok(m.epochs.length>=1);
    assert.deepEqual(Object.keys(m.placed).sort(),['a','b','c']);
    assert.deepEqual(m.neighbours,['c']);
    assert.deepEqual(m.unknownSystems,[]);
    assert.deepEqual(Object.keys(m.badgeHue).sort(),['a','b']);
    assert.equal(m.badgeHue.b,m.epochs[0]?.hue);
    assert.ok(m.title.includes('last 2 runs'));
    assert.equal(m.title,'Pilot · last 2 runs · 16 Oct 08:00–11:30Z');
    assert.equal(m.labels.length,m.epochs.length);
    assert.equal(m.axis.spans.length,m.epochs.length);
    assert.deepEqual(m.rects.lane,{x:40,y:421,w:740,h:128});
    assert.ok(m.buckets.length>0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('buildModel shrinks the fit for unknown systems and words a span across days',async()=>{
  const dir=runtime();
  try{
    journalRun(dir,{phase:'started',run_id:'r1',at:at(23),started:at(23),start_state:{system:'a'}},'run');
    journalRun(dir,{run_id:'r1',at:'2026-10-17T00:28:00.000Z',tool:'spacemolt',action:'jump',params:{id:'zz'},ok:true,summary:'x'},'command');
    const m=await buildModel(dir,{galaxy,runs:3,pilot:'Kvothe'});
    assert.deepEqual(m.unknownSystems,['zz']);
    const known=Object.values(m.placed).filter(p=>p.known);
    assert.ok(known.length>0);
    assert.ok(known.every(p=>(m.placed.zz?.y??0)>p.y)); // the unknown row sits below every known node
    assert.equal(m.title,'Kvothe · last 1 runs · 16 Oct 23:00–17 Oct 00:28Z'); // the runs found, not the 3 asked for
  }finally{rmSync(dir,{recursive:true,force:true});}
});
