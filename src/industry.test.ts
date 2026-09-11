import test from 'node:test';
import assert from 'node:assert/strict';
import {CatalogCache, type Account} from '@spacemolt/lib';
import {normalizeIndustryCatalog} from './persistent-catalog.ts';
import { executeIndustry, craftRouting, settleExperiment, sameQuantities, viableSpend } from './industry.ts';

test('settles partial output across cargo-sized sales and resumes without duplicate withdrawal or production', async () => {
  const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:2,cargo_used:0},cargo:[]};
  let storage=5, first=true;
  const calls:string[]=[];
  const command=async (action:string,params:any={})=>{
    calls.push(action);
    if(action==='spacemolt/craft')return {kind:'queue',jobs:null,total_jobs:0};
    if(action==='spacemolt_storage/view')return {items:[{item_id:'metal',quantity:storage,size:1}]};
    if(action==='spacemolt_storage/withdraw'){storage-=params.quantity;account.ship.cargo_used+=params.quantity;account.cargo=[{item_id:'metal',quantity:account.ship.cargo_used}];return {};}
    if(action==='spacemolt/sell'){
      const sold=first?1:params.quantity;first=false;
      account.ship.cargo_used-=sold;account.cargo=[{item_id:'metal',quantity:account.ship.cargo_used}];account.credits+=sold*10+100;
      return {quantity_sold:sold,total_earned:sold*10,unsold:params.quantity-sold};
    }
    throw new Error(`Unexpected ${action}`);
  };
  const experiment:any={experiment_id:'experiment',station:'station',job_id:'job',status:'pending',started:Date.now(),spent:3,earned:0,sold:{},withdrawn:{},sales:[],before:{storage:[],cargo:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:5}],rawSaleCredits:12,expectedProfit:47}}};
  const snapshots:any[]=[];
  const save=(e:any)=>snapshots.push(structuredClone(e));
  const partial=await settleExperiment(experiment,{max_wait_seconds:0},account as Account,command,save);
  assert.equal(partial.status,'partial');assert.equal(partial.sold.metal,1);assert.equal(partial.withdrawn.metal,2);
  const resumed=await settleExperiment(structuredClone(partial),{max_wait_seconds:0},account as Account,command,save);
  assert.equal(resumed.status,'complete');assert.equal(resumed.sold.metal,5);assert.equal(resumed.withdrawn.metal,5);
  assert.equal(storage,0);assert.equal(account.ship.cargo_used,0);assert.equal(resumed.realized_credit_delta,47);assert.equal(resumed.incremental_profit_after_input_opportunity,35);
  assert.equal(calls.filter(a=>a==='spacemolt_storage/withdraw').length,3);
  assert.ok(snapshots.some(e=>e.pending_action?.action==='spacemolt/sell'));
});

test('an unresolved mutation is not replayed and malformed queues never mean completion',async()=>{
  const account:any={location:{docked_at:'station'}};
  const base:any={station:'station',job_id:'job',status:'pending'};
  let calls=0;
  const command=async()=>{calls++;return {message:'not a queue'};};
  const unknown=await settleExperiment({...base,pending_action:{action:'spacemolt/sell'}},{},account,command,()=>{});
  assert.equal(unknown.status,'needs_reconciliation');assert.equal(calls,0);
  const malformed=await settleExperiment(base,{max_wait_seconds:0},account,command,()=>{});
  assert.equal(malformed.status,'partial');assert.match(malformed.reason,/Malformed/);assert.equal(calls,1);
});


test('repricing must preserve profit as well as reserve and craft formulas compare aggregated quantities',()=>{
  const initial={spent:0,remaining:10,labor:2,revenue:20,opportunity:0,wallet:100,reserve:50,maxSpend:40,minProfit:3};
  assert.equal(viableSpend(initial),true);
  assert.equal(viableSpend({...initial,remaining:18}),false);
  assert.equal(viableSpend({...initial,spent:8,remaining:8}),false);
  assert.equal(viableSpend({...initial,opportunity:7}),false);
  assert.equal(viableSpend({...initial,wallet:60}),false);
  assert.equal(sameQuantities([{item_id:'ore',quantity:2},{item_id:'ore',quantity:3}],[{item_id:'ore',quantity:5}]),true);
  assert.equal(sameQuantities([{item_id:'ore',quantity:5}],[{item_id:'ore',quantity:6}]),false);
  assert.equal(sameQuantities([{item_id:'ore',quantity:NaN}],[{item_id:'ore',quantity:NaN}]),false);
});

