import assert from 'node:assert/strict';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import {Effect} from 'effect';
import {GameLive} from './play/game.ts';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {settleCargoEffect} from './settle-cargo.ts';
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
const flown=async(game:ReturnType<typeof world>,run:()=>Promise<unknown>,who:Pilot={mood:'Cautious'},runtime?:string)=>{
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:()=>{},...runtime?{runtime}:{}});
  try {return await run();} finally {unbind();}
};

test('service tops the cells up to 5% of the hold when they are under 1%',async()=>{
  const game=world(1);
  const out=await flown(game,service) as Awaited<ReturnType<typeof service>>;
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
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-cells-'));
  rememberBook(runtime,'range_base','deep_range',[{...CELLS,best_sell:4} as never],TICK);
  const out=await flown(game,service,{mood:'Cautious'},runtime) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0);
  assert.match(out.did,/none bought: 12 cr is over 1.5x the remembered median 4/);
});

test('with no remembered price the cells are bought at the live one, which is remembered',async()=>{
  const game=world(0);
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-cells-'));
  await flown(game,service,{mood:'Tired'},runtime);
  assert.equal(cellsAboard(game),10);
  const remembered=knownBooks(runtime).flatMap(row=>row.items).find(row=>row.item_id==='fuel_cell');
  assert.equal(remembered?.best_sell,12);
});

test('cells are not bought into the credit reserve',async()=>{
  // The fill costs 24 (20 fuel, 4 hull): 1,000 leaves 976, and 10 cells at 12 would leave 856.
  const game=world(0);
  const out=await flown(game,service,{mood:'Tired',permissions:{credit_reserve:900}}) as Awaited<ReturnType<typeof service>>;
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0);
  assert.equal(cellsAboard(game),0);
  assert.match(out.did,/reserve 900/);
});

test('settle, sell and stow part with the cells above the reserve and keep the reserve aboard',async()=>{
  const settled=world(14);
  const outcome=await Effect.runPromise(settleCargoEffect(settled.account as unknown as ReadinessAccount).pipe(Effect.provide(GameLive({send:settled.command,refresh:()=>settled.account.refresh()}))));
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

// What the buy came to, in place of the world's own: a refusal, or a reply that is lost after it landed.
const buying=(game:ReturnType<typeof world>,answer:(real:()=>Promise<unknown>)=>Promise<unknown>):ReadinessCommand=>
  (action,params)=>action==='spacemolt/buy'?answer(()=>game.command(action,params)):game.command(action,params);
const buy=async(game:ReturnType<typeof world>,answer:(real:()=>Promise<unknown>)=>Promise<unknown>)=>{
  bind({account:game.account as unknown as Account,command:buying(game,answer),pilot:()=>({mood:'Cautious'}),emit:()=>{}});
  try {return await service();} finally {unbind();}
};

test('a cell buy the server refuses with a code skips the cells, names the code, and the service still succeeds',async()=>{
  const game=world(0);
  const out=await buy(game,async()=>{throw new SpacemoltError('insufficient_credits','not enough credits');});
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),0,'the refusal landed nothing');
  assert.equal(cellsAboard(game),0);
  assert.match(out.did,/none bought: spacemolt\/buy: insufficient_credits — not enough credits/);
});

test('a cell buy whose reply is lost is not re-sent: the hold is re-read and says what landed',async()=>{
  const game=world(0);
  const out=await buy(game,async real=>{await real();throw new SpacemoltError('connection_closed','the socket dropped');});
  assert.equal(out.status,'done',out.why);
  assert.equal(game.count('spacemolt/buy'),1,'a mutation is never re-sent');
  assert.equal(cellsAboard(game),10);
  assert.match(out.did,/fuel cells 10\/10 \(bought 10 for \d+ cr\), none bought: reply lost on spacemolt\/buy/);
});

test('a refused cell price estimate skips the cells by name',async()=>{
  const game=world(0);
  const command:typeof game.command=(action,params)=>action==='spacemolt_market/estimate_purchase'
    ?Promise.reject(new SpacemoltError('market_closed','the market is closed')):game.command(action,params);
  bind({account:game.account as unknown as Account,command,pilot:()=>({mood:'Cautious'}),emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    assert.equal(game.count('spacemolt/buy'),0);
    assert.match(out.did,/none bought: spacemolt_market\/estimate_purchase: market_closed — the market is closed/);
  } finally {unbind();}
});
