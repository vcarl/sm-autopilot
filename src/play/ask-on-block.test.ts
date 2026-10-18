/** A base behavior blocked by a resource or by outdated data asks the pilot (`askOnBlock`): each of the nine
 * situations offers the ways round it that the library can carry out, `skip`/`keep` is today's refusal, and a
 * repeat, a query, `ask:false` and the ways themselves never pause again. */
import type {Account,Catalog} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessCommand} from '../readiness.ts';
import {bridgeWorld,rememberAll,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {refit} from './hangar.ts';
import {craft,useCatalog} from './industry/crafting.ts';
import {buy,sell} from './market.ts';
import {answer,bind,querying,stop,unbind,type Question} from './runtime.ts';
import {withdraw} from './storage.ts';
import {goTo} from './travel.ts';

const CATALOG={version:'test',recipes:[{id:'refine_steel',name:'Refine Steel',category:'Refining',
  description:'',crafting_time:1,inputs:[{item_id:'iron_ore',quantity:5}],outputs:[{item_id:'steel_plate',quantity:2}]}],
items:[{id:'iron_ore',name:'Iron Ore',base_value:4,extracted_by:'mining'},{id:'steel_plate',name:'Steel Plate',base_value:120}]} as unknown as Catalog;

/** A docked ship at sol_base. `picks` answers each question with the first choice starting with the next prefix;
 * `wrap` stands in for the server on some sends. */
function world(options:WorldOptions={},picks:string[]=[],wrap?:(command:ReadinessCommand,docked:()=>string|null)=>ReadinessCommand) {
  useCatalog(async()=>CATALOG);
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-block-'));
  const game=bridgeWorld({services:['refuel','repair','storage','crafting'],cargoUsed:0,...options});
  const asked:Question[]=[];
  const binding={account:game.account as unknown as Account,command:wrap?wrap(game.command,()=>game.account.server.location.docked_at):game.command,
    pilot:()=>({mood:'Focused' as const,permissions:{credit_reserve:0}}),runtime,emit:()=>{},
    onAsk:(question:Question)=>{
      asked.push(question);
      const want=picks.shift()??'skip',choice=question.choices?.find(c=>c.startsWith(want));
      if(want==='stop')stop();else answer(choice??want);
    }};
  bind(binding);
  return {...game,asked,binding,runtime,remember:(books:unknown[])=>rememberAll(runtime,JSON.stringify(books)),
    close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const book=(base_id:string,items:Record<string,unknown>[])=>({base_id,at:'earlier',tick:TICK-5,items});
const row=(item_id:string,bid:number,ask:number)=>({item_id,best_buy:bid,best_buy_qty:bid?9:0,best_sell:ask,best_sell_qty:ask?99:0});
/** The same call with `ask:false`, in a fresh world: today's refusal, to compare `skip` against. */
const plain=(a:{status:string;did:string;why?:string},b:{status:string;did:string;why?:string})=>
  assert.deepEqual({status:a.status,did:a.did,why:a.why},{status:b.status,did:b.did,why:b.why});

test('1. sell with no buyer here asks to carry it to the best remembered bid; keep is today\'s refusal',async()=>{
  const setup=()=>({cargo:[{item_id:'steel_plate',quantity:4}],cargoUsed:4,markets:{sol_base:[row('ore',10,12)],range_base:[row('steel_plate',37,0)]}});
  let f=world(setup(),['keep']);
  let kept;
  try {
    f.remember([book('range_base',[row('steel_plate',37,0)])]);
    kept=await sell([{item_id:'steel_plate'}]);
    assert.deepEqual(f.asked[0]?.choices,['carry to range_base','keep']);
    assert.match(f.asked[0]!.question,/steel_plate: no buyer at sol_base; range_base bid 37 for 9, 5 ticks ago/);
  } finally {f.close();}
  f=world(setup());
  try {
    f.remember([book('range_base',[row('steel_plate',37,0)])]);
    plain(kept,await sell([{item_id:'steel_plate'}],{ask:false}));
    assert.equal(f.asked.length,0);
  } finally {f.close();}
  f=world(setup(),['carry']);
  try {
    f.remember([book('range_base',[row('steel_plate',37,0)])]);
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/arrived at range_base.*; sold 4 steel_plate .*at range_base/);
  } finally {f.close();}
});

test('2. buy not on this market asks for a known seller or a hand recipe at this workshop; skip refuses',async()=>{
  // sol_base sells none; range_base does.
  const none=(command:ReadinessCommand,docked:()=>string|null):ReadinessCommand=>async(action,params)=>
    action==='spacemolt_market/estimate_purchase'&&params?.item_id==='steel_plate'&&docked()==='sol_base'
      ?{structuredContent:{item_id:'steel_plate',available:0,total_cost:0,message:'none for sale'}}:command(action,params);
  const f=world({},['skip','buy at'],none);
  try {
    f.remember([book('range_base',[row('steel_plate',0,15)])]);
    const skipped=await buy('steel_plate',2);
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/not on this market/);
    assert.deepEqual(f.asked[0]?.choices,['buy at range_base','craft steel_plate','skip']);
    assert.match(f.asked[0]!.question,/range_base asks 15 each, 99 deep, 5 ticks ago; refine_steel makes it from 5 iron_ore/);
    // Asked once a flight: the same block again takes the answer given, without a pause.
    assert.equal((await buy('steel_plate',2)).status,'refused');
    assert.equal(f.asked.length,1);
  } finally {f.close();}
  const g=world({},['buy at'],none);
  try {
    g.remember([book('range_base',[row('steel_plate',0,15)])]);
    const out=await buy('steel_plate',2);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/arrived at range_base.*; bought 2 steel_plate/);
  } finally {g.close();}
});

