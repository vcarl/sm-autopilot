import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendStrategy } from './experiment-strategy.ts';
import { compactIndustryReply } from './industry.ts';

test('funding uses incremental inventory profit and settled unique outcomes, not cash liquidation or unfinished mining', () => {
  const history = [
    { experiment_id: 'inventory', status: 'pending', realized_credit_delta: 10000 },
    { experiment_id: 'inventory', status: 'complete', quote: {source:'inventory', recipe_id:'steel'}, station:'a', realized_credit_delta:10000, incremental_profit_after_input_opportunity:100 },
    { experiment_id: 'bad-stock', status:'complete', quote:{source:'inventory'}, realized_credit_delta:5000 },
    { event:'mining_experiment', id:'unpaid-fuel', status:'completed', realized_profit:5000, fuel_liability_units:1, hull_liability_units:0 },
  ];
  const result = recommendStrategy(history, 150010);
  assert.equal(result.budget.positiveEconomicProfit, 100);
  assert.equal(result.budget.explorationFund, 1025);
  assert.equal(result.budget.availableExploration, 10);
  assert.equal(result.repeatCandidates.length, 1);
  assert.equal(result.budget.excludedOutcomes, 2);
});

test('realized losses exhaust risk capital while stale untried quotes remain observations', () => {
  const history = [
    { experiment_id:'loss', status:'complete', quote:{source:'buy',recipe_id:'bad'}, station:'a', realized_credit_delta:-1100 },
    { event:'quote', at:0, station:'b',recipe_id:'new',source:'buy',evaluation:{purchaseCredits:10,feasible:true}, inputQuotes:[{total_cost:10}],craft:{credits_total:1} },
  ];
  const exhausted = recommendStrategy(history, 200000, {nowMs:120000});
  assert.equal(exhausted.budget.nextExperimentCap, 0);
  assert.equal(exhausted.explorationCandidates[0].quoteStale, true);
  assert.equal(exhausted.explorationCandidates[0].withinBudget, false);
  assert.ok(!exhausted.nextActions.some(row => row.action === 'revalidate_untried_quote'));
  const funded = recommendStrategy([...history, {experiment_id:'win',status:'complete',quote:{source:'buy',recipe_id:'good'},station:'a',realized_credit_delta:1000}],200000,{nowMs:120000});
  assert.equal(funded.budget.nextExperimentCap,150);
  assert.equal(funded.explorationCandidates[0].withinBudget,true);
  assert.equal(funded.explorationCandidates[0].requiresFreshQuote,true);
});


test('latest station discoveries survive without quotes and remain explicitly non-executable',()=>{
  const history=[
    {event:'screen',station:'a',exploration_candidates:[{recipe_id:'obsolete'}]},
    {event:'screen',station:'a',at:'2026-09-09T00:00:00Z',exploration_candidates:[{recipe_id:'phase_matrix',inputs_needed:[{item_id:'null_matter',quantity:3}],blockers:['insufficient inventory'],potential_conversion_margin:450,output_sale_credits:500}]},
    {event:'screen',station:'b',exploration_candidates:[{recipe_id:'new_alloy',potential_conversion_margin:null,output_sale_credits:800}]},
  ];
  const result=recommendStrategy(history,200000);
  assert.deepEqual(result.discoveryCandidates.map(row=>row.recipe_id),['phase_matrix','new_alloy']);
  assert.deepEqual(result.discoveryCandidates[0].inputs_needed,[{item_id:'null_matter',quantity:3}]);
  assert.ok(result.discoveryCandidates.every(row=>!row.executable&&!row.quoted&&row.expectedProfit===null&&row.requiresFreshQuote));
  assert.ok(result.nextActions.some(row=>row.action==='investigate_unquoted_recipe'&&'recipe_id' in row&&row.recipe_id==='phase_matrix'));
  const compact=compactIndustryReply('recommend',result) as {discoveryCandidates:unknown[];nextActions:{action:string}[]};
  assert.equal(compact.discoveryCandidates.length,2);
  assert.ok(compact.nextActions.some(row=>row.action==='investigate_unquoted_recipe'));
});

test('repeat ranking uses measured profit rate and reports distinct settled sample counts',()=>{
  const row=(id:string,recipe:string,profit:number,seconds:number)=>({experiment_id:id,status:'complete',station:'a',quote:{source:'buy',recipe_id:recipe},realized_credit_delta:profit,seconds});
  const result=recommendStrategy([row('slow','iron',100,100),row('fast1','new',50,10),row('fast1','new',50,10),row('fast2','new',60,10)],200000);
  assert.equal(result.repeatCandidates[0].recipe_id,'new');
  assert.equal(result.repeatCandidates[0].observedEconomicProfitPerSecond,6);
  assert.equal(result.repeatCandidates[0].seconds,10);
  assert.equal(result.repeatCandidates[0].sampleCount,2);
});


test('earlier losses remain learning evidence and changed skills require reevaluation without invented XP',()=>{
  const skill_context={skills:{crafting:{level:1,xp:5}},required_skills:{crafting:1}};
  const skill_progress=[{skill_id:'crafting',level_gain:0,verified_xp_gain:3}];
  const history=[{experiment_id:'practice',status:'complete',station:'a',quote:{source:'buy',recipe_id:'lens'},realized_credit_delta:-4,skill_context,skill_progress},
    {event:'quote',station:'b',recipe_id:'probe',source:'buy',skill_context,evaluation:{feasible:true,expectedProfit:-3,blockers:[]},craft:{runs:1}}];
  const result=recommendStrategy(history,200000,{maxLearningLoss:5,currentSkillContext:{skills:{crafting:{level:1,xp:8}}}});
  assert.equal(result.repeatCandidates.length,0);
  const prior=result.learningCandidates.find(row=>row.recipe_id==='lens')!;
  assert.deepEqual(prior.skill_progress,skill_progress);assert.equal(prior.skill_context_changed,true);
  assert.equal(prior.observed_economic_profit,-4);assert.equal(prior.executable,false);
  const probe=result.learningCandidates.find(row=>row.recipe_id==='probe')!;
  assert.equal(probe.expected_learning_loss,3);assert.equal(probe.within_learning_loss_cap,true);
  assert.ok(result.nextActions.some(row=>row.action==='reevaluate_learning_probe'));
});
