import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {Account,type GameState} from '@spacemolt/lib';
import {BridgeQueue,serveInput} from './bridge-input.ts';
import {watchDefense} from './defense-events.ts';
import {executionFixture} from './execution-fixture.ts';
import {ExecutionStore} from './execution-store.ts';

test('incoming own-battle events latch synchronously and coalesce behind the existing owner through the real Account emitter',async t=>{
  const listeners=new Map<string,Array<(event:any)=>void>>();
  const emit=(type:string,event?:unknown)=>{for(const listener of listeners.get(type)??[])listener(event);};
  const socket={
    addEventListener(type:string,listener:(event:any)=>void){listeners.set(type,[...(listeners.get(type)??[]),listener]);},
    send(){throw new Error('This fixture must not send game commands');},
    close(){emit('close',{code:1000});},
  };
  const account=new Account({url:'ws://offline.invalid/ws/v2',seedState:false,webSocketFactory:()=>socket});
  t.after(()=>account.close());
  const connecting=account.connect();
  emit('open');
  const push=(type:string,payload:unknown)=>emit('message',{data:JSON.stringify({type,payload})});
  push('welcome',{version:'test',release_date:'',release_notes:[],tick_rate:5,current_tick:1,server_time:1,game_info:'',website:'',help_text:'',terms:''});
  await connecting;
  const queue=new BridgeQueue(),errors:unknown[]=[];
  let release!:()=>void,entered!:()=>void;
  const holding=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  queue.enqueue(async()=>{entered();await holding;});await started;
  let latches=0,responses=0;
  const off=watchDefense({on:account.on.bind(account),onReconnected:account.onReconnected.bind(account),state:{player:{id:'pilot'}} as GameState},
    {requestDefense(){latches++;},async respondToDanger(){responses++;}},queue,error=>errors.push(error));
  assert.equal(latches,1); // Startup also reconciles battles that predate listeners.
  push('battle_started',{participants:[{player_id:'bystander'}]});
  push('battle_joined',{player_id:'bystander'});
  push('battle_damage',{target_id:'bystander'});
  assert.equal(latches,1);
  for(const type of ['battle_started','battle_alert','battle_update'])push(type,{participants:[{player_id:'pilot'}]});
  push('battle_joined',{player_id:'pilot'});push('battle_damage',{target_id:'pilot'});
  assert.equal(latches,6);assert.equal(responses,0);
  release();await queue.drain();assert.equal(responses,1);
  off();push('battle_damage',{target_id:'pilot'});await queue.drain();
  assert.equal(latches,6);assert.equal(errors.length,0);

  const f=executionFixture(t);await f.choose();f.execution.context.mood='Relaxed';
  const stop=watchDefense({on:account.on.bind(account),onReconnected:account.onReconnected.bind(account),state:f.state},f.execution,queue,error=>errors.push(error));
  t.after(stop);
  await queue.drain();assert.equal(f.store.data.jobs.length,0);
  f.state.location={system_id:'system',poi_id:'belt',docked_at:null};f.state.ship.fuel=100;f.attack();
  push('battle_started',{participants:[{player_id:'pilot'}]});
  push('battle_damage',{target_id:'pilot'});
  push('battle_update',{participants:[{player_id:'pilot'}]});
  assert.equal(f.store.data.jobs.length,0); // Notification dispatch cannot run mutations inline.
  await queue.drain();
  assert.equal(f.store.data.jobs.length,1);
  const receipt:any=f.store.data.jobs[0];
  assert.equal(receipt.status,'returned_to_base');
  assert.equal(receipt.defense[0].result.retreated,true);
  assert.equal(receipt.after.location.docked_at,f.store.data.home?.base_id);
  assert.equal(receipt.after.ship.fuel,receipt.after.ship.max_fuel);
  assert.ok(!f.calls.some(c=>c.key==='spacemolt/hunt'));
  assert.equal(f.calls.filter(c=>c.key==='spacemolt_battle/stance'&&c.params.id==='flee').length,1);
  assert.equal(f.calls.filter(c=>c.key==='spacemolt/refuel').length,1);
  const persisted=new ExecutionStore(f.directory,'pilot').data.jobs;
  assert.equal(persisted.length,1);assert.equal(persisted[0].id,receipt.id);
  assert.equal(persisted[0].status,receipt.status);
  assert.deepEqual(persisted[0].defense,receipt.defense);
  assert.deepEqual(persisted[0].after,receipt.after);
  stop();const callCount=f.calls.length;push('battle_damage',{target_id:'pilot'});await queue.drain();
  assert.equal(f.calls.length,callCount);assert.deepEqual(errors,[]);
});

test('input, stop cleanup and idle defense share one queue and a rejected task cannot strand later work',async()=>{
  const queue=new BridgeQueue(),input=new PassThrough(),lines=createInterface({input}),seen:string[]=[];
  let release!:()=>void,entered!:()=>void;
  const holding=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const serving=serveInput(lines,async line=>{
    const action=JSON.parse(line).action;seen.push(action);
    if(action==='work'){entered();await holding;throw new Error('known failure');}
  },reason=>seen.push(reason),async()=>{seen.push('cleanup');},queue);
  input.write('{"action":"work"}\n');await started;
  queue.enqueue(async()=>{seen.push('defense');});
  input.end('{"action":"control/stop","params":{"reason":"Tired"}}\n{"action":"next"}\n');
  await serving;assert.deepEqual(seen,['work','Tired']);
  release();await assert.rejects(queue.drain(),/Bridge work failed/);
  assert.deepEqual(seen,['work','Tired','defense','cleanup','next']);
  queue.enqueue(async()=>{seen.push('later');});await queue.drain();assert.equal(seen.at(-1),'later');
});
