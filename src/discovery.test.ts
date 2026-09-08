import test from 'node:test';
import { SpacemoltError } from '@spacemolt/lib';
import assert from 'node:assert/strict';
import {discoverMarket,selectDiscoveryCandidates} from './discovery.ts';

const candidate=(recipe_id:string,output:string,input:string,gross_margin:number)=>({recipe_id,source:'buy',outputs:[{item_id:output,quantity:1}],inputs:[{item_id:input,quantity:2}],gross_margin});
test('discovery diversifies formulas, ranks opportunity-adjusted profit and keeps blocked recipes as evidence',async()=>{
  const screen={station:'station',candidates:[candidate('metal_a','metal','ore_a',100),candidate('metal_b','metal','ore_a',99),{...candidate('crystal','lens','ore_b',30),source:'inventory'},candidate('fuel','fuel','ore_c',20)]};
  const selected=selectDiscoveryCandidates(screen,3);
  assert.deepEqual(new Set(selected.flatMap(row=>row.outputs.map((o:any)=>o.item_id))),new Set(['metal','lens','fuel']));
  const calls:any[]=[],saved:any[]=[];
  const result=await discoverMarket({limit:3},{screen:async()=>screen,quote:async(params)=>{
    calls.push(params);
    if(params.recipe_id==='fuel')throw new SpacemoltError('skill_required','Requires refining level 3');
    const owned=params.source==='inventory';
    return {station:'station',craft:{runs:1,credits_total:4,venue:'Factory'},evaluation:{feasible:true,blockers:[],unknowns:[],expectedProfit:owned?100:20,processingAdvantage:owned?-5:10,seconds:10,purchaseCredits:owned?0:12,rawSaleCredits:105}};
  },record:row=>saved.push(row),now:()=>1000});
  assert.equal(calls.length,3);assert.ok(calls.every(row=>row.quantity===1));
  assert.equal(result.ranked[0].recipe_id,'metal_a');
  const inventory=result.ranked.find((row:any)=>row.source==='inventory');
  assert.equal(inventory.status,'blocked_hypothesis');assert.equal(inventory.economic_profit,-5);assert.equal(inventory.expected_cash_profit,100);
  assert.ok(result.ranked.find((row:any)=>row.recipe_id==='fuel').blockers.some((reason:string)=>reason.includes('refining')));
  assert.equal(saved[0].quotes.length,calls.length);assert.equal(saved[0].screen,screen);
  assert.equal(result.quotes,undefined);
});

test('unknown transport interrupts discovery without disguising it as an economic failure',async()=>{
  let calls=0;
  await assert.rejects(discoverMarket({limit:2},{screen:async()=>({candidates:[candidate('a','x','ore',10),candidate('b','y','gas',9)]}),quote:async()=>{calls++;throw Object.assign(new Error('lost connection'),{code:'connection_closed'});}}),/lost connection/);
  assert.equal(calls,1);
  await assert.rejects(discoverMarket({limit:13},{screen:async()=>{throw new Error('must not query');},quote:async()=>({})}),/1..12/);
});

test('available profitable gas survives complex blocked recipes and missing inputs never report executable earnings',async()=>{
  const gas=candidate('compress_gas','compressed_gas','gas',130);
  const complex=Array.from({length:15},(_,i)=>({...candidate(`complex_${i}`,`module_${i}`,`missing_${i}`,9000-i),source:'mine_or_buy',gross_margin:undefined,potential_conversion_margin:9000-i,blockers:['insufficient inventory'],inputs:Array.from({length:20},(_,j)=>({item_id:`component_${j}`,quantity:10})),inputs_needed:[{item_id:'component_0',quantity:10}]}));
  const screen={candidates:[gas],exploration_candidates:complex};
  const chosen=selectDiscoveryCandidates(screen,6);
  assert.equal(chosen[0].recipe_id,'compress_gas');assert.equal(chosen.length,1);
  const several={...screen,candidates:[gas,candidate('other_a','product_a','input_a',30),candidate('other_b','product_b','input_b',10)]};
  assert.equal(selectDiscoveryCandidates(several,6).filter(row=>row.discovery_pool==='actionable').length,3);
  const result=await discoverMarket({limit:6},{screen:async()=>screen,quote:async(params)=>({craft:{runs:1},evaluation:{feasible:params.recipe_id==='compress_gas',blockers:params.recipe_id==='compress_gas'?[]:['insufficient supply: component_0'],unknowns:[],expectedProfit:6026,processingAdvantage:5000,seconds:10}})});
  assert.equal(result.ranked[0].recipe_id,'compress_gas');
  const blocked=result.ranked.find((row:any)=>row.recipe_id!=='compress_gas');
  assert.equal(blocked.economic_profit,null);assert.equal(blocked.economic_profit_per_second,null);assert.equal(blocked.expected_cash_profit,null);
  assert.equal(blocked.theoretical_processing_advantage,9000);assert.equal(blocked.quote_skipped,true);assert.equal(result.quote_count,1);assert.ok(blocked.blockers.length);assert.ok(blocked.inputs_needed.length);
});


