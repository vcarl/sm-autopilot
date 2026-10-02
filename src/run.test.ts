import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from './readiness.ts';
import {check,runPilot} from './run.ts';
import {closeInterrupted,journalCommand,readJournal,readRun,writeRun} from './run-record.ts';
import {bridgeWorld,type WorldOptions} from './test-support/bridge-world.ts';
import {flying} from './bridge.ts';
import {pace} from './play/combat/hunting.ts';

const PILOT={name:'kvothe',mood:'Focused' as const,stance:'Prospector' as const};

function harness(options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-run-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  const deps={account:game.account as unknown as ReadinessAccount,command:game.command,runtime,
    pilot:()=>PILOT,emit:(text:string)=>lines.push(text)};
  const write=(source:string)=>{mkdirSync(join(runtime,'pilot'),{recursive:true});writeFileSync(join(runtime,'pilot','index.ts'),source);};
  return {...game,runtime,lines,deps,write,close:()=>rmSync(runtime,{recursive:true,force:true})};
}

test('a first run installs the example, and the three gates refuse before anything reaches the game',async()=>{
  const f=harness();
  try {
    const first=await check(f.runtime);
    assert.ok(existsSync(join(f.runtime,'pilot','index.ts')),'the example is the pilot\'s first index.ts');
    assert.deepEqual(first.errors,[],first.errors.join('\n'));
    assert.equal(first.ok,true);
    // A type error is caught by tsc, with the lib's own field names.
    f.write("import {orient} from 'play';\nexport default async function main(){ const o=await orient(); return o.detail.present.ship.fule; }\n");
    const typed=await check(f.runtime);
    assert.equal(typed.ok,false);
    assert.match(typed.errors.join('\n'),/tsc: .*fule/);
    // A reach outside the boundary and an uncapped loop are refused too.
    f.write("import {readFileSync} from 'node:fs';\nexport default async function main(){ readFileSync('notes.txt'); }\n");
    assert.match((await check(f.runtime)).errors.join(' '),/tsc: |may import/);
    f.write("import {orient} from 'play';\nexport default async function main(){ while(true){ await orient(); } }\n");
    assert.match((await check(f.runtime)).errors.join(' '),/stopped\(\)/);
    const refused=await runPilot(f.deps);
    assert.equal(refused.accepted,false);
    assert.equal(f.sent.length,0,'nothing reached the game');
    // A refusal is journalled with the program's sha, and the program is kept under that sha, so
    // a reader of the journal can see what was refused and why.
    const logged=readJournal(f.runtime).find(entry=>entry.event==='run'&&entry.phase==='refused')!;
    assert.ok(logged,'the refusal is in the journal');
    assert.match(logged.errors.join(' '),/stopped\(\)/);
    assert.ok(existsSync(join(f.runtime,'programs',`${logged.sha}.ts`)),'the refused program is kept');
  } finally {f.close();}
});

// Live 2026-09-30 (22:43Z run 058d3387) and 10-01 (15:42Z): `import {Outcome} from 'play'` passed tsc,
// then Node's type stripping crashed on the missing export.
test('a type imported as a value is a typecheck refusal, not a crash at load',async()=>{
  const f=harness();
  try {
    f.write("import {Outcome,orient} from 'play';\nexport default async function main():Promise<Outcome|undefined>{ await orient(); return undefined; }\n");
    const gate=await check(f.runtime);
    assert.equal(gate.ok,false);
    assert.match(gate.errors.join('\n'),/Outcome.*type-only import|type-only import.*Outcome/s);
  } finally {f.close();}
});

// Live 2026-09-30/10-01: 11 refusals were `Cannot find name 'stopped'`, an unimported `play` export.
test('a name that is a play export but not imported says so; one that is not, does not',async()=>{
  const f=harness();
  try {
    f.write("export default async function main(){ while(!stopped()){ nothere(); } }\n");
    const errors=(await check(f.runtime)).errors.join('\n');
    assert.match(errors,/Cannot find name 'stopped'.*stopped is exported by 'play': add it to your import/);
    assert.doesNotMatch(errors,/nothere is exported/);
  } finally {f.close();}
});

