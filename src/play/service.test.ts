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
