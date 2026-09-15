/** The quote read: the server's own dry run, priced against what this base's book will
 * really pay. Nothing here is consumed or queued. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {serve} from './bridge.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';

// Ten plates against four units at 100 and twenty at 50: the top price alone says 1000,
// the book says 700.
const BOOK=[{price_each:100,quantity:4},{price_each:50,quantity:20}];

const QUOTE={action:'craft',kind:'quote',dry_run:true,mode:'craft',
  cost:{fee:9,inputs:[{item_id:'iron_ore',name:'Iron Ore',quantity:20}],labor:191},
  credits_total:200,effective_time_per_run:0.1,est_completion_tick:1,
  facility_id:'facility-1',have_capacity:true,have_credits:true,have_inputs:true,
  message:'Quote only — nothing queued.',produces:[{item_id:'steel_plate',name:'Steel Plate',quantity:10}],
  quantity:10,recipe:'Refine Steel',runs:5,venue:'Station Workshop',venue_type:'station'};

const FACILITY_REFUSAL="'Process Null Matter' is made in a Null Matter Processing Vat, and no "+
  'facility here can make it. Nearest public one: Confederacy Central Command in Sol '+
  '(11 jump(s) away) — travel there to queue it, or buy it on the exchange.';

function fixture(services:string[]) {
  const account={
    state:{location:{system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false},
      ship:{fuel:100,max_fuel:120,hull:80,max_hull:80},player:{credits:5000},cargo:[]},
    refresh:async()=>{},
  } as unknown as ReadinessAccount;
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const command:ReadinessCommand=async(action,params)=>{
    sent.push({action,params});
    if(action==='spacemolt/get_base')return {structuredContent:{services}};
    if(action==='spacemolt/craft') {
      if(params.id==='process_null_matter')throw new Error(FACILITY_REFUSAL);
      return {delta:{details:QUOTE}};
    }
    if(action==='spacemolt_market/view_market')
      return {structuredContent:{items:[{item_id:'steel_plate',item_name:'Steel Plate',
        best_buy:100,best_buy_qty:4,best_sell:0,best_sell_qty:0,buy_orders:BOOK,sell_orders:[],
        buy_price:100,buy_quantity:24,sell_price:0,sell_quantity:0,category:'refined'}]}};
    throw new Error(`unexpected ${action}`);
  };
  return {dispatch:serve(account,command),sent};
}

test('the margin walks the buy levels rather than pricing every unit at the best bid',async()=>{
  const {dispatch,sent}=fixture(['crafting','market']);
  const quote=await dispatch('quote',{recipe_id:'refine_steel',quantity:10}) as any;
  assert.equal(quote.name,'Refine Steel');
  assert.equal(quote.runs,5);
  assert.equal(quote.cost.credits_total,200);
  assert.equal(quote.venue_type,'station');
  const [book]=quote.market;
  assert.equal(book.best_buy,100);
  assert.equal(book.buy_depth.gross,4*100+6*50);
  assert.equal(book.buy_depth.filled,10);
  // 700 proceeds less the 200 bill — not the 800 the top of book alone would claim.
  assert.equal(quote.margin,500);
  // The dry run is the server's own; nothing else was sent to the game.
  const craft=sent.find(row=>row.action==='spacemolt/craft');
  assert.deepEqual(craft?.params,{id:'refine_steel',quantity:10,dry_run:true,
    source:'storage',deliver_to:'storage'});
});

test('a base with no crafting service is refused before any craft call',async()=>{
  const {dispatch,sent}=fixture(['storage','refuel']);
  const quote=await dispatch('quote',{recipe_id:'refine_steel'}) as any;
  assert.equal(quote.refused,'no workshop at sol_base');
  assert.ok(!sent.some(row=>row.action==='spacemolt/craft'),'a base without a bench is never quoted');
});

test('the server quoting fewer runs than asked is what is reported, and what the margin uses',async()=>{
  const {dispatch}=fixture(['crafting','market']);
  // Ten units asked for, five runs' worth of inputs available: the server says so.
  const quote=await dispatch('quote',{recipe_id:'refine_steel',quantity:10}) as any;
  assert.equal(quote.quantity,10);
  assert.equal(quote.runs,5);
  // Ten plates is what five runs make, and the book is walked over those ten, not over the
  // ten units the pilot asked about.
  assert.equal(quote.produces[0].quantity,10);
  assert.equal(quote.margin,quote.market[0].buy_depth.gross-quote.cost.credits_total);
});

test('a recipe the bench cannot run comes back as the server\'s own refusal, not an error',async()=>{
  const {dispatch}=fixture(['crafting','market']);
  const quote=await dispatch('quote',{recipe_id:'process_null_matter',quantity:5}) as any;
  assert.equal(quote.recipe_id,'process_null_matter');
  assert.match(quote.refused,/Null Matter Processing Vat.*Confederacy Central Command/s);
  assert.equal(quote.margin,undefined,'a refusal prices nothing');
});
