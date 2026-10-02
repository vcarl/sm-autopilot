import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from '../readiness.ts';
import {check} from '../run.ts';
import {ABSENCE_STALE,TICK_MS,writeLook} from '../sighting-memory.ts';
import {journalRun} from '../run-record.ts';
import {evaluateMenu,jobStop,type Facts} from '../rules-table.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {factsNow,leadCall,menu,menuDue,pilotingGap,renderMenu,type RunSummary} from './menu.ts';
import {orient} from './orient.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-menu-'));
  const game=bridgeWorld({services:['refuel','repair','storage','shipyard'],...options});
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:()=>record,runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const gather=(over:Partial<RunSummary>={}):RunSummary=>({fn:'gatherUntil',arg:'belt',status:'done',credits:0,items:12,xp:0,at:'sol_base',...over});
const ended=(runtime:string,work:RunSummary)=>journalRun(runtime,{phase:'ended',script:'index.ts',outcome:work.status,work});
/** The facts as the juncture builds them, and the one verdict a field is wired for. */
type Game=ReturnType<typeof world>;
const facts=(f:Game,record:Pilot)=>factsNow(f.account as unknown as ReadinessAccount,f.command,record,f.runtime);
const verdict=(built:Facts,job:string)=>evaluateMenu(built).find(row=>row.job.startsWith(job))!;

test('four identical gathers: the stagnation line names them and the top move is not another gather',async()=>{
  const f=world({mood:'Focused',stance:'Prospector',objective:'obtain credits'},{cargoUsed:6});
  try {
    for(let i=0;i<4;i++)ended(f.runtime,gather());
    const built=await menu(f.runtime);
    assert.equal(built.stagnation,'4 runs of gatherUntil at belt, credits flat');
    assert.ok(built.moves.length>0&&built.moves.length<=5);
    assert.ok(!built.moves[0]!.call.startsWith('gatherUntil'),built.moves[0]!.call);
    assert.ok(built.moves.some(m=>m.call==="sell([{item_id:'ore',quantity:6}])"),JSON.stringify(built.moves));
    // The belt is still admissible (hold half free, fuel over the reserve): ranked under the
    // five that break the repetition, never refused.
    assert.ok(!built.not_now.some(row=>row.move==='gatherUntil'),JSON.stringify(built.not_now));
    assert.match(renderMenu(built),/^Menu — 4 runs of gatherUntil at belt, credits flat:\n  - `sell\(/);
  } finally {f.close();}
});

test('a Hunter told to cull fauna is offered the hunt, and the move that serves the objective is tagged for it',async()=>{
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna at the belt'},{cargoUsed:6});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const built=await menu(f.runtime);
    // Out at a POI with nothing seen, the offer is a list that STARTS where the ship stands: looking
    // here costs no fuel, and `hunt` moves on by itself when it finds nothing. That is strictly
    // better than the bare `hunt()` this used to be, which looked once and stopped.
    const hunt=built.moves.find(m=>m.call.startsWith('hunt({look:'));
    assert.ok(hunt,`no hunt on the menu: ${JSON.stringify(built.moves)}`);
    assert.match(hunt!.call,/^hunt\(\{look:\['belt'/,`the search does not start where the ship is: ${hunt!.call}`);
    assert.equal(hunt!.advances,'objective','the hunt is not tagged [credits]');
    assert.ok(!built.moves.every(m=>m.advances==='credits'),'every move tagged [credits]');
    // Docked is the next test: `hunt` flies to each place itself, so a dock is not a blocker.
  } finally {f.close();}
});

test('a full hold gets the remedy as a move, and the remedy the market supports: sell where there is a bid, stow where there is none',async()=>{
  // Live 2026-09-24: hold 63/63 docked at sirius_observatory_station, `not_now` reading "the hold
  // is full; sell(rows) or stow(rows) first", and neither call anywhere on the menu — the station
  // bid for nothing aboard, so the sell was rightly absent and stow was never offered at all.
  const bid=world({mood:'Focused',stance:'Prospector',goal:'obtain credits'},{cargoUsed:12,cargoCapacity:12});
  try {
    const built=await menu(bid.runtime);
    assert.equal(built.moves[0]!.call,"sell([{item_id:'ore',quantity:12}])",JSON.stringify(built.moves));
    assert.ok(built.not_now.some(row=>row.move==='gatherUntil'&&/hold is full/.test(row.why)),JSON.stringify(built.not_now));
  } finally {bid.close();}
  // The same hold where the counter buys nothing: the store takes it, and the call names all of it.
  const dry=world({mood:'Focused',stance:'Prospector',goal:'obtain credits'},
    {cargoUsed:12,cargoCapacity:12,markets:{sol_base:[]}});
  try {
    const built=await menu(dry.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('sell(')),JSON.stringify(built.moves));
    assert.equal(built.moves[0]!.call,"stow([{item_id:'ore'}])",JSON.stringify(built.moves));
    // Both remedies are calls the gate accepts, which is the half a wrong shape fails silently.
    const runtime=mkdtempSync(join(tmpdir(),'menu-remedy-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {sell, stow} from 'play';\nexport default async function main() {\n  await sell([{item_id:'ore',quantity:12}]);\n  await ${built.moves[0]!.call};\n}\n`);
    const gate=await check(runtime);
    assert.deepEqual(gate.errors,[]);
  } finally {dry.close();}
});

test('an unfitted module in the hold with no free slot is under not_now with the slot reason, not a move',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'},{cargoUsed:0,
    hangar:{fitted:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility',cpu_usage:3,power_usage:4},
      {module_id:'m2',type_id:'mining_laser_i',slot:'utility',cpu_usage:3,power_usage:4}]}});
  try {
    f.account.server.cargo.push({item_id:'cargo_expander_ii',quantity:1});
    f.account.server.ship.cargo_used=1;
    const built=await menu(f.runtime);
    const refused=built.not_now.find(row=>row.move==="refit({install:['cargo_expander_ii']})");
    assert.match(refused!.why,/no free utility slot: 2 of 2 fitted/);
    assert.ok(!built.moves.some(m=>m.call.startsWith('refit')));
  } finally {f.close();}
});

