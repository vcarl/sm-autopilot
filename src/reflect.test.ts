/** The reflection report: what a script's `reflection()` reads before it chooses (N7, N9). */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {SpacemoltError} from '@spacemolt/lib';
import {Effect} from 'effect';
import {GameLive,rawError} from './play/game.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {reflectReportEffect,type Pilotish} from './reflect.ts';
import {journalRun} from './run-record.ts';
import {FakeLibGoalAccount} from './test-support/fake-lib-account.ts';

/** The report as a Promise, run over the world's own command seam and the account's refresh; a failure throws the raw error, as a script's `reflection()` once did. */
async function reflectReport(account:ReadinessAccount,command:ReadinessCommand,pilot:Pilotish,runtime?:string) {
  const exit=await Effect.runPromiseExit(reflectReportEffect(account,pilot,runtime).pipe(
    Effect.provide(GameLive({send:command,refresh:()=>account.refresh()}))));
  if(exit._tag==='Failure')throw rawError(exit.cause);
  return exit.value;
}

/** A pilot docked on a serviced ship, and the runtime its journal lives in. */
function fixture(over:{pilot?:Record<string,unknown>;
  skills?:Record<string,{name:string;level:number;max_level:number}>;
  /** What the world does for an action, instead of refusing it: serve a reply, or throw as the lib does. */
  serve?:Record<string,()=>unknown>}={}) {
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false},
    ship:{id:'ship',fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_used:0,cargo_capacity:12},
    player:{credits:1_000},
    cargo:[] as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
  });
  const command:ReadinessCommand=async action=>{
    const served=over.serve?.[action];
    if(served)return served();
    if(action==='spacemolt/get_skills'&&over.skills)return {structuredContent:{skills:over.skills}};
    throw new SpacemoltError('not_available',`not served here: ${action}`);
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

const refuse=(code:string)=>()=>{throw new SpacemoltError(code,`refused: ${code}`);};
const lost=()=>{throw new SpacemoltError('mutation_timeout','no result');};

test('a world that refuses every read still yields a report, naming each read it could not make',async()=>{
  const report=await fixture({pilot:{objective:'fill the hold'}}).reflect();
  for(const name of ['skills','storage','tax','shipping_debt'])
    assert.ok(report.missing.includes(name),`${name} is named: ${JSON.stringify(report.missing)}`);
  assert.equal(report.owes.tax_due,undefined);
  assert.equal(report.owes.shipping_debt,undefined);
  assert.equal(report.ship.fuel,120);
  assert.equal(report.objective,'fill the hold');
});

test('a refused tax estimate is named and leaves the other reads standing',async()=>{
  const report=await fixture({serve:{'spacemolt/get_tax_estimate':refuse('no_tax'),
    'spacemolt_shipping/profile':()=>({structuredContent:{profile:{outstanding_debt:7,tier:'bronze'}}}),
    'spacemolt_storage/view':()=>({structuredContent:{base_id:'b',items:[{item_id:'ore',quantity:3}],ships:[{}],
      locations:[{base_id:'b',base_name:'Base',system_name:'Sol',item_count:1,ship_count:1}]}})}}).reflect();
  assert.ok(report.missing.includes('tax'));
  assert.ok(!report.missing.includes('storage')&&!report.missing.includes('shipping_debt'));
  assert.equal(report.owes.tax_due,undefined);
  assert.deepEqual(report.owes,{shipping_debt:7,carrier_tier:'bronze'});
  assert.deepEqual(report.holdings.here,[{item_id:'ore',quantity:3}]);
  assert.deepEqual(report.holdings.storage,[{base_id:'b',items:1,ships:1}]);
});

test('a served tax estimate is summed as before',async()=>{
  const report=await fixture({serve:{'spacemolt/get_tax_estimate':()=>({structuredContent:
    {income_tax_total:10,property_tax_total:5,tax_prepaid:3}})}}).reflect();
  assert.equal(report.owes.tax_due,12);
  assert.ok(!report.missing.includes('tax'));
});

test('a lost storage reply is named missing and the report still builds',async()=>{
  const report=await fixture({serve:{'spacemolt_storage/view':lost}}).reflect();
  assert.ok(report.missing.includes('storage'));
  assert.deepEqual(report.holdings.storage,[]);
});

test('a refused skills read, and a defect in any read, are told apart',async()=>{
  const refused=await fixture({serve:{'spacemolt/get_skills':refuse('in_battle')}}).reflect();
  assert.ok(refused.missing.includes('skills'));
  // A bug is not a game outcome: it is not swallowed into `missing`, it goes up as thrown.
  const bug=new Error('a bug in the world');
  await assert.rejects(fixture({serve:{'spacemolt/get_tax_estimate':()=>{throw bug;}}}).reflect(),error=>error===bug);
});

test('a refresh that throws goes up, as it always did',async()=>{
  const account=new FakeLibGoalAccount({ship:{fuel:1}});
  const boom=new Error('refresh down');
  account.refresh=async()=>{throw boom;};
  await assert.rejects(reflectReport(account as unknown as ReadinessAccount,async()=>({}),{}),error=>error===boom);
});

test('an account with no ship names the ship missing rather than reading its zeros as fuel and hull',async()=>{
  const account={state:{player:{credits:5}},refresh:async()=>{}};
  const report=await reflectReport(account as unknown as ReadinessAccount,
    async action=>{throw new SpacemoltError('not_available',`not served here: ${action}`);},{});
  assert.equal(report.ship.fuel,0);
  assert.ok(report.missing.includes('ship'),JSON.stringify(report.missing));
});
