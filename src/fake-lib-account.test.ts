import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

test('send dispatches by tool and action, records payload snapshots, and propagates failures',async()=>{
  const failure=new Error('connection lost');
  const rejected=new Error('server rejected command');
  const account=new FakeLibGoalAccount({}, {
    spacemolt:{status:payload=>{(payload!.filter as {id:string}).id='handler';return {ship:'ready'};},
      travel:()=>{throw failure;}},
    battle:{status:async()=>({battle:'active'}),attack:async()=>{throw rejected;}},
  });
  const payload={filter:{id:'original'}};
  assert.deepEqual(await account.send('spacemolt','status',payload),{ship:'ready'});
  payload.filter.id='caller';
  assert.deepEqual(await account.send('battle','status'),{battle:'active'});
  await assert.rejects(account.send('spacemolt','travel',{id:'belt'}),error=>error===failure);
  await assert.rejects(account.send('battle','attack',{}),error=>error===rejected);
  await assert.rejects(account.send('battle','travel',{}),/Unregistered command: battle\/travel/);
  await assert.rejects(account.send('unknown','status',{}),/Unregistered command: unknown\/status/);
  await assert.rejects(account.send('spacemolt','toString',{}),/Unregistered command/);
  assert.deepEqual(account.calls,[
    {tool:'spacemolt',action:'status',payload:{filter:{id:'original'}}},
    {tool:'battle',action:'status',payload:undefined},
    {tool:'spacemolt',action:'travel',payload:{id:'belt'}},
    {tool:'battle',action:'attack',payload:{}},
    {tool:'battle',action:'travel',payload:{}},
    {tool:'unknown',action:'status',payload:{}},
    {tool:'spacemolt',action:'toString',payload:{}},
  ]);
});

test('server mutations and cache pushes remain independent until a recorded refresh',async()=>{
  let time=10;
  const initial={location:{system_id:'a',poi_id:'origin',in_transit:false},
    ship:{fuel:100,cargo_used:0}};
  const account=new FakeLibGoalAccount(initial,{spacemolt:{travel:()=>{
    account.server.location.poi_id='belt';
    account.server.ship.fuel-=10;
    return {};
  }}},()=>time);
  initial.location.poi_id='external';initial.ship.fuel=0;
  assert.equal(account.server.location.poi_id,'origin');
  assert.equal(account.state.ship!.fuel,100);
  assert.deepEqual(await account.send('spacemolt','travel',{id:'belt'}),{});
  assert.equal(account.state.location!.poi_id,'origin');
  assert.equal(account.state.ship!.fuel,100);
  account.state.ship!.cargo_used=7;
  assert.equal(account.server.ship.cargo_used,0);
  assert.deepEqual(account.refreshes,[]);
  time=30;
  assert.deepEqual(await account.refresh(),account.server);
  assert.equal(account.state.location!.poi_id,'belt');
  assert.equal(account.state.ship!.fuel,90);
  account.server.ship.fuel=80;
  assert.equal(account.state.ship!.fuel,90,'refresh must not alias server state');
  account.state.location!.poi_id='cache-only';
  assert.equal(account.server.location.poi_id,'belt');
  time=60;
  await account.refresh();
  assert.deepEqual(account.state,account.server);
  assert.deepEqual(account.refreshes,[30,60]);
  assert.equal(account.calls.length,1,'refresh does not replay movement');
});
