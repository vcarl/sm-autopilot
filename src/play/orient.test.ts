/** What `scout` hands the pilot to paste, and what `orient` and `scout` say when a read fails. A hint the
 * library refuses is worse than no hint: it reads as knowledge, costs a juncture to try, and the refusal
 * arrives too late to act on. */
import {SpacemoltError,type Account} from '@spacemolt/lib';
import assert,{AssertionError} from 'node:assert/strict';
import test from 'node:test';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {orient,scout} from './orient.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

/** The world, with a hook that refuses (throws), loses (throws a lost reply) or answers differently for one action.
 * The game refuses an action it does not serve and the shared world asserts instead, which is a defect. */
function world(record:Pilot,hook:(action:string)=>unknown=()=>undefined) {
  const game=bridgeWorld({services:['refuel','repair','storage']});
  const command:typeof game.command=async(action,params)=>{
    const said=hook(action);
    if(said!==undefined)return said;
    if(action==='spacemolt/get_skills')return {structuredContent:{skills:{}}};
    if(action==='spacemolt/get_tax_estimate')return {structuredContent:{income_tax_total:10,property_tax_total:5,tax_prepaid:3}};
    try {return await game.command(action,params);}
    catch(error) {
      if(error instanceof AssertionError&&/^Unexpected command/.test(error.message))throw new SpacemoltError('unknown_action',error.message);
      throw error;
    }
  };
  bind({account:game.account as unknown as Account,command,pilot:()=>record,emit:()=>{}});
  return game;
}
const refuse=(on:string,code='not_available')=>(action:string)=>{if(action===on)throw new SpacemoltError(code,`${action} refused`);return undefined;};
const lose=(on:string)=>(action:string)=>{if(action===on)throw new SpacemoltError('connection_closed','the socket dropped');return undefined;};
const answer=(on:string,body:unknown)=>(action:string)=>action===on?{structuredContent:body}:undefined;
const either=(...hooks:((action:string)=>unknown)[])=>(action:string)=>{for(const hook of hooks){const said=hook(action);if(said!==undefined)return said;}return undefined;};

test('orient reads everything the world answers, and names nothing missing',async()=>{
  world({mood:'Focused'});
  try {
    const out=await orient();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.missing,[]);
    assert.equal(out.detail.storage.length,1);
    assert.equal(out.detail.ships.length,1);
    assert.ok(out.detail.owes.carrier,'the carrier record rides in owes');
    assert.equal(out.detail.owes.tax?.income_tax_total,10);
    assert.ok(out.next?.includes('tax due 12 cr'),JSON.stringify(out.next));
  } finally {unbind();}
});

test('orient with a refused read and a lost reply is still done, and names each in missing',async()=>{
  world({mood:'Focused'},either(refuse('spacemolt_storage/view','not_here'),lose('spacemolt_ship/list_ships')));
  try {
    const out=await orient();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.missing,['storage','ships']);
    assert.deepEqual(out.detail.storage,[]);
    assert.match(out.did,/missing: storage, ships/);
  } finally {unbind();}
});

test('a reply that does not read is named missing, not guessed at, and the rest still reads',async()=>{
  // The live server omits spec fields; one whose fields are the wrong type is no answer.
  world({mood:'Focused'},answer('spacemolt_storage/view',{locations:'everywhere'}));
  try {
    const out=await orient();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.missing,['storage']);
    assert.equal(out.detail.ships.length,1);
  } finally {unbind();}
});

test('a bug in a read is not swallowed into missing: the orientation fails',async()=>{
  const bug=new Error('a bug in the world');
  world({mood:'Focused'},action=>{if(action==='spacemolt/get_tax_estimate')throw bug;return undefined;});
  try {
    const out=await orient();
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/a bug in the world/);
  } finally {unbind();}
});

test('orient says first that a battle holds the ship',async()=>{
  world({mood:'Focused'},answer('spacemolt_battle/status',{battle_id:'b1',tick_duration:4,
    participants:[{kind:'creature',is_npc:true,username:'Slag-Tortoise'}]}));
  try {
    const out=await orient();
    assert.match(out.did,/^IN BATTLE with Slag-Tortoise \(battle tick 4\)/);
    assert.equal(out.detail.battle?.opponent,'Slag-Tortoise');
  } finally {unbind();}
});

test('a lost battle read is no battle, and nothing else is lost',async()=>{
  world({mood:'Focused'},lose('spacemolt_battle/status'));
  try {
    const out=await orient();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.battle,undefined);
    assert.deepEqual(out.detail.missing,[]);
  } finally {unbind();}
});

