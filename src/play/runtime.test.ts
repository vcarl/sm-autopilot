import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {distressPlan,goTo} from './travel.ts';
import {bind,command,job,outcome,pilot,progress,stop,unbind,type Pilot} from './runtime.ts';
import {service} from './service.ts';
import {buy,sell,prices} from './market.ts';
import {buyShip,refit,shipsForSale} from './hangar.ts';
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
    // A forced Tired is not cleared by resupply.
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

test('goTo takes a POI id, a display name, or a word that names nothing and says what does',async()=>{
  const f=world({mood:'Focused'});
  try {
    f.account.server.location={system_id:'sol',poi_id:'station',docked_at:null,in_transit:false};
    await f.account.refresh();
    // A POI id ends the trip at that POI, undocked — there is no base to dock at.
    const belt=await goTo('belt');
    assert.equal(belt.status,'done',belt.why);
    assert.equal(f.account.server.location.poi_id,'belt');
    assert.equal(belt.detail.docked,false);
    // A display name is what prose gives the pilot, so it resolves to the id and, for a
    // base, still ends the trip docked.
    const named=await goTo('Sol Base');
    assert.equal(named.status,'done',named.why);
    assert.equal(named.detail.docked,true);
    assert.equal(f.account.server.location.docked_at,'sol_base');
    assert.ok(f.lines.some(line=>line.includes('Sol Base is sol_base')),f.lines.join('\n'));
    // A base id the pilot invented off a system name: the server calls that "Target system
    // not found", which says nothing; the refusal names the system it was built from.
    const guess=await goTo('deep_range_outpost');
    assert.equal(guess.status,'refused');
    assert.match(guess.why!,/no system, POI or base is named deep_range_outpost/);
    assert.match(guess.why!,/nearest: deep_range \(system Deep Range\)/);
    // Nothing was flown on the refusal.
    assert.equal(f.account.server.location.docked_at,'sol_base');
    // A guess built out of the right words, which is neither a prefix nor a suffix of the
    // real id: the words it shares are what finds the POI it was reaching for.
    const invented=await goTo('station_a');
    assert.equal(invented.status,'refused');
    assert.match(invented.why!,/nearest: station \(POI Sol Station\)/);
  } finally {unbind();}
});

test('a guess that names a system with one base is that base; with several it is refused with their ids',async()=>{
  const f=world({mood:'Focused'});
  try {
    f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    await f.account.refresh();
    // "the waystation in Sol" names no place, but Sol has one base, so that is where it meant.
    // (`sol_station` would not get this far: Sol Station is the display name of a POI here.)
    const trip=await goTo('sol_waystation');
    assert.equal(trip.status,'done',trip.why);
    assert.equal(f.account.server.location.docked_at,'sol_base');
    assert.equal(trip.detail.docked,true);
    assert.ok(f.lines.some(line=>line.includes('sol_waystation is not a place; going to sol_base, the one base in Sol')),
      f.lines.join('\n'));
  } finally {unbind();}
  // Two bases in the system: nothing is flown, and both ids are in the refusal.
  const g=world({mood:'Focused'},['refuel','repair','storage'],
    {pois:[{id:'refinery',name:'Sol Refinery',base_id:'refinery_base',base_name:'Sol Refinery Base'}]});
  try {
    g.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    await g.account.refresh();
    const guess=await goTo('sol_waystation');
    assert.equal(guess.status,'refused');
    assert.match(guess.why!,/Sol has 2 base\(s\): sol_base \(Sol Base\), refinery_base \(Sol Refinery Base\)/);
    assert.equal(g.account.server.location.poi_id,'belt');
  } finally {unbind();}
});