test('Tired offers only service here, or the nearest serviced base when out',async()=>{
  // This counter posts a fuel price and no repair price, which is what an ordinary station does:
  // `repair_price_per_hull` is owner-set on player stations. It repairs on credits and bills
  // afterwards, so the resupply is the move wherever the ship stands, and the menu does not split
  // the fill by what is quoted. The live deadlock (2026-09-24) was a menu whose only offer was a
  // `service()` that refused every time for want of that field.
  const f=world({mood:'Tired',stance:'Prospector'},{services:['refuel','storage']});
  try {
    f.account.server.ship.hull=52;
    const docked=await menu(f.runtime);
    assert.deepEqual(docked.moves.map(m=>m.call),['service()']);
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const out=await menu(f.runtime);
    assert.deepEqual(out.moves.map(m=>m.call),["goTo('sol_base')"]);
  } finally {f.close();}
});

test('the trigger fires on repetition, on two runs not done, on a run that gained nothing, and not after one productive run',()=>{
  assert.equal(menuDue([gather({credits:120})]),null);
  assert.equal(menuDue([gather(),gather(),gather({credits:5})]),'3 runs of gatherUntil at belt, credits +5');
  assert.equal(menuDue([gather({credits:1}),gather({fn:'sell',arg:'12',status:'refused'}),gather({status:'partial'})]),'last 2 runs ended refused, partial (sell, gatherUntil)');
  assert.equal(menuDue([gather({fn:'goTo',arg:'belt',items:0})]),'the last run (goTo belt) gained nothing');
  assert.equal(menuDue([]),null);
});

// One case per field factsNow now reads out of the world. Each asserts the rule the field
// exists for, so a wiring that stops reaching the rules table fails here.

test('a fight at the POI is a threat, and docking ends it: safety-only out there, the whole menu at the counter',async()=>{
  const who:Pilot={mood:'Focused',stance:'Prospector'};
  const f=world(who);
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    f.account.server.location.nearby_players=[{player_id:'p1',username:'Raider',in_combat:true}];
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.threats,['Raider']);
    assert.match(jobStop(seen)!,/threat seen: Raider/);
    assert.deepEqual([...new Set(evaluateMenu(seen).map(row=>row.tag))],['safety']);
    // Docked, the same brawl outside is not a threat: resupply stays on the menu.
    f.account.server.location.docked_at='sol_base';
    f.account.server.location.poi_id='station';
    const inside=await facts(f,who);
    assert.equal(inside.observed.threats,undefined);
    assert.equal(jobStop(inside),null);
    assert.ok(evaluateMenu(inside).some(row=>row.tag!=='safety'),'only safety rows at the counter under a brawl outside');
  } finally {f.close();}
});

test('the legal creatures at the POI are J8 targets; one already in a fight and one branded are not',async()=>{
  const who:Pilot={mood:'Focused',stance:'Hunter'};
  const f=world(who,{wildlife:{creatures:[{creature_id:'c1',species:'belt_grazer'},
    {creature_id:'c2',species:'sand_eel',in_combat:true},{creature_id:'c3',species:'ranch_cow',branded:true}]}});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.targets,['belt_grazer']);
    assert.equal(verdict(seen,'J8').admissible,true,verdict(seen,'J8').reason);
  } finally {f.close();}
});

test('a remembered far book against this counter is the J6 spread',async()=>{
  const who:Pilot={mood:'Opportunistic',stance:'Trader'};
  const f=world(who);
  try {
    // A book this pilot read at another base on an earlier visit: ore bids 40 there, and the
    // ask here is 12, so the circuit is worth 28 a unit.
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'range_base',at:'earlier',tick:TICK-5,
      items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]));
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.spread,{item_id:'ore',base_id:'range_base',margin:28,age:5});
    assert.equal(verdict(seen,'J6').admissible,true,verdict(seen,'J6').reason);
    assert.match(verdict(seen,'J6').reason,/5 ticks old/,'J6 hands the pilot the age, it does not gate on it');
    // No memory, no spread — which is the answer J6 gave before the field was wired.
    rmSync(join(f.runtime,'markets.json'));
    assert.equal((await facts(f,who)).observed.spread,undefined);
    assert.equal(verdict(await facts(f,who),'J6').admissible,false);
  } finally {f.close();}
});

test('a remembered book written before books carried a tick is read as 20 ticks old',async()=>{
  const who:Pilot={mood:'Opportunistic',stance:'Trader'};
  const f=world(who);
  try {
    // A pre-ageing markets.json: no `tick` on the entry. The runner's rule is to assume 20.
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'range_base',at:'earlier',
      items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]));
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.spread,{item_id:'ore',base_id:'range_base',margin:28,age:20});
    // Still admissible: the age is reported, never a gate.
    assert.equal(verdict(seen,'J6').admissible,true,verdict(seen,'J6').reason);
    assert.match(verdict(seen,'J6').reason,/20 ticks old/);
  } finally {f.close();}
});

test('a remembered tick ahead of now — a restart or a season rollover — reads as 0, not negative',async()=>{
  const who:Pilot={mood:'Opportunistic',stance:'Trader'};
  const f=world(who);
  try {
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'range_base',at:'earlier',tick:TICK+50,
      items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]));
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.spread,{item_id:'ore',base_id:'range_base',margin:28,age:0});
    assert.doesNotMatch(verdict(seen,'J6').reason,/-\d/);
  } finally {f.close();}
});

