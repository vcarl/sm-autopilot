import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from './readiness.ts';
import {check,runPilot} from './run.ts';
import {readJournal,readRun} from './run-record.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

const PILOT={name:'kvothe',mood:'Focused' as const,stance:'Prospector' as const,home:'sol_base'};

function harness() {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-run-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0});
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
    f.write("import {readFileSync} from 'node:fs';\nexport default async function main(){ readFileSync('/etc/passwd'); }\n");
    assert.match((await check(f.runtime)).errors.join(' '),/tsc: |may import/);
    f.write("import {orient} from 'play';\nexport default async function main(){ while(true){ await orient(); } }\n");
    assert.match((await check(f.runtime)).errors.join(' '),/stopped\(\)/);
    const refused=await runPilot(f.deps);
    assert.equal(refused.accepted,false);
    assert.equal(f.sent.length,0,'nothing reached the game');
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
