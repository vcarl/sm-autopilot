/** The reflection report: what a script's `reflection()` reads before it chooses (N7, N9). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {reflectReport} from './reflect.ts';
import {journalRun} from './run-record.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

/** A pilot docked on a serviced ship, and the runtime its journal lives in. */
function fixture(over:{pilot?:Record<string,unknown>;
  skills?:Record<string,{name:string;level:number;max_level:number}>}={}) {
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false},
    ship:{id:'ship',fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_used:0,cargo_capacity:12},
    player:{credits:1_000},
    cargo:[] as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
  });
  const command:ReadinessCommand=async action=>{
    if(action==='spacemolt/get_skills'&&over.skills)return {structuredContent:{skills:over.skills}};
    throw new Error(`not served here: ${action}`);
  };
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-reflect-'));
  return {runtime,reflect:()=>reflectReport(account as unknown as ReadinessAccount,command,over.pilot??{},runtime) as Promise<any>};
}

test("the report reviews the pilot's own files against how the runs ended", async () => {
  const f=fixture({pilot:{objective:'fill the hold'}});
  mkdirSync(join(f.runtime,'pilot'),{recursive:true});
  writeFileSync(join(f.runtime,'pilot','index.ts'),'export default async function main(){}\n');
  for(const ended of [{outcome:'done',reason:'serviced'},{outcome:'refused',reason:'no route'},
    {outcome:'failed',reason:'the hold was full'}])
    journalRun(f.runtime,{phase:'ended',script:'index.ts',...ended,work:{fn:'gatherUntil'}});
  const report=await f.reflect();
  const mine=report.scripts.find((row:any)=>row.name==='index.ts');
  assert.ok(mine,`the pilot's own file is in the review: ${JSON.stringify(report.scripts)}`);
  assert.equal(mine.bytes,'export default async function main(){}\n'.length);
  assert.equal(mine.runs,3);
  assert.deepEqual(mine.last.map((run:any)=>run.outcome),['done','refused','failed']);
  assert.match(mine.last.at(-1).reason,/hold was full/);
  // The runs' own `work` key is what the repetition signal reads.
  assert.ok(report.stagnation.some((line:string)=>/every run .* led with gatherUntil \(3/.test(line)),
    JSON.stringify(report.stagnation));
});

test('a reflection measures each skill against the earliest one in the journal, and says so when it cannot',async()=>{
  // An objective phrased as movement ("raise the lowest of weapons/gunnery/tactics by 2 levels")
  // cannot be judged from a level on its own, and nothing but a past reflection holds the number
  // it started at. A pilot that cannot check its own claim asserts it — which is how a live
  // objective was declared done at weapons 2 of a target of 3 (2026-09-24).
  const levels={weapons:{name:'weapons',level:2,max_level:5},gunnery:{name:'gunnery',level:1,max_level:5}};
  const bare=fixture({skills:levels});
  const first=await bare.reflect();
  assert.deepEqual(first.skills.map((row:any)=>[row.name,row.level,row.was]),
    [['gunnery',1,undefined],['weapons',2,undefined]]);
  assert.ok(first.missing.some((row:string)=>/earlier skill levels/.test(row)),
    `with no earlier reflection the gap is named, never guessed: ${JSON.stringify(first.missing)}`);

  // The skill rows the first reflection journalled are what the next one measures against.
  const f=fixture({skills:levels});
  journalRun(f.runtime,{skills:first.skills},'reflection_read');
  const second=await f.reflect();
  const weapons=second.skills.find((row:any)=>row.name==='weapons');
  assert.equal(weapons.level,2);
  assert.equal(weapons.was,undefined,'a level that has not moved carries no movement');
  const moved=fixture({skills:{...levels,weapons:{name:'weapons',level:4,max_level:5}}});
  journalRun(moved.runtime,{skills:first.skills},'reflection_read');
  const after=await moved.reflect();
  const raised=after.skills.find((row:any)=>row.name==='weapons');
  assert.equal(raised.was,2,`the baseline reaches the report: ${JSON.stringify(after.skills)}`);
  assert.ok(raised.since,'the baseline says when it was taken');
  assert.ok(!after.missing.some((row:string)=>/earlier skill levels/.test(row)));
});
