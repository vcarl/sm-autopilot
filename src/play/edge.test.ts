import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import {Effect} from 'effect';
import {replyLost} from '../command-boundary.ts';
import type {ReadinessAccount} from '../readiness.ts';
import {readJournal} from '../run-record.ts';
import {FakeLibGoalAccount} from '../test-support/fake-lib-account.ts';
import {Game} from './game.ts';
import {account,bind,checkStop,edge,job,jobEffect,runCalls,stop,Stopped,unbind} from './runtime.ts';

/** A raw `tool/action` command the way a pilot sends one, through `account().commands`. */
const command=(action:string,params:Record<string,unknown>={}):Promise<unknown>=>{
  const [tool='',name='']=action.split('/');
  return (account().commands as any)[tool][name](params);
};

/** A bound run whose `spacemolt/jump` answers with `outcome`: a reply, or what the server raised.
 * Commands go through the binding's own runtime, so the real classify path runs. */
async function flying<T>(outcome:unknown,fly:(runtime:string)=>Promise<T>):Promise<T> {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-edge-'));
  const game=new FakeLibGoalAccount({player:{credits:0},ship:{fuel:10,hull:10},cargo:[]},{spacemolt:{jump:()=>{
    if(outcome instanceof Error)throw outcome;
    return outcome;
  }}});
  bind({account:game as unknown as Account,command:(action,params)=>{const [tool='',name='']=action.split('/');return game.send(tool,name,params);},
    pilot:()=>({mood:'Focused'}),runtime,emit:()=>{}});
  try {return await fly(runtime);} finally {unbind();rmSync(runtime,{recursive:true,force:true});}
}
const jumpEffect=()=>jobEffect('jump','sol',Effect.gen(function*() {
  yield* (yield* Game).command('spacemolt/jump',{id:'sol'});
  return {status:'done' as const,did:'jumped to sol',detail:{}};
}));
/** A pilot function as every converted one is shaped. */
const jump=()=>edge(jumpEffect());
const defects=(runtime:string)=>readJournal(runtime).filter(row=>row.event==='defect');

test('a reply is done, and the call is recorded',()=>flying({ok:1},async()=>{
  const out=await jump();
  assert.deepEqual({status:out.status,did:out.did,fn:out.fn},{status:'done',did:'jumped to sol',fn:'jump'});
  assert.deepEqual(runCalls().map(call=>call.status),['done']);
}));

test('a code with no tag of its own is refused, its why naming the action and the code',()=>flying(new SpacemoltError('not_in_faction','join a faction first'),async runtime=>{
  const out=await jump();
  assert.equal(out.status,'refused');
  assert.equal(out.why,'spacemolt/jump: not_in_faction — join a faction first');
  assert.deepEqual(defects(runtime),[]);
}));

test('in_battle has its own tag and is refused the same way',()=>flying(new SpacemoltError('in_battle','cannot perform this action while in combat'),async()=>{
  const out=await jump();
  assert.equal(out.status,'refused');
  assert.equal(out.why,'spacemolt/jump: in_battle — cannot perform this action while in combat');
}));

test('a lost reply is failed, saying the state was re-read',()=>flying(new SpacemoltError('mutation_timeout','No action_result'),async runtime=>{
  const out=await jump();
  assert.equal(out.status,'failed');
  assert.equal(out.why,'reply lost on spacemolt/jump; state re-read');
  assert.deepEqual(defects(runtime),[]);
}));

for(const [how,body] of [
  ['failed with',Effect.fail(new Stopped())],
  ['thrown from a checkpoint inside',Effect.sync(()=>{stop();checkStop();return {status:'done' as const,did:'not reached',detail:{}};})],
] as const)
  test(`the stop ${how} the body is partial, not a defect`,()=>flying({ok:1},async runtime=>{
    const out=await edge(jobEffect('jump','sol',body));
    assert.equal(out.status,'partial');
    assert.match(out.did,/^jump stopped by the pilot/);
    assert.deepEqual(defects(runtime),[]);
  }));

test('a defect in the body is failed, and its stack goes to a defect line',()=>flying(new TypeError('a bug'),async runtime=>{
  const out=await jump();
  assert.equal(out.status,'failed');
  assert.equal(out.why,'a bug');
  const [line]=defects(runtime);
  assert.equal(line?.fn,'jump');
  assert.match(String(line?.stack),/TypeError: a bug/);
}));

test('a defect outside any job is a failed Outcome and a defect line too',()=>flying({ok:1},async runtime=>{
  const out=await edge(Effect.die(new RangeError('outside')));
  assert.deepEqual({status:out.status,why:out.why},{status:'failed',why:'outside'});
  assert.match(String(defects(runtime)[0]?.stack),/RangeError: outside/);
}));

test("a pilot function's Promise never rejects, whatever the world does",async()=>{
  for(const outcome of [{ok:1},new SpacemoltError('in_battle','in combat'),new SpacemoltError('nope','no'),
    new ConnectionClosedError(),new TypeError('a bug')])
    await flying(outcome,async()=>{await assert.doesNotReject(jump());});
});

test('the Promise job folds a refusal the server raised the same way: refused, not failed',()=>flying(new SpacemoltError('in_battle','in combat'),async()=>{
  const out=await job('jump','sol',async()=>{await command('spacemolt/jump',{id:'sol'});return {status:'done',did:'jumped',detail:{}};});
  assert.deepEqual({status:out.status,why:out.why},{status:'refused',why:'jump: in_battle — in combat'});
}));

// A raw command a pilot sends itself (`account().commands`) branches on the lib's own error, so it
// must come out as the very object.
for(const error of [new SpacemoltError('in_battle','in combat'),new SpacemoltError('not_in_faction','join a faction first'),
  new SpacemoltError('mutation_timeout','No action_result'),new ConnectionClosedError(),new TypeError('a bug')])
  test(`a raw command rejects with the very error the lib threw: ${error.constructor.name} ${error.message}`,()=>flying(error,async()=>{
    await assert.rejects(command('spacemolt/jump',{id:'sol'}),thrown=>thrown===error);
  }));

test('a mutation whose reply was lost rejects with the lib error that says to re-observe, and is not sent twice',async()=>{
  let sends=0;
  const game=new FakeLibGoalAccount({},{spacemolt:{sell:()=>{sends++;throw new ConnectionClosedError();}}});
  const account=Object.assign(game,{onReconnected:(fn:()=>void)=>{setTimeout(fn,0);return ()=>{};}});
  bind({account:account as unknown as Account,command:(action,params)=>{const [tool='',name='']=action.split('/');return game.send(tool,name,params);},pilot:()=>({mood:'Focused'}),emit:()=>{}});
  try {
    await assert.rejects(command('spacemolt/sell',{id:'ore'}),error=>error instanceof SpacemoltError&&replyLost(error)
      &&error.code==='connection_closed'&&error.message==='spacemolt/sell: outcome unknown, re-observe');
    assert.equal(sends,1);
  } finally {unbind();}
});
