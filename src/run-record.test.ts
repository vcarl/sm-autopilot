import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bootJournal,closeInterrupted,readJournal,readRun,writeRun} from './run-record.ts';
import {renderLine} from './journal-lines.ts';

const temp=()=>mkdtempSync(join(tmpdir(),'spacemolt-rotate-'));
const rows=(n:number,from=0)=>Array.from({length:n},(_,i)=>JSON.stringify({event:'x',n:from+i})).join('\n')+'\n';

test('boot rotates a non-empty journal and opens the fresh one with a boot line naming it',()=>{
  const runtime=temp();
  try {
    writeFileSync(join(runtime,'gameplay.jsonl'),rows(3));
    bootJournal(runtime,new Date('2026-09-28T04:53:54.321Z'));
    const rotated='gameplay.2026-09-28T04-53-54Z.jsonl';
    assert.ok(readdirSync(runtime).includes(rotated));
    assert.equal(readFileSync(join(runtime,rotated),'utf8'),rows(3));
    const fresh=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
    assert.equal(fresh.length,1);
    assert.equal(fresh[0].event,'boot');
    assert.equal(fresh[0].rotated_from,rotated);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('boot with an empty or missing journal rotates nothing',()=>{
  const runtime=temp();
  try {
    bootJournal(runtime);
    writeFileSync(join(runtime,'gameplay.jsonl'),'');
    bootJournal(runtime);
    assert.deepEqual(readdirSync(runtime).filter(f=>f.startsWith('gameplay')),['gameplay.jsonl']);
    assert.equal(readJournal(runtime).filter(e=>e.event==='boot').every(e=>e.rotated_from===undefined),true);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a tail read walks back into rotated journals when the current one is short',()=>{
  const runtime=temp();
  try {
    writeFileSync(join(runtime,'gameplay.2026-09-27T00-00-00Z.jsonl'),rows(5,0));
    writeFileSync(join(runtime,'gameplay.2026-09-28T00-00-00Z.jsonl'),rows(5,5));
    writeFileSync(join(runtime,'gameplay.jsonl'),rows(2,10));
    assert.deepEqual(readJournal(runtime,8).map(e=>e.n),[4,5,6,7,8,9,10,11]);
    assert.deepEqual(readJournal(runtime,2).map(e=>e.n),[10,11]);
    assert.equal(readJournal(runtime,100).length,12);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a corrupt, partial or absent run.json reads as no run',()=>{
  const runtime=temp();
  try {
    assert.equal(readRun(runtime),null);
    for(const body of ['{"script":"index.ts"','{"script":"index.ts","ended":false}','{"started":"t","ended":false}','[]','null'])
      {writeFileSync(join(runtime,'run.json'),body);assert.equal(readRun(runtime),null,body);}
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('an interrupted run closes with every key it was written with intact',()=>{
  const runtime=temp();
  try {
    const record={script:'index.ts',source:'abc',params:{poi:'belt'},started:'2026-10-02T00:00:00Z',juncture_at:'2026-10-01T23:59:00Z',
      last_job:'goTo',last_step:'jump',ended:false,question:{question:'which?',choices:['a','b'],asked_at:'2026-10-02T00:00:01Z'}};
    writeRun(runtime,record);
    assert.deepEqual(readRun(runtime),record);
    const closed=closeInterrupted(runtime);
    const {ended:_e,outcome,...rest}=closed??{};
    const {ended:_k,...kept}=record;
    assert.deepEqual(rest,kept);
    assert.equal(outcome?.status,'interrupted');
    assert.equal(readRun(runtime)?.ended,true);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a journal read skips a garbage line and still renders one with no event',()=>{
  const runtime=temp();
  try {
    writeFileSync(join(runtime,'gameplay.jsonl'),[
      JSON.stringify({at:'2026-10-02T12:00:00Z',event:'rest'}),'{torn','[1]','7',
      JSON.stringify({at:'2026-10-02T12:01:00Z',request:{action:'dock'},response:{ok:false,error:'no'}}),''].join('\n'));
    const read=readJournal(runtime);
    assert.equal(read.length,2);
    assert.equal(read[0]?.event,'rest');
    assert.match(renderLine(read[1])??'',/! dock: no/);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});
