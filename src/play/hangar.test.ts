import assert from 'node:assert/strict';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {buyShip,refit,shipsForSale} from './hangar.ts';
import {bind,unbind,type Pilot} from './runtime.ts';
/** A reply's body, loosely: the test pokes at fields the world sent. */
const details=(reply:any):any=>reply?.structuredContent??reply?.delta?.details??reply??{};

/** A world the game answers as the live server does, with hooks that make one command fail the way the
 * server fails it (a refusal: `SpacemoltError`, a `Rejected`; or a lost reply) or answer with a reply
 * that is missing a field. */
function world(record:Pilot,options:WorldOptions,before:(action:string)=>void=()=>{},
  answer:(action:string,reply:unknown)=>unknown=(_,reply)=>reply) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const attempts:string[]=[],lines:string[]=[];
  const command:typeof game.command=async(action,params)=>{attempts.push(action);before(action);return answer(action,await game.command(action,params));};
  bind({account:game.account as unknown as Account,command,pilot:()=>record,emit:text=>lines.push(text)});
  return {...game,attempts,lines,tried:(action:string)=>attempts.filter(each=>each===action).length};
}
/** A reply without the named fields, at the top of its body or of each row of `rows`. */
const without=(reply:unknown,drop:string[],rows?:string)=>{
  const body=structuredClone(details(reply));
  const strip=(row:Record<string,unknown>)=>{for(const key of drop)delete row[key];};
  if(rows)for(const row of body[rows])strip(row);else strip(body);
  return {structuredContent:body};
};
const fitted=(type_id:string,cpu_usage:number,power_usage:number)=>({module_id:`m_${type_id}`,type_id,slot:'utility',cpu_usage,power_usage});
const FULL:WorldOptions['hangar']={fitted:[fitted('cargo_expander_ii',2,3),fitted('mining_laser_i',3,4)]};
const refuse=(on:string,code:string,message:string)=>(action:string)=>{if(action===on)throw new SpacemoltError(code,message);};

