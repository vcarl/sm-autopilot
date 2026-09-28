import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bootJournal,readJournal} from './run-record.ts';

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
