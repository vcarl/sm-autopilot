import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {journalRun} from '../run-record.ts';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,derived} from '../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from './runtime.ts';
import {service} from './service.ts';

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
  bind({account:game.account as unknown as ReadinessAccount,command,
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
    bind({account:game.account as unknown as ReadinessAccount,command:game.command,
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
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'refused',out.did);
    assert.match(out.why!,/spacemolt\/repair charged 48, leaving credits 52 under the reserve 90/);
  } finally {unbind();}
});

// Nothing above the reserve and no price to quote against: the call is never sent, and the refusal
// still names somewhere to go — a base the journal remembers, when this system lists no other.
test('an unpriced counter is not tried at all with nothing above the reserve',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0});
  game.account.server.ship.fuel=game.account.server.ship.max_fuel;
  game.account.server.ship.hull=52;
  game.account.server.player.credits=90;
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-service-'));
  journalRun(runtime,{response:{result:{docked_at:{base_id:'range_base'}}}},'request');
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
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
  game.account.server.player.credits=100;
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
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
  bind({account:game.account as unknown as ReadinessAccount,command,
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
