import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import type {ReadinessAccount} from '../../readiness.ts';
import {readJournal} from '../../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../../test-support/bridge-world.ts';
import {bind,stop,unbind,type Pilot} from '../runtime.ts';
import {freightBoard,haul} from './freight.ts';
import {carryPassengers} from './passengers.ts';

function world(record:Pilot,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const lines:string[]=[];
  let who:Pilot=record;
  bind({account:game.account as unknown as Account,command:game.command,
    pilot:()=>who,emit:text=>lines.push(text)});
  return {...game,lines,record:()=>who};
}
// A near package the tier admits, and a fat one it does not.
const cheap={id:'s1',destination_base_id:'range_base',base_reward:1_200,reserved_exposure:2_000};
const fat={id:'s2',destination_base_id:'range_base',base_reward:9_000,reserved_exposure:40_000};
const hold={cargoCapacity:125,cargoUsed:0,cargo:[]};

test('freightBoard drops the listing the tier will not insure and ranks the rest by net per fuel',async()=>{
  const f=world({mood:'Focused'},{...hold,shipping:{listings:[cheap,fat]}});
  try {
    const out=await freightBoard();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.listings.map(row=>row.contract.id),['s1'],'40,000 is over the 5,000 per-package limit');
    const row=out.detail.listings[0]!;
    assert.equal(row.fuel,7);
    assert.equal(row.liability,2_000);
    assert.equal(row.net,1_200-7,'reward less the fuel bill at fuel_price_all_in 1');
    assert.equal(row.fits,true);
    assert.equal(row.reachable,true,'7 fuel plus the Focused reserve of 24 is inside a 100 tank');
    assert.equal(out.detail.profile.profile.tier,'probationary');
    assert.match(out.next[0]!,/haul\('s1'\)/);
  } finally {unbind();}
});

test('freightBoard fails (does not silently mark unroutable) on a real find_route error, e.g. a dropped connection',async()=>{
  // `route`'s per-listing fuel quote swallows `TravelBlocked` ("not a place") and marks the
  // listing unroutable; anything else — a socket drop, a real server error — must surface as
  // `failed` instead of quietly ranking the listing last.
  const game=bridgeWorld({services:['refuel','repair','storage'],...hold,shipping:{listings:[cheap]}});
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt/find_route')throw new Error('cannot send on a closed socket');
    return game.command(action,params);
  };
  bind({account:game.account as unknown as Account,command,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  try {
    const out=await freightBoard();
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/cannot send on a closed socket/);
  } finally {unbind();}
});

test('haul refuses on cargo before anything is sent, naming the numbers',async()=>{
  const f=world({mood:'Focused'},{cargoUsed:0,shipping:{listings:[cheap]}});
  try {
    const out=await haul('s1');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/needs 100 cargo; the hold has 12 free of 12/);
    assert.equal(f.count('spacemolt_shipping/accept'),0,'nothing was accepted');
    assert.equal(f.count('spacemolt_shipping/profile'),0,'the fit is checked before the carrier record is read');
  } finally {unbind();}
});

test('haul accepts, withdraws the package, flies and delivers',async()=>{
  const f=world({mood:'Focused'},{...hold,shipping:{listings:[cheap]}});
  try {
    const out=await haul('s1');
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.leg,'delivered');
    assert.equal(out.detail.settlement?.carrier_payout,1_200);
    assert.equal(out.gained.credits,1_200);
    assert.equal(out.detail.profile_after.successful_deliveries,1);
    assert.equal(f.count('spacemolt_shipping/accept'),1);
    assert.equal(f.count('spacemolt_storage/withdraw'),1,'the package is not aboard until it is withdrawn');
    assert.equal(out.now.location.docked_at,'range_base');
    assert.deepEqual(f.store.filter(row=>row.item_id.startsWith('package:')),[],'the package left the store');
    assert.ok(f.lines.some(line=>/package:pkg_s1 aboard/.test(line)),'a line per leg');
  } finally {unbind();}
});

test('haul re-entered with the package already aboard skips the accept and the withdraw',async()=>{
  const f=world({mood:'Focused'},
    {cargoCapacity:125,cargoUsed:100,cargo:[{item_id:'package:pkg_s1',quantity:1}],
      shipping:{listings:[cheap],accepted:['s1']}});
  try {
    const out=await haul('s1');
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt_shipping/accept'),0,'the contract was already active');
    assert.equal(f.count('spacemolt_storage/withdraw'),0,'the package was already aboard');
    assert.equal(f.count('spacemolt_shipping/deliver'),1);
    assert.ok(f.lines.some(line=>/s1 is already active/.test(line)));
  } finally {unbind();}
});