// The class cache lives for the process, so the test that needs a class uncached runs before any other reads it.
test('a class reply that does not read is said, left off the board, and asked again next time: it is not remembered',async()=>{
  const f=world({mood:'Focused'},{hangar:{listings:[{listing_id:'l9',ship_id:'s9',class_id:'cobble',price:50}]}},undefined,
    (action,reply)=>{
      if(action!=='spacemolt/inspect')return reply;
      const body=structuredClone(details(reply));
      delete body.catalog.items[0].name;
      return {structuredContent:body};
    });
  try {
    for(let round=0;round<2;round++) {
      const out=await shipsForSale();
      assert.equal(out.status,'done',out.why);
      assert.equal(out.detail.for_sale.length,0);
    }
    assert.equal(f.tried('spacemolt/inspect'),2,'an unreadable answer is not cached');
    assert.ok(f.lines.some(line=>/spacemolt\/inspect: the catalog's answer for cobble did not read as a ship class/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

// Live 2026-09-28: `inspect rubble` on every menu render. A catalogue answer that is another kind of thing is remembered.
test('a class id the catalogue answers as some other kind of thing is left off the board and not asked again',async()=>{
  const f=world({mood:'Focused'},{hangar:{listings:[{listing_id:'l8',ship_id:'s8',class_id:'pebble',price:50}]}},undefined,
    (action,reply)=>{
      if(action!=='spacemolt/inspect')return reply;
      return {structuredContent:{...details(reply),kind:'item'}};
    });
  try {
    for(let round=0;round<2;round++)assert.equal((await shipsForSale()).detail.for_sale.length,0);
    assert.equal(f.tried('spacemolt/inspect'),1,'a definitive answer is cached');
  } finally {unbind();}
});

test('refit says the catalog entry was unreadable, not that there is no such module',async()=>{
  const f=world({mood:'Focused'},{cargo:[{item_id:'cargo_expander_ii',quantity:1}],cargoUsed:1},undefined,
    (action,reply)=>{
      if(action!=='spacemolt/inspect')return reply;
      const body=structuredClone(details(reply));
      delete body.catalog.items[0].cpu_usage;
      return {structuredContent:body};
    });
  try {
    const out=await refit({install:['cargo_expander_ii']});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/cargo_expander_ii: the catalog entry for it was unreadable/);
    assert.equal(f.tried('spacemolt/install_mod'),0);
  } finally {unbind();}
});

test('refit refuses before sending when a module will not fit, and names the slot and the fix',async()=>{
  const f=world({mood:'Focused'},{hangar:FULL,cargo:[{item_id:'cargo_expander_ii',quantity:1}],cargoUsed:1});
  try {
    const out=await refit({install:['cargo_expander_ii']});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/no free utility slot: 2 of 2 fitted; remove one of cargo_expander_ii, mining_laser_i first/);
    assert.deepEqual(f.attempts.filter(action=>/install_mod/.test(action)),[],'nothing was sent');
  } finally {unbind();}
});

test('refit: an install the server refuses is a Rejected, and the pilot is told the action and the code',async()=>{
  const f=world({mood:'Focused'},{cargo:[{item_id:'cargo_expander_ii',quantity:1}],cargoUsed:1},
    refuse('spacemolt/install_mod','module_locked','that module is locked to its owner'));
  try {
    const out=await refit({install:['cargo_expander_ii']});
    assert.equal(out.status,'refused',out.why);
    assert.equal(out.why,'spacemolt/install_mod: module_locked — that module is locked to its owner');
    assert.equal(f.tried('spacemolt/install_mod'),1);
  } finally {unbind();}
});

test('refit: a ReplyLost on a remove is failed, says the reply is lost, and nothing is re-sent or sent after it',async()=>{
  const f=world({mood:'Focused'},{hangar:{fitted:[fitted('mining_laser_i',3,4)]},cargo:[{item_id:'cargo_expander_ii',quantity:1}],cargoUsed:1},
    action=>{if(action==='spacemolt/uninstall_mod')throw new ConnectionClosedError();});
  try {
    const out=await refit({remove:['mining_laser_i'],install:['cargo_expander_ii']});
    assert.equal(out.status,'failed');
    assert.match(out.why!,/reply lost on spacemolt\/uninstall_mod/);
    assert.equal(f.tried('spacemolt/uninstall_mod'),1,'a mutation whose reply is gone is not sent again');
    assert.equal(f.tried('spacemolt/install_mod'),0,'and the run does not go on past it');
  } finally {unbind();}
});

const LISTING={listing_id:'l1',ship_id:'s2',class_id:'hauler_ii',price:800};

test('buyShip refuses on the reserve, with the numbers, before the wallet is touched',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:500}},{hangar:{listings:[LISTING]}});
  try {
    const out=await buyShip('l1');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/costs 800; credits 1000 less reserve 500 leaves 500/);
    assert.equal(f.tried('spacemolt_ship/buy_listed_ship'),0);
  } finally {unbind();}
});

test('buyShip: a buy_listed_ship the server refuses is a Rejected, naming the code; nothing is bought',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{hangar:{listings:[LISTING]}},
    refuse('spacemolt_ship/buy_listed_ship','listing_gone','that listing was just sold'));
  try {
    const out=await buyShip('l1');
    assert.equal(out.status,'refused',out.why);
    assert.equal(out.why,'spacemolt_ship/buy_listed_ship: listing_gone — that listing was just sold');
    assert.equal(f.tried('spacemolt_ship/buy_listed_ship'),1);
    assert.deepEqual(f.fleet.map(row=>row.ship_id),['ship']);
    assert.equal(f.account.server.player.credits,1_000);
  } finally {unbind();}
});

test('buyShip: a ReplyLost on the purchase is failed and the purchase is not re-sent',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{hangar:{listings:[LISTING]}},
    action=>{if(action==='spacemolt_ship/buy_listed_ship')throw new ConnectionClosedError();});
  try {
    const out=await buyShip('l1');
    assert.equal(out.status,'failed');
    assert.match(out.why!,/reply lost on spacemolt_ship\/buy_listed_ship/);
    assert.equal(f.tried('spacemolt_ship/buy_listed_ship'),1);
    assert.equal(f.tried('spacemolt_ship/list_ships'),0,'nothing is read as if it had landed');
  } finally {unbind();}
});