test("the J6 spread is a Trader's pasteable tradeRun; a refused J6 says so under not_now; no other stance is offered one",async()=>{
  const far=JSON.stringify([{base_id:'range_base',at:'earlier',tick:TICK-40,
    items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]);
  // J6 passes: the move names the item and the far base, carries the age, and compiles.
  const ok=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(ok.runtime,'markets.json'),far);
    const built=await menu(ok.runtime);
    const run=built.moves.find(m=>m.call==="tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})");
    assert.ok(run,`no tradeRun: ${JSON.stringify(built.moves)} / ${JSON.stringify(built.not_now)}`);
    assert.match(run!.why,/28 cr a unit on ore at range_base, a bid remembered 40 ticks old/);
    assert.equal(built.moves[0]!.call,run!.call,'the Trader leads with the run');
    const runtime=mkdtempSync(join(tmpdir(),'menu-trade-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {tradeRun} from 'play';\nexport default async function main() {\n  await ${run!.call};\n}\n`);
    assert.deepEqual((await check(runtime)).errors,[]);
  } finally {ok.close();}
  // J6 fails with a spread in hand (a mood that may not start a job): not_now, with J6's reason.
  const relaxed=world({mood:'Relaxed',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(relaxed.runtime,'markets.json'),far);
    const built=await menu(relaxed.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('tradeRun(')),JSON.stringify(built.moves));
    assert.ok(built.not_now.some(row=>row.move==='tradeRun'&&/Relaxed may not initiate a job/.test(row.why)),JSON.stringify(built.not_now));
  } finally {relaxed.close();}
  // J6 fails for want of a spread: still said, not silently dropped.
  const blind=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    const built=await menu(blind.runtime);
    assert.ok(built.not_now.some(row=>row.move==='tradeRun'&&/no quoted spread/.test(row.why)),JSON.stringify(built.not_now));
  } finally {blind.close();}
  // Not a Trader: the same spread in memory is no tradeRun, on the menu or under not_now.
  const miner=world({mood:'Opportunistic',stance:'Prospector'},{cargoUsed:0});
  try {
    writeFileSync(join(miner.runtime,'markets.json'),far);
    const built=await menu(miner.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('tradeRun('))&&!built.not_now.some(row=>row.move==='tradeRun'),renderMenu(built));
  } finally {miner.close();}
});

test("the crafting service is J7's workshop; a base without one still refuses",async()=>{
  const who:Pilot={mood:'Focused',stance:'Industrialist'};
  const f=world(who,{services:['refuel','repair','crafting'],cargoUsed:6});
  try {
    const seen=await facts(f,who);
    assert.equal(seen.place.workshop,true);
    assert.equal(verdict(seen,'J7').admissible,true,verdict(seen,'J7').reason);
  } finally {f.close();}
  const bare=world(who,{services:['refuel','repair'],cargoUsed:6});
  try {
    const seen=await facts(bare,who);
    assert.equal(seen.place.workshop,false);
    assert.match(verdict(seen,'J7').reason,/no workshop or facility at this base/);
  } finally {bare.close();}
});

test('the shipping board is J4, and the platform and the berths are J5',async()=>{
  const who:Pilot={mood:'Cautious',stance:'Carrier',permissions:{max_liability:5_000}};
  const f=world(who,{cargoUsed:0,cargoCapacity:120,
    shipping:{listings:[{id:'s1',destination_base_id:'range_base',base_reward:1_000}]},
    passengers:{berths:{economy:2},waiting:[{citizen_id:'c1',destination:'range_base'}],
      onboard:[{citizen_id:'c2',destination:'range_base'}]}});
  try {
    const seen=await facts(f,who);
    assert.deepEqual(seen.place.board?.contracts,[{id:'s1',cargo:100,liability:1_000}]);
    assert.equal(seen.place.board?.passengers,1);
    assert.equal(seen.obligations.passengers,1,'the seated berth is not counted as a passenger aboard');
    assert.equal(verdict(seen,'J4').admissible,true,verdict(seen,'J4').reason);
    assert.match(verdict(seen,'J5').reason,/1 aboard owed a landing/);
    // The standing liability permission is what a package has to fit inside, not the board.
    who.permissions={max_liability:10};
    assert.match(verdict(await facts(f,who),'J4').reason,/no package fits .* 10 credit liability permission/);
  } finally {f.close();}
});

test('a base in this system that posts a repair price is named with the price, not with hope',async()=>{
  // `inspect({id})` answers with the docked-base body for a base in THIS system, so a counter the
  // ship is not standing at can be quoted from here — but only that far. Where it answers, the move
  // carries the evidence; where it does not, the move is still offered and says plainly that
  // nothing is readable. Undocked is where these rows are offered: standing at a counter, the
  // resupply there is the move.
  const f=world({mood:'Tired',stance:'Prospector'},{services:['refuel','storage'],
    pois:[{id:'yard',name:'Sol Yard',base_id:'yard_base',base_name:'Sol Yard Base',repair_price:4},
      {id:'dark',name:'Sol Dark',base_id:'dark_base',base_name:'Sol Dark Base'}]});
  try {
    f.account.server.ship.hull=52;
    f.account.server.ship.fuel=f.account.server.ship.max_fuel;
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    const built=await menu(f.runtime);
    assert.deepEqual(built.moves.map(m=>m.call),["goTo('sol_base')","goTo('yard_base')","goTo('dark_base')"],JSON.stringify(built.moves));
    assert.match(built.moves[1]!.why,/posts repair 4 cr\/hull/);
    assert.match(built.moves[2]!.why,/no price readable from here/);
  } finally {f.close();}
});

