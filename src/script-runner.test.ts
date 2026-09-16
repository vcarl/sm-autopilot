import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ReadinessAccount} from './readiness.ts';
import type {Facts} from './rules-table.ts';
import {readRun,readJournal} from './run-record.ts';
import {runScript,sourceLabel,type RunOptions,type RunOutcome} from './script-runner.ts';
import {bridgeWorld,type WorldOptions} from './test-support/bridge-world.ts';

const HOME='sol_base';
/** A pilot fit to work: docked at a base with a counter, nothing threatening in sight. */
const facts=(over:Partial<Facts>={}):Facts=>({
  stance:'Prospector',mood:'Focused',
  place:{kind:'base',base_id:HOME,is_home:true,counters:['Services','Storage']},
  holdings:{fuel:100,max_fuel:120,hull:96,max_hull:100,cargo_free:12,credits:1_000},
  obligations:{},permissions:{},observed:{},...over});

function runner(world:WorldOptions={},over:Partial<RunOptions>={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],...world});
  const runtime=mkdtempSync(join(tmpdir(),'script-runner-'));
  const records:any[]=[];
  const run=(script:string,params:Record<string,unknown>,extra:Partial<RunOptions>={}) =>
    runScript({account:game.account as unknown as ReadinessAccount,command:game.command,
      script,params,facts:async()=>facts(),mood:'Focused',home:HOME,runtime,
      onProgress:step=>records.push(step),...over,...extra});
  return {...game,runtime,records,run,
    record:()=>readRun(runtime),
    lines:(event:string)=>readJournal(runtime).filter(entry=>entry.event===event),
    close:()=>rmSync(runtime,{recursive:true,force:true})};
}

test('the gather script runs one job dock to dock and reports one outcome', async () => {
  const f=runner({cargoUsed:0,store:[]});
  try {
    const outcome=await f.run('gather',{poi_id:'belt'});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.script,'gather');
    assert.deepEqual(outcome.jobs.map(job=>[job.job,job.outcome]),[['gather','done']]);
    // The take is the cargo delta, never the reply's claim of 99, and it is in the store.
    assert.deepEqual(outcome.jobs[0]!.yield,[{item_id:'ore',quantity:12}]);
    assert.deepEqual(f.store,[{item_id:'ore',quantity:12}]);
    assert.deepEqual(f.account.server.location,
      {system_id:'sol',poi_id:'station',docked_at:HOME,in_transit:false});
    assert.deepEqual([f.account.server.ship.fuel,f.account.server.ship.hull],[120,100]);
    // The record closes with the outcome on it, and the journal says the run began and ended.
    const record=f.record()!;
    assert.equal(record.ended,true);
    assert.equal(record.script,'gather');
    assert.equal((record.outcome as any).outcome,'done');
    assert.deepEqual(f.lines('run').map(line=>line.phase),['started','ended']);
  } finally {f.close();}
});

test('a composed script runs gather until the store holds what it was asked for', async () => {
  // Four in the store, twelve a trip: one trip is short of twenty, two are not.
  const f=runner({cargoUsed:0,store:[{item_id:'ore',quantity:4}]});
  try {
    const outcome=await f.run('gather-until',
      {poi_id:'belt',item_id:'ore',quantity:20,max_runs:5});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.jobs.length,2,'the third read found the store full enough');
    assert.equal(f.count('spacemolt/undock'),2);
    assert.deepEqual(f.store,[{item_id:'ore',quantity:28}]);
  } finally {f.close();}

  // A store that already holds enough is a script that makes no trip at all.
  const g=runner({cargoUsed:0,store:[{item_id:'ore',quantity:99}]});
  try {
    const outcome=await g.run('gather-until',
      {poi_id:'belt',item_id:'ore',quantity:16,max_runs:5});
    assert.equal(outcome.outcome,'done');
    assert.deepEqual(outcome.jobs,[]);
    assert.equal(g.count('spacemolt/undock'),0,'nothing left the dock');
  } finally {g.close();}
});

