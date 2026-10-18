import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {flushFrames,frameTap,scrubFrame} from './frames.ts';
import {bootJournal} from './run-record.ts';

const temp=()=>mkdtempSync(join(tmpdir(),'spacemolt-frames-'));
const lines=(runtime:string,file='frames.jsonl')=>readFileSync(join(runtime,file),'utf8').trim().split('\n').map(l=>JSON.parse(l));

test('a frame in and a frame out are one line each, in order, with the freighter tag only on a freighter',async()=>{
  const runtime=temp();
  try {
    const pilot=frameTap(runtime),hauler=frameTap(runtime,'hauler-1');
    pilot.onReceive({type:'welcome',payload:{version:'1'}});
    pilot.onSend({tool:'spacemolt',action:'mine',request_id:'r1'});
    hauler.onReceive({type:'tick',payload:{tick:9}});
    await flushFrames();
    const rows=lines(runtime);
    assert.deepEqual(rows.map(r=>r.dir),['in','out','in']);
    assert.deepEqual(rows[1].frame,{tool:'spacemolt',action:'mine',request_id:'r1'});
    assert.match(rows[0].at,/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.deepEqual(Object.keys(rows[0]),['at','dir','frame']);
    assert.equal(rows[0].freighter,undefined);
    assert.equal(rows[2].freighter,'hauler-1');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('every credential field is redacted, in the payload and in structuredContent, and in the text that repeats it',()=>{
  for(const field of ['password','token','registration_code','device_code','session_id','session_key','session_token']) {
    const out=scrubFrame({tool:'spacemolt_auth',action:'login',payload:{username:'u',[field]:'hunter2'},request_id:'r1'}) as any;
    assert.equal(out.payload[field],'[redacted]',field);
    assert.equal(out.payload.username,'u');
    const reply=scrubFrame({type:'result',payload:{result:'Welcome, hunter2!',structuredContent:{[field]:'hunter2',ok:1}}}) as any;
    assert.equal(reply.payload.structuredContent[field],'[redacted]',field);
    assert.equal(reply.payload.structuredContent.ok,1);
    assert.equal(reply.payload.result,'Welcome, [redacted]!');
  }
  const registered=scrubFrame({type:'registered',payload:{player_id:'p',password:'abc'}}) as any;
  assert.deepEqual(registered.payload,{player_id:'p',password:'[redacted]'});
  const logged_in={type:'logged_in',payload:{player:{id:'p'}}};
  assert.equal(scrubFrame(logged_in),logged_in);
});

test('the secret never reaches the file, and the frame handed to the hook is not mutated',async()=>{
  const runtime=temp();
  try {
    const frame={tool:'spacemolt_auth',action:'login',payload:{password:'hunter2'}};
    frameTap(runtime).onSend(frame);
    await flushFrames();
    assert.ok(!readFileSync(join(runtime,'frames.jsonl'),'utf8').includes('hunter2'));
    assert.equal(frame.payload.password,'hunter2');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('boot rotates a non-empty frames.jsonl under the journal\'s stamp and leaves an empty one',()=>{
  const runtime=temp();
  try {
    writeFileSync(join(runtime,'frames.jsonl'),'{"a":1}\n');
    bootJournal(runtime,new Date('2026-09-28T04:53:54.321Z'));
    assert.ok(readdirSync(runtime).includes('frames.2026-09-28T04-53-54Z.jsonl'));
    assert.equal(readFileSync(join(runtime,'frames.2026-09-28T04-53-54Z.jsonl'),'utf8'),'{"a":1}\n');
    assert.ok(!readdirSync(runtime).includes('frames.jsonl'));
    writeFileSync(join(runtime,'frames.jsonl'),'');
    bootJournal(runtime,new Date('2026-09-28T05:00:00Z'));
    assert.ok(!readdirSync(runtime).some(f=>f.startsWith('frames.2026-09-28T05')));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a failing write is journalled once and never throws into the caller; later frames are still tried',async()=>{
  const runtime=temp();
  try {
    mkdirSync(join(runtime,'frames.jsonl')); // appending to a directory fails
    const tap=frameTap(runtime);
    assert.doesNotThrow(()=>tap.onReceive({type:'tick',payload:{}}));
    await flushFrames();
    assert.doesNotThrow(()=>tap.onSend({tool:'t',action:'a'}));
    await flushFrames();
    const failed=lines(runtime,'gameplay.jsonl').filter(l=>l.event==='frames_failed');
    assert.equal(failed.length,1);
    assert.match(failed[0].error,/EISDIR/);
    rmSync(join(runtime,'frames.jsonl'),{recursive:true});
    tap.onSend({tool:'t',action:'b'});
    await flushFrames();
    assert.equal(lines(runtime)[0].frame.action,'b');
    // A second outage is its own journal line.
    rmSync(join(runtime,'frames.jsonl'));mkdirSync(join(runtime,'frames.jsonl'));
    tap.onSend({tool:'t',action:'c'});
    await flushFrames();
    assert.equal(lines(runtime,'gameplay.jsonl').filter(l=>l.event==='frames_failed').length,2);
    const circular:any={};circular.self=circular;
    assert.doesNotThrow(()=>tap.onReceive(circular));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('past the queue cap frames are dropped and counted, and one frames_dropped follows the next append',async()=>{
  const runtime=temp();
  try {
    const tap=frameTap(runtime,undefined,600),big={type:'x',payload:{pad:'y'.repeat(300)}};
    tap.onReceive(big);tap.onReceive(big);tap.onReceive(big);
    await flushFrames();
    assert.equal(lines(runtime).length,1);
    assert.deepEqual(lines(runtime,'gameplay.jsonl').filter(l=>l.event==='frames_dropped').map(l=>l.count),[2]);
    tap.onReceive(big); // room again once the batch has landed
    await flushFrames();
    assert.equal(lines(runtime).length,2);
    assert.equal(lines(runtime,'gameplay.jsonl').filter(l=>l.event==='frames_dropped').length,1);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a secret nested anywhere in a frame is redacted, including an error that echoes one, without mutating the frame',()=>{
  const frame={type:'error',payload:{code:'bad',message:'login failed for code abcd-1234',
    details:{attempts:[{user_code:'abcd-1234',verification_uri_complete:'https://x/y?c=abcd-1234'}],note:'ok'}}};
  const out=scrubFrame(frame) as any;
  assert.equal(out.payload.details.attempts[0].user_code,'[redacted]');
  assert.equal(out.payload.details.attempts[0].verification_uri_complete,'[redacted]');
  assert.equal(out.payload.message,'login failed for code [redacted]');
  assert.equal(out.payload.details.note,'ok');
  assert.equal(frame.payload.details.attempts[0]!.user_code,'abcd-1234');
  assert.equal(frame.payload.message,'login failed for code abcd-1234');
  const deep=scrubFrame({type:'x',payload:{a:[{b:{token:'tok-12345'}}]}}) as any;
  assert.equal(deep.payload.a[0].b.token,'[redacted]');
});
