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

test('a stance job admissible under Focused is blocked under Relaxed, naming the mood',()=>{
  const job='J1 Hold full of ore';
  const focused=evaluateMenu(richProspector('Focused')).find(v=>v.job===job);
  assert.ok(focused?.admissible,'Focused: preconditions hold, so the job is offered');

  const relaxed=evaluateMenu(richProspector('Relaxed')).find(v=>v.job===job);
  assert.equal(relaxed?.admissible,false,'Relaxed may not initiate a job');
  assert.match(relaxed!.reason,/Relaxed/);
});
