import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from './readiness.ts';
import {check,runPilot} from './run.ts';
import {readJournal,readRun} from './run-record.ts';
import {bridgeWorld,type WorldOptions} from './test-support/bridge-world.ts';
import {pace} from './play/combat/hunting.ts';

const PILOT={name:'kvothe',mood:'Focused' as const,stance:'Prospector' as const};

function harness(options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-run-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  const wakes:string[][]=[];
  const deps={account:game.account as unknown as ReadinessAccount,command:game.command,runtime,
    pilot:()=>PILOT,setPilot:()=>{},emit:(text:string)=>lines.push(text),wake:(argv:string[])=>{wakes.push(argv);}};
  const write=(source:string)=>{mkdirSync(join(runtime,'pilot'),{recursive:true});writeFileSync(join(runtime,'pilot','index.ts'),source);};
  return {...game,runtime,lines,wakes,deps,write,close:()=>rmSync(runtime,{recursive:true,force:true})};
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

test('a run streams a line per move (journalled first), ends with the prose, writes the record and raises the juncture',async()=>{
  const f=harness();
  try {
    f.write("import {goTo, service, stow, note} from 'play';\n"+
      "export default async function main(){ note('off to the belt'); const t=await goTo('belt'); if(t.status!=='done') return t; await goTo('sol_base'); return service(); }\n");
    const result=await runPilot({...f.deps,started:undefined} as any);
    assert.equal(result.accepted,true);
    assert.equal(result.status,'done',result.reason);
    assert.match(f.lines[0]!,/^run started .* index\.ts sha [0-9a-f]{12}  mood Focused  stance Prospector$/);
    assert.ok(f.lines.includes('off to the belt'),'note() streams');
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
    assert.deepEqual(f.wakes.length,0,'no SPACEMOLT_WAKE argv in the test environment');
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

test('a script that throws while the pilot is Tired and docked still ends the shift rested',async()=>{
  // Rest lives in the barrel now, so a script that throws never reaches its own `rest()` line.
  // Tired is imposed by the runtime and only rest clears it, so a Tired pilot docked at the end
  // of a run is the one case the runner ends the shift itself: without it a broken script leaves
  // a pilot that can never reflect, and so can never change stance, with no human in the loop.
  const f=harness();
  try {
    let record:any={name:'kvothe',mood:'Tired',stance:'Prospector',goal:'three loads of ore'};
    // Nothing for this base to bring up, so the rest rule admits the evening.
    f.account.server.ship.fuel=f.account.server.ship.max_fuel;
    f.account.server.ship.hull=f.account.server.ship.max_hull;
    f.write("export default async function main(){ throw new Error('the script broke'); }\n");
    const result=await runPilot({...f.deps,pilot:()=>record,setPilot:(next:any)=>{record=next;}});
    assert.equal(result.status,'failed',result.reason);
    assert.deepEqual(record,{name:'kvothe'},'the shift is put down whatever the script did');
    const line=readJournal(f.runtime).find(entry=>entry.event==='rest');
    assert.ok(line,'rest leaves its own line in the journal');
    assert.deepEqual({stance:line!.stance,mood:line!.mood,goal:line!.goal},
      {stance:'Prospector',mood:'Tired',goal:'three loads of ore'});
  } finally {f.close();}
});

test('a run that ends on a mood the pilot chose leaves the shift where the pilot put it',async()=>{
  // Not after every run: ending a shift on a good run takes the boundary out of the pilot's hands.
  const f=harness();
  try {
    let record:any={name:'kvothe',mood:'Focused',stance:'Prospector'};
    f.write("import {orient} from 'play';\nexport default async function main(){ return orient(); }\n");
    await runPilot({...f.deps,pilot:()=>record,setPilot:(next:any)=>{record=next;}});
    assert.equal(record.stance,'Prospector','the shift is still the pilot\'s');
    assert.equal(readJournal(f.runtime).find(entry=>entry.event==='rest'),undefined);
  } finally {f.close();}
});

test('a script ends its own shift and opens the next one, and the run reports it',async()=>{
  const f=harness();
  try {
    let record:any={name:'kvothe',mood:'Focused',stance:'Prospector',goal:'three loads of ore'};
    f.account.server.ship.fuel=f.account.server.ship.max_fuel;
    f.account.server.ship.hull=f.account.server.ship.max_hull;
    f.write("import {rest} from 'play';\nexport default async function main(){ "
      +"return rest({goal:'three more loads',stance:'Prospector',mood:'Focused'}); }\n");
    const result=await runPilot({...f.deps,pilot:()=>record,setPilot:(next:any)=>{record=next;}});
    assert.equal(result.status,'done',result.reason);
    // The record never passes through the empty state: the shift it put down is replaced by the one
    // it named, in a single write. Anything reading between the two cannot see a pilot that cannot work.
    assert.deepEqual(record,{name:'kvothe',goal:'three more loads',stance:'Prospector',mood:'Focused'},
      'the next shift was not opened by the rest that ended this one');
    assert.ok(f.lines.some(line=>/^✓ rest  done/.test(line)),f.lines.join('\n'));
  } finally {f.close();}
});

test('a run does not start at all when the record names no stance or mood',async()=>{
  // Live 2026-09-25, 23:07Z: one run started with the header reading `mood - stance -`, then spent
  // the whole juncture on 38 identical refusals — `hunt not started: the pilot record names no mood;
  // reflect at rest first` — across deep_range, last_light, altais and the_telescope, cycling. Zero
  // reflections. Every mood-gated call refuses in that state, so the run cannot accomplish anything,
  // and `run.ts` prints the empty record in its own header at entry: it knew before the first call.
  //
  // One guard at the start kills the whole class. A retry limit on each mood-gated call would not:
  // there are a dozen of them and the next one would burn the juncture just as well.
  const f=harness();
  try {
    // `orient()` is not mood-gated, so it proves whether the script body ran at all.
    f.write("import {orient, hunt} from 'play';\nexport default async function main(){ await orient(); return hunt({look:['belt','station']}); }\n");
    const atRest={name:'kvothe'};   // exactly what rest() leaves behind
    const result=await runPilot({...f.deps,pilot:()=>atRest as any});
    // Nothing the SCRIPT would have sent reached the game: the body never ran. The one command that
    // does go out is the runner's own battle check, which happens on every exit path because a
    // battle holding the ship outranks everything and a refused run must still report it.
    const byScript=f.sent.map(c=>c.action).filter(action=>action!=='spacemolt_battle/status');
    assert.deepEqual(byScript,[],`a run that cannot work still sent ${byScript.length} commands`);
    // And the refusal is unmistakable where the pilot actually reads: the report and run.json.
    const said=f.lines.join('\n');
    assert.match(said,/spacemolt_reflect/,`the report does not say what to do instead: ${said}`);
    assert.match(said,/goal/,said);
    const record=readRun(f.runtime);
    assert.equal(record?.ended,true,'run.json was left open');
    assert.match(JSON.stringify(record),/reflect/i,`run.json does not carry the reason: ${JSON.stringify(record)}`);
    assert.equal((result as {accepted?:boolean}).accepted??true,true,'the run was accepted and then refused, not rejected unread');
  } finally {f.close();}
});
