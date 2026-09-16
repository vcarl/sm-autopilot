import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {goTo} from './travel.ts';
import {bind,command,job,outcome,pilot,stop,unbind,type Pilot} from './runtime.ts';
import {service} from './service.ts';
import {sell,prices} from './market.ts';
import {stow,withdraw} from './storage.ts';

function world(record:Pilot,services=['refuel','repair','storage']) {
  const game=bridgeWorld({services});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:text=>lines.push(text)});
  return {...game,lines,record:()=>who};
}

test('job measures cost and gains from state reads, and streams its entry and exit lines',async()=>{
  const f=world({mood:'Focused'});
  try {
    const out=await job('probe','x',async()=>{
      f.account.server.player.credits-=40;
      f.account.server.ship.fuel-=7;
      f.account.server.cargo.push({item_id:'ore',quantity:3});
      await command('spacemolt/get_base',{});
      return {status:'done' as const,did:'probed',detail:{n:1},next:['a','b','c','d']};
    });
    assert.equal(out.fn,'probe');
    assert.deepEqual([out.cost.credits,out.cost.fuel,out.cost.hull],[40,7,0]);
    // The hold had 12 ore; the row pushed beside it counts as 3 gained, the reply's claim never read.
    assert.deepEqual(out.gained.items,[{item_id:'ore',quantity:3}]);
    assert.equal(out.next.length,3,'next is capped at three');
    assert.equal(out.now.ship.fuel,93);
    assert.deepEqual(f.lines.map(line=>line.split('  ')[0]),['▶ probe x','✓ probe']);
    // A throw is a failed Outcome, never an exception out of the library.
    const broke=await job('probe','',async()=>{throw new Error('boom');});
    assert.deepEqual([broke.status,broke.why],['failed','boom']);
    // The pilot's own outcome() measures since the run began (or its last call).
    f.account.server.player.credits+=100;
    await f.account.refresh();
    assert.equal(outcome('mine').gained.credits,60);
    assert.equal(outcome('mine').gained.credits,0);
  } finally {unbind();}
});

test('Tired is imposed on the command seam when a margin is crossed and cleared when service brings it back',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}});
  try {
    // Focused keeps 24 fuel: a command that leaves the tank under it imposes Tired.
    f.account.server.ship.fuel=20;
    await f.account.refresh();
    await command('spacemolt/get_base',{});
    assert.equal(f.record().mood,'Tired');
    assert.equal(f.record().mood_before_tired,'Focused');
    assert.match(f.lines.at(-1)!,/tired: fuel 20 under the Focused reserve 24/);
    // Under Tired, a gather may not start but service may; refuelling clears it anywhere.
    const fixed=await service();
    assert.equal(fixed.status,'done',fixed.why);
    assert.equal(fixed.detail.cleared_tired,true);
    assert.equal(f.record().mood,'Focused');
    assert.equal('mood_before_tired' in f.record(),false);
    assert.ok(f.lines.some(line=>line.startsWith('tired cleared')));
    // The operator's forced Tired is not cleared by resupply.
    f.account.server.ship.fuel=10;await f.account.refresh();
    await command('spacemolt/get_base',{});
    assert.equal(f.record().mood,'Tired');
    const forced=f.record();
    bind({account:f.account as unknown as ReadinessAccount,command:f.command,
      pilot:()=>({...forced,tired_forced:true}),setPilot:()=>{assert.fail('a forced Tired must not be rewritten');},emit:()=>{}});
    await service();
    assert.equal(pilot().mood,'Tired');
  } finally {unbind();}
});

test('goTo resolves a base id to the POI it sits at, docks there, and refuses a POI under Tired',async()=>{
  const f=world({mood:'Focused'});
  try {
    f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    await f.account.refresh();
    const trip=await goTo('sol_base');
    assert.equal(trip.status,'done',trip.why);
    assert.equal(trip.detail.docked,true);
    assert.equal(trip.detail.route.target_poi,'station','the route quote carries the base\'s POI');
    // Flown to the POI the base sits at, then docked: never a wait for a POI named sol_base.
    assert.deepEqual(f.sent.filter(c=>['spacemolt/travel','spacemolt/dock'].includes(c.action)).map(c=>[c.action,c.params.id]),
      [['spacemolt/travel','station'],['spacemolt/dock',undefined]]);
    assert.equal(f.account.server.location.docked_at,'sol_base');
    // Already there and docked: nothing sent.
    const before=f.sent.length;
    assert.equal((await goTo('sol_base')).did,'already at sol_base');
    assert.equal(f.sent.filter(c=>c.action==='spacemolt/travel').length,f.sent.slice(0,before).filter(c=>c.action==='spacemolt/travel').length);
    // A stop asked mid-flight ends the trip partial, not wedged.
    stop();
    const halted=await goTo('belt');
    assert.equal(halted.status,'partial');
    assert.match(halted.why!,/stopped by pilot/);
  } finally {unbind();}
});

test('sell, stow and withdraw take rows by name and never default to the whole hold',async()=>{
  const f=world({mood:'Focused'});
  try {
    const nothing=await sell([]);
    assert.equal(nothing.status,'refused');
    assert.equal(f.sent.filter(c=>c.action==='spacemolt/sell').length,0);
    const sold=await sell([{item_id:'ore',quantity:5},{item_id:'ice',quantity:1}]);
    assert.equal(sold.status,'partial');
    assert.deepEqual(sold.detail.short,[{item_id:'ice',requested:1,sold:0,why:'not held'}]);
    assert.equal(sold.gained.credits,50,'measured from the wallet');
    assert.equal(f.account.server.ship.cargo_used,7);
    const quotes=await prices();
    assert.deepEqual(quotes.detail.quotes.map(q=>[q.item_id,q.held,q.stored]),[['ore',7,340]]);
    const put=await stow([{item_id:'ore',quantity:Infinity}]);
    assert.equal(put.status,'done',put.why);
    assert.deepEqual(put.detail.moved,[{item_id:'ore',quantity:7}]);
    const took=await withdraw([{item_id:'ore',quantity:3},{item_id:'scrap',quantity:9}]);
    assert.equal(took.status,'partial');
    assert.deepEqual(took.detail.moved,[{item_id:'ore',quantity:3},{item_id:'scrap',quantity:2}]);
    assert.equal(took.detail.short[0]!.why,'not in store');
  } finally {unbind();}
});
