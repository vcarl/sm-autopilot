import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMenu,jobStop,type Facts} from './rules-table.ts';

// D2/D3: Relaxed and Tired are not initial moods, so neither may initiate a stance job.
const richProspector=(mood:Facts['mood']):Facts=>({
  mood,stance:'Prospector',
  place:{kind:'base',base_id:'base',counters:[],
    sites:[{poi_id:'belt',quoted_fuel:5,resource:'ore'}]},
  holdings:{fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:100_000},
  obligations:{},permissions:{},observed:{}});

test('the workshop counter carries the read it would be taken with',()=>{
  const facts={...richProspector('Focused'),
    place:{kind:'base' as const,base_id:'base',counters:['Workshop / recipes' as const],sites:[]}};
  const counter=evaluateMenu(facts).find(v=>v.job==='Counter: Workshop / recipes');
  assert.ok(counter?.admissible,'a base with a bench offers the counter');
  assert.equal(counter!.play,'recipes()');
});

test('a stance job admissible under Focused is blocked under Relaxed, naming the mood',()=>{
  const job='J1 Hold full of ore';
  const focused=evaluateMenu(richProspector('Focused')).find(v=>v.job===job);
  assert.ok(focused?.admissible,'Focused: preconditions hold, so the job is offered');

  const relaxed=evaluateMenu(richProspector('Relaxed')).find(v=>v.job===job);
  assert.equal(relaxed?.admissible,false,'Relaxed may not initiate a job');
  assert.match(relaxed!.reason,/Relaxed/);
});

test('the rules between jobs and the menu refuse the same worlds',()=>{
  // A run asks jobStop before every job, and the menu asks the same two rules of the
  // stance rows. What one refuses mid-script the other must refuse on the menu (R5).
  const job='J1 Hold full of ore';
  for(const mood of ['Focused','Cautious','Opportunistic','Aggressive'] as const) {
    const facts=richProspector(mood);
    assert.equal(jobStop(facts),null,mood);
    assert.equal(evaluateMenu(facts).find(v=>v.job===job)?.admissible,true,mood);
  }
  for(const mood of ['Tired','Relaxed'] as const) {
    const facts=richProspector(mood);
    assert.match(jobStop(facts)??'',new RegExp(mood),mood);
    assert.notEqual(evaluateMenu(facts).find(v=>v.job===job)?.admissible,true,mood);
  }
  // A threat seen stops the next job and empties the menu of everything but safety.
  const dangerous={...richProspector('Focused'),observed:{threats:['raider']}};
  assert.match(jobStop(dangerous)??'',/raider/);
  assert.ok(evaluateMenu(dangerous).every(v=>v.tag==='safety'));
});

