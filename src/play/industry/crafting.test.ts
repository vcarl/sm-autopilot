import assert from 'node:assert/strict';
import test from 'node:test';
import type {Catalog} from '@spacemolt/lib';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {craft,recipes,useCatalog} from './crafting.ts';

/** The catalog behind the fake bench's one recipe: 5 iron ore into 2 steel plate. */
const CATALOG={version:'test',recipes:[{id:'refine_steel',name:'Refine Steel',category:'Refining',
  description:'',crafting_time:1,inputs:[{item_id:'iron_ore',quantity:5}],
  outputs:[{item_id:'steel_plate',quantity:2}]}],
items:[{id:'iron_ore',name:'Iron Ore',base_value:4,extracted_by:'mining'},
  {id:'steel_plate',name:'Steel Plate',base_value:120}]} as unknown as Catalog;

// Steel plate is worth 100 here; the ore that makes it is worth 4. That gap is the point.
const BOOK=[{item_id:'steel_plate',best_buy:100,best_buy_qty:99,best_sell:110,best_sell_qty:9},
  {item_id:'iron_ore',best_buy:3,best_buy_qty:99,best_sell:4,best_sell_qty:99}];

function world(record:Pilot,options:WorldOptions={}) {
  useCatalog(async()=>CATALOG);
  const game=bridgeWorld({services:['refuel','repair','storage','crafting'],cargoUsed:0,
    market:BOOK,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text)});
  return {...game,lines,record:()=>who};
}

test('recipes lists what the store can make, with the margin in credits',async()=>{
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}]});
  try {
    const out=await recipes();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.recipes.length,1);
    const row=out.detail.recipes[0]!;
    assert.equal(row.id,'refine_steel');
    // 2 steel plate at best_buy 100, less the bench's 19 cr of labour and fee.
    assert.equal(row.margin,181);
    assert.deepEqual(row.have,[{item_id:'iron_ore',quantity:5,have:20}]);
    assert.equal(f.count('spacemolt_market/view_market'),1,'one market read for the whole book');
    assert.match(out.did,/best margin Refine Steel 181 cr/);
  } finally {unbind();}
});

test('recipes reports a null margin, not zero, when this counter buys none of the outputs',async()=>{
  // The bench works and the store is stocked; the only thing missing is a buyer for plate.
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}],
    markets:{sol_base:[{item_id:'iron_ore',best_buy:3,best_buy_qty:99,best_sell:4,best_sell_qty:99}]}});
  try {
    const out=await recipes();
    assert.equal(out.status,'done',out.why);
    const row=out.detail.recipes[0]!;
    assert.equal(row.margin,null,'unknown here, not worthless');
    assert.match(out.did,/no buyer here for their outputs; see spreads\(\)/);
    assert.match(out.next[0]!,/spreads\(\["steel_plate"\]\)/);
    assert.equal(f.count('spacemolt/craft'),1,'still quoted: the bench is fine, the market is not');
  } finally {unbind();}
});

test('recipes says so when the ore is at a base with no bench',async()=>{
  const f=world({mood:'Focused'},{services:['refuel','storage'],store:[{item_id:'iron_ore',quantity:20}]});
  try {
    const out=await recipes();
    assert.equal(out.status,'refused');
    assert.match(out.why!,/no workshop at sol_base/);
    assert.equal(f.count('spacemolt/craft'),0,'nothing was quoted');
  } finally {unbind();}
});

test('craft is refused at a base with no workshop',async()=>{
  const f=world({mood:'Focused'},{services:['refuel','repair','storage'],
    store:[{item_id:'iron_ore',quantity:20}]});
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'refused');
    assert.match(out.why!,/no workshop at sol_base/);
    assert.equal(f.count('spacemolt/craft'),0,'nothing was sent to a bench that is not there');
  } finally {unbind();}
});

test('craft stows the inputs the bench escrows from the store, then measures the outputs',async()=>{
  // The ore is in the hold, not the store, so the bench's first quote is short.
  const f=world({mood:'Focused'},{cargoUsed:5,cargo:[{item_id:'iron_ore',quantity:5}],
    store:[],craft:{polls:2}});
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.made,[{item_id:'steel_plate',quantity:2}]);
    assert.equal(f.count('spacemolt_storage/deposit'),1,'the hold was stowed once');
    assert.equal(f.store.find(row=>row.item_id==='iron_ore')?.quantity,0,'the ore was escrowed out of the store');
    assert.equal(f.store.find(row=>row.item_id==='steel_plate')?.quantity,2,'the plate was delivered to it');
    assert.equal(out.cost.credits,19,'the fee, measured from the wallet');
    assert.match(out.did,/Refine Steel: 2 steel_plate in sol_base's store/);
  } finally {unbind();}
});

test('craft re-enters the wait for a job already queued here, escrowing nothing twice',async()=>{
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}],craft:{polls:1}});
  // The escrow a run made before it was restarted: the job is already on the bench.
  f.queued.push({base_id:'sol_base',job_id:'job-1',recipe:'Refine Steel',mode:'craft',
    deliver_to:'storage',produces:[{item_id:'steel_plate',quantity:2}],runs_total:1,runs_done:0,
    status:'queued',eta_ticks:0});
  const credits=f.account.server.player.credits;
  try {
    const again=await craft('refine_steel',2);
    assert.equal(again.status,'done',again.why);
    assert.deepEqual(again.detail.made,[{item_id:'steel_plate',quantity:2}]);
    assert.equal(f.account.server.player.credits,credits,'no second escrow left the wallet');
    assert.equal(f.store.find(row=>row.item_id==='iron_ore')?.quantity,20,'nothing was escrowed twice');
  } finally {unbind();}
});