test('carryPassengers lands only the passengers whose destination is this stop',async()=>{
  const f=world({mood:'Focused'},{passengers:{berths:{economy:4,first:2},
    waiting:[{citizen_id:'p1',name:'Ari',class:'first',destination:'range_base',estimated_fare:900},
      {citizen_id:'p2',name:'Bel',destination:'range_base',estimated_fare:200},
      {citizen_id:'p3',name:'Cyn',destination:'sol_base',estimated_fare:150}],
    onboard:[{citizen_id:'p0',name:'Dov',destination:'far_base'}]}});
  try {
    const out=await carryPassengers('range_base');
    assert.equal(out.status,'partial',out.why);
    assert.deepEqual(out.detail.loaded.map(row=>row.citizen_id),['p1','p2'],'p3 is bound elsewhere and stays');
    assert.equal(out.detail.loaded[0]!.class,'first','first class first');
    assert.deepEqual(out.detail.landed.map(stop=>stop.base_id),['range_base']);
    assert.deepEqual(out.detail.landed[0]!.unloaded.map(off=>'name' in off?off.name:''),['Ari','Bel']);
    assert.deepEqual(out.detail.aboard.map(row=>row.citizen_id),['p0'],'the passenger for far_base is not put off here');
    assert.equal(out.gained.credits,1_100);
    const unloads=f.sent.filter(call=>call.action==='spacemolt/unload_passenger');
    assert.deepEqual(unloads.map(call=>call.params.id),['p1','p2'],'never the literal `all`');
    assert.match(out.why!,/Dov → far_base/);
  } finally {unbind();}
});

test('nothing waiting is done, not refused',async()=>{
  const f=world({mood:'Focused'},{passengers:{berths:{economy:4}}});
  try {
    const out=await carryPassengers();
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/nothing waiting/);
    assert.equal(f.count('spacemolt/load_passenger'),0);
  } finally {unbind();}
});

/** What a world does with one command: answer it, refuse it, or carry it out and lose the reply. */
type Act=(action:string,params:Record<string,unknown>|undefined,perform:()=>Promise<unknown>)=>Promise<unknown>;
/** `lose` carries `action` out and loses the reply; `refuse` raises the server's refusal with its code. */
const lose=(action:string):Act=>async(name,params,perform)=>{
  const reply=await perform();
  if(name===action)throw new SpacemoltError('mutation_timeout','no reply in time');
  return reply;
};
const refuse=(action:string,code:string):Act=>async(name,params,perform)=>{
  if(name===action)throw new SpacemoltError(code,`the game said ${code}`);
  return perform();
};
/** A world bound to a temporary runtime, so its journal can be read for defects. */
function rig(options:WorldOptions,act:Act) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-hauling-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,...options});
  const asked:string[]=[];
  const command:typeof game.command=async(action,params)=>{asked.push(action);return act(action,params,()=>game.command(action,params));};
  bind({account:game.account as unknown as Account,command,runtime,pilot:():Pilot=>({mood:'Focused'}),emit:()=>{}});
  // Counted as asked, so a send the world refused or never received still counts.
  return {...game,count:(action:string)=>asked.filter(name=>name===action).length,defects:()=>readJournal(runtime).filter(row=>row.event==='defect'),
    close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const second={...cheap,id:'s3'};
const riders={passengers:{berths:{economy:4,first:2},
  waiting:[{citizen_id:'p1',name:'Ari',class:'first',destination:'range_base',estimated_fare:900},
    {citizen_id:'p2',name:'Bel',destination:'range_base',estimated_fare:200}]}};

test('a refused accept ends refused with the server\'s code, and nothing is sent past it',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},refuse('spacemolt_shipping/accept','liability_exceeded'));
  try {
    const out=await haul('s1');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt_shipping\/accept: liability_exceeded/);
    assert.equal(f.count('spacemolt_shipping/accept'),1,'a refusal is not retried');
    assert.equal(f.count('spacemolt_storage/withdraw')+f.count('spacemolt_shipping/deliver'),0);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a refused contract read is refused with its code, not a failed haul',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},refuse('spacemolt_shipping/get','not_found'));
  try {
    const out=await haul('s1');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt_shipping\/get: not_found/);
  } finally {f.close();}
});

