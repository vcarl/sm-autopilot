import assert from 'node:assert/strict';
import {ConnectionClosedError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Result,Schema} from 'effect';
import {answerLine,createShutdown,forPilot,journalResult,MENU_CHARS,MENU_ROWS,readPilot,Request,serve,writePilot,type Pilot,type ServeOptions} from './bridge.ts';
import {controllerLock} from './controller-lock.ts';
import type {ReadinessAccount} from './readiness.ts';
import type {RunResult} from './run.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

function fixture(options:ServeOptions={},services=['refuel','repair']) {
  const world=bridgeWorld({services});
  return {...world,
    dispatch:serve(world.account as unknown as Account,world.command,options)};
}

const PILOT:Pilot={name:'kvothe',objective:'fill the hold',stance:'Prospector'};

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
  assert.ok(calls.includes("tradeRun({stops:[{at:'sol_base'}]})"),calls.join(' | '));
  assert.ok(menu.moves.every((move:any)=>/^m\d$/.test(move.id)&&move.gen&&move.facts),JSON.stringify(menu.moves));
  assert.match(menu.text,/^m1 `/);
  assert.equal(menu.last,null,'nothing has run yet');
  // The juncture renders the situation from this one reply: the clock, the record, the ship.
  assert.ok(Date.parse(menu.now),menu.now);
  const armed=bridgeWorld({wildlife:{creatures:[]}});
  const fitted=await serve(armed.account as unknown as Account,armed.command,{pilot:()=>PILOT})('menu') as any;
  assert.deepEqual(fitted.present.weapons,[{id:'autocannon_i',loaded:500}]);
  // A pilot with no stance gets the same menu: nothing about a missing stance is a state to leave.
  const blank=await fixture().dispatch('menu') as any;
  assert.equal(blank.stance,undefined);
  assert.equal(blank.mood,'Cautious','no stance flies the Cautious margins');
  assert.ok(blank.moves.some((move:any)=>move.call.startsWith('tradeRun(')),blank.text);
});

test('the menu derives the mood from the ship after its reads, writes nothing, and names the walk-away line', async () => {
  const world=bridgeWorld();
  const writes:Pilot[]=[];
  // A record an older runner wrote, mood and all: the stored mood is ignored.
  const serveIt=()=>serve(world.account as unknown as Account,world.command,
    {pilot:()=>({...PILOT,mood:'Aggressive'} as Pilot),setPilot:next=>{writes.push(next);}});
  const menu=await serveIt()('menu') as any;
  assert.equal(menu.mood,'Focused','a Prospector flies Focused');
  assert.equal(menu.present.walk_away,90,'0.90 of a 100 hull is the Focused line');
  world.account.server.ship.fuel=3;
  const tired=await serveIt()('menu') as any;
  assert.equal(tired.mood,'Tired');
  assert.match(tired.tired_by,/fuel 3 under the Focused reserve 24/);
  assert.equal(tired.present.walk_away,90,'Tired does not move the line: it is the working mood\'s');
  assert.equal(writes.length,0,'building the menu wrote the record');
});

test('the pilot request is the one writer of the record, and a null removes a field', async () => {
  let record:Pilot={name:'kvothe',objective:'fill the hold'};
  const f=fixture({pilot:()=>record,setPilot:next=>{record=next;}});
  const out=await f.dispatch('pilot',{set:{stance:'Trader',goal:'walk a price circuit',objective:null}}) as any;
  assert.deepEqual(out.record,{name:'kvothe',stance:'Trader',goal:'walk a price circuit'});
  assert.deepEqual(record,out.record);
});

test('a new objective clears the goal and stance unless the same write sets them', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  let record:Pilot={name:'kvothe',objective:'fill the hold',goal:'mine the belt',steps:['price an upgrade'],stance:'Prospector'};
  const f=fixture({pilot:()=>record,setPilot:next=>{record=next;},runtime});
  await f.dispatch('pilot',{set:{objective:'fill the hold'}});
  assert.equal(record.goal,'mine the belt','the same text again is not a new objective');
  await f.dispatch('pilot',{set:{objective:'explore new areas'}});
  const {objective_start:start,...rest}=record;
  assert.deepEqual(rest,{name:'kvothe',objective:'explore new areas'});
  // Live 2026-09-30 (kvothe): "train an offensive skill" was met (tactics 4→5) while the pilot kept
  // saying no skill rose. A new objective keeps the facts it started from.
  assert.equal(start?.credits,f.account.server.player.credits);
  assert.equal(start?.place,'sol_base');
  assert.equal(start?.ship_class,f.account.server.ship.class_id);
  assert.ok(start?.at&&typeof start.skills==='object',JSON.stringify(start));
  const line=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row))
    .filter(row=>row.event==='pilot').at(-1);
  assert.deepEqual(line.prev,{objective:'fill the hold',goal:'mine the belt',steps:['price an upgrade'],stance:'Prospector',objective_start:null});
  await f.dispatch('pilot',{set:{objective:'trade',stance:'Trader'}});
  assert.equal(record.stance,'Trader','a stance set with it stands');
  assert.notEqual(record.objective_start?.at,undefined);
  await f.dispatch('pilot',{set:{objective:null}});
  assert.equal(record.stance,'Trader','retiring the objective leaves the plan');
  assert.equal(record.objective_start,undefined,'a retired objective takes its start with it');
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

test('the journal keeps a menu move by its call', () => {
  const menu=journalResult('menu',{stance:'Hunter',mood:'Tired',objective:'cull the fauna',
    present:{system:'sys_a',hold:[{item_id:'carbon_ore',quantity:61}]},text:'m1 `completeMissions()` — …',
    moves:[{id:'m1',gen:'missions',call:'completeMissions()',facts:{credits:1,minutes:1},said:'…'},
      {id:'m2',gen:'explore',call:"goTo('sys_b')",facts:{credits:0,minutes:3},said:'…'}]}) as any;
  assert.deepEqual(menu.moves,['completeMissions()',"goTo('sys_b')"],'the call is what the journal keeps');
  assert.equal(menu.mood,'Tired');
  assert.equal(menu.present,undefined,'the world body still never reaches the journal');
  assert.equal(menu.text,undefined,'nor the rendered menu');
});

test('a long menu is capped both ways and other actions still count their arrays', () => {
  const menu=journalResult('menu',{moves:Array.from({length:MENU_ROWS+3},()=>({call:`gatherUntil({poi:'${'x'.repeat(200)}'})`}))}) as any;
  assert.equal(menu.moves[0].length,MENU_CHARS,'a long call is clipped, never wrapped');
  assert.ok(menu.moves[0].endsWith('…'));
  assert.equal(menu.moves.length,MENU_ROWS+1);
  assert.equal(menu.moves.at(-1),'+3 more','the rows past the cap are a count');
  const run=journalResult('run',{status:'done',moves:[{call:'a()'},{call:'b()'}]}) as any;
  assert.deepEqual(run,{status:'done',moves:2},'only menu widens; every other action counts');
});

// Live 2026-09-25: a pilot woke at hull 3/80 in a battle left over from the previous shift and
// died one second after its first move, because nothing it read said it was in a fight. Whether
// a battle holds the ship is the first fact the menu carries, so the juncture can lead with it.
test('the menu says whether a battle holds the ship, before any other fact',async()=>{
  const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};
  const world=bridgeWorld({services:['refuel','repair'],wildlife:{creatures:[grazer],polls:20,damage:0}});
  const dispatch=serve(world.account as unknown as Account,world.command,{pilot:()=>PILOT});
  const calm=await dispatch('menu') as any;
  assert.equal(calm.battle,undefined,'no battle, no line');
  await world.command('spacemolt/hunt',{id:'c1'});
  const fighting=await dispatch('menu') as any;
  assert.equal(fighting.battle?.opponent,'Molt Grazer');
  assert.ok(Number(fighting.battle?.tick)>=1,JSON.stringify(fighting.battle));
  assert.equal(Object.keys(fighting).indexOf('battle'),0,'first key: the juncture renders it first');
});

test('a request that does not decode is answered with what is wrong with it, and nothing runs', async () => {
  const held=heldRun();
  const f=fixture({pilot:()=>PILOT,runPilot:held.runPilot,runtime:mkdtempSync(join(tmpdir(),'spacemolt-bridge-'))});
  await assert.rejects(f.dispatch('fly',{}),/Unknown or malformed request "fly"/);
  await assert.rejects(f.dispatch('run',{juncture:{juncture_id:7}}),/juncture_id/);
  await assert.rejects(f.dispatch('answer',{answer:3}),/answer/);
  assert.equal(held.started.length,0,'a run that did not decode never started');
  // A null juncture field is what juncture.py sends for an `at` it never read: it decodes, and is carried.
  void f.dispatch('run',{juncture:{juncture_id:'j1',at:null}});
  await settle();
  assert.deepEqual(held.started[0]?.juncture,{juncture_id:'j1',at:null});
  held.finish({accepted:true,started:'now',status:'done',reason:'done'});
});

test('a stdin line is decoded once: one that does not decode is answered with what is wrong, and the next still answers', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  const f=fixture({pilot:()=>PILOT,runtime});
  const streamed:(string|undefined)[]=[];
  const bad=await answerLine(f.dispatch,'{"id":"1","action":',id=>streamed.push(id),runtime);
  assert.equal(bad.ok,false);
  assert.match(String(bad.error),/^Unreadable request: /);
  const noAction=await answerLine(f.dispatch,'{"id":"2"}',id=>streamed.push(id),runtime);
  assert.match(String(noAction.error),/action/);
  const unknown=await answerLine(f.dispatch,'{"id":"3","action":"fly"}',id=>streamed.push(id),runtime);
  assert.deepEqual({id:unknown.id,ok:unknown.ok},{id:'3',ok:false});
  assert.match(String(unknown.error),/"fly"/);
  const status=await answerLine(f.dispatch,'{"id":"4","action":"status","params":{}}',id=>streamed.push(id),runtime);
  assert.deepEqual(status,{id:'4',ok:true,result:{running:false,last:null}});
  const journal=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));
  const lines=journal.filter(row=>row.event==='request');
  assert.equal(lines.length,4,'every line is journalled, the unreadable ones with the line itself');
  assert.equal(lines[0].line,'{"id":"1","action":');
  assert.equal(journal.some(row=>row.event==='defect'),false,'a bad request is not a bug');
  assert.deepEqual(streamed,[],'nothing ran, so nothing took the stream');
});

test('a pilot write keeps every field that decodes and names each it dropped, never refusing the rest', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  let record:Pilot={...PILOT};
  const f=fixture({pilot:()=>record,setPilot:next=>{record=next;},runtime});
  // A bad stance beside a new objective: the objective lands, and the old plan's stance retires
  // with it as it did on main, where an unknown stance flew as no stance.
  const both=await f.dispatch('pilot',{set:{stance:'Pirate',objective:'haul ore',instruction:{text:'dock first',at:'2026-10-03T00:00:00Z'}}});
  assert.equal(record.objective,'haul ore');
  assert.deepEqual(record.instruction,{text:'dock first',at:'2026-10-03T00:00:00Z'});
  assert.equal(record.stance,undefined);
  assert.match(JSON.stringify(both),/"dropped":\{"stance":/);
  // A bad permission keeps the permissions it had; the goal beside it lands.
  record={...record,permissions:{credit_reserve:100}};
  const perm=await f.dispatch('pilot',{set:{permissions:{credit_reserve:'500'},goal:'mine'}});
  assert.deepEqual(record.permissions,{credit_reserve:100});
  assert.equal(record.goal,'mine');
  assert.match(JSON.stringify(perm),/"dropped":\{"permissions":/);
  const line=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row)).filter(row=>row.event==='pilot').at(-1);
  assert.ok(line.dropped.permissions,'the journal line names the dropped field');
  // A key the record does not name is dropped, never written, and is not news.
  const mood=await f.dispatch('pilot',{set:{mood:'Tired'}});
  assert.equal(JSON.stringify(mood).includes('dropped'),false);
  assert.equal('mood' in record,false);
});

test('steps that are not a list of lines, or a start that does not read, are dropped and named like any bad field', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  let record:Pilot={...PILOT,goal:'mine',steps:['price an upgrade']};
  const f=fixture({pilot:()=>record,setPilot:next=>{record=next;},runtime});
  const bad=await f.dispatch('pilot',{set:{steps:'price an upgrade',objective_start:{credits:5},goal:'haul'}});
  assert.deepEqual(record.steps,['price an upgrade'],'the old steps stand');
  assert.equal(record.objective_start,undefined);
  assert.equal(record.goal,'haul','the field beside them lands');
  assert.deepEqual(Object.keys((bad as any).dropped).sort(),['objective_start','steps']);
  await f.dispatch('pilot',{set:{steps:[]}});
  assert.deepEqual(record.steps,[],'an empty list is a valid list');
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-bridge-')),path=join(dir,'pilot.json');
  writeFileSync(path,JSON.stringify({objective:'haul ore',steps:[1,2],objective_start:{at:'2026-10-03T00:00:00Z',skills:{mining:3}}}));
  const named:Record<string,string>[]=[];
  assert.deepEqual(readPilot(path,dropped=>named.push(dropped)),
    {objective:'haul ore',objective_start:{at:'2026-10-03T00:00:00Z',skills:{mining:3}}});
  assert.deepEqual(Object.keys(named[0]??{}),['steps']);
});

test('a new objective whose refresh is lost still lands, its start read from memory, and the journal says so', async () => {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  let record:Pilot={...PILOT};
  const f=fixture({pilot:()=>record,setPilot:next=>{record=next;},runtime});
  f.account.refresh=async()=>{throw new ConnectionClosedError();};
  await f.dispatch('pilot',{set:{objective:'haul ore'}});
  assert.equal(record.objective,'haul ore');
  assert.ok(record.objective_start?.at,JSON.stringify(record));
  const journal=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));
  assert.ok(journal.some(row=>row.event==='log'&&/objective_start read from memory: the refresh failed \(reply lost\)/.test(row.message)),
    JSON.stringify(journal));
  assert.equal(journal.some(row=>row.event==='defect'),false,'a lost reply is not a bug');
});

test('pilot.json reads back field by field: an old mood is dropped, a bad field is named and the rest read', () => {
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-bridge-')),path=join(dir,'pilot.json');
  assert.deepEqual(readPilot(path),{},'no record is a pilot with no goal and no stance');
  writeFileSync(path,JSON.stringify({...PILOT,mood:'Focused'}));
  assert.deepEqual(readPilot(path),PILOT);
  writePilot(path,{...PILOT,goal:'mine'});
  assert.deepEqual(readPilot(path),{...PILOT,goal:'mine'});
  writeFileSync(path,JSON.stringify({objective:'haul ore',goal:null,stance:'Pirate',permissions:{credit_reserve:'500'}}));
  const named:Record<string,string>[]=[];
  assert.deepEqual(readPilot(path,dropped=>named.push(dropped)),{objective:'haul ore'});
  assert.deepEqual(Object.keys(named[0]??{}),['stance','permissions']);
  writeFileSync(path,'{"objective":');
  assert.throws(()=>readPilot(path),/Unreadable pilot record/,'only a file that is not JSON is unreadable');
});

test('every request service.py, __init__.py, juncture.py and play.py send decodes', () => {
  const sent:[string,unknown][]=[
    ['status',{}],['menu',{}],['check',{}],['stop',{}],['stop',{reason:'objective'}],
    ['run',{}],['run',{juncture:{juncture_id:'abc',at:'2026-10-03T00:00:00Z'}}],['run',{juncture:{juncture_id:'abc',at:null}}],
    ['answer',{answer:''}],['answer',{answer:'yes'}],
    ['pilot',{set:{goal:'mine',stance:'Prospector'}}],['pilot',{set:{goal:'mine',steps:['price an upgrade','sell']}}],['pilot',{set:{steps:[]}}],
    ['pilot',{set:{objective:null,objective_done:null,objective_completed:'haul ore'}}],
    ['pilot',{set:{instruction:{text:'dock',at:'2026-10-03T00:00:00Z'},objective:'x',permissions:{credit_reserve:'500'}}}],
  ];
  for(const [action,params] of sent)
    assert.ok(Result.isSuccess(Schema.decodeUnknownResult(Request)({action,params})),`${action} ${JSON.stringify(params)}`);
});

// Live 2026-10-02 (kvothe): the run reports read "b495c6003fc83e18f6d8cecbe6929133", and so did
// the pilot's replies. What reaches the pilot names it; the journal keeps the raw id.
test('a reply names opaque place ids in its prose for the pilot, and the menu carries the names', async () => {
  const base='b495c6003fc83e18f6d8cecbe6929133',names={[base]:'Kestrel Yard'};
  const result={accepted:true,status:'done',did:`sold at ${base}`,why:`${base} bids 40`,
    prose:`Done: tradeRun({stops:[{at:'${base}'}]}) at ${base}.`,commands:3};
  assert.deepEqual(forPilot(result,names),{...result,did:`sold at Kestrel Yard (${base})`,why:`Kestrel Yard (${base}) bids 40`,
    prose:`Done: tradeRun({stops:[{at:'${base}'}]}) at Kestrel Yard (${base}).`});
  assert.equal((forPilot({running:false,last:result},names) as any).last.did,`sold at Kestrel Yard (${base})`);
  assert.equal((journalResult('run',result) as any).did,`sold at ${base}`,'the journal is handed the raw reply');
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-bridge-'));
  writeFileSync(join(runtime,'names.json'),JSON.stringify(names));
  const menu=await fixture({pilot:()=>PILOT,runtime}).dispatch('menu') as any;
  assert.deepEqual(menu.names,names);
});