test('3. craft with inputs short asks to supply them here (the bill named) or mine the ore at a known belt; skip refuses',async()=>{
  const belt={pois:[{id:'iron_belt',type:'asteroid_belt',resources:[{resource_id:'iron_ore'}]}],store:[]};
  let f=world(belt,['skip']);
  try {
    const skipped=await craft('refine_steel',2);
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/Refine Steel is short at sol_base: iron_ore 0 of 5/);
    assert.deepEqual(f.asked[0]?.choices,['supply for 60 cr here','mine iron_ore and craft','skip']);
    assert.match(f.asked[0]!.question,/iron_ore 0 of 5, 12 each here, mined, nearest known at iron_belt/);
  } finally {f.close();}
  f=world({store:[]},['supply']);
  try {
    const out=await craft('refine_steel',2);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/bought 5 iron_ore.*; .*steel_plate/);
    assert.deepEqual(f.asked[0]?.choices,['supply for 60 cr here','skip'],'no belt known to give it: no mining');
  } finally {f.close();}
});

test('4. refit with the module nowhere aboard asks to buy it here; skip refuses',async()=>{
  let f=world({},['skip']);
  try {
    const skipped=await refit({install:['cargo_expander_ii']});
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/not in the hold or this base's store/);
    assert.deepEqual(f.asked[0]?.choices,['buy cargo_expander_ii here','skip']);
  } finally {f.close();}
  f=world({},['buy']);
  try {
    const out=await refit({install:['cargo_expander_ii']});
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/bought 1 cargo_expander_ii.*; installed cargo_expander_ii/);
  } finally {f.close();}
});

test('5. buy over OVERPAY × a cheaper remembered ask asks to pay here or go there (its age named); skip refuses',async()=>{
  let f=world({},['skip']);
  let skipped;
  try {
    f.remember([book('range_base',[row('ore',0,2)])]);
    skipped=await buy('ore',5);
    assert.equal(skipped.status,'refused');
    assert.deepEqual(f.asked[0]?.choices,['pay 60 here','buy at range_base','skip']);
    assert.match(f.asked[0]!.question,/ore: 12 each at sol_base \(60 for 5\); range_base asks 2 each, 99 deep, 5 ticks ago/);
  } finally {f.close();}
  f=world();
  try {f.remember([book('range_base',[row('ore',0,2)])]);plain(skipped,await buy('ore',5,{ask:false}));} finally {f.close();}
  f=world({},['pay']);
  try {
    f.remember([book('range_base',[row('ore',0,2)])]);
    const out=await buy('ore',5);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/bought 5 ore/);
  } finally {f.close();}
});

test('6. sell under the caller\'s floor asks to sell at the bid now; keep is today\'s refusal',async()=>{
  const setup={cargo:[{item_id:'ore',quantity:4}],cargoUsed:4};
  let f=world(setup,['keep']);
  try {
    const kept=await sell([{item_id:'ore'}],{floor:{ore:50}});
    assert.equal(kept.status,'refused');
    assert.deepEqual(f.asked[0]?.choices,['sell at 10 now','keep']);
    assert.match(f.asked[0]!.question,/ore: best bid at sol_base is 10, under your floor 50/);
  } finally {f.close();}
  f=world(setup,['sell']);
  try {
    const out=await sell([{item_id:'ore'}],{floor:{ore:50}});
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/sold 4 ore at sol_base for 40 cr/);
  } finally {f.close();}
});