test("a docked Hunter is offered a range of places to look, and the call compiles through the gate",async()=>{
  // Live 2026-09-24: the menu offered a Hunter `hunt()` with no destination, and under a dock only
  // `not_now: docked at sirius_observatory_station; undock or goTo a poi with fauna` — two remedies
  // the barrel has no call for (`grep -c undock src/play/index.ts` → 0, and the menu's goTo rows only
  // ever name unvisited neighbouring systems). The dock is the job's business, not the pilot's.
  //
  // It is a `look` list rather than one `poi` because fauna is not knowable before arrival: POI rows
  // carry no fauna field and `get_nearby` answers only for where the ship stands. Naming one belt
  // asserts prey is there, which we cannot know — so if the pilot finds nothing, that was our fault.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'});
  try {
    f.account.server.location.docked_at='sol_base';f.account.server.location.poi_id='station';
    const built=await menu(f.runtime);
    const hunt=built.moves.find(m=>m.call==="hunt({look:['belt']})");
    assert.ok(hunt,`no hunt with places to look: ${JSON.stringify(built.moves)} / ${JSON.stringify(built.not_now)}`);
    // Never looked at is said as never looked at, not dressed up as a habitat known to hold prey.
    assert.match(hunt!.why,/Inner Belt \(never looked at\)/,hunt!.why);
    assert.match(hunt!.why,/flying from sol_base/,hunt!.why);
    assert.ok(!built.not_now.some(row=>row.move==='hunt'),JSON.stringify(built.not_now));
    // The shape the pilot would paste, through the real gate: a wrong one costs a whole juncture.
    const runtime=mkdtempSync(join(tmpdir(),'menu-hunt-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {hunt} from 'play';\nexport default async function main() {\n  await ${hunt!.call};\n}\n`);
    const gate=await check(runtime);
    assert.deepEqual(gate.errors,[]);
  } finally {f.close();}
});

test('a habitat this runtime remembers as empty is not offered again, and when they all are the menu says so',async()=>{
  // "If we're telling the player where to hunt, then it's our fault if they find nothing huntable
  // there." A look written last shift is the only thing that can stop the menu repeating a guess,
  // so the offer reads sighting memory and drops what it knows to be empty.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'});
  try {
    f.account.server.location.docked_at='sol_base';f.account.server.location.poi_id='station';
    writeLook(f.runtime,{poi_id:'belt',seen:[]});
    const built=await menu(f.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('hunt(')),
      `the belt was looked at and was empty, and is offered anyway: ${JSON.stringify(built.moves)}`);
    const why=built.not_now.find(row=>row.move==='hunt')?.why??'';
    assert.match(why,/remembered empty/,why);
    assert.match(why,/Inner Belt was empty/,why);
  } finally {f.close();}
});

test('an aged-out absence goes back on the list, because a stale absence is not knowledge',async()=>{
  // The failure mode that matters in the other direction: an absence believed forever means a POI
  // with prey in it is skipped for good. `recall` expires absences sooner than presences, and the
  // menu has to honour that rather than caching the answer itself.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'});
  try {
    f.account.server.location.docked_at='sol_base';f.account.server.location.poi_id='station';
    // Stamped by hand, older than the absence bound: the same row that suppressed the offer above.
    writeLook(f.runtime,{poi_id:'belt',seen:[]},
      ()=>new Date(Date.now()-(ABSENCE_STALE+5)*TICK_MS));
    const built=await menu(f.runtime);
    const hunt=built.moves.find(m=>m.call==="hunt({look:['belt']})");
    assert.ok(hunt,`a stale absence suppressed the offer: ${JSON.stringify(built.not_now)}`);
    assert.match(hunt!.why,/too old to trust/,hunt!.why);
  } finally {f.close();}
});
test('the undocked hunt row claims a legal creature only when one was observed',async()=>{
  // The same build's J8 verdict reads `observed.targets`; the menu asserted "fauna at X is legal to
  // engage" without reading it at all, so the two halves of one menu could contradict each other.
  const bare=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'});
  try {
    bare.account.server.location.docked_at=null;bare.account.server.location.poi_id='belt';
    const built=await menu(bare.runtime);
    const hunt=built.moves.find(m=>m.call.startsWith('hunt({look:'));
    assert.ok(hunt,JSON.stringify(built.moves));
    assert.equal(verdict(await facts(bare,{mood:'Focused',stance:'Hunter'}),'J8').admissible,false);
    // The claim is the point of this test: nothing was observed, so nothing is asserted as legal.
    assert.doesNotMatch(hunt!.why,/is legal to engage/);
    assert.match(hunt!.why,/never looked at/,hunt!.why);
  } finally {bare.close();}
  // One that was seen is named, and the claim is the creature's own name.
  const live=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'},
    {wildlife:{creatures:[{creature_id:'c1',species:'rock_grazer'}]}});
  try {
    live.account.server.location.docked_at=null;live.account.server.location.poi_id='belt';
    const built=await menu(live.runtime);
    const hunt=built.moves.find(m=>m.call==='hunt()');
    assert.match(hunt!.why,/rock_grazer at belt is legal to engage/);
  } finally {live.close();}
});

test('an undocked pilot short of fuel for every route is offered the route to a counter',async()=>{
  // The wedge that stranded the pilot for six hours on 2026-09-24: `flies()` refused the belt and
  // `service()` is pushed only when docked. Every row refused, `moves` empty, nothing to paste.
  // `flies()` now asks only whether the tank covers the route (7); the reserve is where Tired
  // begins (operator, 2026-09-26). The record here is fixed, so the mood stays Aggressive.
  const out=world({mood:'Aggressive',stance:'Prospector',goal:'obtain credits'},{cargoUsed:6});
  try {
    out.account.server.location.docked_at=null;out.account.server.location.poi_id='belt';
    out.account.server.ship.fuel=5;
    const built=await menu(out.runtime);
    assert.ok(built.not_now.some(row=>/fuel 5, the route to \S+ needs 7/.test(row.why)),JSON.stringify(built.not_now));
    const exit=built.moves.find(m=>m.call==="goTo('sol_base')");
    assert.ok(exit,`no way to fuel: ${JSON.stringify(built.moves)}`);
    assert.match(exit!.why,/fuel 5, the route to \S+ needs 7; Sol Base in sol/);
    // It unblocks every row the shortfall refused, so it is the move the pilot reads first.
    assert.equal(built.moves[0]!.call,"goTo('sol_base')",JSON.stringify(built.moves));
  } finally {out.close();}
  // Docked with the same shortfall, nothing changes: service() at the counter already covers it,
  // and no route to another base is added on top of it.
  const home=world({mood:'Aggressive',stance:'Prospector',goal:'obtain credits'},{cargoUsed:6});
  try {
    home.account.server.ship.fuel=5;
    const built=await menu(home.runtime);
    assert.ok(built.moves.some(m=>m.call==='service()'),JSON.stringify(built.moves));
    assert.ok(!built.moves.some(m=>m.call.startsWith("goTo('sol_base')")),JSON.stringify(built.moves));
  } finally {home.close();}
});

