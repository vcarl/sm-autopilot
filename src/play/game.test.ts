import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Cause,Effect,Exit} from 'effect';
import {FakeLibGoalAccount} from '../test-support/fake-lib-account.ts';
import {journalCommand,readJournal} from '../run-record.ts';
import {Game,GameLive,type Seam} from './game.ts';

/** The bridge's command seam over the fake account, as `bind()` lends it. */
const wired=(fake:FakeLibGoalAccount<object>)=>(action:string,params:Record<string,unknown>)=>{
  const [tool='',name='']=action.split('/');
  return fake.send(tool,name,params);
};
/** A world whose `spacemolt/jump` answers with `outcome`: a reply, or the error the server raised. */
const world=(outcome:unknown,seam:Partial<Seam>={})=>GameLive({
  send:wired(new FakeLibGoalAccount({},{spacemolt:{jump:()=>{
    if(outcome instanceof Error)throw outcome;
    return outcome;
  }}})),...seam});
const jump=Effect.gen(function*(){return yield* (yield* Game).command('spacemolt/jump',{id:'sol'});});
const failure=(outcome:unknown)=>Effect.runPromise(Effect.flip(jump).pipe(Effect.provide(world(outcome))));
const refused=(code:string)=>failure(new SpacemoltError(code,`${code} said`));

test('a reply comes back as it was sent',async()=>{
  assert.deepEqual(await Effect.runPromise(jump.pipe(Effect.provide(world({ok:1})))),{ok:1});
});

for(const [code,tag] of [['in_battle','InBattle'],['cargo_full','HoldFull'],['depleted','Depleted']] as const)
  test(`${code} is ${tag}, carrying the action, the raw code and the message`,async()=>{
    const error=await refused(code);
    assert.equal(error._tag,tag);
    assert.deepEqual({action:error.action,code:error.code,message:error.message},{action:'spacemolt/jump',code,message:`${code} said`});
    assert.ok(error.cause instanceof SpacemoltError&&error.cause.code===code,'the lib\'s own error stays as the cause');
  });

test('a code with no tag of its own is Rejected with the raw code',async()=>{
  const error=await refused('not_in_faction');
  assert.equal(error._tag,'Rejected');
  assert.ok(error._tag==='Rejected');
  assert.equal(error.code,'not_in_faction');
});

for(const [why,error] of [
  ['an uncertain code',new SpacemoltError('mutation_timeout','No action_result')],
  ['a pending command',new SpacemoltError('action_queued','queued',{pendingCommand:'jump'})],
  ['a closed connection',new ConnectionClosedError()],
] as const)
  test(`${why} is ReplyLost, keeping the cause`,async()=>{
    const lost=await failure(error);
    assert.equal(lost._tag,'ReplyLost');
    assert.ok(lost._tag==='ReplyLost');
    assert.equal(lost.cause,error);
  });

test('an error that is not the game speaking is a defect, not a refusal',async()=>{
  const exit=await Effect.runPromiseExit(jump.pipe(Effect.provide(world(new TypeError('a bug')))));
  assert.ok(Exit.isFailure(exit)&&Cause.hasDies(exit.cause)&&!Cause.hasFails(exit.cause));
});

test('a failed command line says lost exactly when the reply is lost, and keeps its code',()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-game-'));
  journalCommand(runtime,'spacemolt/jump',{id:'sol'},false,new ConnectionClosedError('WebSocket connection closed',1006));
  journalCommand(runtime,'spacemolt/jump',{id:'sol'},false,new SpacemoltError('mutation_timeout','No action_result'));
  journalCommand(runtime,'spacemolt/jump',{id:'sol'},false,new SpacemoltError('in_battle','in combat'));
  journalCommand(runtime,'spacemolt/jump',{id:'sol'},true,{});
  const lines=readJournal(runtime).filter(row=>row.event==='command').map(row=>({code:row.code,lost:row.lost}));
  assert.deepEqual(lines,[{code:1006,lost:true},{code:'mutation_timeout',lost:true},{code:'in_battle',lost:undefined},{code:undefined,lost:undefined}]);
});

// ---- the command path: what the layer does when the connection drops ----

/** A connection that fails its first send with `error`, then answers; the seam's own calls are counted. */
const dropping=(error:Error,seam:Partial<Seam>={})=>{
  const said:string[]=[];
  const calls={sends:0,refreshes:0,afters:0};
  const layer=GameLive({send:async(action,params)=>{if(++calls.sends===1)throw error;return {sent:action,params};},
    refresh:async()=>{calls.refreshes++;},say:text=>said.push(text),after:()=>Effect.sync(()=>{calls.afters++;}),...seam});
  return {layer,said,calls};
};
const issue=(action:string)=>Effect.gen(function*(){return yield* (yield* Game).command(action,{});});
const closed=()=>new ConnectionClosedError('WebSocket connection closed',1006);

