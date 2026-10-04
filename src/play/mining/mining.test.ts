import assert from 'node:assert/strict';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import {test} from 'node:test';
import {details} from '../../response-details.ts';
import type {ReadinessAccount} from '../../readiness.ts';
import {bridgeWorld} from '../../test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {gatherUntil,sellStowed,tripLabel} from './mining.ts';

test('the next move names the stowed items as a paste-able sale from the store',()=>{
  assert.deepEqual(sellStowed([{item_id:'aluminum_ore',quantity:112},{item_id:'iridium_ore',quantity:8}]),
    ["sell([{item_id:'aluminum_ore',quantity:112}, {item_id:'iridium_ore',quantity:8}], {from:'store'})"]);
  assert.deepEqual(sellStowed([]),[]);
});

test('a trip cap is named whenever it was passed, because maxTrips is now honored without until',()=>{
  // The live pilot's own index.ts calls `gatherUntil({poi, then:'sell', maxTrips: loops})` with no
  // `until` and expected `loops` trips (report: maxTrips:2 with no until made only one trip). The
  // label now names the cap whenever it was asked for, whether or not `until` is also given.
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3}),'belt → sol_base ≤3 trips');
  assert.equal(tripLabel({poi:'belt',maxTrips:3,then:'sell'}),'belt ≤3 trips then sell');
  assert.equal(tripLabel({poi:'belt',base:'sol_base',maxTrips:3,until:{item:'ore',quantity:99}}),
    'belt → sol_base until ore ≥ 99 ≤3 trips');
  // And the default cap is not invented into the label when it was not asked for.
  assert.equal(tripLabel({poi:'belt',until:{item:'ore',quantity:99}}),'belt until ore ≥ 99');
  assert.equal(tripLabel({poi:'belt',base:'sol_base'}),'belt → sol_base');
});

test("then:'sell': a sell that broke settles nothing, not a crash",async()=>{
  // A broken sell's detail is `{}`: gatherUntil read `sold.detail.fills.map` off it and crashed.
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0});
  const who:Pilot={mood:'Focused'};
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt_market/view_market')throw new Error('socket gone');
    return game.command(action,params);
  };
  bind({account:game.account as unknown as Account,command,pilot:()=>who,emit:()=>{}});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',maxTrips:1,then:'sell'});
    assert.equal(out.detail.trips,1,JSON.stringify(out));
    assert.deepEqual(out.detail.settled,[]);
  } finally {unbind();}
});

test('maxTrips with no until still makes that many trips (regression for the report: maxTrips:2 made one)',async()=>{
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0});
  const who:Pilot={mood:'Focused'};
  bind({account:game.account as unknown as Account,command:game.command,pilot:()=>who,emit:()=>{}});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',maxTrips:2});
    assert.equal(out.detail.trips,2,JSON.stringify(out));
    // Each trip mines, comes home and stows: two trips means two settle/mine cycles ran.
    assert.equal(game.count('spacemolt/mine')>=2,true,'at least one mine call per trip');
    assert.equal(game.count('spacemolt/dock'),2,'one dock per return leg, one per trip');
  } finally {unbind();}
});

/** A world whose commands the game refuses on demand: `before` sees each action and its params and throws as the lib does. */
function world(before:(action:string,params:Record<string,unknown>)=>void,options:Parameters<typeof bridgeWorld>[0]={},
  answer:(action:string,params:Record<string,unknown>,reply:unknown)=>unknown=(_a,_p,reply)=>reply) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  const command:typeof game.command=async(action,params)=>{before(action,params??{});return answer(action,params??{},await game.command(action,params));};
  bind({account:game.account as unknown as Account,command,pilot:()=>({mood:'Focused'}),emit:text=>lines.push(text)});
  return {...game,lines};
}

test('a refusal on the mine leg reaches the outcome as its status, naming the game\'s code and message',async()=>{
  world(action=>{if(action==='spacemolt/mine')throw new SpacemoltError('no_mining','No mining equipment');});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base'});
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why??'',/no_mining: No mining equipment/);
  } finally {unbind();}
});

