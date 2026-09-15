import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMenu,type Facts} from './rules-table.ts';

// D2/D3: Relaxed and Tired are not initial moods, so neither may initiate a stance job.
const richProspector=(mood:Facts['mood']):Facts=>({
  mood,stance:'Prospector',
  place:{kind:'base',base_id:'base',is_home:false,counters:[],
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
