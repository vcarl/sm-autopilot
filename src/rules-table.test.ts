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
  assert.deepEqual(counter!.call,{tool:'spacemolt_recipes',params:{}});
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
