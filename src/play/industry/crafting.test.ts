import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SpacemoltError,type Catalog,type Account} from '@spacemolt/lib';
import {Effect,Fiber,Layer} from 'effect';
import {TestClock} from 'effect/testing';
import type {ReadinessAccount} from '../../readiness.ts';
import {readJournal} from '../../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {GameLive,type Game} from '../game.ts';
import {boundRun,bind,stop,unbind,type Pilot,type Run} from '../runtime.ts';
import {craft,craftEffect,jobs,materials,quote,recipes,revalidated,supply,useCatalog} from './crafting.ts';

/** The catalog behind the fake bench's one recipe: 5 iron ore into 2 steel plate. */
const CATALOG={version:'test',recipes:[{id:'refine_steel',name:'Refine Steel',category:'Refining',
  description:'',crafting_time:1,inputs:[{item_id:'iron_ore',quantity:5}],
  outputs:[{item_id:'steel_plate',quantity:2}]}],
items:[{id:'iron_ore',name:'Iron Ore',base_value:4,extracted_by:'mining'},
  {id:'steel_plate',name:'Steel Plate',base_value:120}]} as unknown as Catalog;

// Steel plate is worth 100 here; the ore that makes it is worth 4. That gap is the point.
const BOOK=[{item_id:'steel_plate',best_buy:100,best_buy_qty:99,best_sell:110,best_sell_qty:9},
  {item_id:'iron_ore',best_buy:3,best_buy_qty:99,best_sell:4,best_sell_qty:99}];

