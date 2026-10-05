import assert from 'node:assert/strict';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {buy,prices,sell} from './market.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

/** What the server raises for an action, if anything: the same error every time it is asked. */
type Raises=Record<string,Error>;
/** `lost` names the sends the world carries out and whose reply never arrives; `rereadFails` breaks the account's re-read once one has. */
function world(record:Pilot,options:WorldOptions={},raises:Raises={},lost:(action:string,params:Record<string,unknown>|undefined)=>boolean=()=>false,rereadFails=false) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-market-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const asked:Record<string,number>={};
  let silent=false;
  const reread=game.account.refresh.bind(game.account);
  if(rereadFails)game.account.refresh=async()=>{if(silent)throw new Error('socket gone');return reread();};
  const command:typeof game.command=async(action,params)=>{
    asked[action]=(asked[action]??0)+1;
    const error=raises[action];
    if(error)throw error;
    const reply=await game.command(action,params);
    // The server did it and the reply never came back.
    // A message the connection's own reconnect path does not match, so the job's re-read is the one under test.
    if(lost(action,params)){silent=true;throw new SpacemoltError('mutation_timeout','timed out');}
    return reply;
  };
  bind({account:game.account as unknown as Account,command,pilot:()=>record,runtime,emit:()=>{}});
  return {...game,asked,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}

test('a store sell over several hold-loads is summed by item in did, not one clause per fill',async()=>{
  // 30 ore out of a 12-capacity hold takes three withdraw-and-sell loads (12, 12, 6), so the
  // fake bridge answers three `spacemolt/sell` fills for the one row — the shape that produced
  // "sold 12 ore, 12 ore, 6 ore" instead of "sold 30 ore".
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{store:[{item_id:'ore',quantity:30}]});
  try {
    const out=await sell([{item_id:'ore'}],{from:'store'});
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt/sell'),3,'three fills went into one summed row');
    assert.match(out.did,/^sold 30 ore at sol_base for 300 cr$/);
  } finally {f.close();}
});

test('a fill well under a remembered bid elsewhere is flagged in did, not this book\'s ask',async()=>{
  // The fake bridge always pays a fixed 10/unit. A wide local spread (ask 180) must NOT flag
  // this on its own — only a remembered book elsewhere bidding materially more than the fill.
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'steel_plate',quantity:4}],
    markets:{sol_base:[{item_id:'steel_plate',best_buy:1,best_buy_qty:99,best_sell:180,best_sell_qty:5}]}});
  try {
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([{base_id:'frontier_station',at:'earlier',
      tick:TICK-5683,items:[{item_id:'steel_plate',best_buy:37,best_buy_qty:9,best_sell:0,best_sell_qty:0}]}]));
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/sold 4 steel_plate at 10 \(frontier_station bid 37, 5683 ticks ago\) at sol_base for 40 cr/);
  } finally {f.close();}
});

test('a wide local spread alone, with no better remembered bid, is not flagged',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'steel_plate',quantity:4}],
    markets:{sol_base:[{item_id:'steel_plate',best_buy:10,best_buy_qty:99,best_sell:180,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'steel_plate'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^sold 4 steel_plate at sol_base for 40 cr$/);
  } finally {f.close();}
});

test('a fill near the live bid is not flagged',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:1,cargo:[{item_id:'ore',quantity:4}],
    markets:{sol_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}});
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^sold 4 ore at sol_base for 40 cr$/);
  } finally {f.close();}
});

const ore={cargoUsed:1,cargo:[{item_id:'ore',quantity:4}],
  markets:{sol_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}};

test('a sell the server refuses is refused, its why naming the action and the code',async()=>{
  const f=world({mood:'Focused'},ore,{'spacemolt/sell':new SpacemoltError('market_closed','the market is closed')});
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/ore: spacemolt\/sell: market_closed — the market is closed/);
    assert.equal(out.detail.fills.length,0);
  } finally {f.close();}
});

test('a sell whose reply is lost says so and is not sent again',async()=>{
  const f=world({mood:'Focused'},ore,{'spacemolt/sell':new SpacemoltError('mutation_timeout','timed out')});
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/ore: reply lost on spacemolt\/sell; hold re-read: 0 sold/);
    assert.equal(f.asked['spacemolt/sell'],1,'a mutation is never re-sent after its reply is lost');
  } finally {f.close();}
});

test('a sell that landed but whose reply was lost is measured from the hold, and sent once',async()=>{
  const f=world({mood:'Focused'},ore,{},action=>action==='spacemolt/sell');
  try {
    const out=await sell([{item_id:'ore'}]);
    assert.notEqual(out.status,'refused');
    assert.match(out.did,/^sold 4 ore at sol_base for 40 cr/);
    assert.equal(f.asked['spacemolt/sell'],1,'a mutation is never re-sent after its reply is lost');
  } finally {f.close();}
});

test('a buy whose estimate is refused is refused, naming the action and the code',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{},
    {'spacemolt_market/estimate_purchase':new SpacemoltError('not_listed','no such listing')});
  try {
    const out=await buy('ore',2);
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/spacemolt_market\/estimate_purchase: not_listed — no such listing/);
    assert.equal(f.asked['spacemolt/buy']??0,0);
  } finally {f.close();}
});

