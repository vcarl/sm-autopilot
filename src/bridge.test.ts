import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShutdown,journalResult,serve,type Pilot,type ServeOptions} from './bridge.ts';
import {controllerLock} from './controller-lock.ts';
import type {RunOutcome} from './script-runner.ts';
import type {ReadinessAccount} from './readiness.ts';

import {bridgeWorld} from './test-support/bridge-world.ts';

function fixture(options:ServeOptions={},services=['refuel','repair']) {
  const world=bridgeWorld({services});
  return {...world,
    dispatch:serve(world.account as unknown as ReadinessAccount,world.command,options)};
}

test('where reports the live position and the destinations the model may name', async () => {
  const f=fixture();
  const observed=await f.dispatch('where') as any;
  assert.equal(f.account.refreshes.length,1,'position must come from an authoritative read');
  assert.deepEqual(observed.system,{id:'sol',name:'Sol'});
  assert.deepEqual(observed.poi,{id:'station',name:'Sol Station'});
  // A base id is not a POI id: the model is told which base it is docked at, by name.
  assert.deepEqual(observed.docked_at,{base_id:'sol_base',name:'Sol Base'});
  assert.equal(observed.in_transit,false);
  assert.deepEqual(observed.fuel,100);
  assert.deepEqual(observed.pois,[{id:'station',name:'Sol Station',type:'station'},
    {id:'belt',name:'Inner Belt',type:'asteroid_belt'}]);
  // The systems a jump reaches are nameable too, not just this system's POIs.
  assert.deepEqual(observed.connections,[{system_id:'deep_range',name:'Deep Range',distance:4}]);
  // Every listed destination is nameable and nothing heavier rides along.
  assert.ok(JSON.stringify(observed).length<2048);
  for(const poi of observed.pois)assert.deepEqual(Object.keys(poi),['id','name','type']);
});

test('travel undocks, flies to the named poi, and reports the arrival a live read confirms', async () => {
  const f=fixture();
  const result=await f.dispatch('travel',{poi_id:'belt'}) as any;
  assert.equal(result.arrived,true);
  assert.deepEqual(result.location,{system:'sol',poi:'belt',docked_at:null});
  assert.equal(result.fuel,93);
  assert.equal(typeof result.elapsed_s,'number');
  // One route query says which system holds the poi, the second is travelTo's own fuel quote.
  assert.deepEqual(f.sent.map(call=>call.action),
    ['spacemolt/find_route','spacemolt/find_route','spacemolt/undock','spacemolt/travel']);
  assert.deepEqual(f.sent.at(-1)!.params,{id:'belt'});
  assert.equal(f.account.server.location.poi_id,'belt');
  // A destination the model never named must not become a flight.
  await assert.rejects(fixture().dispatch('travel',{}),/poi_id/);
});

test('travel to a poi in another system jumps there rather than refusing', async () => {
  const f=fixture();
  const result=await f.dispatch('travel',{poi_id:'outpost'}) as any;
  assert.equal(result.arrived,true);
  assert.deepEqual(result.location,{system:'deep_range',poi:'outpost',docked_at:null});
  const moves=f.sent.filter(call=>call.action==='spacemolt/jump'||call.action==='spacemolt/travel');
  assert.deepEqual(moves,[{action:'spacemolt/jump',params:{id:'deep_range'}},
    {action:'spacemolt/travel',params:{id:'outpost'}}]);
  assert.equal(f.account.server.location.system_id,'deep_range');
});

test('a destination with no route is reported, never flown', async () => {
  const f=fixture();
  const result=await f.dispatch('travel',{poi_id:'nowhere'}) as any;
  assert.equal(result.arrived,false);
  assert.equal(result.reason,'No route to nowhere');
  assert.deepEqual(f.sent.map(call=>call.action),['spacemolt/find_route']);
});

test('dock reports the dock the pilot already has and otherwise docks once, live read deciding', async () => {
  const f=fixture();
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:true});
  assert.equal(f.sent.length,0,'a dock the pilot already has is never re-sent');
  f.account.server.location.docked_at=null; // the pilot left the station
  assert.deepEqual(await f.dispatch('dock'),{docked:true,docked_at:'sol_base',already_docked:false});
  assert.deepEqual(f.sent.map(call=>call.action),['spacemolt/dock']);
  // A dock somewhere else is reported, never overwritten.
  const elsewhere=fixture();
  elsewhere.account.server.location.docked_at='other_base';
  const refused=await elsewhere.dispatch('dock',{base_id:'sol_base'}) as any;
  assert.equal(refused.docked,false);
  assert.match(refused.reason,/other_base/);
  assert.equal(elsewhere.sent.length,0);
});

