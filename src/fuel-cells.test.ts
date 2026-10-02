import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount} from './readiness.ts';
import {journalCommand,readJournal} from './run-record.ts';
import {settleCargo} from './settle-cargo.ts';
import {TICK,bridgeWorld,type MarketRow} from './test-support/bridge-world.ts';
import {knownBooks,rememberBook,sell} from './play/market.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';
import {service} from './play/service.ts';
import {stow} from './play/storage.ts';

// A 200-unit hold keeps 10 cells (5%) and tops them up only under 2 (1%). The fake counter sells
// cells at 12 and buys them back at 10.
const CELLS:MarketRow={item_id:'fuel_cell',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:99};
const world=(cells:number,credits=1_000)=>{
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoCapacity:200,cargoUsed:10+cells,
    cargo:[{item_id:'ore',quantity:10},...cells?[{item_id:'fuel_cell',quantity:cells}]:[]],market:[CELLS]});
  game.account.server.player.credits=credits;
  return game;
};
const cellsAboard=(game:ReturnType<typeof world>)=>
  game.account.server.cargo.find(row=>row.item_id==='fuel_cell')?.quantity??0;
/** A runtime that remembers another base asking `ask` for a cell: the reference a full top-up needs. */
const elsewhere=(ask=12)=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-cells-'));
  rememberBook(runtime,'range_base','deep_range',[{...CELLS,best_sell:ask} as never],TICK);
  return runtime;
};
const flown=async(game:ReturnType<typeof world>,run:()=>Promise<unknown>,who:Pilot={mood:'Cautious'},runtime?:string)=>{
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,emit:()=>{},...runtime?{runtime}:{}});
  try {return await run();} finally {unbind();}
};

test('service tops the cells up to 5% of the hold when they are under 1%',async()=>{
  const game=world(1);
  const out=await flown(game,service,{mood:'Cautious'},elsewhere()) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(cellsAboard(game),10);
  assert.match(out.did,/fuel cells 10\/10/,out.did);
});

test('service buys no cells while they are above 1% of the hold',async()=>{
  const game=world(4);
  const out=await flown(game,service) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0);
  assert.equal(cellsAboard(game),4);
});

test('a live cell price over 1.5x the remembered median is not paid, and says why',async()=>{
  const game=world(0);
  const out=await flown(game,service,{mood:'Cautious'},elsewhere(4)) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0);
  assert.match(out.did,/none bought: 12 cr is over 1.5x the median 4 other bases ask/);
});

test('with no price remembered elsewhere one cell is bought at the live one, which is remembered',async()=>{
  // Live 2026-09-30 (kvothe 19:29Z): service() bought 9 cells at 3,000 each, 27,000 cr, against a
  // median that held this base's own earlier 3,000 ask. With no other base's ask, one cell.
  const game=world(0);
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-cells-'));
  await flown(game,service,{mood:'Tired'},runtime);
  assert.equal(cellsAboard(game),1);
  const remembered=knownBooks(runtime).flatMap(row=>row.items).find(row=>row.item_id==='fuel_cell');
  assert.equal(remembered?.best_sell,12);
});

test('this base\'s own remembered ask is no reference for its live one, and the trade line says what was',async()=>{
  // Live 2026-09-30 (kvothe 19:29Z): 9 cells at 3,000 each passed a median of this base's own 3,000.
  const game=world(0);
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-cells-'));
  rememberBook(runtime,'sol_base','sol',[CELLS as never],TICK);
  bind({account:game.account as unknown as ReadinessAccount,pilot:()=>({mood:'Cautious'}),emit:()=>{},runtime,
    command:async(action,params)=>{const reply=await game.command(action,params);journalCommand(runtime,action,params,true,reply);return reply;}});
  try {await service();} finally {unbind();}
  assert.equal(cellsAboard(game),1);
  const trade=readJournal(runtime).find(entry=>entry.event==='trade'&&entry.item_id==='fuel_cell');
  assert.deepEqual(trade?.quote&&{reference:trade.quote.reference,reference_asks:trade.quote.reference_asks,want:trade.quote.want,ask:trade.quote.ask},
    {reference:null,reference_asks:0,want:1,ask:12},JSON.stringify(trade));
});

test('cells are not bought into the credit reserve',async()=>{
  // The fill costs 24 (20 fuel, 4 hull): 1,000 leaves 976, and 10 cells at 12 would leave 856.
  const game=world(0);
  const out=await flown(game,service,{mood:'Tired',permissions:{credit_reserve:900}},elsewhere()) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0);
  assert.equal(cellsAboard(game),0);
  assert.match(out.did,/reserve 900/);
});

test('settle, sell and stow part with the cells above the reserve and keep the reserve aboard',async()=>{
  const settled=world(14);
  const outcome=await settleCargo(settled.account as unknown as ReadinessAccount,settled.command);
  assert.deepEqual(outcome.sold.map(row=>[row.item_id,row.quantity]),[['fuel_cell',4],['ore',10]]);
  assert.equal(cellsAboard(settled),10);

  const sold=world(14);
  await flown(sold,()=>sell([{item_id:'fuel_cell'}]));
  assert.equal(cellsAboard(sold),10);

  const stowed=world(10);
  const out=await flown(stowed,()=>stow([{item_id:'fuel_cell'},{item_id:'ore'}])) as Awaited<ReturnType<typeof stow>>;
  assert.equal(cellsAboard(stowed),10);
  assert.deepEqual(out.detail.moved,[{item_id:'ore',quantity:10}]);
});