test('a buy the server refuses is refused, and one whose reply is lost is failed and not sent again',async()=>{
  const refused=world({mood:'Focused',permissions:{credit_reserve:0}},{},{'spacemolt/buy':new SpacemoltError('insufficient_credits','not enough credits')});
  try {
    const out=await buy('ore',2);
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/spacemolt\/buy: insufficient_credits — not enough credits/);
  } finally {refused.close();}
  const lost=world({mood:'Focused',permissions:{credit_reserve:0}},{},{'spacemolt/buy':new SpacemoltError('mutation_timeout','timed out')});
  try {
    const out=await buy('ore',2);
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/reply lost on spacemolt\/buy/);
    assert.equal(lost.asked['spacemolt/buy'],1);
  } finally {lost.close();}
});

test('a store view the server refuses still quotes the book, stored as 0',async()=>{
  const f=world({mood:'Focused'},ore,{'spacemolt_storage/view':new SpacemoltError('not_docked','dock first')});
  try {
    const out=await prices();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.quotes.map(q=>[q.item_id,q.held,q.stored]),[['ore',4,0]]);
  } finally {f.close();}
});

test('a buy with no maxEach is refused over OVERPAY × the cheapest ask remembered elsewhere; maxEach pays it (live: b7ad2c0a)',async()=>{
  // Live 2026-10-04 (kvothe 09:12Z, run b7ad2c0a): 69 iron_ore bought at 999 each while confederacy_central_command
  // was remembered asking 2 for 32,928. The fake asks 12 each here.
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{});
  try {
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([
      {base_id:'confederacy_central_command',at:'',items:[{item_id:'iron_ore',best_buy:0,best_buy_qty:0,best_sell:2,best_sell_qty:32928}]},
      {base_id:'thin_base',at:'',items:[{item_id:'iron_ore',best_buy:0,best_buy_qty:0,best_sell:1,best_sell_qty:3}]}]));
    const out=await buy('iron_ore',69);
    assert.equal(out.status,'refused');
    assert.match(out.why!,/^iron_ore costs 828 for 69 here \(12 each\); confederacy_central_command asks 2 each, 32928 deep/,
      'thin_base asks less, but not for 69');
    assert.deepEqual(out.next,["goTo('confederacy_central_command') and buy there","buy('iron_ore', 69, {maxEach:12})"]);
    assert.equal(f.count('spacemolt/buy'),0);
    assert.equal((await buy('iron_ore',69,{maxEach:1000})).status,'done','an explicit maxEach overrides the cap');
    writeFileSync(join(f.runtime,'markets.json'),JSON.stringify([
      {base_id:'confederacy_central_command',at:'',items:[{item_id:'iron_ore',best_buy:0,best_buy_qty:0,best_sell:11.5,best_sell_qty:32928}]}]));
    assert.equal((await buy('iron_ore',2)).status,'done','12 is within OVERPAY of 11.5');
  } finally {f.close();}
});

test('a buy that goes through is done',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{});
  try {
    const out=await buy('ore',2);
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/^bought 2 ore for 24 cr/);
  } finally {f.close();}
});

const oreAndGem={cargoUsed:2,cargo:[{item_id:'ore',quantity:4},{item_id:'gem',quantity:3}],
  markets:{sol_base:[{item_id:'ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5},
    {item_id:'gem',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}};
const gemLost=(action:string,params:Record<string,unknown>|undefined)=>action==='spacemolt/sell'&&params?.id==='gem';

test('a lost reply on the second row is measured against what the first row already earned',async()=>{
  const f=world({mood:'Focused'},oreAndGem,{},gemLost);
  try {
    const out=await sell([{item_id:'ore'},{item_id:'gem'}]);
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.total,70,'40 for the ore and 30 for the gem, not the ore counted twice');
    assert.match(out.did,/^sold 4 ore, 3 gem at sol_base for 70 cr/);
    assert.equal(f.asked['spacemolt/sell'],2,'each sell is sent once');
  } finally {f.close();}
});

test('a lost reply whose re-read also fails keeps the rows that landed and names the gap',async()=>{
  const f=world({mood:'Focused'},oreAndGem,{},gemLost,true);
  try {
    const out=await sell([{item_id:'ore'},{item_id:'gem'}]);
    assert.equal(out.status,'partial');
    assert.equal(out.detail.total,40);
    assert.match(out.did,/^sold 4 ore at sol_base for 40 cr/);
    assert.match(out.why??'',/gem: reply lost on spacemolt\/sell; hold not re-read: socket gone/);
    assert.equal(f.asked['spacemolt/sell'],2);
  } finally {f.close();}
});

test('a withdraw that broke before a store sell is reported in why, not a crash',async()=>{
  // U15's verifier: a failed withdraw's detail is `{}`, and sell read `took.detail.moved` off it.
  const f=world({mood:'Focused'},{store:[{item_id:'ore',quantity:30}]},{'spacemolt/get_base':new Error('socket gone')});
  try {
    const out=await sell([{item_id:'ore'}],{from:'store'});
    assert.equal(out.status,'failed',out.why);
    assert.equal(out.did,'sold nothing');
    assert.match(out.why??'',/^withdraw first: .*socket gone/);
    assert.equal(f.asked['spacemolt/sell'],undefined);
  } finally {f.close();}
});