test('goTo a system id is done wherever in that system the jump lands, and never names it as a POI',async()=>{
  const f=world({mood:'Focused'});
  try {
    f.account.server.location={system_id:'sol',poi_id:'belt',docked_at:null,in_transit:false};
    await f.account.refresh();
    const trip=await goTo('deep_range');
    assert.equal(trip.status,'done',trip.why);
    assert.equal(f.account.server.location.system_id,'deep_range');
    // The jump was flown and paid for; naming the system as a POI afterwards is the server's
    // "Unknown destination", which is what turned a landed trip into a `failed`.
    assert.deepEqual(f.sent.filter(c=>c.action==='spacemolt/travel').map(c=>c.params.id),[]);
    assert.equal(f.sent.filter(c=>c.action==='spacemolt/jump').length,1);
    assert.match(trip.did,/arrived at deep_range \(gate\) after 1 jump\(s\)/,'the did names the POI landed at');
    assert.equal(trip.detail.docked,false);
    // Already in that system: nothing sent, whatever POI the ship is parked at.
    const before=f.sent.length;
    assert.match((await goTo('deep_range')).did,/already at deep_range \(gate\)/);
    assert.equal(f.sent.slice(before).filter(c=>c.action==='spacemolt/jump').length,0);
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

// The Cobble that lost 2,080 cr: two utility slots, both fitted, and a cargo expander bought
// anyway. Every check below is that mistake made impossible.
const cobble=(extra:WorldOptions['hangar']={}):WorldOptions=>
  ({cargoUsed:0,hangar:{fitted:[
    {module_id:'m1',type_id:'cargo_expander_ii',slot:'utility',cpu_usage:2,power_usage:3},
    {module_id:'m2',type_id:'mining_laser_i',slot:'utility',cpu_usage:3,power_usage:4}],...extra}});

test('refit names the full slot and what to remove, and fits once one comes off',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},['refuel','repair','storage'],cobble());
  try {
    f.account.server.cargo.push({item_id:'cargo_expander_ii',quantity:1});
    f.account.server.ship.cargo_used+=1;
    await f.account.refresh();
    const full=await refit({install:['cargo_expander_ii']});
    assert.equal(full.status,'refused');
    assert.match(full.why!,/no free utility slot: 2 of 2 fitted; remove one of cargo_expander_ii, mining_laser_i first/);
    assert.equal(f.count('spacemolt/install_mod'),0,'nothing was sent');
    // The remove frees the slot the install needs, in the same call and in that order.
    const swapped=await refit({remove:['mining_laser_i'],install:['cargo_expander_ii']});
    assert.equal(swapped.status,'done',swapped.why);
    assert.deepEqual([swapped.detail.removed,swapped.detail.installed],[['mining_laser_i'],['cargo_expander_ii']]);
    assert.deepEqual(f.account.server.modules.map(row=>row.type_id),['cargo_expander_ii','cargo_expander_ii']);
    assert.deepEqual([f.account.server.ship.cpu_used,f.account.server.ship.power_used],[4,6]);
    // A module already off, and one already on by its module_id, are both nothing to do.
    const again=await refit({remove:['mining_laser_i'],install:['m1']});
    assert.equal(again.status,'done',again.why);
    assert.match(again.did,/already fitted: m1; already unfitted: mining_laser_i/);
    assert.equal(f.count('spacemolt/uninstall_mod'),1,'only the real remove was sent');
  } finally {unbind();}
});

test('buying a module that could not be fitted is refused at the counter, forced through only on request',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},['refuel','repair','storage'],cobble());
  try {
    const refused=await buy('cargo_expander_ii',1);
    assert.equal(refused.status,'refused');
    assert.match(refused.why!,/no free utility slot: 2 of 2 fitted/);
    assert.equal(f.count('spacemolt_market/estimate_purchase'),0,'the wallet was never opened');
    assert.match(refused.next.join(' '),/refit\(\{remove/);
    // A spare is a legitimate buy: the pilot says so and the check steps aside.
    const spare=await buy('cargo_expander_ii',1,{force:true});
    assert.equal(spare.status,'done',spare.why);
    assert.equal(f.count('spacemolt/buy'),1);
    // An item that is not a module is never slot-checked at all.
    const ore=await buy('ore',2);
    assert.equal(ore.status,'done',ore.why);
  } finally {unbind();}
});

