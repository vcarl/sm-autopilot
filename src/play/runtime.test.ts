import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {goTo} from './travel.ts';
import {bind,command,job,outcome,pilot,progress,stop,unbind,type Pilot} from './runtime.ts';
import {service} from './service.ts';
import {sell,prices} from './market.ts';
import {stow,withdraw} from './storage.ts';
import {acceptMission,missions} from './missions.ts';

function world(record:Pilot,services=['refuel','repair','storage'],options:WorldOptions={}) {
  const game=bridgeWorld({services,...options});
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
    // A row that is not held needed nothing done: it is said in `did`, and the status stays done.
    const sold=await sell([{item_id:'ore',quantity:5},{item_id:'ice',quantity:1}]);
    assert.equal(sold.status,'done',sold.why);
    assert.match(sold.did,/nothing to sell: ice not held/);
    assert.deepEqual(sold.detail.short,[{item_id:'ice',requested:1,sold:0,why:'not held'}]);
    assert.equal(sold.gained.credits,50,'measured from the wallet');
    assert.equal(f.account.server.ship.cargo_used,7);
    const quotes=await prices();
    assert.deepEqual(quotes.detail.quotes.map(q=>[q.item_id,q.held,q.stored]),[['ore',7,340]]);
    // No quantity on a row means all of it.
    const put=await stow([{item_id:'ore'}]);
    assert.equal(put.status,'done',put.why);
    assert.deepEqual(put.detail.moved,[{item_id:'ore',quantity:7}]);
    const took=await withdraw([{item_id:'ore',quantity:3},{item_id:'scrap',quantity:9}]);
    assert.equal(took.status,'done',took.why);
    assert.deepEqual(took.detail.moved,[{item_id:'ore',quantity:3},{item_id:'scrap',quantity:2}]);
    assert.equal(took.detail.short[0]!.why,'not in store');
  } finally {unbind();}
});

test('a row that is not there is done with nothing to do, and a real precondition is still refused',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},['refuel','repair','storage']);
  try {
    // Nothing of that item is aboard: the end state already holds.
    const again=await stow([{item_id:'aluminum_ore',quantity:41}]);
    assert.equal(again.status,'done',again.why);
    assert.match(again.did,/nothing to stow: aluminum_ore not held/);
    assert.equal(f.count('spacemolt_storage/deposit'),0,'nothing was sent');
    // Nor in the store: withdraw says so and is done too.
    const none=await withdraw([{item_id:'aluminum_ore'}]);
    assert.equal(none.status,'done',none.why);
    assert.match(none.did,/nothing to withdraw: aluminum_ore not in store/);
    // A real precondition failure is still a refusal.
    f.account.server.location.docked_at=null;
    await f.account.refresh();
    const adrift=await stow([{item_id:'ore',quantity:1}]);
    assert.equal(adrift.status,'refused');
    assert.match(adrift.why!,/needs a docked ship/);
  } finally {unbind();}
});

test('sell from the store keeps withdrawing hold-loads until the named rows are gone, and leaves what has no buyer',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},['refuel','repair','storage'],
    {cargoUsed:0,store:[{item_id:'ore',quantity:30},{item_id:'dust',quantity:5}]});
  try {
    // The hold takes 12: 30 ore is three loads, and dust has no book here, so it never moves.
    const out=await sell([{item_id:'ore'},{item_id:'dust',quantity:5}],{from:'store'});
    assert.equal(out.status,'partial',out.why);
    assert.equal(out.detail.total,300,'every unit of ore sold, not one hold-load');
    assert.equal(out.gained.credits,300);
    assert.equal(f.count('spacemolt_storage/withdraw'),3,'one withdraw per hold-load');
    assert.deepEqual(f.store.map(row=>[row.item_id,row.quantity]),[['dust',5]],'the unsellable row stayed');
    assert.match(out.did,/left in the store: dust no buyer/);
    assert.deepEqual(out.detail.short,[{item_id:'dust',requested:5,sold:0,why:'no buyer'}]);
  } finally {unbind();}
});

test('a non-finite quantity is refused, and says to omit it instead',async()=>{
  const f=world({mood:'Focused'});
  try {
    for(const out of [await stow([{item_id:'ore',quantity:Infinity}]),
      await withdraw([{item_id:'ore',quantity:NaN}]),
      await sell([{item_id:'ore',quantity:Infinity}])]) {
      assert.equal(out.status,'refused');
      assert.match(out.why!,/omit quantity to mean all of it/);
    }
    assert.equal(f.sent.filter(c=>['spacemolt/sell','spacemolt_storage/deposit','spacemolt_storage/withdraw'].includes(c.action)).length,0);
  } finally {unbind();}
});