function world(record:Pilot,options:WorldOptions={},runtime?:string) {
  useCatalog(async()=>CATALOG);
  const game=bridgeWorld({services:['refuel','repair','storage','crafting'],cargoUsed:0,
    market:BOOK,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:text=>lines.push(text),...runtime?{runtime}:{}});
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
  bind({account:f.account as unknown as Account,pilot:()=>f.record(),emit:()=>{},
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

test('supply refuses an input dearer than OVERPAY × an ask remembered elsewhere, naming it, and maxEach pays it (live: b7ad2c0a)',async()=>{
  // Live 2026-10-04 (kvothe 09:12Z, run b7ad2c0a): 69 iron_ore bought at 999 each while confederacy_central_command
  // was remembered asking 2 for 32,928.
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-supply-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify([{base_id:'confederacy_central_command',at:'',
    items:[{item_id:'iron_ore',best_buy:0,best_buy_qty:0,best_sell:2,best_sell_qty:32928,buy_orders:[],sell_orders:[]}]}]));
  const f=world({mood:'Focused'},{store:[]},runtime);
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'refused');
    assert.match(out.why!,/^iron_ore costs 60 for 5 here \(12 each\); confederacy_central_command asks 2 each, 32928 deep/);
    assert.equal(mutations(f),0,'nothing stowed, nothing bought');
    assert.deepEqual(out.next,["supply('refine_steel', 2, {maxEach:12})"]);
    const paid=await supply('refine_steel',2,{maxEach:12});
    assert.equal(paid.status,'done',paid.why);
    assert.deepEqual(paid.detail.bought,[{item_id:'iron_ore',quantity:5}]);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('supply is partial, with a short row and a did rewrite, when this market does not sell an input',async()=>{
  const f=world({mood:'Focused'},{store:[]});
  bind({account:f.account as unknown as Account,pilot:()=>f.record(),emit:()=>{},
    command:async(action,params)=>action==='spacemolt_market/estimate_purchase'
      ?{structuredContent:{item_id:params.item_id,available:0,total_cost:0,unfilled:Number(params.quantity)}}
      :f.command(action,params)});
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'partial');
    assert.deepEqual(out.detail.short,[{item_id:'iron_ore',have:0,need:5,source:'mining'}]);
    assert.deepEqual(out.detail.bought,[],'nothing was on offer to buy');
    assert.match(out.did,/Refine Steel: nothing moved/);
    assert.match(out.why!,/still short iron_ore 0 of 5 \(mining\)/);
    assert.equal(mutations(f),0,'no buy, no stow');
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

test('jobs reads the typed venue field when a row carries no venue_type',async()=>{
  // `JobView` types `venue`, not `venue_type`; a live queue row may carry only the former, and
  // `facility_id` is required (never absent) — so neither of the other two signals can be relied
  // on alone. A workshop row here still has to read as paused when undocked.
  const f=world({mood:'Focused'},{craft:{polls:5}});
  f.queued.push({mode:'craft',deliver_to:'storage',runs_total:1,runs_done:0,status:'active',eta_ticks:3,
    job_id:'w2',base_id:'sol_base',recipe:'Refine Steel',facility_id:'sol_base_workshop',venue:'Sol Base Workshop'});
  f.account.server.location.docked_at=null;
  try {
    const out=await jobs();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.jobs.map(job=>[job.job_id,job.paused]),[['w2',true]]);
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

test('materials lists a shared intermediate before every step that consumes it',async()=>{
  world({mood:'Focused'});
  // frame takes plate and a panel; the panel takes plate too. Walk order is frame, plate, panel.
  useCatalog(async()=>({...CATALOG,recipes:[...CATALOG.recipes,
    {id:'assemble_hull',name:'Assemble Hull',category:'Components',description:'',crafting_time:1,
      inputs:[{item_id:'steel_plate',quantity:3}],outputs:[{item_id:'hull_panel',quantity:1}]},
    {id:'assemble_frame',name:'Assemble Frame',category:'Components',description:'',crafting_time:1,
      inputs:[{item_id:'steel_plate',quantity:1},{item_id:'hull_panel',quantity:1}],outputs:[{item_id:'frame',quantity:1}]}]}) as unknown as Catalog);
  try {
    const out=await materials('frame',1);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.steps.map(row=>row.recipe),['refine_steel','assemble_hull','assemble_frame']);
  } finally {unbind();}
});

test('the catalog is kept on disk: a 304 answers from it, a failed fetch falls back to it', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'catalog-'));
  const asked:(string|undefined)[]=[];
  assert.equal((await revalidated(dir,async(_,etag)=>{asked.push(etag);return {notModified:false,catalog:CATALOG,etag:'"v1"'};})).version,'test');
  assert.equal((await revalidated(dir,async(_,etag)=>{asked.push(etag);return {notModified:true,etag:etag!};})).version,'test');
  assert.equal((await revalidated(dir,async()=>{throw new Error('GET -> 429 Too Many Requests');})).version,'test');
  assert.deepEqual(asked,[undefined,'"v1"']);
  const fetches=readFileSync(join(dir,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));
  assert.deepEqual(fetches.map(row=>[row.event,row.status,row.from_disk]),
    [['fetch',200,undefined],['fetch',304,true],['fetch',undefined,true]]);
  await assert.rejects(revalidated(join(dir,'empty'),async()=>{throw new Error('down');}),/down/);
});

test('a catalog copy on disk that does not decode is fetched whole, not trusted', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'catalog-'));
  writeFileSync(join(dir,'catalog.json'),JSON.stringify({etag:'"v1"',catalog:{version:'old',recipes:[null],items:[]}}));
  const asked:(string|undefined)[]=[];
  const got=await revalidated(dir,async(_,etag)=>{asked.push(etag);return etag?{notModified:true,etag}:{notModified:false,catalog:CATALOG,etag:'"v2"'};});
  assert.deepEqual(asked,[undefined]);
  assert.equal(got.version,'test');
  assert.equal(JSON.parse(readFileSync(join(dir,'catalog.json'),'utf8')).etag,'"v2"');
  const fetches=readFileSync(join(dir,'gameplay.jsonl'),'utf8').trim().split('\n').map(row=>JSON.parse(row));
  assert.deepEqual(fetches.map(row=>[row.status,row.disk_unread]),[[200,true]]);
});

