import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError} from '@spacemolt/lib';
import {Effect} from 'effect';
import {DockBlocked,dockAt,dockAtEffect} from './dock.ts';
import {Rejected,ReplyLost,GameLive} from './play/game.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

type Server={location:{system_id:string;poi_id?:string;docked_at?:string}};
/** A ship at `poi_id` in Sol. `dock` is the server's answer: it may change the world (land) and then throw
 * (a reply lost after it landed), or throw without landing. */
const world=(location:Server['location'],dock:(fake:FakeLibGoalAccount<Server>)=>unknown=()=>{})=>{
  const fake:FakeLibGoalAccount<Server>=new FakeLibGoalAccount<Server>({location},{spacemolt:{dock:()=>dock(fake)}});
  const send=(action:string,params:Record<string,unknown>)=>{const [tool='',name='']=action.split('/');return fake.send(tool,name,params);};
  return {fake,send,docks:()=>fake.calls.filter(c=>c.action==='dock').length};
};
const land=(fake:FakeLibGoalAccount<Server>,at='sol_base')=>{fake.server.location.docked_at=at;};
const station={system_id:'sol',poi_id:'station'};
const twin=(w:ReturnType<typeof world>,base?:string)=>
  Effect.runPromise(Effect.flip(dockAtEffect(w.fake,base)).pipe(Effect.provide(GameLive({send:w.send,refresh:()=>w.fake.refresh()}))));

test('already docked at the base: confirmed with no dock sent',async()=>{
  const w=world({...station,docked_at:'sol_base'});
  assert.deepEqual(await dockAt(w.fake,w.send,'sol_base'),{docked:true,docked_at:'sol_base',already_docked:true});
  assert.equal(w.docks(),0);
});

test('a dock that lands is confirmed by a live read',async()=>{
  const w=world(station,fake=>{land(fake);return {ok:true};});
  assert.deepEqual(await dockAt(w.fake,w.send),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.equal(w.docks(),1);
});

test('a dock whose reply says it landed but the read does not: DockBlocked, not re-sent',async()=>{
  const w=world(station,()=>({ok:true}));
  const error=await dockAt(w.fake,w.send).then(()=>undefined,e=>e);
  assert.ok(error instanceof DockBlocked);
  assert.match(error.message,/not confirmed by a live read/);
  assert.equal(w.docks(),1);
});

test('already_docked is reconciled by the read, and sent once',async()=>{
  const w=world(station,fake=>{land(fake);throw new SpacemoltError('already_docked','already docked');});
  assert.deepEqual(await dockAt(w.fake,w.send),{docked:true,docked_at:'sol_base',already_docked:true});
  assert.equal(w.docks(),1);
});

test('already_docked the read does not show is the refusal, not re-sent',async()=>{
  const w=world(station,()=>{throw new SpacemoltError('already_docked','already docked');});
  const failed=await twin(w);
  assert.ok(failed instanceof Rejected&&failed.code==='already_docked');
  assert.equal(w.docks(),1);
});

test('a generic refusal is the raw SpacemoltError from dockAt and Rejected from the twin',async()=>{
  const refusal=()=>new SpacemoltError('no_base','no base here');
  const raised=refusal();
  const w=world(station,()=>{throw raised;});
  assert.equal(await dockAt(w.fake,w.send).then(()=>undefined,e=>e),raised);
  const failed=await twin(world(station,()=>{throw refusal();}));
  assert.ok(failed instanceof Rejected&&failed.code==='no_base');
});

test('a reply lost after the dock landed is confirmed, not re-sent',async()=>{
  const w=world(station,fake=>{land(fake);throw new ConnectionClosedError('closed');});
  assert.deepEqual(await dockAt(w.fake,w.send),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.equal(w.docks(),1);
});

test('a reply lost that did not land is re-sent once, because dock is re-observed first',async()=>{
  let sends=0;
  const w=world(station,fake=>{if(sends++===0)throw new ConnectionClosedError('closed');land(fake);return {ok:true};});
  assert.deepEqual(await dockAt(w.fake,w.send),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.equal(w.docks(),2);
});

test('a reply lost twice without landing fails as ReplyLost after one re-send, the raw error from dockAt',async()=>{
  const raised=new ConnectionClosedError('closed');
  const w=world(station,()=>{throw raised;});
  assert.equal(await dockAt(w.fake,w.send).then(()=>undefined,e=>e),raised);
  assert.equal(w.docks(),2);
  const failed=await twin(world(station,()=>{throw new ConnectionClosedError('closed');}));
  assert.ok(failed instanceof ReplyLost);
});

test('a reply lost while the dock is queued that did not land fails and is not re-sent',async()=>{
  const queued=new SpacemoltError('action_pending','dock is queued',{pendingCommand:'dock'});
  const w=world(station,()=>{throw queued;});
  assert.equal(await dockAt(w.fake,w.send).then(()=>undefined,e=>e),queued);
  assert.equal(w.docks(),1);
  const failed=await twin(world(station,()=>{throw queued;}));
  assert.ok(failed instanceof ReplyLost&&failed.cause===queued);
});

test('docked at another base is DockBlocked, with nothing sent',async()=>{
  const w=world({...station,docked_at:'sol_base'});
  const error=await dockAt(w.fake,w.send,'range_base').then(()=>undefined,e=>e);
  assert.ok(error instanceof DockBlocked);
  assert.equal(error.message,'Docked at sol_base, not range_base; undock before docking elsewhere');
  assert.equal(w.docks(),0);
});

test('no POI is DockBlocked, with nothing sent',async()=>{
  const w=world({system_id:'sol'});
  const error=await dockAt(w.fake,w.send).then(()=>undefined,e=>e);
  assert.ok(error instanceof DockBlocked);
  assert.equal(error.message,'No station here to dock at; travel to a station first');
  assert.equal(w.docks(),0);
});