test('a tsc error carries the offending line, so the pilot need not be sent its own file back',async()=>{
  const f=harness();
  try {
    f.write("import {orient} from 'play';\n"+
      "export default async function main(){ const o=await orient(); return o.detail.present.ship.fule; }\n");
    const gate=await check(f.runtime);
    assert.equal(gate.ok,false);
    const bad=gate.errors.find(line=>/fule/.test(line))!;
    assert.match(bad,/\(2,\d+\)/,'the line and column are still named');
    assert.match(bad,/\n    2 \| .*o\.detail\.present\.ship\.fule/,bad);
  } finally {f.close();}
});

test('the run summary says how the run ended, not how its first call did',async()=>{
  const f=harness();
  try {
    // A trip that lands, then a partial the pilot returns: the summary used to read `done`
    // off goTo and the menu's stagnation checks never saw the run give up.
    f.write("import {goTo, outcome} from 'play';\n"+
      "export default async function main(){ await goTo('belt'); return outcome('gave up at the belt','partial'); }\n");
    const result=await runPilot(f.deps);
    assert.equal(result.status,'partial');
    const work=readJournal(f.runtime).find(entry=>entry.phase==='ended')!.work;
    assert.equal(work.fn,'goTo');
    assert.equal(work.status,'partial',JSON.stringify(work));
  } finally {f.close();}
});

// Live 2026-09-29 (kvothe 17:38Z): a paying trip returned completeMissions()'s refusal, and
// the trip itself was journalled `refused`.
test('a later call that refused does not stamp its refusal on the work call',async()=>{
  const f=harness();
  try {
    f.write("import {goTo, completeMissions} from 'play';\n"+
      "export default async function main(){ await goTo('belt'); return completeMissions(); }\n");
    const result=await runPilot(f.deps);
    assert.equal(result.status,'refused');
    const work=readJournal(f.runtime).find(entry=>entry.phase==='ended')!.work;
    assert.equal(work.fn,'goTo');
    assert.equal(work.status,'done',JSON.stringify(work));
  } finally {f.close();}
});

// A work call that refused (hold full) followed by one that paid off: the run's real ending
// (`done`) is not worse than the work call's own `refused`, so the run's status wins and the
// stale refusal is not stamped on a run that actually earned credits.
test('a paying call after a refused one lifts the summary off the stale refusal',async()=>{
  const f=harness({cargoUsed:5});
  try {
    f.write("import {sell} from 'play';\n"+
      "export default async function main(){ await sell([]); return sell([{item_id:'ore',quantity:5}]); }\n");
    const result=await runPilot(f.deps);
    assert.equal(result.status,'done');
    const work=readJournal(f.runtime).find(entry=>entry.phase==='ended')!.work;
    assert.equal(work.fn,'sell');
    assert.equal(work.status,'done',JSON.stringify(work));
  } finally {f.close();}
});

// Live 2026-09-28 (kvothe L6045): a buy/craft/sell run was labelled `quote`, its first call.
test('the run summary names the first work call, past the reads that planned it',async()=>{
  const f=harness();
  try {
    f.write("import {goTo, quote, recipes} from 'play';\n"+
      "export default async function main(){ await recipes(); await quote('refine_ore'); return goTo('belt'); }\n");
    await runPilot(f.deps);
    const work=readJournal(f.runtime).find(entry=>entry.phase==='ended')!.work;
    assert.equal(work.fn,'goTo',JSON.stringify(work));
  } finally {f.close();}
});

// Live 2026-09-28 (kvothe L5277): a program returned a hand-built Outcome with `gained: {}` and
// `now: null`; rendering it threw, and the run never journalled its end.
test('a hand-built, malformed Outcome still ends the run, journalled and recorded',async()=>{
  const f=harness();
  try {
    f.write("export default async function main(){ return {status:'done',did:'catalog probe complete',why:'',cost:{},gained:{},now:null,next:['look again'],detail:{probed:true}} as any; }\n");
    const result=await runPilot(f.deps);
    assert.equal(result.accepted,true);
    assert.equal(result.status,'done',result.why);
    assert.equal(result.reason,'catalog probe complete');
    assert.match(result.prose!,/look again/);
    const ended=readJournal(f.runtime).find(entry=>entry.phase==='ended');
    assert.ok(ended,'run/ended is journalled');
    assert.equal(ended.outcome,'done');
    assert.equal(readRun(f.runtime)!.ended,true);
  } finally {f.close();}
});