test('workshop quotes route by preset while real facilities retain their identifier',()=>{
  assert.deepEqual(craftRouting({venue_type:'workshop',facility_id:'workshop:player:station'}),{preset:'workshop'});
  assert.deepEqual(craftRouting({venue_type:'facility',facility_id:'real-facility'}),{preset:'cheap',facility_id:'real-facility'});
});

test('shared settlement checkpoints preserve queued work and accepted withdrawals before stopping',async()=>{
  const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:2,cargo_used:0},cargo:[]};
  const experiment:any={experiment_id:'shared',station:'station',job_id:'job',status:'pending',started:0,spent:0,earned:0,sold:{},withdrawn:{},sales:[],before:{storage:[],cargo:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:2}]}}};
  let time=0,queued=true,tired=false,stock=2;
  const sleeps:number[]=[],snapshots:any[]=[],mutations:string[]=[];
  const context={existing_experiments:[experiment],record:(e:any)=>snapshots.push(structuredClone(e)),now:()=>time,
    sleep:async(ms:number)=>{sleeps.push(ms);time+=ms;tired=true;},checkpoint:async()=>{if(tired)throw new Error('Tired: return home');}};
  const command=async(action:string,params:any={})=>{
    if(action==='spacemolt/craft')return {kind:'queue',jobs:queued?[{job_id:'job'}]:[]};
    if(action==='spacemolt_storage/view')return {items:[{item_id:'metal',quantity:stock,size:1}]};
    mutations.push(action);
    if(action==='spacemolt_storage/withdraw'){stock-=params.quantity;account.ship.cargo_used+=params.quantity;account.cargo=[{item_id:'metal',quantity:account.ship.cargo_used}];tired=true;return {};}
    throw new Error(`Unexpected mutation ${action}`);
  };
  const pending:any=await executeIndustry('settle',{experiment_id:'shared'},account,command,context);
  assert.equal(pending.status,'pending');assert.equal(pending.job_id,'job');
  assert.ok(sleeps.length>0&&sleeps.every(ms=>ms>0&&ms<=2000));assert.deepEqual(mutations,[]);
  assert.equal(snapshots.at(-1).reason,pending.reason);
  queued=false;tired=false;
  const partial:any=await executeIndustry('settle',{experiment_id:'shared'},account,command,context);
  assert.equal(partial.status,'partial');assert.equal(partial.withdrawn.metal,2);
  assert.equal(partial.pending_action,undefined);assert.deepEqual(mutations,['spacemolt_storage/withdraw']);
  assert.equal(snapshots.at(-1).withdrawn.metal,2);
});