test('a travel verdict carries the barrel call a pilot can paste, not a script helper',()=>{
  // Live 2026-09-24: a pilot wedged below its fuel reserve out in the open sat Tired for six
  // hours. `resupply.travel` knew the serviced base and the quote all along and offered
  // `travel(ctx,'sol_base')` in prose — a script helper that does not exist in the barrel, so
  // pasting it costs a whole juncture and the pilot still has no exit. The exit is `goTo`.
  const wedged:Facts={mood:'Cautious',stance:'Prospector',
    place:{kind:'space',sites:[{poi_id:'sol_base',quoted_fuel:5,serviced_base:true}]},
    holdings:{fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:1000},
    obligations:{},permissions:{},observed:{}};
  const trip=evaluateMenu(wedged).find(v=>v.job==='Travel to sol_base');
  assert.ok(trip?.admissible,`the fuel admits the hop: ${trip?.reason}`);
  assert.equal(trip!.play,"goTo('sol_base')");
  assert.doesNotMatch(trip!.reason,/travel\(ctx/,'the reason still names a helper the barrel has no export for');
});

test('a travel verdict the fuel refuses carries no call to paste',()=>{
  // A refused option is a sentence, never a call: handing the pilot a line the same build just
  // refused is how a menu contradicts itself.
  const dry:Facts={mood:'Cautious',stance:'Prospector',
    place:{kind:'space',sites:[{poi_id:'sol_base',quoted_fuel:80,serviced_base:true}]},
    holdings:{fuel:10,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:1000},
    obligations:{},permissions:{},observed:{}};
  const trip=evaluateMenu(dry).find(v=>v.job==='Travel to sol_base');
  assert.equal(trip?.admissible,false,trip?.reason);
  assert.equal(trip!.play,undefined);
});

/** Every verdict a stance can be shown, with the barrel line the pilot would paste, or
 * `undefined` where the barrel has no primitive for it at all. The menu offers exactly the
 * rows with a line and leaves the rest unsaid, so this table is the contract between what the
 * rules know and what the pilot can actually do about it. */
test('each admissible verdict carries the barrel call it would be taken with, or none at all',()=>{
  const rich=(over:Partial<Facts>):Facts=>({mood:'Focused',
    place:{kind:'base',base_id:'sol_base',counters:[],sites:[]},
    holdings:{fuel:60,max_fuel:120,hull:80,max_hull:100,cargo_free:50,credits:100_000},
    obligations:{},permissions:{},observed:{},...over});
  const play=(facts:Facts,job:string)=>evaluateMenu(facts).find(v=>v.job.startsWith(job));

  // J12: the counter at this base, which is the one verdict the menu already consumed.
  const serviced=play(rich({place:{kind:'base',base_id:'sol_base',counters:['Services'],sites:[],
    service_prices:{fuel:1,hull:1}}}),'J12');
  assert.ok(serviced?.admissible,serviced?.reason);
  assert.equal(serviced!.play,'service()');

  // A counter is a read, and the read is a barrel call, not the MCP tool name the pilot cannot
  // paste. `Services` is the exception: its act is J12's, and one owner per idea.
  const counters=evaluateMenu(rich({place:{kind:'base',base_id:'sol_base',sites:[],
    counters:['Market','Storage','Workshop / recipes','Hangar / refit','Boards — missions','Boards — shipping','Services','Comms / news']}}));
  const byName=(name:string)=>counters.find(v=>v.job===`Counter: ${name}`);
  assert.equal(byName('Market')!.play,'prices()');
  assert.equal(byName('Storage')!.play,'storage()');
  assert.equal(byName('Workshop / recipes')!.play,'recipes()');
  assert.equal(byName('Hangar / refit')!.play,'shipsForSale()');
  assert.equal(byName('Boards — missions')!.play,'missions()');
  assert.equal(byName('Boards — shipping')!.play,'freightBoard()');
  assert.equal(byName('Services')!.play,undefined,'the act at the service counter is J12, not the counter row');
  assert.equal(byName('Comms / news')!.play,undefined,'no barrel call reaches the news desk');

  // J1: the belt the fuel admits, and the base the trip comes home to. `gatherUntil` refuses
  // outright without a base to settle at (mining.ts), so the call names one or is not offered.
  const j1=play(rich({stance:'Prospector',
    place:{kind:'base',base_id:'sol_base',counters:[],sites:[{poi_id:'belt',quoted_fuel:5,resource:'ore'}]}}),'J1 ');
  assert.ok(j1?.admissible,j1?.reason);
  assert.equal(j1!.play,"gatherUntil({poi:'belt',base:'sol_base'})");

  // Undocked with no base named, the same belt is still reachable and the call would refuse for
  // want of a home: the rules say so in prose rather than handing over a line that fails.
  const homeless=play(rich({stance:'Prospector',
    place:{kind:'poi',counters:[],sites:[{poi_id:'belt',quoted_fuel:5,resource:'ore'}]}}),'J1 ');
  assert.ok(homeless?.admissible,homeless?.reason);
  assert.equal(homeless!.play,undefined,'a gather with nowhere to settle is not a call to paste');
  assert.match(homeless!.reason,/base/);

  const j7=play(rich({stance:'Industrialist',
    place:{kind:'base',base_id:'sol_base',counters:[],workshop:true,sites:[]},
    holdings:{fuel:60,max_fuel:120,hull:80,max_hull:100,cargo_free:50,credits:100,inputs:['iron_plate']}}),'J7');
  assert.ok(j7?.admissible,j7?.reason);
  assert.equal(j7!.play,'recipes()');

  const j6=play(rich({stance:'Trader',observed:{spread:{item_id:'ore',margin:40,age:12}}}),'J6');
  assert.ok(j6?.admissible,j6?.reason);
  assert.equal(j6!.play,'spreads()','the remembered bid is a lead; spreads() is what confirms it live');

  const j4=play(rich({stance:'Carrier',permissions:{max_liability:9000},
    place:{kind:'base',base_id:'sol_base',counters:[],sites:[],
      board:{contracts:[{id:'ship_7',cargo:10,liability:500}]}}}),'J4');
  assert.ok(j4?.admissible,j4?.reason);
  assert.equal(j4!.play,"haul('ship_7')");

  const j5=play(rich({stance:'Carrier',
    place:{kind:'base',base_id:'sol_base',counters:[],sites:[],board:{passengers:3}}}),'J5');
  assert.ok(j5?.admissible,j5?.reason);
  assert.equal(j5!.play,'carryPassengers()');

  const j8=play(rich({stance:'Hunter',place:{kind:'poi',counters:[],sites:[]},
    observed:{targets:['rock_grazer']}}),'J8');
  assert.ok(j8?.admissible,j8?.reason);
  assert.equal(j8!.play,'hunt()','J8 reads targets where the ship stands, so the hunt needs no destination');

  const j9=play(rich({stance:'Scout',place:{kind:'base',base_id:'sol_base',counters:[],
    sites:[{poi_id:'yard_base',quoted_fuel:4,serviced_base:true},{poi_id:'dark_base',quoted_fuel:6,serviced_base:true}]}}),'J9');
  assert.ok(j9?.admissible,j9?.reason);
  assert.equal(j9!.play,'prices()','the circuit starts by reading the book here; that read is what remembers it');
});

test('the verdicts with no barrel primitive behind them carry no call, and the menu leaves them unsaid',()=>{
  // The three safety rows. There is no `watch`, `dock`, `retreat` or `undock` in the barrel:
  // `disengage()` exists but breaks off a battle that already holds THIS ship, whereas a threat
  // here is another ship's `in_combat` flag, so it is the wrong call and not offered.
  const dangerous:Facts={mood:'Focused',stance:'Hunter',place:{kind:'poi',counters:[],sites:[]},
    holdings:{fuel:60,max_fuel:120,hull:80,max_hull:100,cargo_free:50,credits:100},
    obligations:{},permissions:{},observed:{threats:['raider']}};
  const safety=evaluateMenu(dangerous);
  assert.ok(safety.length>=2&&safety.every(v=>v.tag==='safety'),JSON.stringify(safety.map(v=>v.job)));
  assert.deepEqual(safety.filter(v=>v.play!==undefined),[],'a safety row must not offer a call the barrel has no export for');

  const ready:Facts={mood:'Relaxed',place:{kind:'base',base_id:'sol_base',counters:[],sites:[]},
    holdings:{fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:100},
    obligations:{},permissions:{},observed:{}};
  // Rest is the counter-example, and it changed: it used to carry no call because resting was an
  // AI tool. It is a barrel call now, which is what lets the menu offer the end of a shift — and
  // the menu has to, because that tool was the pilot's always-available path to reflecting, and
  // without reflection it can never change stance.
  const rest=evaluateMenu(ready).find(v=>v.job==='Rest and reflect');
  assert.ok(rest?.admissible,rest?.reason);
  assert.equal(rest!.play,'rest()');
});