test('a run whose report cannot be rendered still journals its end, with the error as the reason',async()=>{
  const f=harness();
  try {
    // A getter that throws: no normalisation can make every shape safe to render.
    f.write("import {outcome} from 'play';\nexport default async function main(){ const o=outcome('probed'); Object.defineProperty(o.now,'location',{get(){ throw new Error('boom'); }}); return o; }\n");
    const result=await runPilot(f.deps);
    assert.equal(result.accepted,true);
    const ended=readJournal(f.runtime).find(entry=>entry.phase==='ended');
    assert.ok(ended,'run/ended is journalled');
    assert.match(ended.why,/report.*boom/);
    assert.equal(readRun(f.runtime)!.ended,true);
  } finally {f.close();}
});

test('a run streams a line per move (journalled first), ends with the prose and writes the record',async()=>{
  const f=harness();
  try {
    f.write("import {goTo, service, stow, note} from 'play';\n"+
      "export default async function main(){ note('off to the belt'); const t=await goTo('belt'); if(t.status!=='done') return t; await goTo('sol_base'); return service(); }\n");
    const result=await runPilot({...f.deps,started:undefined} as any);
    assert.equal(result.accepted,true);
    assert.equal(result.status,'done',result.reason);
    assert.match(f.lines[0]!,/^run started .* index\.ts sha [0-9a-f]{12}  mood Focused  stance Prospector$/);
    assert.ok(f.lines.includes('✎ off to the belt'),'note() streams');
    assert.ok(f.lines.some(line=>line.startsWith('▶ goTo belt')),f.lines.join('\n'));
    assert.ok(f.lines.some(line=>/^✓ goTo  done/.test(line)));
    assert.ok(f.lines.some(line=>line.startsWith('Done: ')),'the prose report is streamed last');
    assert.match(f.lines.at(-1)!,/^run ended  done  \d+ commands$/);
    // Every streamed line was written to the journal before it was sent.
    const journalled=readJournal(f.runtime).filter(entry=>entry.event==='line').map(entry=>entry.text);
    assert.deepEqual(journalled,f.lines);
    const record=readRun(f.runtime)!;
    assert.equal(record.ended,true);
    assert.equal((record.outcome as any).status,'done');
    assert.equal(f.account.server.location.docked_at,'sol_base');
    assert.match(readFileSync(join(f.runtime,'gameplay.jsonl'),'utf8'),/"phase":"ended"/);
  } finally {f.close();}
});

// Live 2026-09-25: the 22:20 death happened in four minutes of dead air *after* the script
// returned. The pilot is blind between runs, so a fight left running when a run ends is
// unattended combat, and a silent return is the bug.
test('a run that would hand back with a battle live breaks it off and says so',async()=>{
  pace.tickMs=1;
  const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};
  const f=harness({wildlife:{creatures:[grazer],polls:30,damage:0,fleeTicks:1}});
  try {
    f.write("import {orient} from 'play';\nexport default async function main(){ return orient(); }\n");
    // The battle the previous shift left running, which the script itself never touches.
    await f.command('spacemolt/hunt',{id:'c1'});
    const out=await runPilot(f.deps);
    assert.equal(out.accepted,true,out.errors?.join('\n'));
    assert.match(f.lines.join('\n'),/the run returned with a battle still live against Molt Grazer/);
    assert.match(out.why!,/broken off before the run closed/);
    // And the proof: the ship moves again, which a live battle refuses `in_battle`.
    await f.command('spacemolt/travel',{id:'belt'});
    assert.equal(f.account.server.location.poi_id,'belt');
  } finally {f.close();pace.tickMs=10_000;}
});

test('a pilot with no stance runs its script, and the script can bring the ship up',async()=>{
  // Live 2026-09-26 (kvothe): a fresh pilot had a mood and no stance, every run was refused for
  // want of a stance, so it could never service, and rest (which needed a serviced ship) could
  // never open the shift that would admit the run. Nothing about a missing stance stops a run now.
  const f=harness();
  try {
    f.account.server.ship.fuel=10;
    await f.account.refresh();
    const record={name:'kvothe'};
    f.write("import {rest} from 'play';\nexport default async function main(){ return rest(); }\n");
    const result=await runPilot({...f.deps,pilot:()=>flying(record,f.account.state as never)});
    assert.equal(result.accepted,true,result.errors?.join('\n'));
    assert.equal(result.status,'done',`${result.reason}: ${result.why}`);
    assert.match(f.lines[0]!,/mood Tired  stance none$/,'the header says what the derived mood was');
    assert.equal(f.account.server.ship.fuel,f.account.server.ship.max_fuel,'the ship was refuelled');
    assert.ok(f.sent.some(c=>c.action==='spacemolt/refuel'));
    assert.ok(f.lines.some(line=>/tired cleared: back inside the Cautious margins/.test(line)),f.lines.join('\n'));
  } finally {f.close();}
});