test('buyShip: a hull the fleet list does not show is failed, and says to re-observe',async()=>{
  const emptied:{fleet?:unknown[]}={};
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{hangar:{listings:[LISTING]}},
    action=>{if(action==='spacemolt_ship/list_ships')emptied.fleet?.splice(0);});
  emptied.fleet=f.fleet;
  try {
    const out=await buyShip('l1');
    assert.equal(out.status,'failed');
    assert.match(out.why!,/list_ships does not show the new hull/);
  } finally {unbind();}
});

test('shipsForSale skips a class whose inspect is refused as not found, and does not ask again',async()=>{
  // Live 2026-09-26: `inspect` answered `Ship class "rubble" not found.` for a class the yard had just listed.
  const f=world({mood:'Focused'},{hangar:{unknownClasses:['ghost'],
    listings:[{listing_id:'l0',ship_id:'s1',class_id:'ghost',price:100},LISTING]}});
  try {
    const first=await shipsForSale();
    assert.equal(first.status,'done',first.why);
    assert.deepEqual(first.detail.for_sale.map(row=>row.kind==='listing'?row.listing.class_id:'commission'),['hauler_ii']);
    const second=await shipsForSale();
    assert.equal(second.status,'done',second.why);
    const asked=()=>f.sent.filter(call=>call.action==='spacemolt/inspect'&&call.params.id==='ghost').length;
    assert.equal(asked(),1,'a class the catalogue has no entry for is remembered');
  } finally {unbind();}
});

test('shipsForSale: a ReplyLost on a class read skips that listing and is not remembered',async()=>{
  let lost=true;
  const f=world({mood:'Focused'},{hangar:{listings:[{listing_id:'l9',ship_id:'s9',class_id:'cobble',price:50}]}},
    action=>{if(action==='spacemolt/inspect'&&lost)throw new ConnectionClosedError();});
  try {
    const first=await shipsForSale();
    assert.equal(first.status,'done',first.why);
    assert.equal(first.detail.for_sale.length,0);
    lost=false;
    const second=await shipsForSale();
    assert.equal(second.detail.for_sale.length,1,'the read that was lost is asked again');
    assert.equal(f.tried('spacemolt/inspect'),2);
  } finally {unbind();}
});

test('shipsForSale: a refused browse ends the run as refused, naming the code',async()=>{
  world({mood:'Focused'},{},refuse('spacemolt_ship/browse_ships','rate_limited','slow down'));
  try {
    const out=await shipsForSale();
    assert.equal(out.status,'refused');
    assert.equal(out.why,'spacemolt_ship/browse_ships: rate_limited — slow down');
  } finally {unbind();}
});

const YARD:WorldOptions['hangar']={commissions:{hauler_ii:{total:700},cobble:{total:300,blockers:['no free berth at this yard']}}};
const YARD_SERVICES={services:['refuel','repair','storage','shipyard']};

test('a completed commission whose reply omits credits_paid is done, priced by the quote and shown by the fleet list',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{...YARD_SERVICES,hangar:YARD},undefined,
    (action,reply)=>action==='spacemolt_ship/commission_ship'?without(reply,['credits_paid']):reply);
  try {
    const out=await buyShip('hauler_ii',{commission:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.price,700);
    assert.equal(f.tried('spacemolt_ship/commission_ship'),1);
    assert.ok(f.fleet.some(row=>row.ship_id==='built_hauler_ii'));
  } finally {unbind();}
});

test('a commission whose reply is unreadable is partial, says so, and is not sent again',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{...YARD_SERVICES,hangar:YARD},undefined,
    (action,reply)=>action==='spacemolt_ship/commission_ship'?without(reply,['status']):reply);
  try {
    const out=await buyShip('hauler_ii',{commission:true});
    assert.equal(out.status,'partial');
    assert.match(out.why!,/commission_ship reply was unreadable/);
    assert.equal(f.tried('spacemolt_ship/commission_ship'),1);
    assert.ok(f.lines.some(line=>/commission_ship: the reply for hauler_ii did not read/.test(line)));
  } finally {unbind();}
});