test('a dropped read is waited out, the world re-read, and the read re-issued once',async()=>{
  const world=dropping(closed(),{reconnected:async()=>true});
  assert.deepEqual(await Effect.runPromise(issue('spacemolt/get_base').pipe(Effect.provide(world.layer))),{sent:'spacemolt/get_base',params:{}});
  assert.deepEqual(world.calls,{sends:2,refreshes:1,afters:1});
  assert.deepEqual(world.said,['  spacemolt/get_base: WebSocket connection closed; waiting for the connection',
    '  spacemolt/get_base: reconnected; re-issued once']);
});

test('a dropped mutation is never re-sent: it is a lost reply that says to re-observe',async()=>{
  const world=dropping(closed(),{reconnected:async()=>true});
  const lost=await Effect.runPromise(Effect.flip(issue('spacemolt/sell')).pipe(Effect.provide(world.layer)));
  assert.ok(lost._tag==='ReplyLost');
  assert.ok(lost.cause instanceof SpacemoltError);
  assert.deepEqual({code:lost.cause.code,message:lost.cause.message},{code:'connection_closed',message:'spacemolt/sell: outcome unknown, re-observe'});
  assert.deepEqual(world.calls,{sends:1,refreshes:1,afters:1});
  assert.ok(world.said.includes('  spacemolt/sell: reconnected, but the command may have landed; not re-sent'));
});

test('a drop no reconnect follows stands as the lost reply, keeping the very error the lib threw',async()=>{
  const error=closed(),world=dropping(error);
  const lost=await Effect.runPromise(Effect.flip(issue('spacemolt/get_base')).pipe(Effect.provide(world.layer)));
  assert.ok(lost._tag==='ReplyLost');
  assert.equal(lost.cause,error);
  assert.deepEqual(world.calls,{sends:1,refreshes:1,afters:1});
});

test('a forced reconnect that fails is said, and the drop stands; one that works re-issues the read',async()=>{
  const error=closed(),failing=dropping(error,{reconnected:async()=>false,reconnect:async()=>{throw new Error('socket gone');}});
  const lost=await Effect.runPromise(Effect.flip(issue('spacemolt/get_base')).pipe(Effect.provide(failing.layer)));
  assert.ok(lost._tag==='ReplyLost'&&lost.cause===error);
  assert.deepEqual(failing.said.slice(1),['  spacemolt/get_base: no reconnect in 60s; forcing one','  spacemolt/get_base: the forced reconnect failed (socket gone)']);
  const working=dropping(closed(),{reconnected:async()=>false,reconnect:async()=>{}});
  await Effect.runPromise(issue('spacemolt/get_base').pipe(Effect.provide(working.layer)));
  assert.equal(working.calls.sends,2);
});

test('a re-read that fails does not fail the command',async()=>{
  const world=dropping(closed(),{reconnected:async()=>true,refresh:async()=>{throw new Error('read failed too');}});
  assert.deepEqual(await Effect.runPromise(issue('spacemolt/get_base').pipe(Effect.provide(world.layer))),{sent:'spacemolt/get_base',params:{}});
});

test('a refusal is not waited out or re-sent, and what comes after still runs',async()=>{
  const refusal=new SpacemoltError('in_battle','cannot perform this action while in combat'),world=dropping(refusal,{reconnected:async()=>true});
  const error=await Effect.runPromise(Effect.flip(issue('spacemolt/get_base')).pipe(Effect.provide(world.layer)));
  assert.ok(error._tag==='InBattle');
  assert.equal(error.cause,refusal);
  assert.deepEqual(world.calls,{sends:1,refreshes:0,afters:1});
});

test('a second failure after the re-issue is classified, not waited out again',async()=>{
  const refusal=new SpacemoltError('in_battle','in combat');
  let sends=0;
  const layer=GameLive({send:async()=>{if(++sends===1)throw closed();throw refusal;},reconnected:async()=>true});
  const error=await Effect.runPromise(Effect.flip(issue('spacemolt/get_base')).pipe(Effect.provide(layer)));
  assert.ok(error._tag==='InBattle'&&error.cause===refusal);
  assert.equal(sends,2);
});

test('a throw that is not the game speaking is a defect holding the very thrown value',async()=>{
  const bug=new TypeError('a bug');
  const exit=await Effect.runPromiseExit(issue('spacemolt/jump').pipe(Effect.provide(dropping(bug).layer)));
  assert.ok(Exit.isFailure(exit)&&Cause.squash(exit.cause)===bug);
});

test('the re-read a caller asks for fails with the raw error, to be said and gone past',async()=>{
  const error=new Error('no read');
  const layer=GameLive({send:async()=>({}),refresh:async()=>{throw error;}});
  const failed=await Effect.runPromise(Effect.flip(Effect.gen(function*(){return yield* (yield* Game).refresh;})).pipe(Effect.provide(layer)));
  assert.ok(failed._tag==='SeamFailed');
  assert.equal(failed.cause,error);
});