test('shared production persists every mutation and uses accepted costs despite unrelated wallet income',async()=>{
  for(const missingEscrow of [false,true]) {
    const recipe={id:'refine',name:'Refine',category:'refining',description:'',crafting_time:1,inputs:[{item_id:'ore',quantity:2}],outputs:[{item_id:'metal',quantity:1}]};
    const cache=new CatalogCache(normalizeIndustryCatalog({version:'fixture',items:[],recipes:[recipe]}));
    const account:any={credits:100,location:{docked_at:'station'},cargo:[],state:{skills:{}}};
    let stock=0;
    const snapshots:any[]=[],mutations:string[]=[];
    const market={items:[{item_id:'ore',sell_orders:[{price_each:2,quantity:20}],buy_orders:[]},{item_id:'metal',buy_orders:[{price_each:20,quantity:20}]}]};
    const context={existing_experiments:[] as any[],catalog:Promise.resolve({cache,freshness:'fresh' as const,fetchedAt:0,retryAt:null}),snapshot:Promise.resolve({market,storage:{items:[]},facilities:{}}),record:(e:any)=>snapshots.push(structuredClone(e)),now:()=>0};
    const command=async(action:string,params:any={})=>{
      if(action==='spacemolt_market/view_market')return market;
      if(action==='spacemolt_market/estimate_purchase')return {total_cost:4,sales_tax:0,unfilled:0,fills:[{price_each:2,quantity:2}]};
      if(action==='spacemolt_storage/view')return {items:[{item_id:'ore',quantity:stock}]};
      if(action==='spacemolt/craft'&&params.dry_run)return {kind:'quote',runs:1,credits_total:3,effective_time_per_run:1,have_inputs:true,cost:{inputs:recipe.inputs},produces:recipe.outputs};
      if(action==='spacemolt/craft'&&!params.id)return {kind:'queue',jobs:[{job_id:'job'}]};
      mutations.push(action);account.credits+=100;
      if(action==='spacemolt/buy'){stock=2;return {total_cost:4,unfilled:0,delivered_to_storage:2};}
      if(action==='spacemolt/craft')return {kind:'job',job_id:'job',escrowed:missingEscrow?{labor:3}:{labor:2,fee:1}};
      throw new Error(`Unexpected ${action}`);
    };
    const result:any=await executeIndustry('produce',{recipe_id:'refine',source:'buy',credit_reserve:0,max_spend:7,max_wait_seconds:0},account,command,context);
    assert.equal(result.job_id,'job');assert.equal(result.earned,0);
    assert.equal(result.spent,missingEscrow?4:7);
    assert.equal(result.status,missingEscrow?'needs_reconciliation':'pending');
    assert.equal(result.pending_action,undefined);
    assert.ok(snapshots.some(e=>e.pending_action?.action==='spacemolt/buy'));
    assert.ok(snapshots.some(e=>e.pending_action?.action==='spacemolt/craft'));
    assert.equal(snapshots.at(-1).job_id,'job');assert.equal(snapshots.at(-1).status,result.status);
    context.existing_experiments.push(result);
    const resumed:any=await executeIndustry('settle',{experiment_id:result.experiment_id,max_wait_seconds:0},account,command,context);
    assert.equal(resumed.status,result.status);
    assert.deepEqual(mutations,['spacemolt/buy','spacemolt/craft']);
    if(!missingEscrow) {
      account.ship={cargo_capacity:1,cargo_used:0};
      let output=1;
      const saleReceipt={quantity_sold:1,unsold:0};
      const settleCommand=async(action:string,params:any={})=>{
        if(action==='spacemolt/craft')return {kind:'queue',jobs:[]};
        if(action==='spacemolt_storage/view')return {items:[{item_id:'metal',quantity:output,size:1}]};
        mutations.push(action);
        if(action==='spacemolt_storage/withdraw'){output=0;account.ship.cargo_used=1;account.cargo=[{item_id:'metal',quantity:1}];return {};}
        if(action==='spacemolt/sell'){account.ship.cargo_used=0;account.cargo=[];account.credits+=100;return saleReceipt;}
        throw new Error(`Unexpected ${action}`);
      };
      const unpriced:any=await executeIndustry('settle',{experiment_id:result.experiment_id,max_wait_seconds:0},account,settleCommand,context);
      assert.equal(unpriced.status,'needs_reconciliation');assert.equal(unpriced.sold.metal,1);
      assert.equal(unpriced.earned,0);assert.equal(unpriced.pending_action,undefined);
      assert.deepEqual(unpriced.last_receipt,saleReceipt);
      assert.equal(unpriced.accounting_unverified.action,'spacemolt/sell');
      assert.equal(snapshots.at(-1).sold.metal,1);
      const beforeRetry=[...mutations];
      const blocked:any=await executeIndustry('settle',{experiment_id:result.experiment_id},account,async()=>{throw new Error('Unpriced settlement must not issue commands');},context);
      assert.equal(blocked.status,'needs_reconciliation');assert.deepEqual(mutations,beforeRetry);
    }
  }
});