/** What a world does with one command: answer it, refuse it, or carry it out and lose the reply. Every send is counted as asked. */
type Params=Record<string,unknown>|undefined;
type Act=(action:string,params:Params,perform:()=>Promise<unknown>)=>Promise<unknown>;
type Match=(action:string,params:Params)=>boolean;
const lostReply=()=>new SpacemoltError('mutation_timeout','no reply in time');
/** `landed` carries the command out and loses its reply; `dropped` loses it before the game ever saw it. */
const landed=(match:Match):Act=>async(action,params,perform)=>{
  const reply=await perform();
  if(match(action,params))throw lostReply();
  return reply;
};
const dropped=(match:Match):Act=>async(action,params,perform)=>{
  if(match(action,params))throw lostReply();
  return perform();
};
const refused=(match:Match,code:string):Act=>async(action,params,perform)=>{
  if(match(action,params))throw new SpacemoltError(code,`the game said ${code}`);
  return perform();
};
const plain:Act=(action,params,perform)=>perform();
const isCommit:Match=(action,params)=>action==='spacemolt/craft'&&params?.id!==undefined&&!params.dry_run;
const isDry:Match=(action,params)=>action==='spacemolt/craft'&&params?.dry_run===true;
const isBuy:Match=action=>action==='spacemolt/buy';
/** A world bound to a temporary runtime, so its journal can be read for defects, whose command seam may intercept. */
function rig(options:WorldOptions,act:Act) {
  useCatalog(async()=>CATALOG);
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-crafting-'));
  const game=bridgeWorld({services:['refuel','repair','storage','crafting'],cargoUsed:0,market:BOOK,...options});
  const asked:{action:string;params:Params}[]=[];
  const command:typeof game.command=async(action,params)=>{asked.push({action,params});return act(action,params,()=>game.command(action,params));};
  bind({account:game.account as unknown as Account,command,runtime,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  return {...game,command,
    count:(match:Match)=>asked.filter(row=>match(row.action,row.params)).length,
    defects:()=>readJournal(runtime).filter(row=>row.event==='defect'),
    close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
/** A fresh store per use: a commit escrows out of the array it is handed. */
const stocked={get store(){return [{item_id:'iron_ore',quantity:20}];}};

test('a commit the game refuses ends refused in the server\'s code, sent once, and escrows nothing',async()=>{
  const f=rig(stocked,refused(isCommit,'insufficient_funds'));
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/was not queued at sol_base: spacemolt\/craft: insufficient_funds/);
    assert.equal(f.count(isCommit),1,'a refusal is not retried');
    assert.equal(f.queued.length,0);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a dry run the game refuses ends the craft refused in its code, with nothing committed',async()=>{
  const f=rig(stocked,refused(isDry,'wrong_facility'));
  try {
    const out=await craft('refine_steel',2,{at:'fac-9'});
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/wrong_facility/);
    assert.equal(f.count(isCommit),0);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a commit whose reply is lost is never re-sent: the queue says it landed, and the craft goes on to done',async()=>{
  const f=rig({...stocked,craft:{polls:1}},landed(isCommit));
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.deepEqual(out.detail.made,[{item_id:'steel_plate',quantity:2}]);
    assert.equal(f.count(isCommit),1,'a mutation whose reply is lost is never re-sent');
    assert.equal(f.store.find(row=>row.item_id==='iron_ore')?.quantity,15,'one escrow, not two');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a commit whose reply is lost and that the queue and store do not show is partial, never done, and not re-sent',async()=>{
  const f=rig(stocked,dropped(isCommit));
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why!,/reply lost on spacemolt\/craft; the queue does not show the job, the store shows no output, so it may have landed/);
    assert.equal(f.count(isCommit),1);
    assert.deepEqual(out.detail.made,[]);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a commit whose reply does not read waits on the queue for the same order, not a blank job id that reads as gone',async()=>{
  // A blank id matched no queue row, so the wait ended at once and a craft still running was called failed.
  const f=rig({...stocked,craft:{polls:2}},async(action,params,perform)=>{const reply=await perform();return isCommit(action,params)?{job_id:7}:reply;});
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.deepEqual(out.detail.made,[{item_id:'steel_plate',quantity:2}]);
    assert.equal(f.count(isCommit),1);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a commit whose reply is lost, of a craft that already finished, is done from the store\'s delta',async()=>{
  // The queue is empty again by the time it is re-read; the output is in the store.
  const f=rig(stocked,landed(isCommit));
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.deepEqual(out.detail.made,[{item_id:'steel_plate',quantity:2}]);
    assert.match(out.did,/the store shows it landed/);
    assert.equal(f.count(isCommit),1);
  } finally {f.close();}
});

test('a queue that cannot be read after the commit leaves the craft partial with the job named, not failed',async()=>{
  let committed=false;
  const f=rig(stocked,async(action,params,perform)=>{
    if(isCommit(action,params))committed=true;
    if(committed&&action==='spacemolt/craft'&&params?.id===undefined)throw lostReply();
    return perform();
  });
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.did,/queued at sol_base as job job-1/);
    assert.match(out.why!,/the queue could not be read: reply lost on spacemolt\/craft/);
    assert.equal(f.count(isCommit),1);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a buy the game refuses leaves supply partial with the server\'s code, and the shortfall read from the store',async()=>{
  const f=rig({store:[]},refused(isBuy,'insufficient_credits'));
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why!,/iron_ore: spacemolt\/buy: insufficient_credits/);
    assert.deepEqual(out.detail.short,[{item_id:'iron_ore',have:0,need:5,source:'mining'}]);
    assert.equal(f.count(isBuy),1);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a buy whose reply is lost is never re-sent: the store says it arrived, and the wallet says what it cost',async()=>{
  const f=rig({store:[]},landed(isBuy));
  try {
    const out=await supply('refine_steel',2);
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.equal(f.count(isBuy),1,'a buy whose reply is lost is never re-sent');
    assert.equal(f.store.find(row=>row.item_id==='iron_ore')?.quantity,5);
    assert.equal(out.detail.spent,60,'5 at 12, from the wallet');
    assert.deepEqual(out.detail.short,[]);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

/** Run one Effect against a world on the TestClock, a minute at a time. `during` runs between minutes. */
const clocked=<A,E>(f:ReturnType<typeof rig>,effect:Effect.Effect<A,E,Game|Run>,minutes:number,during:(minute:number)=>void=()=>{})=>
  Effect.runPromise(Effect.gen(function*() {
    const fiber=yield* Effect.forkChild(effect);
    for(let minute=0;minute<minutes;minute++) {
      yield* TestClock.adjust('60 seconds');
      yield* Effect.promise(()=>new Promise(resolve=>setImmediate(resolve)));
      during(minute);
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(Layer.mergeAll(GameLive({send:f.command,refresh:()=>f.account.refresh()}),TestClock.layer(),boundRun()))));
const slow={get store(){return stocked.store;},craft:{polls:10_000,eta_ticks:100}};

// Time comes from the clock the wait sleeps on: ten minutes of polling pass in a test that sleeps for none of them.
test('a craft the bench never delivers is given up on at the ceiling, on the TestClock, partial with the job named',async()=>{
  const f=rig(slow,plain);
  try {
    const out=await clocked(f,craftEffect('refine_steel',2),15);
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.did,/Refine Steel is still queued at sol_base as job job-1/);
    assert.match(out.why!,/did not deliver inside 10 minutes/);
    assert.equal(f.count(isCommit),1);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a pilot stop mid-wait ends the craft partial and is not a defect',async()=>{
  const f=rig(slow,plain);
  try {
    const out=await clocked(f,craftEffect('refine_steel',2),15,minute=>{if(minute===2)stop();});
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why!,/stopped by pilot/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a catalog that cannot be read fails recipes saying so, and is no defect',async()=>{
  const f=rig(stocked,plain);
  useCatalog(async()=>{throw new Error('down');});
  try {
    const out=await recipes();
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/catalog unavailable: down/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a queue row that does not read is left out and said, not a failed jobs read',async()=>{
  const f=rig({...stocked,craft:{polls:5}},plain);
  f.queued.push({job_id:'j1',recipe:'Refine Steel',status:'active',base_id:'sol_base',facility_id:'fac-1',runs_done:0,runs_total:1,produces:[]},{recipe:'No Id',status:'queued',produces:[]});
  try {
    const out=await jobs();
    assert.equal(out.status,'done',JSON.stringify(out));
    assert.deepEqual(out.detail.jobs.map(row=>row.job_id),['j1']);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});