test('supplied negative single-run recipes receive bounded learning attention without projected gains',async()=>{
  const screen={candidates:[candidate('income','metal','ore',20),candidate('practice','lens','crystal',-4)],exploration_candidates:[{...candidate('future','reactor','rare',900),source:'mine_or_buy',blockers:['skill required']}]};
  assert.ok(selectDiscoveryCandidates(screen,3,5).some(row=>row.recipe_id==='practice'));
  const context={skills:{crafting:{level:1,xp:5}},required_skills:{crafting:1}};
  const result=await discoverMarket({limit:3,max_learning_loss:5},{screen:async()=>screen,quote:async(params)=>({skill_context:context,craft:{runs:1,credits_total:1},evaluation:{feasible:params.recipe_id!=='future',blockers:params.recipe_id==='future'?['skill required']:[],unknowns:[],expectedProfit:params.recipe_id==='income'?20:-4,seconds:10}})});
  const probe=result.learning_candidates.find((row:any)=>row.recipe_id==='practice');
  assert.equal(probe.learning_kind,'supplied_single_run_probe');
  assert.equal(probe.expected_learning_loss,4);assert.equal(probe.within_learning_loss_cap,true);
  assert.deepEqual(probe.skill_context,context);assert.deepEqual(probe.skill_progress,[]);
  assert.ok(!result.income_candidates.some((row:any)=>row.recipe_id==='practice'));
  assert.ok(result.learning_candidates.some((row:any)=>row.recipe_id==='future'));
});


test('known supply facility and skill blockers never call quote, and unaffordable losses stay local',async()=>{
  const blocked=['missing supplies','missing facility','required skill'].map((reason,index)=>({...candidate(`blocked_${index}`,`future_${index}`,'rare',1000),blockers:[reason]}));
  const calls:string[]=[];
  const result=await discoverMarket({limit:6,max_learning_loss:3},{screen:async()=>({candidates:[candidate('income','metal','ore',8),candidate('affordable','practice','ore',-2),candidate('over_budget','other','ore',-4),...blocked]}),quote:async(params)=>{
    calls.push(params.recipe_id);return {craft:{runs:1},evaluation:{feasible:true,blockers:[],unknowns:[],expectedProfit:params.recipe_id==='income'?8:-2,seconds:10}};
  }});
  assert.deepEqual(calls,['income','affordable']);
  assert.equal(result.quote_count,2);
  const local=result.learning_candidates.filter((row:any)=>row.quote_skipped);
  assert.equal(local.length,4);
  assert.ok(local.every((row:any)=>row.economic_profit===null&&row.expected_cash_profit===null));
  assert.equal(result.local_hypothesis_count,4);
  assert.ok(!selectDiscoveryCandidates({candidates:[candidate('loss','item','ore',-1)]},3).length);
});


test('unchanged observed skill failures reuse a bounded memo but changed snapshots and expiry requery',async()=>{
  let at=1000,calls=0,key='initial';const memo=new Map();
  const deps={screen:async()=>({station:'a',catalog_version:'v',observation_key:key,candidates:[candidate('probe','item','ore',8)]}),quote:async()=>{calls++;throw new SpacemoltError('skill_required','Need level3');},now:()=>at,blockedQuoteMemo:memo};
  await discoverMarket({limit:1},deps);
  const reused=await discoverMarket({limit:1},deps);
  assert.equal(calls,1);assert.equal(reused.cache_reuse_count,1);assert.equal(reused.quote_count,0);
  key='changed_skills';await discoverMarket({limit:1},deps);assert.equal(calls,2);
  at+=300001;await discoverMarket({limit:1},deps);assert.equal(calls,3);
  const rateDeps={...deps,quote:async()=>{calls++;throw new SpacemoltError('rate_limited','Slow down');}};
  key='rate';await assert.rejects(discoverMarket({limit:1},rateDeps),/Slow down/);await assert.rejects(discoverMarket({limit:1},rateDeps),/Slow down/);assert.equal(calls,5);
});


test('catalog metadata survives blocked and completed discovery, and rate limits stop the scan',async()=>{
  const catalog={status:'cooldown',complete:false},retryAt=1234;
  const blocked=await discoverMarket({}, {screen:async()=>({status:'blocked',reason:'catalog unavailable',catalog,retryAt,evaluated_recipe_count:0}),quote:async()=>{throw new Error('must not quote');}});
  assert.deepEqual(blocked.catalog,catalog);assert.equal(blocked.retryAt,retryAt);
  let calls=0;
  for(const code of ['rate_limited','server_busy']){
    await assert.rejects(discoverMarket({limit:2},{screen:async()=>({candidates:[candidate('a','x','ore',10),candidate('b','y','ore',9)]}),quote:async()=>{calls++;throw new SpacemoltError(code,'defer requests');}}),/defer requests/);
  }
  assert.equal(calls,2);
  const complete=await discoverMarket({}, {screen:async()=>({catalog:{complete:true},evaluated_recipe_count:500,candidates:[]}),quote:async()=>({})});
  assert.deepEqual(complete.catalog,{complete:true});assert.equal(complete.evaluated_recipe_count,500);
});