test("an objective that says \"skill\" is not a hunting objective, and the phase named first leads",()=>{
  // Live 2026-09-24. Unanchored, the earliest match anywhere in this sentence was `kill` at index
  // 13 — inside "skill" — so every objective that mentioned skills read as a hunt, and
  // `OBJECTIVES.find` returned whichever pattern sat earliest in the array rather than the phase
  // the orders put first. Five of this objective's six phases match some pattern.
  const objective="Train every skill to level 5. First run: orient() and note() the current level of "
    +"every skill. Then close the gaps in this order: a gatherUntil mining trip (mining, piloting, "
    +"navigation) -> sell at a rich counter or a tradeRun (trading) -> exploreNearby on unvisited "
    +"systems (exploration) -> hunts at a creature habitat -> a pirate fight -> craft at a workshop";
  assert.notEqual(leadCall({mood:'Focused',stance:'Prospector',objective}),'hunt');
  assert.equal(leadCall({mood:'Focused',stance:'Prospector',objective}),'gatherUntil');
  // The stance is still the fallback when nothing is named, and the words still win when they are.
  assert.equal(leadCall({mood:'Focused',stance:'Hunter',objective}),'gatherUntil');
  assert.equal(leadCall({mood:'Focused',stance:'Prospector',objective:'cull the fauna at the belt'}),'hunt');
  assert.equal(leadCall({mood:'Focused',stance:'Hunter'}),'hunt');
  // The other substrings the anchors close, each one reachable in ordinary orders.
  assert.equal(leadCall({mood:'Focused',stance:'Hunter',objective:'sell at the store, then explore'}),'sell');
  assert.equal(leadCall({mood:'Focused',stance:'Scout',objective:'determine what is out there before anything else'}),'goTo');
});

// Live 2026-09-25: a pilot woke at hull 3/80 inside a battle left over from the previous shift
// and died a second after its first move. `orient` answered where it was, what it held and what
// it owed, and never that it was in a fight — so the fight goes first, ahead of every other fact.
test('orient leads with the battle holding the ship',async()=>{
  const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};
  const f=world({mood:'Focused',stance:'Hunter'},{wildlife:{creatures:[grazer],polls:20,damage:0}});
  try {
    const calm=await orient();
    assert.ok(!calm.did.includes('IN BATTLE'),calm.did);
    assert.equal(calm.detail.battle,undefined);
    await f.command('spacemolt/hunt',{id:'c1'});
    const out=await orient();
    assert.match(out.did,/^IN BATTLE with Molt Grazer \(battle tick \d+\): disengage\(\) or fight it;/);
    assert.equal(out.detail.battle?.opponent,'Molt Grazer');
  } finally {f.close();}
});

// Live 2026-09-25: the mining row emitted `gatherUntil({poi})` with no base, and the library
// refused it — "no base to return to: pass base, or dock first" (mining.ts:71). A whole juncture
// was spent on a call that could not run. The offered call names the base it settles at.
test('the mining row names the base the trip settles at, docked or not',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'},{cargoUsed:0});
  try {
    const docked=await menu(f.runtime);
    assert.ok(docked.moves.some(move=>move.call==="gatherUntil({poi:'belt',base:'sol_base'})"),
      JSON.stringify(docked.moves.map(move=>move.call)));
    // Undocked at a POI is the case that mattered: there is no `docked_at` to fall back to.
    await f.command('spacemolt/travel',{id:'station'});
    const out=await menu(f.runtime);
    const row=out.moves.find(move=>move.call.startsWith('gatherUntil('));
    assert.ok(row,JSON.stringify(out.moves.map(move=>move.call)));
    assert.match(row!.call,/^gatherUntil\(\{poi:'belt',base:'sol_base'\}\)$/);
  } finally {f.close();}
});

test('the verdicts the menu never used are now moves: the stance work and the counter reads, in that order',async()=>{
  // `evaluateMenu` computes roughly fifteen verdicts. The menu consumed ONE of them (J12) and threw
  // the rest away while re-deriving a narrower picture inline, which is the largest gap in the tree
  // between what we know and what the pilot is told. J4, J5 and the base's counters were all
  // computed on every build and never offered.
  const f=world({mood:'Focused',stance:'Carrier',goal:'land passengers',permissions:{max_liability:5_000}},
    {cargoUsed:0,cargoCapacity:120,
      shipping:{listings:[{id:'s1',destination_base_id:'range_base',base_reward:1_000}]},
      passengers:{berths:{economy:2},waiting:[{citizen_id:'c1',destination:'range_base'}]}});
  try {
    const built=await menu(f.runtime);
    const calls=built.moves.map(m=>m.call);
    // J4 and J5 carry their own calls off facts the menu never read for itself.
    assert.ok(calls.some(call=>call.startsWith('haul(')||call==='carryPassengers()'),
      `no Carrier work from the verdicts: ${JSON.stringify(built.moves)}`);
    // A read spends nothing and starts nothing, so it is the floor of the menu and never its head:
    // surfacing more verdicts must not cost the pilot the row it would have acted on.
    const reads=['prices()','storage()','shipsForSale()','missions()','freightBoard()'];
    const firstRead=calls.findIndex(call=>reads.includes(call));
    const lastWork=calls.reduce((at,call,index)=>reads.includes(call)?at:index,-1);
    if(firstRead>=0)assert.ok(firstRead>lastWork,`a counter read outranked work: ${JSON.stringify(calls)}`);
    // And the budget is unchanged: more coverage, not a longer menu.
    assert.ok(built.moves.length<=5,JSON.stringify(calls));
  } finally {f.close();}
});

