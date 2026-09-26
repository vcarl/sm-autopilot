/** `ask()`: a program hands a question back to the model that is running it, and resumes with
 * the answer. Driven through `serve` with the real runner and the real gate, so what is pinned
 * is what the tools see: the run answers early with the question, run.json carries it for the
 * juncture gate, and an answer (or a stop) is the only way on. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve,type Pilot} from './bridge.ts';
import type {ReadinessAccount} from './readiness.ts';
import {readRun} from './run-record.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

const PILOT:Pilot={name:'kvothe',stance:'Prospector',mood:'Focused'};

const ASKS="import {ask, note, outcome} from 'play';\n"+
  "export default async function main(){\n"+
  "  const pick=await ask({question:'Which belt?',choices:['north','south'],effort:'high'});\n"+
  "  note(`picked ${pick}`);\n"+
  "  return outcome(`went ${pick}`);\n"+
  "}\n";

function harness(source:string) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-ask-'));
  mkdirSync(join(runtime,'pilot'),{recursive:true});
  writeFileSync(join(runtime,'pilot','index.ts'),source);
  const game=bridgeWorld({services:['refuel','repair']});
  const lines:string[]=[];
  const dispatch=serve(game.account as unknown as ReadinessAccount,game.command,
    {pilot:()=>PILOT,runtime,emit:text=>lines.push(text)});
  /** Which requests took the stream over, in order. */
  const attached:string[]=[];
  const send=(action:string,params:Record<string,unknown>={})=>
    dispatch(action,params,()=>attached.push(action)) as Promise<any>;
  return {runtime,lines,attached,send,close:()=>rmSync(runtime,{recursive:true,force:true})};
}

test('a program that asks pauses: the run answers early with the question, and the answer resumes it to its report',async()=>{
  const f=harness(ASKS);
  try {
    const paused=await f.send('run');
    assert.equal(paused.accepted,true);
    assert.equal(paused.paused,true);
    assert.deepEqual({...paused.question,asked_at:undefined},
      {question:'Which belt?',choices:['north','south'],effort:'high',asked_at:undefined});
    assert.ok(Date.parse(paused.question.asked_at));
    assert.ok(f.lines.some(line=>line.includes('Which belt?')),'the question is streamed and journalled too');
    // Durable for the juncture gate, which cannot ask the bridge anything.
    const record=readRun(f.runtime)!;
    assert.equal(record.ended,false);
    assert.equal((record.question as any).question,'Which belt?');
    assert.equal((record.question as any).effort,'high');

    // The status row: a paused run is still running, and says what it is waiting on.
    const status=await f.send('status');
    assert.equal(status.running,true);
    assert.equal(status.question.question,'Which belt?');
    assert.equal((await f.send('menu')).question.question,'Which belt?');

    const ended=await f.send('answer',{answer:'South'});
    assert.equal(ended.accepted,true);
    assert.equal(ended.paused,undefined);
    assert.equal(ended.status,'done');
    assert.equal(ended.did,'went south','the answer is the choice as written, whatever its case');
    assert.ok(f.lines.includes('picked south'),f.lines.join('\n'));
    const after=readRun(f.runtime)!;
    assert.equal(after.ended,true);
    assert.equal(after.question,undefined,'the question is cleared once answered');
    assert.deepEqual(f.attached,['run','answer'],'each request that waits on the run takes its stream');
  } finally {f.close();}
});

test('an answer that is not one of the choices is refused with the question shown again, and the program waits on',async()=>{
  const f=harness(ASKS);
  try {
    await f.send('run');
    const refused=await f.send('answer',{answer:'west'});
    assert.equal(refused.accepted,false);
    assert.match(refused.reason,/not one of the choices/);
    assert.deepEqual(refused.question.choices,['north','south']);
    assert.deepEqual(f.attached,['run'],'a refused answer never takes the stream');
    assert.equal((await f.send('status')).question.question,'Which belt?','still paused, untouched');
    assert.equal((await f.send('answer',{answer:'north'})).did,'went north');
  } finally {f.close();}
});

test('an answer with no question pending is refused with the run state',async()=>{
  const f=harness(ASKS);
  try {
    const idle=await f.send('answer',{answer:'north'});
    assert.equal(idle.accepted,false);
    assert.match(idle.reason,/no question is pending/);
    assert.equal(idle.running,false);
  } finally {f.close();}
});

test('a run with no source while paused starts nothing and hands the pending question back',async()=>{
  const f=harness(ASKS);
  try {
    const first=await f.send('run');
    const again=await f.send('run');
    assert.equal(again.paused,true);
    assert.equal(again.reattached,true);
    assert.equal(again.question.asked_at,first.question.asked_at,'the same question, not a second run asking it');
    assert.equal(f.lines.filter(line=>line.startsWith('run started')).length,1);
    // After that it behaves like run: the answer blocks to the end.
    assert.equal((await f.send('answer',{answer:'north'})).status,'done');
  } finally {f.close();}
});

test('a stop while paused rejects the ask with the stop error; the run unwinds partial and the question clears',async()=>{
  const f=harness("import {ask, note, outcome} from 'play';\n"+
    "export default async function main(){\n"+
    "  try { await ask({question:'Sell here?'}); }\n"+
    "  catch(error){ note(`ask threw ${(error as Error).message}`); throw error; }\n"+
    "  return outcome('sold');\n"+
    "}\n");
  try {
    await f.send('run');
    assert.equal(readRun(f.runtime)!.question?.question,'Sell here?');
    const stopped=await f.send('stop');
    assert.equal(stopped.stopping,true);
    assert.equal(stopped.withdrawn.question,'Sell here?');
    assert.equal(stopped.status,'partial','a stop is a stop, however the program was waiting');
    assert.ok(f.lines.includes('ask threw stopped by pilot'),f.lines.join('\n'));
    const record=readRun(f.runtime)!;
    assert.equal(record.ended,true);
    assert.equal(record.question,undefined);
    assert.equal((await f.send('status')).running,false);
  } finally {f.close();}
});

test('an ask with empty choices is refused at the call, before anything pauses',async()=>{
  const f=harness("import {ask, outcome} from 'play';\n"+
    "export default async function main(){\n"+
    "  try { await ask({question:'Which?',choices:[]}); } catch(error){ return outcome((error as Error).message,'failed'); }\n"+
    "  return outcome('asked');\n"+
    "}\n");
  try {
    const ended=await f.send('run');
    assert.equal(ended.paused,undefined);
    assert.match(ended.did,/choices/);
  } finally {f.close();}
});
