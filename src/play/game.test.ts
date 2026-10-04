import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Cause,Effect,Exit} from 'effect';
import {FakeLibGoalAccount} from '../test-support/fake-lib-account.ts';
import {journalCommand,readJournal} from '../run-record.ts';
import {Game,GameLive} from './game.ts';

/** A world whose `spacemolt/jump` answers with `outcome`: a reply, or the error the server raised. */
const world=(outcome:unknown)=>GameLive(new FakeLibGoalAccount({},{spacemolt:{jump:()=>{
  if(outcome instanceof Error)throw outcome;
  return outcome;
}}}));
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