test('the stow script deposits the hold at the counter and says so in the run outcome', async () => {
  // The hold the pilot has been carrying: a full hold, at a base with a store, and no trip.
  const f=runner({cargoUsed:12,store:[]});
  try {
    const outcome=await f.run('stow',{});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.script,'stow');
    assert.match(outcome.reason!,/stowed 1 item at sol_base: 12 ore/);
    assert.deepEqual((outcome.result as any).remaining,[]);
    assert.equal((outcome.result as any).cargo_free,12);
    assert.deepEqual(f.store,[{item_id:'ore',quantity:12}]);
    assert.equal(f.count('spacemolt/undock'),0,'a counter is not a trip');
    // Run it again on the hold it emptied: nothing to stow, and nothing sent.
    const again=await f.run('stow',{});
    assert.equal(again.outcome,'done',again.reason);
    assert.match(again.reason!,/nothing to stow at sol_base/);
    assert.equal(f.count('spacemolt_storage/deposit'),1);
  } finally {f.close();}
});

test('the withdraw script takes the store into the hold and says so in the run outcome', async () => {
  // Stow's inverse at the same counter: an empty hold, and ore in the store here.
  const f=runner({cargoUsed:0,store:[{item_id:'ore',quantity:5}]});
  try {
    const outcome=await f.run('withdraw',{items:[{item_id:'ore',quantity:3}]});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.script,'withdraw');
    assert.match(outcome.reason!,/withdrew 3 ore at sol_base/);
    assert.equal((outcome.result as any).cargo_free,9);
    assert.deepEqual(f.store,[{item_id:'ore',quantity:2}]);
    assert.equal(f.count('spacemolt/undock'),0,'a counter is not a trip');
    // Ask for what the store no longer holds: done, nothing sent, and the reason says why.
    const again=await f.run('withdraw',{items:[{item_id:'ice',quantity:4}]});
    assert.equal(again.outcome,'done',again.reason);
    assert.match(again.reason!,/nothing to withdraw at sol_base: ice not in store/);
    assert.equal(f.count('spacemolt_storage/withdraw'),1);
  } finally {f.close();}
});

test('the craft script runs one job at the bench and its sentence reaches the run outcome', async () => {
  const f=runner({cargoUsed:0,services:['refuel','repair','storage','crafting'],
    store:[{item_id:'iron_ore',quantity:20}]});
  try {
    const outcome=await f.run('craft',{recipe_id:'refine_steel',quantity:2});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.script,'craft');
    assert.deepEqual(outcome.jobs.map(job=>[job.job,job.outcome]),[['craft','done']]);
    assert.match(outcome.reason!,/Refine Steel: 1 run, 2 steel_plate, cost 19 at sol_base/);
    assert.deepEqual((outcome.result as any).produced,[{item_id:'steel_plate',quantity:2}]);
    assert.equal((outcome.result as any).job_id,'job-1');
    // The output is in the store and the inputs are not: the craft sold and withdrew nothing.
    assert.deepEqual(f.store,[{item_id:'iron_ore',quantity:15},{item_id:'steel_plate',quantity:2}]);
    assert.equal(f.count('spacemolt/sell'),0);
  } finally {f.close();}
});

test('the hunt script takes one fight and its sentence reaches the run outcome', async () => {
  const f=runner({cargoUsed:0,store:[],
    wildlife:{creatures:[{creature_id:'crt_1',species:'veil_ray',speed:2}]}});
  try {
    const outcome=await f.run('hunt',{poi_id:'belt'});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.equal(outcome.script,'hunt');
    assert.deepEqual(outcome.jobs.map(job=>[job.job,job.outcome]),[['hunt','done']]);
    assert.match(outcome.reason!,/hunted 1 at belt: 1 creature_carapace, hull 96→100, stowed at sol_base/);
    assert.deepEqual((outcome.result as any).targets,
      [{species:'veil_ray',outcome:'down',hull_before:96,hull_after:96}]);
    // The loot is in the store, and nothing was sold or towed to get it there.
    assert.deepEqual(f.store,[{item_id:'creature_carapace',quantity:1}]);
    assert.equal(f.count('spacemolt/sell'),0);
  } finally {f.close();}
});