test('an accept whose reply is lost is never re-sent: the active list says it landed, and the haul goes on',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},lose('spacemolt_shipping/accept'));
  try {
    const out=await haul('s1');
    assert.equal(out.status,'done',`${out.did}: ${out.why}`);
    assert.equal(f.count('spacemolt_shipping/accept'),1,'a mutation whose reply is lost is never re-sent');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('an accept whose reply is lost and that did not land fails naming the lost reply, and is not re-sent',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},async(name,params,perform)=>{
    if(name==='spacemolt_shipping/accept')throw new SpacemoltError('mutation_timeout','no reply in time');
    return perform();
  });
  try {
    const out=await haul('s1');
    assert.equal(out.status,'failed',JSON.stringify(out));
    assert.match(out.why!,/reply lost on spacemolt_shipping\/accept/);
    assert.equal(f.count('spacemolt_shipping/accept'),1);
    assert.equal(f.count('spacemolt_storage/withdraw'),0,'nothing was fetched for a contract that may not exist');
  } finally {f.close();}
});

test('a delivery whose reply is lost is partial, never done and never re-sent',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},lose('spacemolt_shipping/deliver'));
  try {
    const out=await haul('s1');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why!,/reply lost on spacemolt_shipping\/deliver; the contract is no longer active, so it may have settled/);
    assert.equal(f.count('spacemolt_shipping/deliver'),1,'a delivery that may have landed is not sent twice');
    assert.equal(out.detail.leg,'loaded');
    assert.equal(out.detail.settlement,undefined,'no settlement is claimed');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a refused delivery ends refused with the server\'s code',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},refuse('spacemolt_shipping/deliver','not_at_destination'));
  try {
    const out=await haul('s1');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt_shipping\/deliver: not_at_destination/);
  } finally {f.close();}
});

test('a pilot stop mid-board ends partial and is not a defect',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap,second]}},async(name,params,perform)=>{
    if(name==='spacemolt/find_route')stop();
    return perform();
  });
  try {
    const out=await freightBoard();
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why??'',/stopped by pilot/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a pilot stop mid-flight leaves the haul partial with the contract kept, and is not a defect',async()=>{
  const f=rig({...hold,shipping:{listings:[cheap]}},async(name,params,perform)=>{
    if(name==='spacemolt/jump')stop();
    return perform();
  });
  try {
    const out=await haul('s1');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.equal(f.count('spacemolt_shipping/deliver'),0);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a find_route the game refuses fails the board with its code; "not a place" only marks that listing unroutable',async()=>{
  const slow=rig({...hold,shipping:{listings:[cheap]}},refuse('spacemolt/find_route','rate_limited'));
  try {
    const out=await freightBoard();
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt\/find_route: rate_limited/);
  } finally {slow.close();}
  const unknown=rig({...hold,shipping:{listings:[cheap]}},async(name,params,perform)=>{
    if(name==='spacemolt/find_route')throw new SpacemoltError('not_found','Target system not found');
    return perform();
  });
  try {
    const out=await freightBoard();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.listings[0]!.reachable,false);
    assert.equal(out.detail.listings[0]!.fuel,Infinity);
  } finally {unknown.close();}
});

test('a passenger boarding the game refuses ends refused with its code, and flies nobody',async()=>{
  const f=rig(riders,refuse('spacemolt/load_passenger','berths_full'));
  try {
    const out=await carryPassengers('range_base');
    assert.equal(out.status,'refused',JSON.stringify(out));
    assert.match(out.why!,/spacemolt\/load_passenger: berths_full/);
    assert.equal(f.count('spacemolt/jump'),0);
  } finally {f.close();}
});

test('a boarding whose reply is lost is never re-sent: the manifest says who boarded, and the trip goes on',async()=>{
  const f=rig(riders,lose('spacemolt/load_passenger'));
  try {
    const out=await carryPassengers('range_base');
    assert.equal(out.status,'done',`${out.did}: ${out.why}`);
    assert.equal(f.count('spacemolt/load_passenger'),1);
    assert.deepEqual(out.detail.loaded.map(row=>row.citizen_id),['p1','p2']);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('an unload whose reply is lost is partial, never claimed done and never re-sent',async()=>{
  const f=rig(riders,lose('spacemolt/unload_passenger'));
  try {
    const out=await carryPassengers('range_base');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why!,/reply lost on spacemolt\/unload_passenger for Ari, Bel: they may have landed/);
    assert.equal(f.count('spacemolt/unload_passenger'),2,'once per rider, never twice');
    assert.deepEqual(out.detail.landed,[]);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a pilot stop mid-landing ends partial and is not a defect',async()=>{
  const f=rig(riders,async(name,params,perform)=>{
    if(name==='spacemolt/unload_passenger')stop();
    return perform();
  });
  try {
    const out=await carryPassengers('range_base');
    assert.equal(out.status,'partial',JSON.stringify(out));
    assert.match(out.why??'',/stopped by pilot/);
    assert.equal(f.count('spacemolt/unload_passenger'),1,'the second rider is not landed after the stop');
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});