test('gather runs one job from the dock the ship is at and reports a verified outcome', async () => {
  const f=fixture();
  const result=await f.dispatch('gather',{poi_id:'belt'}) as any;
  assert.equal(result.outcome,'done',result.reason);
  // Dock to dock: out to the belt, home to the station POI, dock at the base behind it.
  assert.deepEqual(f.sent.filter(call=>call.action==='spacemolt/travel').map(call=>call.params),
    [{id:'belt'},{id:'station'}]);
  assert.deepEqual(f.account.server.location,
    {system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false});
  assert.equal(result.script,'gather');
  assert.deepEqual(result.jobs.map((job:any)=>[job.job,job.outcome]),[['gather','done']]);
  // The hold the pilot undocked with is its own: the counter never sees it, so a job that
  // mined nothing sells nothing and still comes home serviced (C8).
  assert.equal(f.sent.filter(call=>call.action==='spacemolt/sell').length,0);
  assert.deepEqual(f.account.server.cargo,[{item_id:'ore',quantity:12}]);
  assert.deepEqual([f.account.server.ship.fuel,f.account.server.ship.hull],[120,100]);
  assert.equal(f.account.server.player.credits,1_000-34-4);
  assert.ok(JSON.stringify(result).length<2048,'one compact outcome, not a transcript');
  // A destination the model never named must not become a trip: the script says it needs
  // one, so the run is refused before anything reaches the game.
  await assert.rejects(fixture().dispatch('gather',{}),/poi_id is required/);
});

test('gather mines a site in another system and stows the yield at the home base', async () => {
  const f=fixture();
  // The site is a jump away; the base the ship is docked at is the home the ore comes back to.
  const result=await f.dispatch('gather',{poi_id:'far_belt'}) as any;
  assert.equal(result.outcome,'done',result.reason);
  // Out: jump to the site's own system, then fly to it. Home: jump back to the base's system,
  // fly to the POI it sits at, dock there.
  assert.deepEqual(f.sent.filter(call=>['spacemolt/jump','spacemolt/travel'].includes(call.action))
    .map(call=>[call.action,call.params.id]),
    [['spacemolt/jump','deep_range'],['spacemolt/travel','far_belt'],
      ['spacemolt/jump','sol'],['spacemolt/travel','station']]);
  assert.deepEqual(f.account.server.location,
    {system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false});
  // A site nothing routes to is reported, never flown.
  const g=fixture();
  const nowhere=await g.dispatch('gather',{poi_id:'nowhere'}) as any;
  assert.equal(nowhere.outcome,'failed');
  assert.match(nowhere.reason,/No route to nowhere/);
  assert.deepEqual(g.sent.filter(call=>call.action==='spacemolt/travel'),[],'nothing was flown');
});

test('storage reads the current base by default and passes a named station through, compact', async () => {
  const f=fixture();
  const here=await f.dispatch('storage') as any;
  assert.deepEqual(f.sent.at(-1),{action:'spacemolt_storage/view',params:{}});
  assert.deepEqual(here,{base_id:'sol_base',base_name:'Sol Base',
    items:[{item_id:'ore',name:'Ore',quantity:340},{item_id:'scrap',quantity:2}],
    ships:1,locations:[{base_id:'sol_base',base_name:'Sol Base',system_name:'Sol',
      item_count:2,ship_count:1}]});
  assert.ok(JSON.stringify(here).length<2048);
  await f.dispatch('storage',{station_id:'other_base'});
  assert.deepEqual(f.sent.at(-1),{action:'spacemolt_storage/view',params:{station_id:'other_base'}});
});

const PILOT:Pilot={name:'kvothe',objective:'fill the hold',stance:'Prospector',mood:'Focused',home:'sol_base'};