test('the rules between jobs end the script, with the jobs after it unrun', async () => {
  const f=runner({cargoUsed:0,store:[]});
  try {
    // The first trip is fine; the pilot comes home Tired, and Tired starts no job.
    let calls=0;
    const outcome=await f.run('gather-until',
      {poi_id:'belt',item_id:'ore',quantity:99,max_runs:5},
      {facts:async()=>facts(++calls>1?{mood:'Tired'}:{})});
    assert.equal(outcome.outcome,'blocked',outcome.reason);
    assert.match(outcome.reason!,/Tired/);
    assert.equal(outcome.jobs.length,1,'the second job never started');
    assert.equal(f.count('spacemolt/undock'),1);
    assert.equal((f.record()!.outcome as any).outcome,'blocked');
  } finally {f.close();}
});

test('a run interrupted by a restart is re-run to completion, mining nothing twice', async () => {
  const f=runner({cargoUsed:0,store:[]});
  try {
    // The first runner got the whole trip done and died before it could close the record.
    const first=await f.run('gather',{poi_id:'belt'});
    assert.equal(first.outcome,'done',first.reason);
    const mined=f.count('spacemolt/mine'),undocks=f.count('spacemolt/undock');
    assert.ok(mined>0);
    const interrupted={...f.record()!,ended:false};
    delete interrupted.outcome;

    const again=await f.run('gather',{poi_id:'belt'},{resume:interrupted});
    assert.equal(again.outcome,'done',again.reason);
    // Every step's end state already held, so the re-run sent nothing: no second departure,
    // no second mine, and the store still holds one trip's take.
    assert.equal(f.count('spacemolt/mine'),mined,'the hold was already full of nothing to mine again');
    assert.equal(f.count('spacemolt/undock'),undocks,'the re-run never left the dock');
    assert.deepEqual(f.store,[{item_id:'ore',quantity:12}]);
    // The re-run kept the run's identity: it is the same started stamp, not a new run.
    assert.equal(f.record()!.started,interrupted.started);
  } finally {f.close();}
});

test('a run of a script the pilot wrote is re-run from the record after a restart', async () => {
  // The pilot's own trip: the barrel's gather under a name and a sentence of its own.
  const source="import {gather,type Ctx,type JobOutcome} from '../jobs/index.ts';\n"+
    "export const params={type:'object',properties:{poi_id:{type:'string'}},required:['poi_id']};\n"+
    'export default async (ctx:Ctx,args:{poi_id:string}):Promise<JobOutcome>=>{\n'+
    "const out=await gather(ctx,args);return {job:'my-run',outcome:out.outcome,reason:'my own trip'};};\n";
  const label=sourceLabel(source);
  const f=runner({cargoUsed:0,store:[]});
  try {
    const first=await f.run(label,{poi_id:'belt'},{source});
    assert.equal(first.outcome,'done',first.reason);
    assert.equal(first.script,label,'a source run is named by its hash, not by its text');
    const kept=f.record()!;
    assert.equal(kept.source,source,'the record keeps the script, because nothing else has it');
    const mined=f.count('spacemolt/mine'),undocks=f.count('spacemolt/undock');

    // The restart: the runner that wrote the file is gone, and so is what it wrote.
    rmSync(join(f.runtime,'scripts'),{recursive:true,force:true});
    const interrupted={...kept,ended:false};
    delete interrupted.outcome;
    const again=await f.run(label,{poi_id:'belt'},{source:interrupted.source,resume:interrupted});
    assert.equal(again.outcome,'done',again.reason);
    assert.equal(again.reason,'my own trip','the very script the record held ran again');
    assert.equal(f.count('spacemolt/mine'),mined,'and nothing was mined twice');
    assert.equal(f.count('spacemolt/undock'),undocks,'the re-run never left the dock');
    assert.equal(f.record()!.started,interrupted.started,'the same run, not a new one');
  } finally {f.close();}
});

test('a script that fails the lint is refused before any command reaches the game', async () => {
  const dir=mkdtempSync(join(tmpdir(),'script-lint-'));
  writeFileSync(join(dir,'sneaky.ts'),
    "import {readFileSync} from 'node:fs';\nexport const params={type:'object',properties:{}};\n"+
    'export default async ()=>{readFileSync("/etc/passwd");};\n');
  const f=runner();
  try {
    await assert.rejects(
      f.run('sneaky',{},{scriptsDir:pathToFileURL(`${dir}/`)}),
      /not admissible/);
    assert.deepEqual(f.sent,[],'nothing was sent to the game');
    assert.equal(f.record(),null,'and no run was ever written down');
  } finally {f.close();rmSync(dir,{recursive:true,force:true});}
});

