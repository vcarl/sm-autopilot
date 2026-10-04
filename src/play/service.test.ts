import assert from 'node:assert/strict';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {bridgeWorld,derived} from '../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from './runtime.ts';
import {Effect} from 'effect';
import {ServiceBlocked,ServiceUnsafe,serviceShipEffect,type ServiceOptions} from '../servicing.ts';
import {GameLive} from './game.ts';
import {service,serviceElsewhereEffect} from './service.ts';

// S4: `service` read the mood at the top of the job, but the quote it takes first is a command,
// and a command is where `imposeTired()` lands. A tank under the mood's reserve is exactly what
// imposes Tired, so the crossing happens between the read and the spend — and the mood the
// pilot has left keeps a 500 credit ceiling where Tired's row is "service only", unbounded.
// The stale margin refuses the one bill that clears Tired, which is a pilot stuck at the dock
// it flew to for this.
test('the spend margin is the mood the crossing imposed, not the one service opened under',async()=>{
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0});
  // An expensive counter: 110 units at 6 credits is 660, over the Cautious ceiling of 500 and
  // inside the 1,000 credits the wallet holds.
  const command:typeof game.command=async(action,params)=>{
    const res=await game.command(action,params);
    if(action==='spacemolt/get_base')
      (res as {delta:{details:{fuel_price_all_in:number}}}).delta.details.fuel_price_all_in=6;
    return res;
  };
  // Fuel 10 against the Cautious reserve of 30: the crossing is already true, and the quote
  // command is what reports it.
  game.account.server.ship.fuel=10;
  const who=derived(()=>({mood:'Cautious'}),game.account);
  bind({account:game.account as unknown as Account,command,
    pilot:who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.cleared_tired,true,'the fill put the ship back inside the Cautious margins');
    assert.equal(who().mood,'Cautious','the working mood is back once the ship is');
    assert.equal(game.account.server.ship.fuel,120);
    assert.equal(game.account.server.ship.hull,100);
  } finally {unbind();}
});

// The live juncture (2026-09-24): six hours wedged in Tired at a station whose `get_base` body
// carries no `repair_price_per_hull` — the field is owner-set on player stations, so an ordinary
// counter never posts it. Driven by hand, `repair({})` there took hull 59 → 80 for 105 credits.
// A missing price is an unknown bill, not a closed counter: the fill is issued and the hull comes
// up, whatever the mood.
for(const mood of ['Tired','Cautious'] as const)
  test(`${mood} repairs at a counter that posts no repair price`,async()=>{
    const game=bridgeWorld({services:['refuel'],cargoUsed:0});
    game.account.server.ship.fuel=117;
    game.account.server.ship.hull=52;
    let who:Pilot={mood};
    bind({account:game.account as unknown as Account,command:game.command,
      pilot:()=>who,emit:()=>{}});
    try {
      const out=await service();
      assert.equal(out.status,'done',out.why);
      assert.equal(game.account.server.ship.fuel,120);
      assert.equal(game.account.server.ship.hull,100,'the unpriced repair is issued and the server bills it');
      assert.deepEqual(out.detail.issued,['spacemolt/refuel','spacemolt/repair']);
      assert.equal(out.detail.spent,51,'3 fuel at the posted 1 cr plus the 48 the repair charged');
      assert.deepEqual(out.detail.short,[],'a full fill leaves nothing short');
      // The fuel-cell read after the fill is a command, and a command is where a restored Tired
      // clears, so `next` may say so; it never names another station.
      assert.ok(!(out.next??[]).some(line=>line.includes('goTo')),'a full fill advises no other station');
    } finally {unbind();}
  });

// The cost of an unpriced service is knowable only from the charge, so the reserve is enforced on
// it: what was bought stands, nothing further is, and the refusal names the reserve.
test('an unpriced repair that eats into the standing reserve is refused by name',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0});
  game.account.server.ship.fuel=game.account.server.ship.max_fuel;
  game.account.server.ship.hull=52;
  game.account.server.player.credits=100;
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'refused',out.did);
    assert.match(out.why!,/spacemolt\/repair charged 48, leaving credits 52 under the reserve 90/);
  } finally {unbind();}
});

// Nothing above the reserve and no price to quote against: the call is never sent, and the refusal
// still names somewhere to go — a base places.json placed, when this system lists no other.
test('an unpriced counter is not tried at all with nothing above the reserve',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0});
  game.account.server.ship.fuel=game.account.server.ship.max_fuel;
  game.account.server.ship.hull=52;
  game.account.server.player.credits=90;
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-service-'));
  writeFileSync(join(runtime,'places.json'),JSON.stringify({range_base:'deep_range'}));
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:()=>{},runtime});
  try {
    const out=await service();
    assert.equal(out.status,'refused',out.did);
    assert.match(out.why!,/credits 90 leave nothing above the reserve 90/);
    const next=(out.next??[]).join('\n');
    assert.match(next,/goTo\('range_base'\)/,next);
    assert.match(next,/unknown until docked/,next);
    assert.equal(game.account.server.ship.hull,52,'nothing was bought');
    assert.equal(game.account.server.player.credits,90);
  } finally {unbind();}
});

