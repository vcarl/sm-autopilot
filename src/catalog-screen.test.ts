import test from 'node:test';
import assert from 'node:assert/strict';
import { screenCatalog } from './catalog-screen.ts';

const level = (price_each:number,quantity=100) => ({price_each,quantity});
test('screens the full catalog before ranking and retains recipes with missing output demand', () => {
  const recipes = Array.from({length:65},(_,index)=>({id:`r${index}`,inputs:[{item_id:'ore',quantity:1}],outputs:[{item_id:`out${index}`,quantity:1}],crafting_time:1}));
  const result = screenCatalog({recipes,station:'a',storage:[],cargo:[],facilities:{},skills:{},
    market:{items:[{item_id:'ore',sell_orders:[level(1)],buy_orders:[level(1)]},...recipes.slice(0,64).map((recipe,index)=>({item_id:recipe.outputs[0].item_id,buy_orders:[level(index+2)]}))]}});
  assert.equal(result.evaluated_recipe_count,65);
  assert.equal(result.candidates[0].recipe_id,'r63');
  const missingDemand = result.exploration_candidates.find(row=>row.recipe_id==='r64');
  assert.ok(missingDemand);
  assert.equal(missingDemand.output_demand_complete,false);
  assert.equal(missingDemand.potential_conversion_margin,null);
  assert.ok(missingDemand.blockers.some((reason:string)=>reason.startsWith('insufficient demand:')));
});

test('aggregates owned stock and distinguishes explicit gates from unknown skills and private ownership', () => {
  const recipe = {id:'r',facility_only:true,required_skills:{refining:3},inputs:[{item_id:'ore',quantity:2},{item_id:'ore',quantity:2}],outputs:[{item_id:'plate',quantity:1}],crafting_time:1};
  const input = {recipes:[recipe],station:'a',storage:{items:[{item_id:'ore',quantity:1},{item_id:'ore',quantity:1}]},cargo:[{item_id:'ore',quantity:2}],
    market:{items:[{item_id:'plate',buy_orders:[level(50)]},{item_id:'ore',buy_orders:[level(2)]}]},skills:{refining:{level:2}},facilities:{public_facilities:[{recipe_id:'r',production:{public:false}}]}};
  const blocked = screenCatalog(input).exploration_candidates[0];
  assert.deepEqual(blocked.inputs_needed,[]);
  assert.ok(blocked.blockers.some((reason:string)=>reason.includes('Requires refining')));
  assert.ok(blocked.blockers.some((reason:string)=>reason.includes('accessible facility')));
  const owned = screenCatalog({...input,skills:{},facilities:{player_facilities:[{recipe_id:'r',name:'Own',production:{public:false}}]}});
  assert.equal(owned.candidates.find(row=>row.source==='inventory')?.venue,'Own');
  assert.ok(owned.candidates[0].unknowns.includes('Unknown skill level: refining'));
  const shortage = screenCatalog({...input,cargo:[]}).exploration_candidates[0];
  assert.deepEqual(shortage.inputs_needed,[{item_id:'ore',quantity:2}]);
});