test('7. buy over the caller\'s maxEach asks to pay the price here; skip refuses',async()=>{
  let f=world({},['skip']);
  try {
    const skipped=await buy('ore',5,{maxEach:5});
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/over maxEach 5/);
    assert.deepEqual(f.asked[0]?.choices,['pay 60 here','skip']);
    assert.match(f.asked[0]!.question,/ore: 12 each at sol_base \(60 for 5\), over your maxEach 5/);
  } finally {f.close();}
  f=world({},['pay']);
  try {assert.equal((await buy('ore',5,{maxEach:5})).status,'done');} finally {f.close();}
});

test('8. withdraw with no room in the hold asks to stow the biggest other row first; skip refuses',async()=>{
  const full={cargo:[{item_id:'scrap',quantity:12}],cargoUsed:12};
  let f=world(full,['skip']);
  try {
    const skipped=await withdraw([{item_id:'ore',quantity:5}]);
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/ore: no room/);
    assert.deepEqual(f.asked[0]?.choices,['stow scrap to make room','skip']);
  } finally {f.close();}
  f=world(full,['stow']);
  try {
    const out=await withdraw([{item_id:'ore',quantity:5}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/stowed 12 scrap.*; withdrew 5 ore/);
  } finally {f.close();}
  f=world(full,['stow']);
  try {
    const out=await sell([{item_id:'ore',quantity:5}],{from:'store'});
    assert.equal(f.asked[0]?.question,'ore: the hold has no room to take it out of the store at sol_base');
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/stowed 12 scrap.*; sold 5 ore/);
  } finally {f.close();}
});

test('9. goTo short of fuel, undocked at a base\'s POI, asks to refuel there and go; skip refuses',async()=>{
  const low=(f:ReturnType<typeof world>)=>{f.account.server.location.docked_at=null;f.account.server.ship.fuel=3;};
  let f=world({},['skip']);
  try {
    low(f);
    const skipped=await goTo('range_base');
    assert.equal(skipped.status,'refused');
    assert.match(skipped.why??'',/fuel 3, the route needs 7/);
    assert.deepEqual(f.asked[0]?.choices,['refuel at sol_base then go','skip']);
  } finally {f.close();}
  f=world({},['refuel']);
  try {
    low(f);
    const out=await goTo('range_base');
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/serviced at sol_base.*; arrived at range_base/);
  } finally {f.close();}
});

test('no way open, a query, no one to answer, or ask:false: the refusal comes back as it did, with no pause',async()=>{
  // No remembered bid anywhere: nothing to carry it to, so nothing to ask.
  const setup={cargo:[{item_id:'steel_plate',quantity:4}],cargoUsed:4,markets:{sol_base:[row('ore',10,12)]}};
  let f=world(setup);
  try {
    assert.equal((await sell([{item_id:'steel_plate'}])).status,'refused');
    assert.equal(f.asked.length,0);
    f.remember([book('range_base',[row('steel_plate',37,0)])]);
    assert.equal((await sell([{item_id:'steel_plate'}],{ask:false})).status,'refused');
    assert.equal(f.asked.length,0);
    const read=await querying(f.binding,()=>buy('ore',5,{maxEach:5}));
    assert.equal(read.status,'refused');
    assert.equal(f.asked.length,0);
    unbind();bind({account:f.binding.account,command:f.binding.command,pilot:f.binding.pilot,runtime:f.runtime,emit:()=>{}});
    assert.equal((await sell([{item_id:'steel_plate'}])).status,'refused');
    assert.equal(f.asked.length,0);
  } finally {f.close();}
});

test('a way taken on an answer never asks again: the far sale that finds no buyer either refuses plainly',async()=>{
  const f=world({cargo:[{item_id:'steel_plate',quantity:4}],cargoUsed:4,markets:{sol_base:[row('ore',10,12)],range_base:[row('ore',10,12)]}},['carry']);
  try {
    f.remember([book('range_base',[row('steel_plate',37,0)])]);
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'refused');
    assert.match(out.did,/arrived at range_base.*; sold nothing at range_base/);
    assert.equal(f.asked.length,1);
  } finally {f.close();}
});

test('a stop while paused on a block ends the call partial, as any stop does',async()=>{
  const f=world({},['stop']);
  try {
    const out=await buy('ore',5,{maxEach:5});
    assert.equal(out.status,'partial');
    assert.match(out.why??'',/stopped/);
  } finally {f.close();}
});
