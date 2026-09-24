import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from '../readiness.ts';
import {journalRun} from '../run-record.ts';
import {evaluateMenu,jobStop,type Facts} from '../rules-table.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {factsNow,menu,menuDue,renderMenu,type RunSummary} from './menu.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-menu-'));
  const game=bridgeWorld({services:['refuel','repair','storage','shipyard'],...options});
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,pilot:()=>record,setPilot:()=>{},runtime,emit:()=>{}});
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
    const hunt=built.moves.find(m=>m.call==='hunt()');
    assert.ok(hunt,`no hunt on the menu: ${JSON.stringify(built.moves)}`);
    assert.equal(hunt!.advances,'objective','the hunt is not tagged [credits]');
    assert.ok(!built.moves.every(m=>m.advances==='credits'),'every move tagged [credits]');
    // Docked, the hunt is out of reach rather than silently absent.
    f.account.server.location.docked_at='sol_base';
    const docked=await menu(f.runtime);
    assert.ok(!docked.moves.some(m=>m.call==='hunt()'));
    assert.ok(docked.not_now.some(row=>row.move==='hunt'),JSON.stringify(docked.not_now));
  } finally {f.close();}
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
    // Docked, the same brawl outside is not a threat: rest and resupply stay on the menu.
    f.account.server.location.docked_at='sol_base';
    f.account.server.location.poi_id='station';
    const inside=await facts(f,who);
    assert.equal(inside.observed.threats,undefined);
    assert.equal(jobStop(inside),null);
    assert.ok(evaluateMenu(inside).some(row=>row.tag==='rest'),'no rest row at the counter under a brawl outside');
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
    assert.deepEqual(seen.observed.spread,{item_id:'ore',margin:28,age:5});
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
    // A pre-ageing markets.json: no `tick` on the entry. The operator's rule is to assume 20.
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'range_base',at:'earlier',
      items:[{item_id:'ore',best_buy:40,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}]));
    const seen=await facts(f,who);
    assert.deepEqual(seen.observed.spread,{item_id:'ore',margin:28,age:20});
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
    assert.deepEqual(seen.observed.spread,{item_id:'ore',margin:28,age:0});
    assert.doesNotMatch(verdict(seen,'J6').reason,/-\d/);
  } finally {f.close();}
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
    // The operator's liability permission is what a package has to fit inside, not the board.
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