test('own-use production retains verified output without sale demand while preserving input quote and budget gates',async()=>{
  for(const source of ['inventory','buy'])for(const scenario of ['retain','zero_workshop','sell','incomplete','changed_quote','budget']) {
    const recipe={id:'build',name:'Build cabin',category:'utility',description:'',crafting_time:1,inputs:[{item_id:'ore',quantity:2}],outputs:[{item_id:'cabin',quantity:1}]};
    const cache=new CatalogCache(normalizeIndustryCatalog({version:'retention-fixture',items:[],recipes:[recipe]}));
    const stock=[{item_id:'ore',quantity:source==='inventory'?2:0},{item_id:'cabin',quantity:3}];
    const account:any={credits:100,location:{docked_at:'station'},cargo:[{item_id:'original',quantity:1}],state:{skills:{}}};
    const mutations:string[]=[],snapshots:any[]=[];
    let estimates=0;
    const context={existing_experiments:[],catalog:Promise.resolve({cache,freshness:'fresh' as const,fetchedAt:0,retryAt:null}),snapshot:Promise.resolve({market:{items:[]},storage:{items:structuredClone(stock)},facilities:{}}),record:(row:any)=>snapshots.push(structuredClone(row))};
    const command=async(action:string,params:any={})=>{
      if(action==='spacemolt_market/view_market')return {items:[]};
      if(action==='spacemolt_storage/view')return {items:structuredClone(stock)};
      if(action==='spacemolt_market/estimate_purchase') {
        estimates++;
        return {quantity_requested:2,available:2,unfilled:0,subtotal:4,sales_tax:0,total_cost:scenario==='incomplete'||scenario==='changed_quote'&&estimates>1?0:4,fills:[{quantity:2,price_each:2}]};
      }
      if(action==='spacemolt/craft'&&params.dry_run)return {kind:'quote',runs:1,credits_total:scenario==='zero_workshop'?0:3,effective_time_per_run:1,have_inputs:stock[0]!.quantity>=2,have_credits:true,have_capacity:true,cost:{inputs:recipe.inputs,...(scenario==='zero_workshop'?{}:{labor:2,fee:1})},produces:recipe.outputs};
      if(action==='spacemolt/craft'&&!params.id)return {kind:'queue',jobs:[],total_jobs:0};
      mutations.push(action);
      if(action==='spacemolt/buy'){stock[0]!.quantity+=2;account.credits+=96;return {total_cost:4,unfilled:0,delivered_to_storage:2};}
      if(action==='spacemolt/craft'){stock[0]!.quantity-=2;stock[1]!.quantity++;account.credits+=scenario==='zero_workshop'?100:97;return {kind:'job',job_id:'job',escrowed:scenario==='zero_workshop'?{labor:0,fee:0}:{labor:2,fee:1}};}
      throw new Error(`Unexpected retained-output mutation ${action}`);
    };
    const params={recipe_id:'build',source,...(scenario==='sell'?{}:{disposition:'retain'}),credit_reserve:0,max_spend:scenario==='budget'?2:7,max_wait_seconds:0};
    const result:any=await executeIndustry('produce',params,account,command,context);
    const succeeds=['retain','zero_workshop'].includes(scenario)||source==='inventory'&&['incomplete','changed_quote'].includes(scenario);
    if(succeeds) {
      assert.equal(result.status,'complete',result.reason);assert.equal(result.disposition,'retain');
      assert.deepEqual(result.retained,{cabin:1});assert.equal(stock[1]!.quantity,4);
      assert.equal(result.earned,0);assert.equal(result.realized_credit_delta,0-((source==='buy'?4:0)+(scenario==='zero_workshop'?0:3)));
      assert.equal(result.incremental_profit_after_input_opportunity,null);assert.equal(result.quote.evaluation.expectedProfit,null);
      assert.deepEqual(account.cargo,[{item_id:'original',quantity:1}]);
      assert.ok(snapshots.every(row=>row.disposition==='retain'));
    } else {assert.notEqual(result.status,'complete');assert.deepEqual(mutations,[]);}
    assert.equal(mutations.some(action=>action==='spacemolt/sell'||action==='spacemolt_storage/withdraw'),false);
  }
});