test('buyShip refuses a hull that would take the wallet under the reserve, with the numbers',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:500}},['refuel','repair','storage'],
    {cargoUsed:0,hangar:{listings:[{listing_id:'l1',ship_id:'s2',class_id:'hauler_ii',price:800}]}});
  try {
    const over=await buyShip('l1');
    assert.equal(over.status,'refused');
    assert.match(over.why!,/costs 800; credits 1000 less reserve 500 leaves 500/);
    assert.equal(f.count('spacemolt_ship/buy_listed_ship'),0,'nothing was sent');
    // Inside the reserve it goes through, and the fleet list is the evidence, not the reply.
    f.account.server.player.credits=2_000;
    await f.account.refresh();
    const bought=await buyShip('l1');
    assert.equal(bought.status,'done',bought.why);
    assert.deepEqual([bought.detail.price,bought.detail.switched],[800,false]);
    assert.deepEqual(f.fleet.map(row=>row.ship_id),['ship','s2']);
    // NOT `switchShip('s2')`: `fleet/fleet.ts` throws `unimplemented`, so the hint that named it
    // handed the pilot the one call it most wanted to make and could not. The runnable command is
    // what a hint owes, and this test used to pin the dead one.
    assert.match(bought.next.join(' '),/spacemolt_ship\.switch_ship\(\{id:'s2'\}\)/);
    assert.doesNotMatch(bought.next.join(' '),/(?<!\.)\bswitchShip\('/);
    const board=await shipsForSale();
    assert.equal(board.status,'done',board.why);
    assert.equal(board.detail.for_sale.length,0,'the only listing was bought');
  } finally {unbind();}
});

/** A distress call as `get_active_missions` lists one: a single `visit_system` objective,
 * which arriving in that system is the whole of. */
const distress=(over:Record<string,unknown>={})=>({mission_id:'d1',title:'Distress: Wexler LAC-X3 in Deep Range',
  type:'distress',description:'',difficulty:1,accepted_at:'',issuing_base:'sol_base',expires_in_ticks:100,
  percent_complete:0,rewards:{credits:1_500},
  objectives:[{description:'Investigate distress call in Deep Range',type:'visit_system',system_id:'deep_range',
    current:0,required:1,completed:false}],...over});

test('goTo answers a distress call on its route and claims it en route',async()=>{
  const f=world({mood:'Focused'});
  try {
    f.taken.push(distress());
    const trip=await goTo('range_base');
    assert.equal(trip.status,'done',trip.why);
    assert.match(trip.did,/completed distress Distress: Wexler LAC-X3 in Deep Range at deep_range en route for 1500 cr/);
    assert.equal(f.taken.length,0,'the slot the pilot kept abandoning is paid instead');
    assert.equal(trip.gained.credits,1_500,'the reward is measured, not claimed');
    assert.equal(f.count('spacemolt/jump'),1,'a call on the route costs no extra jump');
    assert.equal(f.count('spacemolt/accept_mission'),0,'travel never accepts a mission');
  } finally {unbind();}
});

test('a distress call one jump off the route is answered, two jumps off or expired is not',()=>{
  // Four jumps a-b-c-d-e, so a quarter of the route is one jump of detour budget.
  const quote={route:['a','b','c','d','e'].map((system_id,jumps)=>({system_id,jumps,name:system_id})),
    total_jumps:4,estimated_fuel:28,fuel_per_jump:7,fuel_available:200};
  const legs=new Map([['x',{route:[{system_id:'a',jumps:0,name:'a'},{system_id:'b',jumps:1,name:'b'},{system_id:'x',jumps:2,name:'x'}],total_jumps:2}],
    ['y',{route:[{system_id:'a',jumps:0,name:'a'},{system_id:'b',jumps:1,name:'b'},{system_id:'z',jumps:2,name:'z'},{system_id:'y',jumps:3,name:'y'}],total_jumps:3}]]);
  const at=(id:string,system:string,over:Record<string,unknown>={})=>distress({mission_id:id,title:id,
    objectives:[{description:`Investigate distress call in ${system}`,type:'visit_system',system_id:system,
      current:0,required:1,completed:false}],...over}) as never;
  const plan=distressPlan(quote,[at('onRoute','c'),at('near','x'),at('far','y'),at('dead','c',{expires_in_ticks:0})],
    legs,24);
  assert.deepEqual(plan.map(s=>[s.id,s.extra]),[['onRoute',0],['near',1]],
    'two jumps off the route and an expired call are both left alone');
  // The same plan with a tank that only covers the direct route drops the detour.
  assert.deepEqual(distressPlan({...quote,fuel_available:56},[at('onRoute','c'),at('near','x')],legs,24).map(s=>s.id),['onRoute']);
});