// Tired is the guarantee the ship gets resupplied, and it must not rest on the script remembering
// to write service(): the runtime brings the ship up itself at the next work helper, and the work
// then goes on.
test('a script that crosses the fuel reserve and never services is resupplied by the runtime',async()=>{
  const f=harness();
  try {
    let drained=false;
    const command:typeof f.command=async(action,params)=>{
      const res=await f.command(action,params);
      if(action==='spacemolt/buy'&&!drained){drained=true;f.account.server.ship.fuel=20;}
      return res;
    };
    f.write("import {buy} from 'play';\nexport default async function main(){ for(let i=0;i<3;i++) await buy('ore',1); }\n");
    const who=()=>flying(PILOT,f.account.state as never);
    const result=await runPilot({...f.deps,command,pilot:who});
    assert.equal(result.accepted,true,result.errors?.join('\n'));
    assert.equal(f.sent.filter(c=>c.action==='spacemolt/buy').length,3,'the work went on once the ship was up');
    assert.ok(f.sent.some(c=>c.action==='spacemolt/refuel'),'the runtime refuelled');
    assert.equal(f.account.server.ship.fuel,f.account.server.ship.max_fuel);
    assert.equal(who().mood,'Focused');
    const resupplied=readJournal(f.runtime).filter(entry=>entry.event==='resupply');
    assert.ok(resupplied.some(entry=>entry.cleared===true),JSON.stringify(resupplied));
  } finally {f.close();}
});

// A script that ends Tired and away from a counter leaves no one to fly it home: the run does.
test('a run that ends Tired and undocked flies to a serviced base and services there',async()=>{
  const f=harness();
  try {
    f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    f.account.server.ship.fuel=15;
    await f.account.refresh();
    f.write("export default async function main(){}\n");
    const who=()=>flying(PILOT,f.account.state as never);
    const result=await runPilot({...f.deps,pilot:who});
    assert.equal(result.accepted,true,result.errors?.join('\n'));
    assert.equal(f.account.server.location.docked_at,'sol_base');
    assert.equal(f.account.server.ship.fuel,f.account.server.ship.max_fuel);
    assert.equal(who().mood,'Focused');
    const resupplied=readJournal(f.runtime).filter(entry=>entry.event==='resupply');
    assert.ok(resupplied.some(entry=>entry.cleared===true&&entry.base==='sol_base'),JSON.stringify(resupplied));
  } finally {f.close();}
});

// Away from a counter with too little fuel to reach one, the cells aboard are the way out: the
// runtime burns them, then flies to a base and services there.
test('a run that ends Tired in space short of any base burns its cells, then reaches a counter',async()=>{
  const f=harness({cargo:[{item_id:'fuel_cell',quantity:2}],cargoUsed:2,cargoCapacity:50});
  try {
    f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    // 2 fuel reaches nothing (a hop is 7); two 5-fuel cells make 12, still under the reserve 24.
    f.account.server.ship.fuel=2;
    await f.account.refresh();
    f.write("export default async function main(){}\n");
    const who=()=>flying(PILOT,f.account.state as never);
    const result=await runPilot({...f.deps,pilot:who});
    assert.equal(result.accepted,true,result.errors?.join('\n'));
    const journal=readJournal(f.runtime);
    const burned=journal.filter(entry=>entry.event==='fuel_cell');
    assert.deepEqual(burned.map(entry=>[entry.burned,entry.fuel_before,entry.fuel_after,entry.cells_left]),[[2,2,12,0]]);
    assert.equal(f.account.server.location.docked_at,'sol_base');
    assert.equal(who().mood,'Focused');
  } finally {f.close();}
});

test('a run past its wall-clock cap is asked to stop, then cut off, and the record is closed',async()=>{
  const f=harness();
  try {
    f.write("export default async function main(){ await new Promise(()=>{}); }\n");
    const result=await runPilot({...f.deps,capMs:20,graceMs:20});
    assert.equal(result.status,'partial');
    assert.equal(result.abandoned,true,'the bridge is told to exit');
    assert.match(f.lines.join('\n'),/wall-clock cap/);
    assert.equal(readRun(f.runtime)?.ended,true,'run.json was left open');
    const ended=readJournal(f.runtime).find(entry=>entry.phase==='ended')!;
    assert.equal(ended.abandoned,true);
  } finally {f.close();}
});

