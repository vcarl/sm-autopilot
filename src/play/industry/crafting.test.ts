import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Catalog} from '@spacemolt/lib';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {craft,jobs,materials,quote,recipes,revalidated,supply,useCatalog} from './crafting.ts';

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
    pilot:()=>who,emit:text=>lines.push(text)});
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

/** The commits a world was sent: `craft` with a recipe and no `dry_run`. */
const commits=(f:ReturnType<typeof world>)=>f.sent.filter(call=>call.action==='spacemolt/craft'&&call.params.id!==undefined&&!call.params.dry_run);
const mutations=(f:ReturnType<typeof world>)=>commits(f).length+f.count('spacemolt/buy')+f.count('spacemolt_storage/deposit');

test('quote values produces per run times runs',async()=>{
  // 6 plate asked for, 3 per run: the server quotes 2 runs and `produces` says 3 — per run.
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}],
    craft:{runs:2,quantity:6,produces:[{item_id:'steel_plate',quantity:3}]}});
  try {
    const out=await quote('refine_steel',6);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.produces_total.map(row=>[row.item_id,row.quantity]),[['steel_plate',6]]);
    assert.equal(out.detail.output_value,600,'6 plate at 100, not 3');
    assert.equal(out.detail.margin,581);
    assert.match(out.did,/2 runs at Sol Base Workshop \(labour 10 \+ fee 9 cr\), 19 cr in all, makes 6 steel_plate/);
    assert.equal(f.count('spacemolt/craft'),1);
  } finally {unbind();}
});

test('at names the venue the dry run is sent to',async()=>{
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}]});
  try {
    await quote('refine_steel',2);
    await quote('refine_steel',2,{at:'workshop'});
    const there=await quote('refine_steel',2,{at:'fac-1'});
    const sent=f.sent.filter(call=>call.action==='spacemolt/craft').map(call=>call.params);
    assert.equal(sent[0]!.preset,undefined);
    assert.equal(sent[0]!.facility_id,undefined,'omitted is the server\'s choice');
    assert.equal(sent[1]!.preset,'workshop');
    assert.equal(sent[1]!.facility_id,undefined,'the workshop is a preset, never a facility id');
    assert.equal(sent[2]!.facility_id,'fac-1');
    assert.equal(sent[2]!.preset,undefined);
    assert.equal(there.detail.venue_type,'facility');
    assert.equal(there.detail.facility_id,'fac-1');
    assert.equal(there.detail.labor,10);
    assert.equal(there.detail.fee,9);
  } finally {unbind();}
});

test('quote prices each missing input to buy and to sell, and names its source',async()=>{
  const f=world({mood:'Focused'},{store:[]});
  try {
    const out=await quote('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    // The fake market charges 12 each, fee included; the book here bids 3 for ore.
    assert.deepEqual(out.detail.missing,[{item_id:'iron_ore',need:5,have:0,buy_each:12,sell_each:3,source:'mining'}]);
    assert.match(out.next.join('\n'),/iron_ore: store has 0 of 5; buys at 12 cr each, sells at 3/);
    assert.equal(mutations(f),0,'a quote moves nothing');
  } finally {unbind();}
});

test('quote survives a catalog outage and an unsold input',async()=>{
  const f=world({mood:'Focused'},{store:[]});
  useCatalog(async()=>{throw new Error('down');});
  bind({account:f.account as unknown as ReadinessAccount,pilot:()=>f.record(),emit:()=>{},
    command:async(action,params)=>action==='spacemolt_market/estimate_purchase'
      ?{structuredContent:{item_id:params.item_id,available:0,total_cost:0,unfilled:Number(params.quantity)}}
      :f.command(action,params)});
  try {
    const out=await quote('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.missing[0]!.buy_each,null,'not sold here: mine it');
    assert.equal(out.detail.missing[0]!.source,'unknown');
    assert.match(out.next.join('\n'),/materials\('iron_ore', 5\)/);
  } finally {unbind();}
});

test('craft does not re-enter a queued job of the same recipe with a different run count',async()=>{
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}]});
  f.queued.push({base_id:'sol_base',job_id:'job-0',recipe:'Refine Steel',mode:'craft',
    deliver_to:'storage',produces:[{item_id:'steel_plate',quantity:2}],runs_total:3,runs_done:0,
    status:'queued',eta_ticks:0});
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.equal(commits(f).length,1,'a 3-run job is a different order: this one is committed');
    assert.equal(out.detail.venue_type,'workshop');
    assert.match(out.did,/made at Sol Base Workshop \(labour 10 \+ fee 9 cr\)/);
  } finally {unbind();}
});

