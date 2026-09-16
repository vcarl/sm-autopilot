import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShutdown,journalResult,serve,type Pilot,type ServeOptions} from './bridge.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount} from './readiness.ts';
import type {RunResult} from './run.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

function fixture(options:ServeOptions={},services=['refuel','repair']) {
  const world=bridgeWorld({services});
  return {...world,
    dispatch:serve(world.account as unknown as ReadinessAccount,world.command,options)};
}

const PILOT:Pilot={name:'kvothe',objective:'fill the hold',stance:'Prospector',mood:'Focused',home:'sol_base'};

/** A run that starts and does not finish, so the bridge can be observed mid-flight. */
function heldRun() {
  const started:any[]=[];
  let release:((result:RunResult)=>void)|undefined;
  const runPilot=((deps:any)=>{
    started.push(deps);
    return new Promise<RunResult>(resolve=>{release=resolve;});
  }) as any;
  return {runPilot,started,finish:(result:RunResult)=>release!(result)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('menu answers with moves from the present, each a paste-able call, and the rendered text', async () => {
  const f=fixture({pilot:()=>PILOT});
  const menu=await f.dispatch('menu') as any;
  assert.equal(f.account.refreshes.length>0,true,'the present must come from an authoritative read');
  assert.equal(menu.stance,'Prospector');
  assert.equal(menu.objective,'fill the hold');
  assert.deepEqual([menu.present.docked_at,menu.present.fuel,menu.present.cargo_free],['sol_base',100,0]);
  const calls=menu.moves.map((move:any)=>move.call);
  assert.ok(calls.includes("sell([{item_id:'ore',quantity:12}])"),calls.join(' | '));
  assert.ok(menu.not_now.some((row:any)=>row.move==='gatherUntil'&&/hold is full/.test(row.why)),JSON.stringify(menu.not_now));
  assert.match(menu.text,/^Menu:\n  - `sell\(/);
  assert.equal(menu.last,null,'nothing has run yet');
  // A pilot with no stance and no mood is at rest: the consultation is the reflection (N7).
  const resting=await fixture().dispatch('menu') as any;
  assert.equal(resting.at_rest,true);
  assert.equal(resting.moves,undefined,'a resting pilot is offered no moves');
});

test('run blocks until the pilot file ends; status, stop and menu answer meanwhile', async () => {
  const held=heldRun();
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  const f=fixture({pilot:()=>PILOT,runPilot:held.runPilot,runtime});
  assert.deepEqual(await f.dispatch('status'),{running:false,last:null});
  assert.deepEqual(await f.dispatch('stop'),{stopping:false,reason:'nothing is running'});

  const flight=f.dispatch('run',{}) as Promise<any>;
  await settle();
  assert.equal(held.started.length,1,'the pilot file was started once');
  assert.equal(held.started[0].runtime,runtime);
  assert.equal(typeof held.started[0].emit,'function','the run is handed the stream');
  const status=await f.dispatch('status') as any;
  assert.equal(status.running,true);
  assert.equal(typeof status.started,'string');
  assert.equal(status.fuel,100,'reads answer while a run is in flight');
  // A second run while one is in flight changes nothing and is told why.
  const refused=await f.dispatch('run',{}) as any;
  assert.equal(refused.accepted,false);
  assert.equal(held.started.length,1);
  assert.equal(((await f.dispatch('menu')) as any).busy,true);
  assert.equal(((await f.dispatch('stop')) as any).stopping,true);

  held.finish({accepted:true,status:'done',reason:'serviced',prose:'Done: serviced.',started:'t0',commands:3});
  const result=await flight;
  assert.equal(result.prose,'Done: serviced.');
  const after=await f.dispatch('status') as any;
  assert.equal(after.running,false);
  assert.equal(after.last.status,'done');
  // Neither answer carries the Outcome: a pilot reads `status` through a tool call, and the
  // ship, the location, the cargo and every skill stay in run.json and the journal.
  assert.deepEqual(Object.keys(after.last).sort(),['commands','did','ended','prose','started','status']);
  assert.deepEqual(Object.keys(result).sort(),['accepted','commands','did','ended','prose','started','status']);
});

test('shutdown forces exit within the grace even when the account never finishes closing, and stays idempotent', async () => {
  const account={close:()=>new Promise<void>(()=>{})};
  const exits:number[]=[];
  let fireGrace:(()=>void)|undefined;
  const schedule=((cb:()=>void)=>{fireGrace=cb;return 0;}) as unknown as typeof setTimeout;
  const shutdown=createShutdown(account,{exit:code=>exits.push(code),schedule,graceMs:2000});
  shutdown();
  await settle();
  assert.deepEqual(exits,[],'close() never resolves and the grace has not elapsed yet');
  fireGrace!();
  assert.deepEqual(exits,[0]);
  shutdown();
  fireGrace?.();
  assert.deepEqual(exits,[0],'already shutting down; no second exit');
});

test('shutdown exits immediately once account.close() resolves, ahead of the grace timer', async () => {
  const account={close:()=>Promise.resolve()};
  const exits:number[]=[];
  const schedule=(()=>0) as unknown as typeof setTimeout;
  const shutdown=createShutdown(account,{exit:code=>exits.push(code),schedule});
  shutdown();
  await settle();
  assert.deepEqual(exits,[0]);
});

test('the controller lock is taken over from a dead holder and refused to a live one', () => {
  const path=join(mkdtempSync(join(tmpdir(),'spacemolt-lock-')),'controller.lock');
  const reaped=spawnSync(process.execPath,['-e','']).pid!;
  writeFileSync(path,JSON.stringify({pid:reaped,started_at:'2026-01-01T00:00:00.000Z'}));
  const unlock=controllerLock(path);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).pid,process.pid,'the live controller owns the lock');
  assert.throws(()=>controllerLock(path),/EEXIST/);
  unlock();
  assert.equal(existsSync(path),false);
  unlock();
});

test('the journal keeps the outcome of a request and never the prose or a body', () => {
  const run=journalResult('run',{accepted:true,status:'done',reason:'serviced',prose:'Done: serviced.\nCost: nothing.',
    outcome:{fn:'service',status:'done',did:'serviced',detail:{huge:'x'.repeat(5_000)}},started:'t0',commands:3}) as any;
  assert.deepEqual(run,{accepted:true,status:'done',reason:'serviced',started:'t0',commands:3});
  const status=journalResult('status',{running:false,last:{status:'done',did:'serviced',prose:'…'}}) as any;
  assert.deepEqual(status,{running:false,last:{status:'done',did:'serviced'}});
});