test('a promise the program left unawaited ends the run failed with its error, and the process lives',async()=>{
  const f=harness();
  // The test runner's own listener would claim the rejection; the bridge has none, so neither may this.
  const runner=process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  try {
    f.write("export default async function main(){ void Promise.reject(new Error('No response to spacemolt/get_active_missions')); await new Promise(()=>{}); }\n");
    const result=await runPilot({...f.deps,capMs:5000,graceMs:100});
    assert.equal(process.listenerCount('unhandledRejection'),0,'outside a run the process is left as it was');
    for(const fn of runner)process.on('unhandledRejection',fn);
    assert.equal(result.status,'failed');
    assert.match(result.why!,/unhandled rejection: No response to spacemolt\/get_active_missions/);
    const ended=readJournal(f.runtime).find(entry=>entry.phase==='ended')!;
    assert.equal(ended.outcome,'failed');
    assert.match(ended.why,/get_active_missions/);
  } finally {
    if(!process.listenerCount('unhandledRejection'))for(const fn of runner)process.on('unhandledRejection',fn);
    f.close();
  }
});

test('a run a dead bridge left open is closed as interrupted at boot, and nothing is re-run',()=>{
  const f=harness();
  try {
    writeRun(f.runtime,{script:'index.ts',source:'abc123abc123',started:'2026-09-26T18:00:00.000Z',ended:false});
    // The dead bridge's log, rotated aside at this boot: its last error line is the cause.
    writeFileSync(join(f.runtime,'bridge.stderr.2026-09-26T18-05-00Z.log'),
      "[bridge] booting\n    const timer = setTimeout(() => reject(new SpacemoltError('x')), ms);\n"+
      "SpacemoltError: No response to spacemolt/get_active_missions within 15000ms\n    at Timeout._onTimeout (lib.js:1:1)\n");
    writeFileSync(join(f.runtime,'bridge.stderr.log'),'[bridge] booting\n');
    const closed=closeInterrupted(f.runtime);
    assert.equal(closed?.ended,true);
    assert.equal((readRun(f.runtime)!.outcome as any).status,'interrupted');
    const ended=readJournal(f.runtime).find(entry=>entry.phase==='ended')!;
    assert.equal(ended.outcome,'interrupted');
    assert.equal(ended.why,'SpacemoltError: No response to spacemolt/get_active_missions within 15000ms');
    assert.equal(f.sent.length,0,'nothing was sent to the game');
    assert.equal(closeInterrupted(f.runtime),null,'an ended record is left alone');
  } finally {f.close();}
});

test('telemetry: a run stamps its id on its command lines, and journals its states and its calls with costs',async()=>{
  const f=harness();
  try {
    const deps={...f.deps,juncture:{juncture_id:'j1',at:new Date(Date.now()-5000).toISOString()},
      command:async(action:string,params:Record<string,unknown>)=>{
        const reply=await f.command(action,params);journalCommand(f.runtime,action,params,true,reply);return reply;}};
    f.write("import {goTo} from 'play';\nexport default async function main(){ return goTo('belt'); }\n");
    await runPilot(deps);
    const journal=readJournal(f.runtime);
    const started=journal.find(entry=>entry.phase==='started')!,ended=journal.find(entry=>entry.phase==='ended')!;
    const commands=journal.filter(entry=>entry.event==='command');
    assert.ok(commands.length&&commands.every(entry=>entry.run_id===started.run_id),JSON.stringify(commands[0]));
    assert.equal(started.juncture_id,'j1');
    assert.ok(started.since_juncture_s>=5);
    for(const state of [started.start_state,ended.end_state])
      for(const key of ['credits','fuel','max_fuel','hull','max_hull','cargo_used','cargo_capacity','cargo','skills','system','poi','docked_at'])
        assert.ok(key in state,`${key} in ${JSON.stringify(state)}`);
    assert.equal(ended.run_id,started.run_id);
    const call=ended.calls[0];
    assert.equal(call.fn,'goTo');
    assert.ok('credits' in call.cost&&'fuel' in call.cost&&'items' in call.gained&&call.started_at&&call.seconds>=0,JSON.stringify(call));
  } finally {f.close();}
});