test('supply is done with nothing sent when the store already holds the inputs',async()=>{
  const f=world({mood:'Focused'},{store:[{item_id:'iron_ore',quantity:20}]});
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.equal(mutations(f),0);
    assert.deepEqual(out.detail,{stowed:[],bought:[],short:[],spent:0});
  } finally {unbind();}
});

test('supply stows what the hold carries and buys the rest into the store',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:2,cargo:[{item_id:'iron_ore',quantity:2}],store:[],taxBps:500});
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.stowed,[{item_id:'iron_ore',quantity:2}]);
    assert.deepEqual(out.detail.bought,[{item_id:'iron_ore',quantity:3}]);
    // 3 at 12 = 36 subtotal, +5% tax (floored) = 37: the fee-inclusive wallet delta, not the
    // reply's pre-tax `total_cost`.
    assert.equal(out.detail.spent,37,'3 at 12 plus tax, from the wallet');
    assert.equal(f.store.find(row=>row.item_id==='iron_ore')?.quantity,5);
    assert.equal(f.sent.find(call=>call.action==='spacemolt/buy')?.params.deliver_to,'storage');
    const again=await supply('refine_steel',2);
    assert.equal(again.status,'done');
    assert.equal(f.count('spacemolt/buy'),1,'a second call buys nothing');
  } finally {unbind();}
});

test('supply refuses a bill over maxSpend before anything moves',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:2,cargo:[{item_id:'iron_ore',quantity:2}],store:[]});
  try {
    const out=await supply('refine_steel',2,{maxSpend:30});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/costs 36 cr, over maxSpend 30/);
    assert.equal(mutations(f),0,'nothing stowed, nothing bought');
  } finally {unbind();}
});

test('jobs reads the queue undocked and flags a workshop job away from the ship as paused',async()=>{
  const f=world({mood:'Focused'},{craft:{polls:5}});
  const row={mode:'craft',deliver_to:'storage',runs_total:2,runs_done:1,status:'active',eta_ticks:3};
  f.queued.push({...row,job_id:'w',base_id:'sol_base',recipe:'Refine Steel',facility_id:''},
    {...row,job_id:'f',base_id:'sol_base',recipe:'Refine Steel',facility_id:'fac-1'});
  f.account.server.location.docked_at=null;
  try {
    const out=await jobs();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.jobs.map(job=>[job.job_id,job.paused]),[['w',true],['f',false]]);
    assert.deepEqual(out.detail.jobs[0],{job_id:'w',recipe:'Refine Steel',base_id:'sol_base',status:'active',
      runs_done:1,runs_total:2,paused:true});
    assert.match(out.did,/1 paused until you dock at sol_base/);
  } finally {unbind();}
});

test('materials walks a two-level tree to its raw leaves, net of what is held',async()=>{
  world({mood:'Focused'},{store:[{item_id:'steel_plate',quantity:2},{item_id:'iron_ore',quantity:3}]});
  useCatalog(async()=>({...CATALOG,recipes:[...CATALOG.recipes,{id:'assemble_hull',name:'Assemble Hull',
    category:'Components',description:'',crafting_time:1,inputs:[{item_id:'steel_plate',quantity:3}],
    outputs:[{item_id:'hull_panel',quantity:1}]}]}) as unknown as Catalog);
  try {
    // 2 panels take 6 plate; 2 are stored, so 4 more is 2 runs of 2, which takes 10 ore.
    const out=await materials('hull_panel',2);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.steps,[{recipe:'refine_steel',runs:2,facility_only:false},
      {recipe:'assemble_hull',runs:2,facility_only:false}]);
    assert.deepEqual(out.detail.leaves,[{item_id:'iron_ore',need:10,have:3,source:'mining'}]);
    assert.match(out.next[0]!,/iron_ore: 7 more to get \(mining\)/);
  } finally {unbind();}
});

test('the catalog is kept on disk: a 304 answers from it, a failed fetch falls back to it', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'catalog-'));
  const asked:(string|undefined)[]=[];
  assert.equal((await revalidated(dir,async(_,etag)=>{asked.push(etag);return {notModified:false,catalog:CATALOG,etag:'"v1"'};})).version,'test');
  assert.equal((await revalidated(dir,async(_,etag)=>{asked.push(etag);return {notModified:true,etag};})).version,'test');
  assert.equal((await revalidated(dir,async()=>{throw new Error('GET -> 429 Too Many Requests');})).version,'test');
  assert.deepEqual(asked,[undefined,'"v1"']);
  const fetches=readFileSync(join(dir,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));
  assert.deepEqual(fetches.map(row=>[row.event,row.status,row.from_disk]),
    [['fetch',200,undefined],['fetch',304,true],['fetch',undefined,true]]);
  await assert.rejects(revalidated(join(dir,'empty'),async()=>{throw new Error('down');}),/down/);
});
