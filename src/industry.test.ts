import test from 'node:test';
import assert from 'node:assert/strict';
import type { Account } from '@spacemolt/lib';
import { craftRouting, settleExperiment, sameQuantities, viableSpend } from './industry.ts';

test('settles partial output across cargo-sized sales and resumes without duplicate withdrawal or production', async () => {
  const account:any={credits:100,location:{docked_at:'station'},ship:{cargo_capacity:2,cargo_used:0},cargo:[]};
  let storage=5, first=true;
  const calls:string[]=[];
  const command=async (action:string,params:any={})=>{
    calls.push(action);
    if(action==='spacemolt/craft')return {kind:'queue',jobs:null,total_jobs:0};
    if(action==='spacemolt_storage/view')return {items:[{item_id:'metal',quantity:storage,size:1}]};
    if(action==='spacemolt_storage/withdraw'){storage-=params.quantity;account.ship.cargo_used+=params.quantity;return {};}
    if(action==='spacemolt/sell'){
      const sold=first?1:params.quantity;first=false;
      account.ship.cargo_used-=sold;account.credits+=sold*10;
      return {quantity_sold:sold,total_earned:sold*10,unsold:params.quantity-sold};
    }
    throw new Error(`Unexpected ${action}`);
  };
  const experiment:any={experiment_id:'experiment',station:'station',job_id:'job',status:'pending',started:Date.now(),spent:3,earned:0,sold:{},withdrawn:{},sales:[],before:{storage:[]},quote:{source:'inventory',evaluation:{inputs:[],outputs:[{item_id:'metal',quantity:5}],rawSaleCredits:12,expectedProfit:47}}};
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