test("scout's gather hint names the base the trip settles at, because gatherUntil refuses without one",async()=>{
  // The refusal that cost a live shift, and cost it twice in two files: `gatherUntil` settles the
  // take at a base and falls back to `docked_at`, so out at a POI there is none and the call is
  // `refused` with "no base to return to" before it mines anything (mining.ts). The menu row was
  // fixed on 2026-09-25; this hint kept handing over the broken shape.
  const f=world({mood:'Focused',stance:'Prospector'});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    const out=await scout();
    const gather=(out.next??[]).filter(row=>row.startsWith('gatherUntil'));
    assert.ok(gather.length,`no gather hint at all: ${JSON.stringify(out.next)}`);
    for(const hint of gather)
      assert.match(hint,/base:'[^']+'/,`a gather hint with no base, which the library refuses: ${hint}`);
  } finally {unbind();}
});

test('a system with no station gets no gather hint, because there is nowhere to settle the take',async()=>{
  // Rather than a hint that cannot run. `scout` of a far system is exactly this case: the pilot is
  // reading about somewhere it is not standing, so there is no docked base to fall back on.
  const f=world({mood:'Focused',stance:'Prospector'});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    const out=await scout('deep_range');
    for(const hint of out.next??[])
      if(hint.startsWith('gatherUntil'))
        assert.match(hint,/base:'[^']+'/,`unrunnable hint for a system the ship is not in: ${hint}`);
  } finally {unbind();}
});

test('scout of a target the game refuses is refused, naming the action and the code',async()=>{
  world({mood:'Focused'},refuse('spacemolt/find_route','target_not_found'));
  try {
    const out=await scout('nowhere');
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/spacemolt\/find_route: target_not_found/);
  } finally {unbind();}
});

test("scout of a target the route read could not place is refused with the game's own words",async()=>{
  world({mood:'Focused'},answer('spacemolt/find_route',{found:false,message:'no such place'}));
  try {
    const out=await scout('nowhere');
    assert.equal(out.status,'refused');
    assert.equal(out.why,'no such place');
    assert.equal(out.did,'could not find nowhere');
  } finally {unbind();}
});

test('scout whose system read loses its reply fails, naming the action',async()=>{
  world({mood:'Focused'},lose('spacemolt/get_system'));
  try {
    const out=await scout();
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/reply lost on spacemolt\/get_system/);
  } finally {unbind();}
});

test('scout says a map entry off the spec did not read, rather than reporting nothing as something',async()=>{
  world({mood:'Focused'},answer('spacemolt/get_map',{name:7}));
  try {
    const out=await scout('deep_range');
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/spacemolt\/get_map: reply off spec/);
  } finally {unbind();}
});

test("a refused or unreadable route quote leaves that link's fuel unquoted (NaN) and the report whole",async()=>{
  world({mood:'Focused'},refuse('spacemolt/find_route','no_route'));
  try {
    const out=await scout();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.connections.length,1);
    assert.ok(Number.isNaN(out.detail.connections[0]?.fuel));
  } finally {unbind();}
  world({mood:'Focused'},answer('spacemolt/find_route',{found:true}));
  try {
    const out=await scout();
    assert.ok(Number.isNaN(out.detail.connections[0]?.fuel),'an unreadable quote is no number');
  } finally {unbind();}
});

test('a quote that is served is the fuel on the link',async()=>{
  world({mood:'Focused'});
  try {
    const out=await scout();
    assert.equal(out.detail.connections[0]?.fuel,7);
    assert.equal(out.detail.connections[0]?.name,'Deep Range');
  } finally {unbind();}
});

test('out at a POI, a refused nearby read leaves `here` out and a refused wreck read reports no wrecks',async()=>{
  const refused=world({mood:'Focused'},refuse('spacemolt/get_nearby','no_nearby'));
  try {
    refused.account.server.location.docked_at=null;
    refused.account.server.location.poi_id='belt';
    const out=await scout();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.here,undefined);
  } finally {unbind();}
  const nowrecks=world({mood:'Focused'},refuse('spacemolt_salvage/wrecks','no_wrecks'));
  try {
    nowrecks.account.server.location.docked_at=null;
    nowrecks.account.server.location.poi_id='belt';
    const out=await scout();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.here?.wrecks.count,0);
    assert.match(out.did,/here: 0 creatures, 0 pirates, 0 wrecks/);
  } finally {unbind();}
});

test('the deposits at the POI the ship stands at are named by their resource ids, as the report promises',async()=>{
  // The location's rows say `item_id`; the report says `resource_id`. Read as the one, the hint named `undefined`.
  const f=world({mood:'Focused'});
  try {
    f.account.server.location.docked_at=null;
    f.account.server.location.poi_id='belt';
    Object.assign(f.account.server.location,{resources:[{item_id:'iron_ore',item_name:'Iron Ore',remaining:-1,richness:80}]});
    const out=await scout();
    assert.equal(out.detail.resources.belt?.[0]?.resource_id,'iron_ore');
    assert.equal(out.detail.resources.belt?.[0]?.remaining_display,'unlimited');
    assert.ok((out.next??[]).some(row=>row.startsWith('gatherUntil')&&row.endsWith('asteroid_belt: iron_ore')),JSON.stringify(out.next));
  } finally {unbind();}
});
