/** The drain: when it fires, what it carries, and what it does when the post does not land.
 *
 * Nothing here reaches the network — `post` and `rng` are injected, and the timer is a fake
 * that records the delay it was armed with instead of waiting it out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {BUDGET,MAX_MS,MIN_MS,journalDrain,nextDelayMs,type PostResult} from './journal-webhook.ts';

/** A clock that never ticks: the drain arms it, the test reads the delay and fires by hand. */
function clock() {
  const delays:number[]=[];
  let due:(()=>void)|null=null;
  return {delays,
    schedule:(fn:()=>void,ms:number)=>{delays.push(ms);due=fn;return {unref(){}};},
    fire:()=>{const run=due;due=null;run?.();}};
}

function drainFixture(replies:PostResult[]=[],rolls=[0.5]) {
  const posted:string[]=[];
  let roll=0,reply=0;
  const time=clock();
  const drain=journalDrain('https://example.invalid/hook',{
    post:async content=>{posted.push(content);return replies[reply++]??{ok:true};},
    rng:()=>rolls[roll++%rolls.length]!,
    schedule:time.schedule});
  return {drain,posted,...time};
}

test('the next drain is always minutes away, and sooner the fuller the buffer is', () => {
  for(const roll of [0,0.25,0.5,0.75,1])
    for(const chars of [0,100,900,1_800,BUDGET*3]) {
      const delay=nextDelayMs(chars,roll);
      assert.ok(delay>=MIN_MS&&delay<=MAX_MS,`${delay} outside [${MIN_MS},${MAX_MS}]`);
    }
  // Same roll, more buffered: never longer than the emptier buffer would have waited.
  let previous=nextDelayMs(0,1);
  for(const chars of [100,400,900,1_400,1_899,BUDGET,BUDGET*4]) {
    const delay=nextDelayMs(chars,1);
    assert.ok(delay<=previous,`${chars} chars waited ${delay}, longer than ${previous}`);
    previous=delay;
  }
  assert.equal(nextDelayMs(BUDGET,0.9),MIN_MS,'a buffer past one message drains at the minimum');
  assert.equal(nextDelayMs(0,0),MIN_MS,'the roll still bounds the range from below');
});

test('a drain posts as many whole lines as fit and keeps the rest buffered', async () => {
  const f=drainFixture();
  const line=(n:number)=>`18:${String(n).padStart(2,'0')} gather mine ${'x'.repeat(90)}`;
  const lines=Array.from({length:40},(_,index)=>line(index));
  for(const row of lines)f.drain.push(row);
  await f.drain.flush();

  assert.equal(f.posted.length,1,'one message per drain');
  const sent=f.posted[0]!.split('\n');
  assert.ok(f.posted[0]!.length<=BUDGET,`${f.posted[0]!.length} characters is over budget`);
  assert.deepEqual(sent,lines.slice(0,sent.length),'the oldest lines, in order, whole');
  assert.ok(sent.every(row=>lines.includes(row)),'no line was cut in half');
  assert.deepEqual(f.drain.buffered(),lines.slice(sent.length),'the rest waits for the next drain');
  // Still full: the next drain is the soonest one allowed.
  assert.equal(f.drain.nextDelay(),MIN_MS);

  await f.drain.flush();
  assert.equal(f.posted.length,2);
  assert.ok(f.drain.buffered().length<lines.length-sent.length);
});

test('a post that does not land keeps every line for the next attempt', async () => {
  const f=drainFixture([{ok:false}]);
  f.drain.push('18:35 run gather → belt');
  await f.drain.flush();
  assert.equal(f.posted.length,1);
  assert.deepEqual(f.drain.buffered(),['18:35 run gather → belt'],'nothing is dropped on a failure');
  await f.drain.flush();
  assert.equal(f.posted.length,2,'the same line goes again');
  assert.deepEqual(f.drain.buffered(),[],'and clears once it lands');
});

test('a 429 waits exactly as long as Discord asked', async () => {
  const f=drainFixture([{ok:false,retryAfterMs:4_500}]);
  f.drain.push('18:35 rest');
  await f.drain.flush();
  assert.equal(f.drain.nextDelay(),4_500,'the rate limit outranks the random interval');
  assert.deepEqual(f.drain.buffered(),['18:35 rest']);
});

test('the timer is what drains, and an empty buffer posts nothing', async () => {
  const f=drainFixture();
  assert.ok(f.delays.length===1,'a drain arms itself the moment it is made');
  f.fire();
  await f.drain.flush();
  assert.deepEqual(f.posted,[],'an empty buffer is not a message');
  assert.ok(f.delays.length>1,'and it arms again anyway');
});

test('with no webhook set, nothing is started and nothing is posted', async () => {
  const {startJournalDrain,flushJournalDrain,stopJournalDrain}=await import('./journal-webhook.ts');
  const had=process.env.SPACEMOLT_JOURNAL_WEBHOOK;
  delete process.env.SPACEMOLT_JOURNAL_WEBHOOK;
  try {
    assert.equal(startJournalDrain(),null,'no secret, no drain');
    await flushJournalDrain();
  } finally {
    stopJournalDrain();
    if(had!==undefined)process.env.SPACEMOLT_JOURNAL_WEBHOOK=had;
  }
});

test('a started drain renders the journal lines it is handed', async () => {
  const {startJournalDrain,stopJournalDrain}=await import('./journal-webhook.ts');
  const {journalRun}=await import('./run-record.ts');
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const runtime=mkdtempSync(join(tmpdir(),'journal-drain-'));
  const posted:string[]=[];
  process.env.SPACEMOLT_JOURNAL_WEBHOOK='https://example.invalid/hook';
  try {
    const drain=startJournalDrain({post:async content=>{posted.push(content);return {ok:true};},
      rng:()=>0.5,schedule:()=>({unref(){}})})!;
    journalRun(runtime,{job:'gather',step:'mine',outcome:'done',
      yield:[{item_id:'ore',quantity:12}]},'step');
    journalRun(runtime,{tool:'spacemolt',action:'get_system',ok:true,params:{},summary:'normal'},'command');
    assert.equal(drain.buffered().length,1,'the step earns a line; the command it summarises does not');
    await drain.flush();
    assert.match(posted[0]!,/gather mine \+12 ore/);
  } finally {
    stopJournalDrain();
    delete process.env.SPACEMOLT_JOURNAL_WEBHOOK;
    rmSync(runtime,{recursive:true,force:true});
  }
});