test('the board leads with the free slots, and a full one refuses without sending',async()=>{
  const f=world({mood:'Focused'});
  try {
    const board=await missions();
    assert.equal(board.detail.slots_free,5);
    assert.match(board.did,/^5 slot\(s\) free: 0 of 5 active; 2 on the board/);
    const took=await acceptMission('m1');
    assert.equal(took.status,'done',took.why);
    assert.equal((await missions()).detail.slots_free,4);
    // Five taken is the cap: the refusal is local and the counter never hears about it.
    for(const id of ['m1','m1','m1','m1'])f.taken.push({mission_id:id,percent_complete:0});
    const refused=await acceptMission('m2');
    assert.equal(refused.status,'refused');
    assert.match(refused.why!,/no slot free: 5 of 5/);
    assert.equal(f.count('spacemolt/accept_mission'),1,'only the admitted accept was sent');
  } finally {unbind();}
});

test('a disconnect mid-command is waited out, an idempotent command re-issued once, a mutation never',async()=>{
  const game=bridgeWorld({});
  let calls=0,drop=true;
  const flaky=async(action:string,params:Record<string,unknown>)=>{
    calls++;
    if(drop){drop=false;throw new Error('No action_result for mutation r145 within 180000ms of its ack');}
    return game.command(action,params);
  };
  // The lib's own reconnect: `reconnect:true` re-authenticates and then says so.
  const account=Object.assign(game.account,{onReconnected:(fn:()=>void)=>{setTimeout(fn,0);return ()=>{};}});
  const lines:string[]=[];
  bind({account:account as unknown as ReadinessAccount,command:flaky,
    pilot:()=>({mood:'Focused'}),setPilot:()=>{},emit:text=>lines.push(text)});
  try {
    await command('spacemolt/get_base',{});
    assert.equal(calls,2,'the read was re-issued once after the reconnect');
    assert.ok(lines.some(line=>line.includes('reconnected; re-issued once')),lines.join('\n'));
    // A sell may have landed before the wire went: it is never re-sent, and says why.
    drop=true;calls=0;
    await assert.rejects(command('spacemolt/sell',{id:'ore',quantity:1}),/outcome unknown, re-observe/);
    assert.equal(calls,1,'nothing was sent twice');
    assert.equal(game.count('spacemolt/sell'),0);
  } finally {unbind();}
});

test('a command pending longer than 30s says so every 30s, and status names what it waits on',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date']});
  const game=bridgeWorld({});
  const lines:string[]=[];
  let release:(()=>void)|undefined;
  const slow=async(action:string,params:Record<string,unknown>)=>{
    if(action==='spacemolt/mine')await new Promise<void>(resolve=>{release=resolve;});
    return game.command(action,params);
  };
  bind({account:game.account as unknown as ReadinessAccount,command:slow,
    pilot:()=>({mood:'Focused'}),setPilot:()=>{},emit:text=>lines.push(text)});
  try {
    const flight=command('spacemolt/mine',{});
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    const waits=lines.filter(l=>l.includes('waiting'));
    assert.deepEqual(waits,['  spacemolt/mine: waiting 30s for the game (last tick ?)',
      '  spacemolt/mine: waiting 60s for the game (last tick ?)']);
    // While it is on the wire, status tells a pilot which of the two silences this is.
    assert.deepEqual(progress().pending,{action:'spacemolt/mine',since_s:60});
    release!();
    await flight;
    assert.equal(progress().pending,undefined,'nothing pends once the reply lands');
    assert.ok(progress().last_command_at,'and the last reply is stamped');
  } finally {unbind();t.mock.timers.reset();}
});

test('a half-open socket the lib never reconnects is forced back, then the command re-issued',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  const game=bridgeWorld({});
  let calls=0,drop=true,forced=0;
  const flaky=async(action:string,params:Record<string,unknown>)=>{
    calls++;
    if(drop){drop=false;throw new Error('No action_result for mutation r88 within 60000ms of its ack');}
    return game.command(action,params);
  };
  // The socket never closed, so the lib's own reconnect never fires; only reconnectOnce moves.
  const account=Object.assign(game.account,{onReconnected:()=>()=>{},reconnectOnce:async()=>{forced++;}});
  const lines:string[]=[];
  bind({account:account as unknown as ReadinessAccount,command:flaky,
    pilot:()=>({mood:'Focused'}),setPilot:()=>{},emit:text=>lines.push(text)});
  try {
    const flight=command('spacemolt/get_base',{});
    // The throw and the catch that arms the reconnect wait are microtasks: let them land first.
    await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(60_000);
    await flight;
    assert.equal(forced,1,'the reconnect was forced, not waited on forever');
    assert.equal(calls,2,'and the read was re-issued once');
    assert.ok(lines.some(l=>l.includes('no reconnect in 60s; forcing one')),lines.join('\n'));
  } finally {unbind();t.mock.timers.reset();}
});
