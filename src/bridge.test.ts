import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShutdown,journalResult,MENU_CHARS,MENU_ROWS,serve,type Pilot,type ServeOptions} from './bridge.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount} from './readiness.ts';
import type {RunResult} from './run.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

function fixture(options:ServeOptions={},services=['refuel','repair']) {
  const world=bridgeWorld({services});
  return {...world,
    dispatch:serve(world.account as unknown as ReadinessAccount,world.command,options)};
}

const PILOT:Pilot={name:'kvothe',objective:'fill the hold',stance:'Prospector',mood:'Focused'};

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
  // The juncture renders the situation from this one reply: the clock, the record, the ship.
  assert.ok(Date.parse(menu.now),menu.now);
  const armed=bridgeWorld({wildlife:{creatures:[]}});
  const fitted=await serve(armed.account as unknown as ReadinessAccount,armed.command,{pilot:()=>PILOT})('menu') as any;
  assert.deepEqual(fitted.present.weapons,[{id:'autocannon_i',loaded:500}]);
  // A pilot with no stance is at rest, and the menu is still never empty (VISION): the moves
  // are computed all the same and what reflect would set is named beside them.
  const resting=await fixture({pilot:()=>({objective:'fill the hold',mood:'Focused'})}).dispatch('menu') as any;
  assert.equal(resting.rest.at_rest,true);
  assert.deepEqual(resting.rest.absent,['goal','stance']);
  assert.ok(resting.moves?.length,JSON.stringify(resting));
  assert.ok(resting.moves.some((move:any)=>move.call.startsWith('sell(')),resting.text);
  // With no mood either, the resting default stands in so the rules still have one.
  const blank=await fixture().dispatch('menu') as any;
  assert.deepEqual(blank.rest.absent,['goal','stance','mood']);
  assert.ok(blank.moves?.length,JSON.stringify(blank));
});

test('the menu reports the mood the record holds after its reads, and the walk-away line', async () => {
  // The reads push state, every push runs `imposeTired`, and Tired clears the moment the ship
  // is back inside the prior mood's margins. A frozen copy of the record cleared the same Tired
  // on every push and then reported a mood the pilot no longer had (playtest 2026-09-22).
  const world=bridgeWorld();
  let push:(()=>void)|undefined;
  (world.account as any).onStateChange=(fn:()=>void)=>{push=fn;return ()=>{push=undefined;};};
  const pushing=async(action:string,params:Record<string,unknown>={})=>{
    const reply=await world.command(action,params);push?.();return reply;};
  let record:Pilot={...PILOT,mood:'Tired',mood_before_tired:'Focused'};
  const writes:Pilot[]=[];
  const menu=await serve(world.account as unknown as ReadinessAccount,pushing,
    {pilot:()=>record,setPilot:next=>{writes.push(next);record=next;}})('menu') as any;
  assert.equal(menu.mood,'Focused','the reads cleared Tired; the menu says so');
  assert.equal(writes.length,1,'cleared once, not once per push');
  // The mood's walk-away line, so the pilot is told the hull it breaks off at, never guessing.
  assert.equal(menu.present.walk_away,90,'0.90 of a 100 hull is the Focused line');
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

test('the journal keeps a menu move by its call and a refusal by its reason', () => {
  const menu=journalResult('menu',{stance:'Hunter',mood:'Tired',objective:'cull the fauna',
    present:{system:'sys_a',hold:[{item_id:'carbon_ore',quantity:61}]},text:'Menu — …\n  - `hunt()` — …',
    moves:[{call:'service()',why:'Tired: resupply here clears it',advances:'ship'},
      {call:"goTo('base_iron')",why:'the nearest serviced base',advances:'ship'}],
    not_now:[{move:'gatherUntil',why:'fuel 12, need 30 with the Cautious reserve 18'}]}) as any;
  assert.deepEqual(menu.moves,['service()',"goTo('base_iron')"],'the call is what the journal keeps');
  assert.deepEqual(menu.not_now,['gatherUntil: fuel 12, need 30 with the Cautious reserve 18']);
  assert.equal(menu.mood,'Tired');
  assert.equal(menu.present,undefined,'the world body still never reaches the journal');
  assert.equal(menu.text,undefined,'nor the rendered menu');
});

test('a long menu is capped both ways and other actions still count their arrays', () => {
  const menu=journalResult('menu',{moves:[{call:`gatherUntil({poi:'${'x'.repeat(200)}'})`}],
    not_now:Array.from({length:MENU_ROWS+3},(_,n)=>({move:`m${n}`,why:'no route'}))}) as any;
  assert.equal(menu.moves[0].length,MENU_CHARS,'a long call is clipped, never wrapped');
  assert.ok(menu.moves[0].endsWith('…'));
  assert.equal(menu.not_now.length,MENU_ROWS+1);
  assert.equal(menu.not_now.at(-1),'+3 more','the rows past the cap are a count');
  const run=journalResult('run',{status:'done',moves:[{call:'a()'},{call:'b()'}],not_now:[{move:'c'}]}) as any;
  assert.deepEqual(run,{status:'done',moves:2,not_now:1},'only menu widens; every other action counts');
});

// Live 2026-09-25: a pilot woke at hull 3/80 in a battle left over from the previous shift and
// died one second after its first move, because nothing it read said it was in a fight. Whether
// a battle holds the ship is the first fact the menu carries, so the juncture can lead with it.
test('the menu says whether a battle holds the ship, before any other fact',async()=>{
  const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};
  const world=bridgeWorld({services:['refuel','repair'],wildlife:{creatures:[grazer],polls:20,damage:0}});
  const dispatch=serve(world.account as unknown as ReadinessAccount,world.command,{pilot:()=>PILOT});
  const calm=await dispatch('menu') as any;
  assert.equal(calm.battle,undefined,'no battle, no line');
  await world.command('spacemolt/hunt',{id:'c1'});
  const fighting=await dispatch('menu') as any;
  assert.equal(fighting.battle?.opponent,'Molt Grazer');
  assert.ok(Number(fighting.battle?.tick)>=1,JSON.stringify(fighting.battle));
  assert.equal(Object.keys(fighting).indexOf('battle'),0,'first key: the juncture renders it first');
});
