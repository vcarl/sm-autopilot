import test from 'node:test';
import assert from 'node:assert/strict';
import {settleExperiment} from './industry.ts';

test('settlement never sells starting cargo when output withdrawal is absent or partial',async()=>{
  for(const moved of [0,1]) {
    const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:10,cargo_used:2},cargo:[{item_id:'metal',quantity:2}]};
    let storage=2;
    const sales:number[]=[];
    const experiment:any={experiment_id:'custody',station:'station',job_id:'job',status:'pending',started:0,spent:0,earned:0,sold:{},withdrawn:{},sales:[],before:{cargo:structuredClone(account.cargo),storage:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:2}]}}};
    const command=async(action:string,params:any={})=>{
      if(action==='spacemolt/craft')return {kind:'queue',jobs:[]};
      if(action==='spacemolt_storage/view')return {items:[{item_id:'metal',quantity:storage,size:1}]};
      if(action==='spacemolt_storage/withdraw'){
        storage-=moved;account.cargo[0].quantity+=moved;account.ship.cargo_used+=moved;
        return {item_id:'metal',quantity:params.quantity};
      }
      if(action==='spacemolt/sell'){
        sales.push(params.quantity);account.cargo[0].quantity-=params.quantity;account.ship.cargo_used-=params.quantity;account.credits+=params.quantity*10;
        return {quantity_sold:params.quantity,total_earned:params.quantity*10};
      }
      throw new Error(`Unexpected ${action}`);
    };
    const result=await settleExperiment(experiment,{max_wait_seconds:0},account,command,()=>{});
    assert.equal(result.status,'needs_reconciliation');
    assert.equal(result.pending_action.action,'spacemolt_storage/withdraw');
    const retry=await settleExperiment(result,{},account,async()=>{throw new Error('Unverified withdrawal must not be replayed');},()=>{});
    assert.equal(retry.status,'needs_reconciliation');
    assert.deepEqual(sales,[],'Unverified output withdrawal cannot authorize a sale');
    assert.ok(account.cargo[0].quantity>=experiment.before.cargo[0].quantity,'Starting cargo is preserved');
  }
});


test('resumed settlement cannot substitute starting stock for vanished produced cargo',async()=>{
  const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:10,cargo_used:2},cargo:[{item_id:'metal',quantity:2}]};
  const experiment:any={experiment_id:'partial',station:'station',job_id:'job',status:'partial',started:0,spent:0,earned:0,sold:{},withdrawn:{metal:2},sales:[],before:{cargo:[{item_id:'metal',quantity:2}],storage:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:2}]}}};
  const command=async(action:string)=>{
    if(action==='spacemolt/craft')return {kind:'queue',jobs:[]};
    if(action==='spacemolt_storage/view')return {items:[]};
    throw new Error(`No mutation authorized after produced cargo disappeared: ${action}`);
  };
  const result=await settleExperiment(experiment,{max_wait_seconds:0},account,command,()=>{});
  assert.equal(result.status,'partial');assert.match(result.reason,/starting inventory/);
  assert.equal(account.cargo[0].quantity,2);assert.deepEqual(result.sold,{});
});


test('accepted sale must match canonical cargo removal before production is complete',async()=>{
  const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:10,cargo_used:4},cargo:[{item_id:'metal',quantity:4}]};
  const experiment:any={experiment_id:'sale',station:'station',job_id:'job',status:'partial',started:0,spent:0,earned:0,sold:{},withdrawn:{metal:2},sales:[],before:{cargo:[{item_id:'metal',quantity:2}],storage:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:2}]}}};
  const sale={quantity_sold:2,total_earned:20};
  const command=async(action:string)=>{
    if(action==='spacemolt/craft')return {kind:'queue',jobs:[]};
    if(action==='spacemolt_storage/view')return {items:[]};
    if(action==='spacemolt/sell')return sale;
    throw new Error(`Unexpected ${action}`);
  };
  const result=await settleExperiment(experiment,{max_wait_seconds:0},account,command,()=>{});
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.pending_action.action,'spacemolt/sell');
  assert.deepEqual(result.last_receipt,sale);assert.equal(account.cargo[0].quantity,4);
  await settleExperiment(result,{},account,async()=>{throw new Error('Unverified sale cannot replay');},()=>{});
});

test('retained settlement preserves purpose and starting stock through resume and final observation',async()=>{
  for(const scenario of ['complete','starting_only','vanished','malformed','queue_count','missing_count','changed_disposition','pending','overlap_retain','overlap_sell']) {
    const account:any={credits:97,location:{docked_at:'station'},cargo:[{item_id:'original',quantity:1}],state:{skills:{}}};
    const overlapping=scenario.startsWith('overlap');
    const experiment:any={experiment_id:'retained',station:'station',job_id:'job',status:'pending',disposition:scenario==='overlap_sell'?'sell':'retain',started:0,spent:3,earned:0,sold:{},withdrawn:{},sales:[],before:{storage:[{item_id:'metal',quantity:10}],cargo:structuredClone(account.cargo)},quote:{source:'inventory',disposition:scenario==='overlap_sell'?'sell':'retain',evaluation:{inputs:overlapping?[{item_id:'metal',quantity:2}]:[],outputs:[{item_id:'metal',quantity:1}]}}};
    let reads=0,calls=0;
    const command=async(action:string)=>{
      calls++;
      if(action==='spacemolt/craft')return {kind:'queue',jobs:scenario==='pending'?[{job_id:'job'}]:[],...(scenario==='missing_count'?{}:{total_jobs:['pending','queue_count'].includes(scenario)?1:0})};
      if(action==='spacemolt_storage/view') {
        reads++;
        return {items:[{item_id:'metal',quantity:scenario==='malformed'?'unknown':scenario==='starting_only'||overlapping||scenario==='vanished'&&reads>1?10:11}]};
      }
      throw new Error(`Retained settlement cannot mutate ${action}`);
    };
    const result=await settleExperiment(experiment,{max_wait_seconds:0,...(scenario==='changed_disposition'?{disposition:'sell'}:{})},account,command,()=>{});
    if(scenario==='complete') {
      assert.equal(result.status,'complete',result.reason);assert.deepEqual(result.retained,{metal:1});
      assert.equal(result.realized_credit_delta,-3);assert.equal(result.earned,0);assert.equal(result.incremental_profit_after_input_opportunity,null);
      const again=await settleExperiment(structuredClone(result),{},account,async()=>{throw new Error('Completed retention must not re-settle');},()=>{});
      assert.deepEqual(again.retained,{metal:1});
    } else assert.notEqual(result.status,'complete');
    if(scenario==='changed_disposition'||overlapping)assert.equal(calls,0);
    assert.deepEqual(result.sold??{},{});assert.deepEqual(result.withdrawn??{},{});
    assert.deepEqual(account.cargo,experiment.before.cargo);
  }
});
