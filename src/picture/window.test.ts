/** The window: the last N runs from the journal (`window.ts`). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalRun} from '../run-record.ts';
import {CONTEXT_MS,CONTEXT_RUNS,readWindow} from './window.ts';
import {FLIGHT_JUNCTURE,FLIGHT_RUN,flightRuntime} from '../test-support/flight-runtime.ts';

const runtime=()=>{const dir=join(mkdtempSync(join(tmpdir(),'spacemolt-window-')),'runtime');mkdirSync(dir,{recursive:true});return dir;};

test('readWindow keeps the newest N runs and their lines',()=>{
  const dir=runtime();
  try{
    for(const i of [1,2,3]){
      journalRun(dir,{phase:'started',run_id:`r${i}`,started:`2026-10-16T0${i}:00:00.000Z`,start_state:{system:'a'}},'run');
      journalRun(dir,{run_id:`r${i}`,tool:'spacemolt',action:'jump',params:{id:'b'},ok:true,summary:'x'},'command');
      journalRun(dir,{phase:'ended',run_id:`r${i}`,started:`2026-10-16T0${i}:00:00.000Z`,outcome:'done',end_state:{system:'b'}},'run');
    }
    const w=readWindow(dir,2);
    assert.deepEqual(w.runs.map(r=>r.run_id),['r2','r3']);
    assert.equal(w.lines.filter(l=>l.event==='command').length,2);
    assert.equal(w.start.toISOString(),'2026-10-16T02:00:00.000Z');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('readWindow on an empty directory is empty, not an error',()=>{
  const dir=runtime();
  try{const w=readWindow(dir);assert.deepEqual(w.runs,[]);assert.deepEqual(w.lines,[]);}
  finally{rmSync(dir,{recursive:true,force:true});}
});
test('readWindow reads further back until it has N runs',()=>{
  const dir=runtime();
  try{
    for(const i of [1,2]){
      journalRun(dir,{phase:'started',run_id:`r${i}`,started:`2026-10-16T0${i}:00:00.000Z`},'run');
      for(let n=0;n<2500;n++)journalRun(dir,{run_id:`r${i}`,tool:'spacemolt',action:'mine',ok:true,summary:'x'},'command');
    }
    const w=readWindow(dir,2);
    assert.deepEqual(w.runs.map(r=>r.run_id),['r1','r2']);
    assert.equal(w.lines.filter(l=>l.event==='command').length,5000);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

// Spec "Per-juncture selection" (built 2026-10-19): the juncture's runs in focus, the runs before it as muted context.
test('readWindow {juncture}: the juncture\'s runs in focus, the runs before them as context; a run id stands in; none is empty',()=>{
  const dir=flightRuntime();
  const w=readWindow(dir,{juncture:FLIGHT_JUNCTURE.slice(0,8)});
  assert.deepEqual(w.runs.map(r=>[r.run_id.slice(0,8),r.focus]),[['c0000000',false],['c0000000',false],['f1a9c0de',true]]);
  assert.equal(w.focusStart.toISOString(),'2026-10-19T08:45:00.000Z');assert.equal(w.start.toISOString(),'2026-10-19T08:00:00.000Z');
  assert.equal(w.end.toISOString(),'2026-10-19T10:10:00.000Z');
  assert.ok(w.lines.some(l=>l.run_id==='c0000000-0000-4000-8000-000000000001'));
  assert.deepEqual(readWindow(dir,{juncture:FLIGHT_RUN.slice(0,8)}).runs.map(r=>r.focus),[false,false,true]);
  assert.deepEqual(readWindow(dir,{juncture:'ffffffff'}).runs,[]);
  assert.ok(readWindow(dir,3).runs.every(r=>r.focus)); // the last N runs are all in focus
});

test('readWindow {juncture}: the context is at most ten runs and six hours before the focus',()=>{
  const dir=runtime(),at=(h:number)=>new Date(Date.parse('2026-10-19T00:00:00Z')+h*3600_000).toISOString();
  for(let i=0;i<14;i++)journalRun(dir,{at:at(i*0.25),phase:'started',run_id:`r${i}`,started:at(i*0.25),juncture_id:`j${i}`},'run');
  assert.equal(readWindow(dir,{juncture:'j13'}).runs.filter(r=>!r.focus).length,CONTEXT_RUNS);
  const far=runtime();
  for(const [i,h] of [[0,0],[1,1],[2,8]] as const)journalRun(far,{at:at(h),phase:'started',run_id:`r${i}`,started:at(h),juncture_id:`j${i}`},'run');
  assert.deepEqual(readWindow(far,{juncture:'j2'}).runs.map(r=>r.run_id),['r2']); // seven hours back is past the six
  assert.equal(CONTEXT_MS,6*3600_000);
});