// `credit_reserve` is the one standing money bound, and Tired does not widen it: Tired lifts
// the mood's own spend margin to unbounded, so the reserve is the only thing left that can
// refuse a fill — and a refusal a script cannot read is a pilot guessing. It names the reserve.
test('the standing credit reserve still refuses a Tired fill, by name',async()=>{
  const game=bridgeWorld({services:['refuel','repair'],cargoUsed:0});
  game.account.server.ship.fuel=10;
  // Only the fuel is due: a 4-point repair would fit the 10 above the reserve and be bought alone.
  game.account.server.ship.hull=100;
  game.account.server.player.credits=100;
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'refused',out.did);
    assert.match(out.why!,/credits 100 less reserve 90 cannot cover the quoted/);
    assert.equal(game.account.server.ship.fuel,10,'a service under the reserve spends nothing');
  } finally {unbind();}
});

// Live 2026-09-24: a Cautious pilot's service() refused two refuels quoted over the 500 credit
// margin, and the tank was filled by a raw refuel. Fuel is resupply: no mood refuses it; the
// reserve still bounds it.
test('a Cautious refuel quoted over the 500 credit margin is filled; only the reserve bounds it',async()=>{
  const game=bridgeWorld({services:['refuel','repair'],cargoUsed:0});
  const command:typeof game.command=async(action,params)=>{
    const res=await game.command(action,params);
    if(action==='spacemolt/get_base')
      (res as {delta:{details:{fuel_price_all_in:number}}}).delta.details.fuel_price_all_in=8;
    return res;
  };
  // 80 units at 8 is 640: over Cautious's 500, and fuel 40 is above its reserve of 30, so no Tired.
  game.account.server.ship.fuel=40;
  game.account.server.player.credits=1_000;
  let who:Pilot={mood:'Cautious',permissions:{credit_reserve:200}};
  bind({account:game.account as unknown as Account,command,
    pilot:()=>who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    assert.equal(who.mood,'Cautious');
    assert.equal(game.account.server.ship.fuel,120);
    who={...who,permissions:{credit_reserve:900}};
    game.account.server.ship.fuel=40;
    const held=await service();
    assert.equal(held.status,'refused');
    assert.match(held.why!,/less reserve 900 cannot cover the quoted 640/);
  } finally {unbind();}
});

// Tired is the guarantee the ship gets resupplied, so a wallet that cannot cover the whole bill
// buys what it can: the fuel first (resupply), the repair only if what is left still covers it.
test('credits for only part of the bill buy the fuel and leave the repair short, not refused whole',async()=>{
  const game=bridgeWorld({services:['refuel','repair'],cargoUsed:0});
  // 110 fuel at 1 cr and 48 hull at 1 cr is 158; the wallet holds 130.
  game.account.server.ship.fuel=10;
  game.account.server.ship.hull=52;
  game.account.server.player.credits=130;
  let who:Pilot={mood:'Tired'};
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'partial',`${out.did}: ${out.why}`);
    assert.equal(game.account.server.ship.fuel,120,'the tank was filled');
    assert.equal(game.account.server.ship.hull,52,'the repair the wallet could not cover was not sent');
    assert.deepEqual(out.detail.issued,['spacemolt/refuel']);
    assert.match(out.why!,/repair/);
  } finally {unbind();}
});

// What the server answers for one action, in place of the world's own: a refusal, or a reply that is lost.
const answering=(game:ReturnType<typeof bridgeWorld>,on:string,answer:(real:()=>Promise<unknown>)=>Promise<unknown>):ReadinessCommand=>
  (action,params)=>action===on?answer(()=>game.command(action,params)):game.command(action,params);
const flown=async<T>(game:ReturnType<typeof bridgeWorld>,command:typeof game.command,run:()=>Promise<T>,extra:Partial<Parameters<typeof bind>[0]>={})=>{
  bind({account:game.account as unknown as Account,command,pilot:()=>({mood:'Cautious'}),emit:()=>{},...extra});
  try {return await run();} finally {unbind();}
};
const thirsty=()=>{const game=bridgeWorld({services:['refuel','repair'],cargoUsed:0});game.account.server.ship.fuel=10;return game;};

test('a refuel the server refuses with a code is refused, naming the action and the code',async()=>{
  const game=thirsty();
  const refuse=async()=>{throw new SpacemoltError('insufficient_credits','not enough credits');};
  const out=await flown(game,answering(game,'spacemolt/refuel',refuse),()=>service());
  assert.equal(out.status,'refused',out.why);
  assert.match(out.why!,/spacemolt\/refuel: insufficient_credits — not enough credits/);
  assert.equal(game.account.server.ship.fuel,10);
});

