import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
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
  let who:Pilot={mood:'Cautious'};
  bind({account:game.account as unknown as ReadinessAccount,command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.cleared_tired,true,'the fill put the ship back inside the Cautious margins');
    assert.equal(who.mood,'Cautious','the mood Tired replaced is restored, not left as Tired');
    assert.equal(game.account.server.ship.fuel,120);
    assert.equal(game.account.server.ship.hull,100);
  } finally {unbind();}
});

// The live juncture: Tired at frontier_station, which posts no all-in repair quote. Refusing
// the whole service left the pilot three fuel units short of being able to fly anywhere, at the
// one station that would have sold it the fuel. Tired takes what the counter does sell and names
// where the rest is, because forcing the supply is what the mood is for.
test('Tired buys what the counter sells and names the other base for the rest',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0,
    pois:[{id:'yard',name:'Sol Yard',base_id:'yard_base',base_name:'Sol Yard Base'}]});
  game.account.server.ship.fuel=117;
  game.account.server.ship.hull=52;
  let who:Pilot={mood:'Tired'};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    assert.equal(game.account.server.ship.fuel,120,'the tank is filled from the one counter that quotes');
    assert.equal(game.account.server.ship.hull,52,'the hull is not bought at a station that posts no price');
    assert.match(out.detail.short.join('\n'),/no all-in repair quote at this station/);
    assert.equal(out.detail.cleared_tired,false,'the hull is still down, so the mood stands');
    const next=(out.next??[]).join('\n');
    assert.match(next,/goTo\('yard_base'\)/,next);
    assert.match(next,/7 fuel/,next);
    assert.match(next,/price unknown until docked/,next);
  } finally {unbind();}
});

test('with no other base to name, the partial fill says so and claims no station',async()=>{
  const game=bridgeWorld({services:['refuel'],cargoUsed:0});
  game.account.server.ship.hull=52;
  let who:Pilot={mood:'Tired'};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'done',out.why);
    const next=(out.next??[]).join('\n');
    assert.doesNotMatch(next,/goTo\('/,next);
    assert.match(next,/no other base in sol/,next);
  } finally {unbind();}
});

// `credit_reserve` is the operator's one money bound, and Tired does not widen it: Tired lifts
// the mood's own spend margin to unbounded, so the reserve is the only thing left that can
// refuse a fill — and a refusal a script cannot read is a pilot guessing. It names the reserve.
test('the operator credit reserve still refuses a Tired fill, by name',async()=>{
  const game=bridgeWorld({services:['refuel','repair'],cargoUsed:0});
  game.account.server.ship.fuel=10;
  game.account.server.player.credits=100;
  let who:Pilot={mood:'Tired',permissions:{credit_reserve:90}};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  try {
    const out=await service();
    assert.equal(out.status,'refused',out.did);
    assert.match(out.why!,/credits 100 less reserve 90 cannot cover the quoted/);
    assert.equal(game.account.server.ship.fuel,10,'a service under the reserve spends nothing');
  } finally {unbind();}
});