test('a verdict with no barrel primitive behind it is left unsaid, not invented',async()=>{
  // The three safety rows. Under a threat `evaluateMenu` returns only those, and none of them has a
  // call: there is no `watch`, `dock`, `retreat` or `undock` in the barrel, and `disengage()` breaks
  // off a battle that already holds THIS ship, which is not what a threat here is. Emitting any of
  // them would hand the pilot code that does not compile, which costs a whole juncture — so the
  // menu says nothing rather than guessing, and that silence is the reported gap.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'});
  try {
    f.account.server.location.docked_at=null;f.account.server.location.poi_id='belt';
    f.account.server.location.nearby_players=[{player_id:'p9',username:'Raider',in_combat:true}];
    const built=await menu(f.runtime);
    for(const bad of ['watch','dock(','retreat','undock','disengage'])
      assert.ok(!built.moves.some(m=>m.call.includes(bad)),`invented a safety primitive: ${JSON.stringify(built.moves)}`);
  } finally {f.close();}
});

test("the rules' own refusals reach not_now, which is what the pilot was promised they would",async()=>{
  // `play/README.md` tells the pilot "not now says what the rules refuse and why". It did not.
  // `no()` never sets `play`, so the label was derived from a field that is always absent for an
  // inadmissible verdict, the `if(fn&&…)` guard was always false, and every one of the rules
  // table's refusal reasons — J1's "no reachable POI is quoted with resources", J4's liability
  // line, the service bill — was computed on every build and dropped. Every `not_now` row the
  // pilot has ever read came from the menu's own inline rows.
  const f=world({mood:'Cautious',stance:'Carrier',goal:'land passengers',
    permissions:{max_liability:10}},{cargoUsed:0,cargoCapacity:120,
      shipping:{listings:[{id:'s1',destination_base_id:'range_base',base_reward:1_000,reserved_exposure:9_000}]}});
  try {
    const built=await menu(f.runtime);
    // J4 is refused here: the one package on the board is far over the standing liability.
    const refused=built.not_now.find(row=>/liability/.test(row.why));
    assert.ok(refused,`the J4 refusal never reached the pilot: ${JSON.stringify(built.not_now)}`);
    // And it is labelled with something the pilot can act on rather than an empty string.
    assert.ok(refused!.move.length>0,'a refusal with no label at all');
    assert.ok(!built.not_now.some(row=>row.move===''),`an unlabelled not_now row: ${JSON.stringify(built.not_now)}`);
    // Live 2026-09-30 (kvothe): "J9 Price circuit walked" stood in 122 contexts. No row id reaches the pilot.
    assert.doesNotMatch(renderMenu(built),/\bJ\d+\b/,renderMenu(built));
  } finally {f.close();}
});