test('what a script returns is the run outcome, unless the world already said otherwise', async () => {
  const dir=mkdtempSync(join(tmpdir(),'script-said-'));
  const write=(name:string,body:string)=>writeFileSync(join(dir,`${name}.ts`),
    `export const params={type:'object',properties:{}};\nexport default async ()=>(${body});\n`);
  write('spoke',"{job:'spoke',outcome:'done',reason:'twelve ore at sol_base',result:{held:12,skip:()=>1}}");
  write('unhappy',"{job:'unhappy',outcome:'failed',reason:'the store never filled'}");
  writeFileSync(join(dir,'denial.ts'),
    "export const params={type:'object',properties:{}};\n"+
    "export default async (ctx)=>{ctx.jobs.push({job:'gather',outcome:'blocked',"+
    "reason:'the site gives no more'});return {job:'denial',outcome:'done',reason:'all fine'};};\n");
  const f=runner({cargoUsed:0,store:[]});
  const scriptsDir=pathToFileURL(`${dir}/`);
  try {
    // A script's own sentence replaces the derived one, and its numbers reach the juncture.
    const spoke=await f.run('spoke',{},{scriptsDir});
    assert.equal(spoke.outcome,'done');
    assert.equal(spoke.reason,'twelve ore at sol_base');
    assert.deepEqual(spoke.result,{held:12},'what JSON cannot carry never reaches the agent');

    // A script that ran every job and still calls the run a failure is believed.
    const unhappy=await f.run('unhappy',{},{scriptsDir});
    assert.equal(unhappy.outcome,'failed');
    assert.equal(unhappy.reason,'the store never filled');

    // But a job that did not finish outranks anything the script says about it.
    const denial=await f.run('denial',{},{scriptsDir});
    assert.equal(denial.outcome,'blocked');
    assert.match(denial.reason!,/the site gives no more/);
    assert.ok(!/all fine/.test(denial.reason!),'the script does not talk over the world');
  } finally {f.close();rmSync(dir,{recursive:true,force:true});}
});

test('the wall clock cap ends a run that will not finish', async () => {
  const dir=mkdtempSync(join(tmpdir(),'script-slow-'));
  writeFileSync(join(dir,'forever.ts'),
    "export const params={type:'object',properties:{}};\n"+
    'export default async ()=>{await new Promise(()=>{});};\n');
  const f=runner();
  try {
    const outcome:RunOutcome=await f.run('forever',{},
      {scriptsDir:pathToFileURL(`${dir}/`),capMs:100});
    assert.equal(outcome.outcome,'failed');
    assert.match(outcome.reason!,/timeout/);
    assert.deepEqual(outcome.jobs,[]);
    assert.equal(f.record()!.ended,true,'the record closes: the next runner has nothing to resume');
  } finally {f.close();rmSync(dir,{recursive:true,force:true});}
});

test("a script's own outcome is a job outcome, and its result reaches the juncture", async () => {
  const f=runner({cargoUsed:0,store:[{item_id:'ore',quantity:4}]});
  try {
    const outcome=await f.run('gather-until',
      {poi_id:'belt',item_id:'ore',quantity:16,max_runs:5});
    assert.equal(outcome.outcome,'done',outcome.reason);
    // The numbers the script counted are the run's, carried whole from what it returned.
    assert.deepEqual(outcome.result,{held:16,target:16,trips:1});
  } finally {f.close();}
});

test('a script composes another script: one entry in the job list, its trips inside it', async () => {
  // Four in the store, twelve a trip: twenty-eight is two trips, fifty-two is two more.
  const f=runner({cargoUsed:0,store:[{item_id:'ore',quantity:4}]});
  try {
    const outcome=await f.run('stock-up',{poi_id:'belt',max_runs:5,
      targets:[{item_id:'ore',quantity:28},{item_id:'ore',quantity:52}]});
    assert.equal(outcome.outcome,'done',outcome.reason);
    // Two calls to gather-until, so two entries under that name — not the four trips they made.
    assert.deepEqual(outcome.jobs.map(job=>job.job),['gather-until','gather-until']);
    assert.equal(f.count('spacemolt/undock'),4,'four trips left the dock');
    // The inner script's own jobs travel inside its one outcome, where a reader can open them.
    for(const job of outcome.jobs)
      assert.deepEqual((job.result!.jobs as any[]).map(inner=>inner.job),['gather','gather']);
    // And the run's result is the outer script's account: one row per target it was given.
    assert.deepEqual(outcome.result!.stocked,
      [{item_id:'ore',held:28,target:28,trips:2},{item_id:'ore',held:52,target:52,trips:2}]);
    assert.deepEqual(f.store,[{item_id:'ore',quantity:52}]);
  } finally {f.close();}
});

