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