test('the refusals the rules produce are capped and ranked, because not_now is prompt budget too',async()=>{
  // `shared.travel` maps over every site in the system, so a fuel shortfall refuses one verdict per
  // POI and would bury the stance refusal that actually explains why the shift is stuck. The rows
  // that say why the pilot cannot do its job come first, and the tail is dropped rather than shown.
  const f=world({mood:'Cautious',stance:'Prospector',goal:'obtain credits'},
    {pois:[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'},{id:'d',name:'D'},{id:'e',name:'E'}]});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    f.account.server.ship.fuel=8;
    const built=await menu(f.runtime);
    const travel=built.not_now.filter(row=>/^Travel to /.test(row.move));
    assert.ok(travel.length<=1,`one shortfall became ${travel.length} near-identical rows: ${JSON.stringify(travel)}`);
    assert.ok(built.not_now.length<=6,`not_now ran to ${built.not_now.length} rows`);
  } finally {f.close();}
});

test('hunting looks at a nebula, and at a planet, because fauna is not confined to the types we happened to name',async()=>{
  // Live 2026-09-25, driven on the real game: the only fauna in the whole region was in
  // `probability_cloud_distant_light`, `type: "nebula"` — found after an asteroid belt and five
  // planets came back empty. The habitat filter was /belt|field|cloud/, which does not match
  // `nebula`, so the menu would never have sent a Hunter there. The career README had said
  // "exotics in nebulae" all along; the code disagreed with the documentation.
  //
  // A type whitelist is the wrong shape for this. Mining needs ore and must stay typed; hunting
  // needs somewhere to look, and every type we have not yet seen fauna in is a habitat a
  // whitelist wrongly excludes. So the types are a PREFERENCE and nothing is filtered out.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'},
    {pois:[{id:'neb',name:'Distant Light',type:'nebula'},{id:'rock',name:'Grey Rock',type:'planet'}]});
  try {
    f.account.server.location.docked_at='sol_base';f.account.server.location.poi_id='station';
    const built=await menu(f.runtime);
    const hunt=built.moves.find(m=>m.call.startsWith('hunt({look:'));
    assert.ok(hunt,`no hunt at all: ${JSON.stringify(built.moves)} / ${JSON.stringify(built.not_now)}`);
    assert.match(hunt!.call,/'neb'/,`the nebula is not on the list: ${hunt!.call}`);
    // And a planet is a place to look too — it is ranked after the known habitats, not excluded.
    assert.match(hunt!.call,/'rock'/,`a planet was filtered out rather than ranked: ${hunt!.call}`);
    // The documented habitats still come first, because that is where fauna has been seen.
    assert.ok(hunt!.call.indexOf("'neb'")<hunt!.call.indexOf("'rock'"),
      `a planet outranked a nebula: ${hunt!.call}`);
  } finally {f.close();}
});

test('nothing in the system is filtered out of a hunt, only ordered',async()=>{
  // The whitelist refused with "no belt, field or cloud in sol to hunt at" and sent the pilot away
  // from a system it had never looked in. Every POI is somewhere fauna might be.
  const f=world({mood:'Focused',stance:'Hunter',objective:'cull the fauna'},
    {pois:[{id:'p1',name:'First',type:'planet'},{id:'p2',name:'Second',type:'planet'}]});
  try {
    f.account.server.location.docked_at='sol_base';f.account.server.location.poi_id='station';
    const built=await menu(f.runtime);
    const hunt=built.moves.find(m=>m.call.startsWith('hunt({look:'));
    assert.ok(hunt,`told to leave a system it never looked in: ${JSON.stringify(built.not_now)}`);
    // The belt leads because it is a known habitat; the planets are on the list behind it.
    assert.match(hunt!.call,/^hunt\(\{look:\['belt'/,hunt!.call);
    assert.match(hunt!.call,/'p1'|'p2'/,`the planets were excluded rather than ranked: ${hunt!.call}`);
  } finally {f.close();}
});

test("a docked Trader is offered routes(), below a live J6 run, whatever the hold; another stance is not",async()=>{
  const far=JSON.stringify([{base_id:'range_base',at:'earlier',tick:TICK-40,
    items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]);
  // No spread: routes() is the Trader's lead, and it compiles.
  const blind=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    const built=await menu(blind.runtime);
    assert.equal(built.moves[0]?.call,'routes()',renderMenu(built));
    assert.match(built.moves[0]!.why,/net per jump.*next call.*the best trade known/);
    const runtime=mkdtempSync(join(tmpdir(),'menu-routes-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {routes} from 'play';\nexport default async function main() {\n  return ${built.moves[0]!.call};\n}\n`);
    assert.deepEqual((await check(runtime)).errors,[]);
  } finally {blind.close();}
  // A concrete spread beats the search.
  const ok=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(ok.runtime,'markets.json'),far);
    const calls=(await menu(ok.runtime)).moves.map(m=>m.call);
    const run=calls.indexOf("tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})"),search=calls.indexOf('routes()');
    assert.ok(run>=0&&search>run,JSON.stringify(calls));
  } finally {ok.close();}
  // A full hold: goods aboard are routes too.
  const full=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:12,cargoCapacity:12});
  try {
    const built=await menu(full.runtime);
    assert.ok(built.moves.some(m=>m.call==='routes()'),renderMenu(built));
  } finally {full.close();}
  // Not a Trader.
  const miner=world({mood:'Opportunistic',stance:'Prospector'},{cargoUsed:0});
  try {
    const built=await menu(miner.runtime);
    assert.ok(!built.moves.some(m=>m.call==='routes()')&&!built.not_now.some(row=>row.move==='routes'),renderMenu(built));
  } finally {miner.close();}
});

test('a docked Trader with unread books near is offered scoutMarkets(), under the trades, and it compiles; with none near, not',async()=>{
  const near=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    const built=await menu(near.runtime);
    const calls=built.moves.map(m=>m.call),scout=built.moves.find(m=>m.call==='scoutMarkets()');
    assert.ok(scout,renderMenu(built));
    assert.equal(scout!.advances,'knowledge');
    assert.match(scout!.why,/within 4 jumps: 0 base\(s\) never read, 2 system\(s\) never listed, 0 book\(s\) older than 1080 ticks/);
    assert.ok(calls.indexOf('routes()')<calls.indexOf('scoutMarkets()'),JSON.stringify(calls));
    const runtime=mkdtempSync(join(tmpdir(),'menu-scout-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {scoutMarkets} from 'play';\nexport default async function main() {\n  return ${scout!.call};\n}\n`);
    assert.deepEqual((await check(runtime)).errors,[]);
  } finally {near.close();}
  // Every base placed, every book fresh: nothing to scout.
  const known=world({mood:'Opportunistic',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(known.runtime,'places.json'),JSON.stringify({sol_base:'sol',range_base:'deep_range'}));
    writeFileSync(join(known.runtime,'markets.json'),JSON.stringify(['sol_base','range_base'].map(base_id=>({base_id,at:'',tick:TICK,items:[]}))));
    const built=await menu(known.runtime);
    assert.ok(!built.moves.some(m=>m.call==='scoutMarkets()')&&!built.not_now.some(row=>row.move==='scoutMarkets()'),renderMenu(built));
  } finally {known.close();}
});

test('goods with no bid here and a remembered far bid are a pasteable tradeRun in every stance; with no far bid, not_now says so',async()=>{
  // Live 2026-09-24: dark_matter_residue, iridium, vanadium and copper aboard at a station that
  // bid for none of them; the menu offered stow and never the base that did bid.
  const far=JSON.stringify([{base_id:'range_base',at:'earlier',tick:TICK-30,items:[
    {item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0},
    {item_id:'iridium',best_buy:90,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}]);
  const held=world({mood:'Focused',stance:'Prospector',goal:'obtain credits'},
    {cargoUsed:12,cargoCapacity:12,store:[{item_id:'iridium',quantity:30}],markets:{sol_base:[]}});
  try {
    writeFileSync(join(held.runtime,'markets.json'),far);
    const built=await menu(held.runtime);
    const aboard=built.moves.find(m=>m.call==="tradeRun({stops:[{at:'range_base'}]})");
    assert.ok(aboard,renderMenu(built));
    assert.match(aboard!.why,/12 ore aboard has no bid at sol_base; range_base bid 40 .* 30 ticks old .* fuel there is not priced in/);
    assert.equal(built.moves[0]!.call,aboard!.call,'the full hold ranks the far sale above the stow');
    const stored=built.moves.find(m=>m.call==="tradeRun({stops:[{at:'sol_base',buy:'iridium',from:'store'},{at:'range_base'}]})");
    assert.ok(stored,renderMenu(built));
    assert.match(stored!.why,/30 iridium in the store here/);
    const runtime=mkdtempSync(join(tmpdir(),'menu-far-'));
    mkdirSync(join(runtime,'pilot'),{recursive:true});
    writeFileSync(join(runtime,'pilot','index.ts'),
      `import {tradeRun} from 'play';\nexport default async function main() {\n  await ${aboard!.call};\n  return ${stored!.call};\n}\n`);
    assert.deepEqual((await check(runtime)).errors,[]);
  } finally {held.close();}
  // No book anywhere bids: no move, and the menu says why rather than going quiet.
  const blind=world({mood:'Focused',stance:'Prospector'},{cargoUsed:12,cargoCapacity:12,store:[],markets:{sol_base:[]}});
  try {
    const built=await menu(blind.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('tradeRun(')),renderMenu(built));
    assert.ok(built.not_now.some(row=>row.move==='sell'&&/no remembered book bids for 12 ore/.test(row.why)),renderMenu(built));
  } finally {blind.close();}
});

// Live 2026-09-28 (kvothe): `inspect rubble` answered "Ship class not found" on every menu render.
test('a ship class the catalogue cannot answer for is asked about once, not on every menu',async()=>{
  const f=world({mood:'Focused',objective:'obtain credits'},{cargoUsed:0,
    hangar:{unknownClasses:['rubble'],listings:[{listing_id:'l1',ship_id:'s2',class_id:'rubble',price:100}]}});
  try {
    const inspects=()=>f.sent.filter(call=>call.action==='spacemolt/inspect'&&call.params.id==='rubble').length;
    await menu(f.runtime);
    assert.equal(inspects(),1,'the menu reads the listing\'s class');
    await menu(f.runtime);
    assert.equal(inspects(),1,'and does not ask again');
  } finally {f.close();}
});

test('a wreck-sale mission is not offered as fitting tradeRun',async()=>{
  const record:Pilot={mood:'Cautious',stance:'Trader',goal:'obtain credits'};
  const f=world(record);
  try {
    const command:typeof f.command=async(action,params)=>{
      const res=await f.command(action,params);
      if(action==='spacemolt/get_missions')(res as any).structuredContent.missions=[
        {mission_id:'w1',title:'Wreck sale',type:'sell',difficulty:1,objectives:[{description:'Sell 1 wreck at a salvage yard'}],rewards:{credits:9}},
        {mission_id:'t1',title:'Sell ore',type:'sell',difficulty:1,objectives:[{description:'Sell 5 ore'}],rewards:{credits:9}}];
      return res;
    };
    bind({account:f.account as unknown as ReadinessAccount,command,pilot:()=>record,runtime:f.runtime,emit:()=>{}});
    const text=JSON.stringify((await menu(f.runtime)).moves);
    assert.ok(!text.includes("acceptMission('w1')"),text);
    assert.ok(text.includes("acceptMission('t1')"),text);
  } finally {f.close();}
});

test('pilotingGap names the class asks nothing this pilot has not cleared, and the gap when it has not',()=>{
  // Live: a Tier 2 listing was offered every juncture and the server refused it outright —
  // `skill_required: Flying a Tier 2 ship requires Piloting level 10 (you have 9)`.
  assert.equal(pilotingGap(10,{level:9,xp:1744,next_level_xp:2000}),'needs Piloting 10, you have 9 (xp 1744/2000)');
  assert.equal(pilotingGap(10,{level:10,xp:0,next_level_xp:5000}),null);
  assert.equal(pilotingGap(0,{level:0,xp:0,next_level_xp:100}),null,'no requirement is never a gap');
  // The skill unread (get_skills failed, attempt() swallowed it) is unknown, not 0: no gap.
  assert.equal(pilotingGap(5,undefined),null,'an unread skill is not a gap');
});

test('an unfitted module in the store, not the hold, is offered as a refit, not left to be sold',async()=>{
  // Live 2026-09-28: 5 cargo_expander_i sat in the store here and the menu only ever scanned the
  // hold, so the sell move took them instead of a refit ever being offered.
  const record:Pilot={mood:'Focused',stance:'Prospector'};
  const f=world(record,{cargoUsed:0,store:[{item_id:'cargo_expander_ii',quantity:1}]});
  try {
    // An empty board and an already-visited neighbour, so the refit is not crowded off the
    // five-row cap by the two other generic moves every stance gets.
    const command:typeof f.command=async(action,params)=>{
      const res=await f.command(action,params);
      if(action==='spacemolt/get_missions')(res as any).structuredContent.missions=[];
      if(action==='spacemolt/get_map')for(const row of (res as any).structuredContent.systems??[])row.visited=true;
      return res;
    };
    bind({account:f.account as unknown as ReadinessAccount,command,pilot:()=>record,runtime:f.runtime,emit:()=>{}});
    const built=await menu(f.runtime);
    const refit=built.moves.find(m=>m.call==="refit({install:['cargo_expander_ii']})");
    assert.ok(refit,`no refit from the store: ${JSON.stringify(built.moves)}`);
    assert.match(refit!.why,/in the store here/);
  } finally {f.close();}
});

test('a stuck abandonMission unblocks acceptMission and ranks onto the menu, and a full board says "no slot free" once',async()=>{
  const f=world({mood:'Focused',stance:'Prospector',goal:'obtain credits'},{cargoUsed:0});
  try {
    // Five active missions, each short of an item nobody is carrying: every slot is stuck, none
    // completable, none expired.
    for(let i=0;i<5;i++)f.taken.push({mission_id:`x${i}`,title:`Stuck ${i}`,type:'delivery',difficulty:1,
      percent_complete:0,expires_in_ticks:500,rewards:{credits:1},
      objectives:[{item_id:'iron_ore',required:10,current:0,completed:false,description:'iron'}]});
    const built=await menu(f.runtime);
    // Ranked onto the menu (not cut by the 5-row cap) because it unblocks acceptMission.
    assert.ok(built.moves.some(m=>m.call.startsWith('abandonMission(')),JSON.stringify(built.moves));
    // The default board (m1, m2) both fit a Prospector and neither is active: one "no slot
    // free" line, not one per fitting mission.
    const noSlot=built.not_now.filter(row=>row.move==='acceptMission');
    assert.equal(noSlot.length,1,JSON.stringify(built.not_now));
  } finally {f.close();}
});