test('a run that ends raises the next juncture, and a wake that fails changes nothing (N4)', async () => {
  const f=runner({cargoUsed:0,store:[]});
  const before=process.env.SPACEMOLT_WAKE;
  const argv=['/usr/bin/python3','/plugins/spacemolt/wake_juncture.py'];
  process.env.SPACEMOLT_WAKE=JSON.stringify(argv);
  const asked:string[][]=[],phasesWhenAsked:string[][]=[];
  try {
    const outcome=await f.run('gather',{poi_id:'belt'},{wake:seen=>{
      asked.push(seen);
      phasesWhenAsked.push(f.lines('run').map(line=>String(line.phase)));
      throw new Error('no such interpreter');
    }});
    // The wake is the argv Python handed the bridge, asked for exactly once.
    assert.deepEqual(asked,[argv]);
    // And asked for after the run was written down: what the juncture reads is already there.
    assert.deepEqual(phasesWhenAsked[0],['started','ended']);
    assert.equal(f.record()!.ended,true);
    assert.deepEqual(f.lines('log').map(line=>[line.job,line.message]),[['gather','juncture raised']]);
    // A wake that throws is the wake's problem: the run still ended the way it ended.
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.deepEqual(outcome.jobs.map(job=>job.outcome),['done']);
  } finally {
    if(before===undefined)delete process.env.SPACEMOLT_WAKE;else process.env.SPACEMOLT_WAKE=before;
    f.close();
  }
});

test('a run that fails inside a minute leaves its juncture to the schedule', async () => {
  const f=runner({cargoUsed:0,store:[]});
  const before=process.env.SPACEMOLT_WAKE;
  process.env.SPACEMOLT_WAKE=JSON.stringify(['/usr/bin/python3','/plugins/spacemolt/wake_juncture.py']);
  const asked:string[][]=[];
  try {
    const outcome=await f.run('gather',{poi_id:'nowhere'},{wake:seen=>{asked.push(seen);}});
    assert.notEqual(outcome.outcome,'done');
    assert.deepEqual(asked,[]);
    assert.deepEqual(f.lines('log').map(line=>String(line.message)),['juncture left to the schedule: failed inside a minute']);
  } finally {
    if(before===undefined)delete process.env.SPACEMOLT_WAKE;else process.env.SPACEMOLT_WAKE=before;
    f.close();
  }
});

test('a gather writes a step line per rung, and the run record advances with it (N22)', async () => {
  const f=runner({cargoUsed:0,store:[]});
  try {
    const outcome=await f.run('gather',{poi_id:'belt'});
    assert.equal(outcome.outcome,'done',outcome.reason);
    assert.deepEqual(f.lines('step').map(line=>[line.job,line.step,line.outcome]),
      [['gather','travel','done'],['gather','mine','done'],['gather','return','done'],
        ['gather','dock','done'],['gather','settle','done'],['gather','service','done'],
        ['gather','verify','done']]);
    // The numbers, not the reply bodies: the mine step carries the cargo delta and the
    // settle step carries what actually reached the store.
    const mine=f.lines('step').find(line=>line.step==='mine')!;
    assert.deepEqual(mine.yield,[{item_id:'ore',quantity:12}]);
    const settle=f.lines('step').find(line=>line.step==='settle')!;
    assert.deepEqual([settle.base_id,settle.yield],[HOME,[{item_id:'ore',quantity:12}]]);
    assert.ok(f.lines('step').every(line=>JSON.stringify(line).length<300),
      'a step line is ids and quantities, never a response body');

    // The record advanced through the same rungs while the run was in flight, so a restart
    // at any point would have found the step the runner was on.
    const advanced=f.records.map(record=>record.last_step).filter(Boolean);
    assert.deepEqual([...new Set(advanced)],
      ['travel','mine','return','dock','settle','service','verify']);
  } finally {f.close();}
});