/** `serviceShipEffect` over its own `Game`; resolves with what it failed with. */
const serviceFailure=(account:ReadinessAccount,command:ReadinessCommand,options:ServiceOptions)=>
  Effect.runPromise(Effect.flip(serviceShipEffect(account,options)).pipe(Effect.provide(GameLive({send:command}))));

test('serviceShipEffect fails with the refusal\'s tag, carrying the lib error the server raised',async()=>{
  const game=thirsty();
  const raised=new SpacemoltError('insufficient_credits','not enough credits');
  const command=answering(game,'spacemolt/refuel',async()=>{throw raised;});
  const error=await serviceFailure(game.account as unknown as ReadinessAccount,command,{mood:'Cautious'});
  assert.equal(error._tag,'Rejected');
  assert.ok('cause' in error&&error.cause===raised);
});

test('a refuel whose reply is lost is not re-sent, and is failed by name',async()=>{
  const game=thirsty();
  const lose=async(real:()=>Promise<unknown>)=>{await real();throw new SpacemoltError('connection_closed','the socket dropped');};
  const out=await flown(game,answering(game,'spacemolt/refuel',lose),()=>service());
  assert.equal(out.status,'failed',out.why);
  assert.match(out.why!,/reply lost on spacemolt\/refuel/);
  assert.equal(game.count('spacemolt/refuel'),1,'a mutation is never re-sent');
  assert.equal(game.count('spacemolt/repair'),0,'nothing further is bought after a lost reply');
});

test('a counter that will not quote is a failed service naming the refusal',async()=>{
  const game=thirsty();
  const out=await flown(game,answering(game,'spacemolt/get_base',async()=>{throw new SpacemoltError('no_base','no base here');}),()=>service());
  assert.equal(out.status,'failed');
  assert.match(out.did,/would not quote/);
  assert.match(out.why!,/spacemolt\/get_base: no_base — no base here/);
});

test('a bill the wallet cannot cover is ServiceBlocked from serviceShipEffect, with the same message and blockers',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0});
  game.account.server.ship.fuel=game.account.server.ship.max_fuel;
  game.account.server.ship.hull=52;
  game.account.server.player.credits=90;
  const error=await serviceFailure(game.account as unknown as ReadinessAccount,game.command,{mood:'Tired',creditReserve:90});
  assert.ok(error instanceof ServiceBlocked);
  assert.match(error.message,/^service_blocked: credits 90 leave nothing above the reserve 90/);
  assert.equal(error.blockers.length>0,true);
});

test('a ship that is not at a dock is ServiceUnsafe, with the message it always had',async()=>{
  const game=thirsty();
  Reflect.deleteProperty(game.account.server.location,"docked_at");
  const error=await serviceFailure(game.account as unknown as ReadinessAccount,game.command,{mood:'Cautious'});
  assert.ok(error instanceof ServiceUnsafe);
  assert.equal(error.message,'Servicing requires a verified dock');
});

test('a ship that moves during the fill is a failed service, not a refusal',async()=>{
  const game=thirsty();
  const drift=async(real:()=>Promise<unknown>)=>{const reply=await real();game.account.server.location.poi_id='belt';return reply;};
  const out=await flown(game,answering(game,'spacemolt/refuel',drift),()=>service());
  assert.equal(out.status,'failed',out.did);
  assert.match(out.why!,/Ship or docking changed during servicing/);
});

test('serviceElsewhere names a base whose counter the server will not quote, in the row',async()=>{
  const game=bridgeWorld({pois:[{id:'far_station',base_id:'far_base',base_name:'Far Base'}]});
  const refuse=async()=>{throw new SpacemoltError('target_not_found','no such thing');};
  const command:typeof game.command=(action,params)=>
    action==='spacemolt/find_route'||action==='spacemolt/inspect'?refuse():game.command(action,params);
  const rows=await flown(game,command,()=>Effect.runPromise(serviceElsewhereEffect('sol_base').pipe(Effect.provide(GameLive({send:command})))));
  assert.equal(rows.length,1);
  assert.equal(rows[0]?.base,'far_base');
  assert.match(rows[0]!.why,/no route quote \(spacemolt\/find_route: target_not_found — no such thing\); no price readable from here \(spacemolt\/inspect: target_not_found/);
});

test('serviceElsewhere with no listing falls back to the placed bases, unquoted when find_route refuses',async()=>{
  const game=bridgeWorld();
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-service-'));
  writeFileSync(join(runtime,'places.json'),JSON.stringify({range_base:'deep_range'}));
  const refuse=async()=>{throw new SpacemoltError('target_not_found','no such thing');};
  const command:typeof game.command=(action,params)=>
    action==='spacemolt/get_system'||action==='spacemolt/find_route'?refuse():game.command(action,params);
  const rows=await flown(game,command,()=>Effect.runPromise(serviceElsewhereEffect().pipe(Effect.provide(GameLive({send:command})))),{runtime});
  assert.deepEqual(rows.map(row=>row.base),['range_base']);
  assert.match(rows[0]!.why,/a base this pilot has placed: no route quote \(spacemolt\/find_route: target_not_found — no such thing\)/);
});