test('a refused read of the store before a trip ends the run refused, naming the action and the code',async()=>{
  const f=world((action,params)=>{if(action==='spacemolt_storage/view'&&params.station_id)throw new SpacemoltError('no_storage','no storage at this station');});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',until:{item:'ore',quantity:400}});
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why??'',/spacemolt_storage\/view: no_storage — no storage at this station/);
    assert.equal(f.count('spacemolt/mine'),0,'nothing was mined on a store that could not be read');
  } finally {unbind();}
});

test('a poi that is not a place is refused with the travel refusal, not failed',async()=>{
  world(()=>{});
  try {
    const out=await gatherUntil({poi:'nowhere',base:'sol_base'});
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why??'',/nowhere/);
  } finally {unbind();}
});

test('a refused re-read of the store after the trip leaves held as the first read had it, and says so',async()=>{
  let reads=0;
  const f=world((action,params)=>{if(action==='spacemolt_storage/view'&&params.station_id&&++reads>1)throw new SpacemoltError('no_storage','no storage at this station');});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',until:{item:'ore',quantity:400},maxTrips:1});
    assert.equal(out.detail.trips,1,JSON.stringify(out));
    assert.equal(out.detail.held,340,'the failed re-read does not change what the first read saw');
    assert.ok(f.lines.some(line=>/the re-read failed \(spacemolt_storage\/view: no_storage — no storage at this station\)/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

/** The store's answer to a read of a named station, with `rows` as its items: what the live server may send. */
const storeRows=(rows:unknown[])=>(action:string,params:Record<string,unknown>,reply:unknown)=>
  action==='spacemolt_storage/view'&&params.station_id?{structuredContent:{...details(reply),items:rows}}:reply;

test('a count of the item asked for that does not read is unknown: held is left unset, not written as 0',async()=>{
  const f=world(()=>{},{},storeRows([{item_id:'ore',quantity:'lots'}]));
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',until:{item:'ore',quantity:400},maxTrips:1});
    assert.equal(out.detail.trips,1,JSON.stringify(out));
    assert.equal(out.detail.held,undefined);
    assert.ok(f.lines.some(line=>/store sol_base ore not read/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

test('a store row that does not read is left out and named; the rows that read are still counted',async()=>{
  const f=world(()=>{},{},storeRows([{item_id:'ore',quantity:340},{item_id:'scrap',quantity:'x'},{item_id:'ore',quantity:5}]));
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',until:{item:'ore',quantity:400},maxTrips:1});
    assert.equal(out.detail.held,345,JSON.stringify(out));
    assert.ok(f.lines.some(line=>/an items row \(scrap\) did not read; left out/.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

test('a sale whose book read is refused (folded with an empty detail) settles nothing and is not a crash',async()=>{
  // `sell` does not catch a refused book read, so the runtime folds it with `{}` as its detail: no `fills`.
  const f=world((action)=>{if(action==='spacemolt_market/view_market')throw new SpacemoltError('no_market','no market here');});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',then:'sell'});
    assert.doesNotMatch(out.why??'',/Cannot read|undefined/,JSON.stringify(out));
    assert.deepEqual(out.detail.settled,[]);
    assert.ok(f.lines.some(line=>/sell (refused|failed): /.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});

test('a sale the game refuses settles nothing, is named in the stream, and is not a crash',async()=>{
  const f=world((action)=>{if(action==='spacemolt/sell')throw new SpacemoltError('no_market','no market here');});
  try {
    const out=await gatherUntil({poi:'belt',base:'sol_base',then:'sell'});
    assert.doesNotMatch(out.why??'',/Cannot read|undefined/,JSON.stringify(out));
    assert.deepEqual(out.detail.settled,[]);
    assert.ok(f.lines.some(line=>/sell (refused|failed): /.test(line)),f.lines.join('\n'));
  } finally {unbind();}
});