/** A run that starts and does not finish, so a juncture can be observed mid-flight. */
function heldRun() {
  const started:any[]=[];
  let release:((outcome:RunOutcome)=>void)|undefined;
  const runScript=((options:any)=>{
    started.push(options);
    options?.onProgress?.({script:options.script,params:options.params,started:options.started,
      keep:[],last_job:'gather',ended:false});
    return new Promise<RunOutcome>(resolve=>{release=resolve;});
  }) as any;
  return {runScript,started,finish:(outcome:RunOutcome)=>release!(outcome)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('menu assembles the present from live state and answers with the rules table', async () => {
  const f=fixture({pilot:()=>PILOT});
  const menu=await f.dispatch('menu') as any;
  assert.equal(f.account.refreshes.length>0,true,'the present must come from an authoritative read');
  assert.equal(menu.stance,'Prospector');
  assert.equal(menu.objective,'fill the hold');
  assert.deepEqual([menu.present.docked_at,menu.present.fuel,menu.present.cargo_free],['sol_base',100,0]);
  const offered=menu.options.map((option:any)=>option.job);
  // The station's own counter, the way home to a serviced ship, and the one quoted site.
  assert.ok(offered.includes('Counter: Services'),offered.join(' | '));
  assert.ok(offered.includes('J12 Home, serviced'));
  assert.ok(offered.includes('Travel to belt'),'the route quote for this system governs its POIs');
  for(const option of menu.options)assert.ok(option.reason&&option.bounds.fuelReserve>0);
  // A full hold is why the stance's own job is refused, and the menu says so.
  const refused=menu.unavailable.find((row:any)=>row.job.startsWith('J1 '));
  assert.match(refused.reason,/hold is full/);
  assert.equal(menu.last,null,'nothing has run yet');
  assert.ok(JSON.stringify(menu).length<4096,'one consultation, not a transcript');
  // A pilot with no stance and no mood is at rest, and what it is consulted about is not a
  // menu of work but the reflection the next shift is chosen from (N7).
  const resting=await fixture().dispatch('menu') as any;
  assert.equal(resting.at_rest,true);
  assert.equal(resting.options,undefined,'a resting pilot is offered no stance work');
  assert.ok(Array.isArray(resting.stagnation),'reflection carries what it has been doing');
});

test('every option carries the call it would be taken with, and the present says what the hold holds', async () => {
  // The base posts no storage and no bench: a full hold has nowhere to go here, and the
  // present says so rather than leaving the pilot to guess (playtest 2026-09-15).
  const bare=await fixture({pilot:()=>PILOT}).dispatch('menu') as any;
  assert.deepEqual(bare.present.hold,[{item_id:'ore',quantity:12}]);
  assert.deepEqual([bare.present.cargo_free,bare.present.storage,bare.present.workshop],[0,false,false]);

  const f=fixture({pilot:()=>PILOT},['refuel','repair','storage','crafting']);
  f.account.server.ship.cargo_used=0; // room to fill, so the stance's gather is admissible
  const menu=await f.dispatch('menu') as any;
  assert.deepEqual([menu.present.storage,menu.present.workshop],[true,true]);
  // Acting left the toolsets: what a menu option names is a script to run or a station read.
  const tools=new Set(['spacemolt_storage','spacemolt_rest','spacemolt_run','spacemolt_recipes']);
  for(const option of menu.options)
    assert.ok(option.call===null||tools.has(option.call.tool),`${option.job}: ${JSON.stringify(option.call)}`);
  const gather=menu.options.find((option:any)=>option.call?.tool==='spacemolt_run');
  assert.ok(gather,'a hold with room is offered the gather');
  assert.equal(gather.call.params.script,'gather');
  // The mining sites to choose among — the station the ship is docked at is not one of them,
  // and the base id belongs in base_id, never in poi_id.
  assert.deepEqual(gather.call.params.params.poi_id,['belt']);
  assert.equal(gather.call.params.params.base_id,'sol_base');
});

test('the Storage counter offers the deposit when the hold is full, and the read when it is not', async () => {
  // A full hold at a base that takes deposits wants the act: reading the store changes nothing.
  const full=await fixture({pilot:()=>PILOT},['refuel','repair','storage']).dispatch('menu') as any;
  const stowing=full.options.find((option:any)=>option.job==='Counter: Storage');
  assert.deepEqual(stowing.call,{tool:'spacemolt_run',params:{script:'stow',params:{}}});

  const f=fixture({pilot:()=>PILOT},['refuel','repair','storage']);
  f.account.server.ship.cargo_used=0; // room in the hold: the counter is a read again
  const roomy=await f.dispatch('menu') as any;
  const reading=roomy.options.find((option:any)=>option.job==='Counter: Storage');
  assert.deepEqual(reading.call,{tool:'spacemolt_storage',params:{}});
});

test('run starts one script in the runner and returns before it ends; status carries it', async () => {
  const held=heldRun();
  const f=fixture({pilot:()=>PILOT,runScript:held.runScript});
  assert.deepEqual(await f.dispatch('status'),{running:false,last:null});

  const started=await f.dispatch('run',{script:'gather',params:{poi_id:'belt'}}) as any;
  assert.equal(started.accepted,true);
  assert.equal(started.script,'gather');
  assert.equal(started.record.ended,false);
  assert.equal(typeof started.record.started,'string');
  // The script was handed the pilot's own bounds, not the model's: the mood the record
  // holds, the home it stows at, and the parameters exactly as the agent named them.
  assert.equal(held.started[0].mood,'Focused');
  assert.equal(held.started[0].home,'sol_base');
  assert.deepEqual(held.started[0].params,{poi_id:'belt'});
  assert.deepEqual(await f.dispatch('status'),{running:true,script:'gather',record:started.record});

  // A second juncture while the script runs changes nothing and is told why.
  const refused=await f.dispatch('run',{script:'gather',params:{poi_id:'belt'}}) as any;
  assert.equal(refused.accepted,false);
  assert.equal(refused.script,'gather');
  assert.equal(held.started.length,1,'a running script is never joined by a second');
  const busy=await f.dispatch('menu') as any;
  assert.equal(busy.busy,true);
  assert.equal(busy.options,undefined,'a busy pilot is offered nothing to choose');

  held.finish({script:'gather',outcome:'done',reason:'gather done: 1 job',jobs:[]});
  await settle();
  const after=await f.dispatch('status') as any;
  assert.equal(after.running,false);
  assert.equal(after.last.reason,'gather done: 1 job');
  // The runner is free again, and the next juncture reads the outcome from `last`.
  assert.equal(((await f.dispatch('menu')) as any).last.script,'gather');
});

test('a script the runner does not have is refused before anything reaches the game', async () => {
  const held=heldRun();
  const f=fixture({pilot:()=>PILOT,runScript:held.runScript});
  await assert.rejects(f.dispatch('run',{script:'mine-the-moon',params:{}}),/Unknown script/);
  // The parameters a script says it needs are checked too, by the script's own schema.
  await assert.rejects(f.dispatch('run',{script:'gather',params:{}}),/poi_id is required/);
  assert.equal(held.started.length,0,'nothing was started');
  assert.deepEqual(await f.dispatch('status'),{running:false,last:null});
});

/** A script of the pilot's own: it reaches the barrel, and nothing else, and says what it
 * saw, so a run of it is visible in the outcome the next juncture reads. */
const OWN_SCRIPT="import {where,type Ctx,type JobOutcome} from '../jobs/index.ts';\n"+
  "export const params={type:'object',description:'Look around from the dock.',properties:{}};\n"+
  'export default async (ctx:Ctx):Promise<JobOutcome>=>{const at=await where(ctx);\n'+
  "return {job:'look',outcome:'done',reason:`docked at ${at.docked_at?.base_id}`};};\n";
const SNEAKY="import {readFileSync} from 'node:fs';\n"+
  "export const params={type:'object',properties:{}};\n"+
  "export default async ()=>{readFileSync('/etc/passwd');};\n";

/** The run is the runner's own work, so a caller waits for it the way a window does. */
async function idle(dispatch:Awaited<ReturnType<typeof serve>>) {
  for(let tries=0;tries<500;tries++) {
    const status=await dispatch('status') as any;
    if(!status.running)return status;
    await settle();
  }
  throw new Error('the run never ended');
}
const runtimeDir=()=>mkdtempSync(join(tmpdir(),'spacemolt-runtime-'));

test('a script the pilot wrote runs from its source, and the juncture reads its outcome', async () => {
  const runtime=runtimeDir();
  const f=fixture({pilot:()=>PILOT,runtime});
  const started=await f.dispatch('run',{source:OWN_SCRIPT,params:{}}) as any;
  assert.equal(started.accepted,true);
  // The run is named by what the script is, not by its text: the journal stays small.
  assert.match(started.script,/^source:[0-9a-f]{12}$/);
  const after=await idle(f.dispatch);
  assert.equal(after.last.script,started.script);
  assert.equal(after.last.reason,'docked at sol_base','the pilot\'s own script really ran');
  // The record keeps the script itself, because a restart has nowhere else to find it.
  const record=JSON.parse(readFileSync(join(runtime,'run.json'),'utf8'));
  assert.equal(record.source,OWN_SCRIPT);
  const journal=readFileSync(join(runtime,'gameplay.jsonl'),'utf8');
  assert.ok(journal.includes(started.script),'the journal names the run');
  assert.ok(!journal.includes('docked at ${at'),'and never carries the script itself');
  rmSync(runtime,{recursive:true,force:true});
});

test('a script the pilot saves is listed, readable, and run by name afterwards', async () => {
  const runtime=runtimeDir();
  const f=fixture({pilot:()=>PILOT,runtime});
  assert.deepEqual(await f.dispatch('scripts',{action:'save',name:'look-around',source:OWN_SCRIPT}),
    {saved:true,name:'look-around'});

  const rows=await f.dispatch('scripts',{action:'list'}) as any[];
  const mine=rows.find(row=>row.name==='look-around');
  assert.ok(mine?.saved,`the pilot's own scripts are listed too: ${rows.map(row=>row.name).join(', ')}`);
  assert.ok(rows.some(row=>row.name==='gather'&&!row.saved),'beside the shipped ones');
  assert.ok(mine.params.description,'with what it takes, the way a shipped one is listed');
  // The shipped scripts are the worked examples a pilot writes its own from.
  assert.equal((await f.dispatch('scripts',{action:'read',name:'look-around'}) as any).source,OWN_SCRIPT);
  assert.match((await f.dispatch('scripts',{action:'read',name:'gather'}) as any).source,
    /from '\.\.\/jobs\/index\.ts'/);

  const started=await f.dispatch('run',{script:'look-around',params:{}}) as any;
  assert.equal(started.accepted,true);
  assert.equal(started.script,'look-around');
  assert.equal((await idle(f.dispatch)).last.reason,'docked at sol_base');
  rmSync(runtime,{recursive:true,force:true});
});

test('a script that reaches past the barrel is refused at the save, and nothing is written', async () => {
  const runtime=runtimeDir();
  const f=fixture({pilot:()=>PILOT,runtime});
  await assert.rejects(f.dispatch('scripts',{action:'save',name:'sneaky',source:SNEAKY}),/not admissible/);
  assert.equal(existsSync(join(runtime,'scripts','sneaky.ts')),false,'nothing was written');
  await assert.rejects(f.dispatch('run',{script:'sneaky',params:{}}),/Unknown script/);
  // A source run is linted by the same rule, and a shipped name stays the runner's.
  await assert.rejects(f.dispatch('run',{source:SNEAKY,params:{}}),/not admissible/);
  await assert.rejects(f.dispatch('scripts',{action:'save',name:'gather',source:OWN_SCRIPT}),/ships/);
  assert.deepEqual(await f.dispatch('status'),{running:false,last:null},'nothing ever started');
  rmSync(runtime,{recursive:true,force:true});
});

test('a run names one of a script or a source, never both and never neither', async () => {
  const f=fixture({pilot:()=>PILOT,runtime:runtimeDir()});
  await assert.rejects(f.dispatch('run',{params:{}}),/one of script or source/);
  await assert.rejects(f.dispatch('run',{script:'gather',source:OWN_SCRIPT,params:{}}),/one of script or source/);
});

test('scripts lists what the run tool may name, each with the parameters it takes', async () => {
  const rows=await fixture().dispatch('scripts') as any[];
  const names=rows.map(row=>row.name);
  for(const shipped of ['gather','gather-until','stock-up'])
    assert.ok(names.includes(shipped),`${shipped} is dispatchable: ${names.join(', ')}`);
  for(const row of rows) {
    assert.equal(row.params.type,'object');
    assert.ok(row.params.description,row.name);
    assert.ok(Object.keys(row.params.properties).length,row.name);
  }
});

test('scripts commands answers with the real signatures from the library reference', async () => {
  const found=await fixture().dispatch('scripts',{action:'commands',search:'shipyard'}) as any;
  assert.ok(found.matched>=1,`a shipyard command exists in the reference: ${found.matched}`);
  // Signatures, not prose: every line names a command, what it takes and what it answers.
  for(const line of found.lines) {
    assert.match(line,/^- `[a-z_]+\(/,line);
    assert.match(line.toLowerCase(),/shipyard/,line);
  }
  assert.ok(found.lines.some((line:string)=>line.startsWith('- `commission_ship(')),
    `commissioning a hull is reachable: ${found.lines.join(' | ')}`);
  // A search nothing matches is an empty answer, never the whole reference.
  assert.deepEqual(await fixture().dispatch('scripts',{action:'commands',search:'zzzznope'}),
    {search:'zzzznope',matched:0,lines:[]});
});

test('shutdown forces exit within the grace even when the account never finishes closing, and stays idempotent', async () => {
  const account={close:()=>new Promise<void>(()=>{})}; // a real, connected Account can hang here
  const exits:number[]=[];
  let fireGrace:(()=>void)|undefined;
  const schedule=((cb:()=>void)=>{fireGrace=cb;return 0;}) as unknown as typeof setTimeout;
  const shutdown=createShutdown(account,{exit:code=>exits.push(code),schedule,graceMs:2000});
  shutdown();
  await settle();
  assert.deepEqual(exits,[],'close() never resolves and the grace has not elapsed yet');
  fireGrace!(); // the grace timer, not the account, is what ends it
  assert.deepEqual(exits,[0]);
  shutdown(); // a second signal (SIGTERM after SIGINT, stdin close after SIGTERM) changes nothing
  fireGrace?.();
  assert.deepEqual(exits,[0],'already shutting down; no second exit');
});

test('shutdown exits immediately once account.close() resolves, ahead of the grace timer', async () => {
  const account={close:()=>Promise.resolve()};
  const exits:number[]=[];
  const schedule=(()=>0) as unknown as typeof setTimeout; // the grace timer never fires here
  const shutdown=createShutdown(account,{exit:code=>exits.push(code),schedule});
  shutdown();
  await settle();
  assert.deepEqual(exits,[0]);
});

test('the controller lock is taken over from a dead holder and refused to a live one', () => {
  const path=join(mkdtempSync(join(tmpdir(),'spacemolt-lock-')),'controller.lock');
  // A SIGKILLed bridge never ran its unlock; its pid is gone, so the next bridge may run.
  const reaped=spawnSync(process.execPath,['-e','']).pid!;
  writeFileSync(path,JSON.stringify({pid:reaped,started_at:'2026-01-01T00:00:00.000Z'}));
  const unlock=controllerLock(path);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).pid,process.pid,'the live controller owns the lock');
  // A lock whose holder is alive is never stolen: an operator inspects the pilot first.
  assert.throws(()=>controllerLock(path),/EEXIST/);
  unlock();
  assert.equal(existsSync(path),false);
  unlock(); // the exit handler may run after an explicit release
});

test('the journal keeps the outcome of a request and never the body of a read', async () => {
  const f=fixture({pilot:()=>PILOT},['refuel','repair','storage']);
  const where=await f.dispatch('where') as any;
  const kept=journalResult('where',where) as any;
  // Reflection reads a `where` line for where the pilot has been, so that much survives.
  assert.deepEqual([kept.system,kept.poi,kept.docked_at,kept.in_transit],
    [where.system,where.poi,where.docked_at,where.in_transit]);
  assert.ok(kept.bytes>0&&Array.isArray(kept.keys),'the rest is a size and a shape');
  assert.ok(!('pois' in kept)&&!('connections' in kept),'never the rows themselves');
  assert.ok(JSON.stringify(kept).length<JSON.stringify(where).length,
    'a journal line is smaller than the answer it records');

  const store=await f.dispatch('storage') as any;
  assert.deepEqual(Object.keys(journalResult('storage',store) as object),['bytes','keys']);

  // An outcome keeps the fields that say whether the thing happened, and nothing else.
  const status=journalResult('status',{running:false,
    last:{script:'gather',outcome:'done',reason:'docked at sol_base',
      jobs:[{job:'gather',outcome:'done',result:{huge:'x'.repeat(5_000)}}]}}) as any;
  assert.deepEqual(status,{running:false,
    last:{script:'gather',outcome:'done',reason:'docked at sol_base',
      jobs:[{job:'gather',outcome:'done',result:{huge:'x'.repeat(5_000)}}]}},
    'the run record the juncture reads is the outcome itself');
  const run=journalResult('run',{accepted:true,script:'gather',
    jobs:[{job:'gather',outcome:'done',yield:[{item_id:'ore',quantity:12}],
      result:{rows:'x'.repeat(5_000)}}]}) as any;
  assert.deepEqual(run.jobs,[{job:'gather',outcome:'done'}],'a job is what it is and how it went');

  // An action with no rule of its own is written down whole: travel and dock are already small.
  const arrival={arrived:true,location:{system:'sol',poi:'belt',docked_at:null}};
  assert.deepEqual(journalResult('travel',arrival),arrival);
});