test('a commission quote with can_commission false is refused, naming the blockers; and an unreadable quote is said to be',async()=>{
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},{...YARD_SERVICES,hangar:YARD});
  try {
    const out=await buyShip('cobble',{commission:true});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/this yard will not build cobble: no free berth at this yard/);
    assert.equal(f.tried('spacemolt_ship/commission_ship'),0);
  } finally {unbind();}
  const g=world({mood:'Focused',permissions:{credit_reserve:0}},{...YARD_SERVICES,hangar:YARD},undefined,
    (action,reply)=>action==='spacemolt_ship/commission_quote'?without(reply,['credits_only_total']):reply);
  try {
    const out=await buyShip('hauler_ii',{commission:true});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/commission_quote reply for hauler_ii was unreadable/);
    assert.equal(g.tried('spacemolt_ship/commission_ship'),0);
  } finally {unbind();}
});

test('a switch whose reply lacks active_ship_class still reports switched; one that does not read is judged by the account',async()=>{
  const bought={...YARD_SERVICES,hangar:{listings:[LISTING]}};
  const f=world({mood:'Focused',permissions:{credit_reserve:0}},bought,undefined,
    (action,reply)=>action==='spacemolt_ship/switch_ship'?without(reply,['active_ship_class']):reply);
  try {
    const out=await buyShip('l1',{switchTo:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.switched,true);
  } finally {unbind();}
  const g=world({mood:'Focused',permissions:{credit_reserve:0}},bought,undefined,
    (action,reply)=>action==='spacemolt_ship/switch_ship'?without(reply,['active_ship_id']):reply);
  try {
    const out=await buyShip('l1',{switchTo:true});
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.switched,true,'the refreshed account shows the new hull');
    assert.equal(g.tried('spacemolt_ship/switch_ship'),1);
    assert.ok(g.lines.some(line=>/switch_ship: the reply did not read/.test(line)));
  } finally {unbind();}
});

test('a browse row without listed_at is listed; one whose price does not read is left out and named in a step',async()=>{
  // The live server leaves out fields the spec requires, so only what the code reads is required of a row.
  const f=world({mood:'Focused'},{hangar:{listings:[{listing_id:'bad',ship_id:'s1',class_id:'cobble',price:50},LISTING]}},undefined,
    (action,reply)=>{
      if(action!=='spacemolt_ship/browse_ships')return reply;
      const body=structuredClone(details(reply));
      delete body.listings[0].price;
      return {structuredContent:body};
    });
  try {
    const out=await shipsForSale();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.for_sale.map(row=>row.kind==='listing'?row.listing.listing_id:'commission'),['l1']);
    assert.ok(f.lines.some(line=>/browse_ships: a listings row \(bad\) did not read; left out/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

test('a browse reply with no listings list is said so',async()=>{
  const f=world({mood:'Focused'},{hangar:{listings:[LISTING]}},undefined,
    (action,reply)=>action==='spacemolt_ship/browse_ships'?without(reply,['listings']):reply);
  try {
    const out=await shipsForSale();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.for_sale.length,0);
    assert.ok(f.lines.some(line=>/browse_ships: the reply has no listings list/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

test('shipsForSale lists a yard commission beside the listings, its quote copied out of the decode',async()=>{
  const f=world({mood:'Focused'},{...YARD_SERVICES,hangar:{...YARD,listings:[LISTING]}});
  try {
    const out=await shipsForSale();
    assert.equal(out.status,'done',out.why);
    assert.ok(out.detail.for_sale.some(row=>row.kind==='commission'&&row.quote.credits_only_total===700),JSON.stringify(out.detail.for_sale));
    assert.equal(f.tried('spacemolt_ship/commission_quote'),1,'only the classes a listing names are quoted');
  } finally {unbind();}
});
