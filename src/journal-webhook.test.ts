/** The drain: when it fires, what it carries, and what it does when the post does not land.
 *
 * Nothing here reaches the network — `post` and `rng` are injected, and the timer is a fake
 * that records the delay it was armed with instead of waiting it out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {BUDGET,GAP_MS,MAX_MS,MIN_MS,journalDrain,nextDelayMs,type PostResult} from './journal-webhook.ts';

/** A clock that never ticks: the drain arms it, the test reads the delay and fires by hand. */
function clock() {
  const delays:number[]=[];
  let due:(()=>void)|null=null;
  return {delays,
    schedule:(fn:()=>void,ms:number)=>{delays.push(ms);due=fn;return {unref(){}};},
    fire:()=>{const run=due;due=null;run?.();}};
}

function drainFixture(replies:PostResult[]=[],rolls=[0.5]) {
  const posted:string[]=[],slept:number[]=[];
  let roll=0,reply=0;
  const time=clock();
  const drain=journalDrain('https://example.invalid/hook',{
    post:async content=>{posted.push(content);return replies[reply++]??{ok:true};},
    rng:()=>rolls[roll++%rolls.length]!,
    schedule:time.schedule,
    // The burst's pauses are recorded, never waited out.
    sleep:async ms=>{slept.push(ms);}});
  return {drain,posted,slept,...time};
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

test('one drain empties the backlog, whole lines, one message at a time', async () => {
  const f=drainFixture();
  const line=(n:number)=>`18:${String(n).padStart(2,'0')} gather mine ${'x'.repeat(90)}`;
  // ~4,600 characters: more than two messages' worth, so the tick must post three times.
  const lines=Array.from({length:40},(_,index)=>line(index));
  for(const row of lines)f.drain.push(row);
  await f.drain.flush();

  assert.equal(f.posted.length,3,'the whole backlog went out in one tick');
  for(const message of f.posted)
    assert.ok(message.length<=BUDGET,`${message.length} characters is over budget`);
  assert.deepEqual(f.posted.join('\n').split('\n'),lines,'every line, in order, whole');
  assert.deepEqual(f.drain.buffered(),[],'nothing is left behind');
  assert.deepEqual(f.slept,[GAP_MS,GAP_MS],'a gap between messages, none after the last');
  // Empty now, so the next drain is free to be a lazy one.
  assert.ok(f.drain.nextDelay()>MIN_MS);
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

test('a 429 waits exactly as long as Discord asked, then carries on', async () => {
  const f=drainFixture([{ok:false,retryAfterMs:4_500}]);
  f.drain.push('18:35 rest');
  await f.drain.flush();
  assert.deepEqual(f.slept,[4_500],'the drain waited out the rate limit inside the tick');
  assert.equal(f.posted.length,2,'and sent the same line again');
  assert.deepEqual(f.drain.buffered(),[],'so the tick still ends empty');
});

test('a 429 that never lets up gives the lines back to the next tick', async () => {
  const f=drainFixture(Array.from({length:20},()=>({ok:false,retryAfterMs:9_000})));
  f.drain.push('18:35 rest');
  await f.drain.flush();
  assert.ok(f.slept.length<5,`${f.slept.length} retries is not a bounded tick`);
  assert.deepEqual(f.drain.buffered(),['18:35 rest'],'nothing is dropped');
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
