import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogCache} from '@spacemolt/lib';
import {executeIndustry} from './industry.ts';
import {normalizeIndustryCatalog} from './persistent-catalog.ts';

test('discovery shares one station snapshot across finalists and never quotes missing inputs',async()=>{
  const recipe=(id:string,input:string,output:string)=>({id,name:id,category:'refining',description:'',crafting_time:1,inputs:[{item_id:input,quantity:2}],outputs:[{item_id:output,quantity:1}]});
  const recipes=[recipe('gas','gas_input','gas_output'),recipe('ore','ore_input','ore_output'),recipe('blocked','missing','gas_output')];
  const cache=new CatalogCache(normalizeIndustryCatalog({version:'fixture',items:[],recipes}));
  const calls:{action:string;params:any}[]=[],events:any[]=[];
  const command=async(action:string,params:any={})=>{
    calls.push({action,params});
    if(action==='spacemolt_market/view_market')return {items:['gas_input','ore_input','gas_output','ore_output'].map(item_id=>({item_id,sell_orders:[{price_each:2,quantity:100}],buy_orders:[{price_each:10,quantity:100}]}))};
    if(action==='spacemolt_storage/view')return {items:[]};
    if(action==='spacemolt_facility/list')return {station_facilities:[]};
    if(action==='spacemolt/craft'){
      assert.equal(params.dry_run,true);
      const r=recipes.find(r=>r.id===params.id)!;
      assert.notEqual(r.id,'blocked');
      return {kind:'quote',runs:1,credits_total:0,effective_time_per_run:1,cost:{inputs:r.inputs},produces:r.outputs};
    }
    if(action==='spacemolt_market/estimate_purchase')return {total_cost:4,sales_tax:0,fills:[{price_each:2,quantity:2}]};
    throw new Error(`Unexpected action ${action}`);
  };
  const result:any=await executeIndustry('discover',{limit:8},{credits:200000,location:{docked_at:'station'},cargo:[],state:{skills:{}}} as any,command,{catalog:Promise.resolve({cache,freshness:'fresh',fetchedAt:1000,retryAt:null}),record:event=>events.push(event)});
  for(const action of ['spacemolt_market/view_market','spacemolt_storage/view','spacemolt_facility/list'])assert.equal(calls.filter(c=>c.action===action).length,1);
  assert.equal(result.quote_count,2);
  assert.equal(result.income_candidates.length,2);
  assert.equal(result.evaluated_recipe_count,3);
  assert.ok(result.learning_candidates.some((r:any)=>r.recipe_id==='blocked'&&r.quote_skipped));
  assert.equal(calls.length,7);
  assert.equal(events.filter(e=>e.event==='market_discovery').length,1);
});

test('cold catalog cooldown and stale production refuse all game requests',async()=>{
  const account:any={credits:200000,location:{docked_at:'station'}};
  const command=async()=>{throw new Error('must not query game');};
  const unavailable:any=await executeIndustry('discover',{},account,command,{catalog:Promise.resolve({cache:null,freshness:'unavailable',fetchedAt:null,retryAt:2000,reason:'HTTP 429'})});
  assert.equal(unavailable.status,'blocked');
  assert.equal(unavailable.catalog.retryAt,2000);
  const cache=new CatalogCache(normalizeIndustryCatalog({version:'fixture',items:[],recipes:[]}));
  const stale:any=await executeIndustry('produce',{recipe_id:'x'},account,command,{catalog:Promise.resolve({cache,freshness:'stale',fetchedAt:1000,retryAt:2000})});
  assert.equal(stale.status,'blocked');
  assert.match(stale.reason,/stale/);
});
