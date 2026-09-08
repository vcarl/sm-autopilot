import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryInputPlan} from './industry.ts';

test('owned-input preparation uses storage first and deposits only aggregate recipe shortfalls',()=>{
  const storage=[{item_id:'silicon',quantity:4},{item_id:'carbon',quantity:18}];
  const cargo=[{item_id:'silicon',quantity:25},{item_id:'palladium',quantity:4},{item_id:'unrelated_module',quantity:1}];
  const original=structuredClone({storage,cargo});
  const plan=inventoryInputPlan([{item_id:'silicon',quantity:5},{item_id:'silicon',quantity:3},{item_id:'carbon',quantity:2},{item_id:'palladium',quantity:5}],storage,cargo);
  assert.deepEqual(plan.find(row=>row.item_id==='silicon'),{item_id:'silicon',required:8,stored:4,carried:25,available:29,deposit_from_cargo:4,missing:0});
  assert.equal(plan.find(row=>row.item_id==='carbon')!.deposit_from_cargo,0);
  assert.equal(plan.find(row=>row.item_id==='palladium')!.missing,1);
  assert.ok(!plan.some(row=>row.item_id==='unrelated_module'));
  assert.deepEqual({storage,cargo},original);
  const fulfilled=inventoryInputPlan([{item_id:'silicon',quantity:8}],[{item_id:'silicon',quantity:8}],cargo);
  assert.equal(fulfilled[0].deposit_from_cargo,0);
});
