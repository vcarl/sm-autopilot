import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SpacemoltError,type Account} from '@spacemolt/lib';
import type {ReadinessCommand} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {readJournal} from '../run-record.ts';
import {bind,unbind} from './runtime.ts';
import {stow,storage,withdraw} from './storage.ts';

/** A bridge world whose command seam `fault` may intercept, counting what it was asked. */
function world(fault:(action:string,real:ReadinessCommand)=>ReturnType<ReadinessCommand>|undefined,options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargo:[{item_id:'ore',quantity:7}],cargoUsed:7,cargoCapacity:50,...options});
  const asked:string[]=[];
  const command:ReadinessCommand=(action,params)=>{asked.push(action);return fault(action,game.command)??game.command(action,params);};
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-storage-'));
  bind({account:game.account as unknown as Account,command,pilot:()=>({mood:'Focused'}),runtime,emit:()=>{}});
  return {...game,asked,runtime,defects:()=>readJournal(runtime).filter(row=>row.event==='defect'),close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});},count:(action:string)=>asked.filter(a=>a===action).length};
}

test('a withdraw the game refuses for a reason that is not room names the code, and is refused',async()=>{
  const f=world(action=>{if(action==='spacemolt_storage/withdraw')throw new SpacemoltError('in_battle','cannot do that in combat');return undefined;});
  try {
    const out=await withdraw([{item_id:'ore',quantity:3}]);
    assert.equal(out.status,'refused');
    assert.deepEqual(out.detail.moved,[]);
    assert.equal(out.detail.short[0]?.why,'in_battle: cannot do that in combat');
    assert.match(out.why??'',/ore: in_battle: cannot do that in combat/);
    assert.equal(f.count('spacemolt_storage/withdraw'),1,'a refusal that is not about room is not retried');
  } finally {f.close();}
});

test('a deposit whose reply is lost is sent once, and what moved is measured from the hold',async()=>{
  // The game took the ore, then the reply died: re-sending would try to move it again.
  const f=world((action,real)=>{
    if(action!=='spacemolt_storage/deposit')return undefined;
    return real(action,{item_id:'ore',quantity:7}).then(()=>{throw new SpacemoltError('mutation_timeout','No action_result');});
  });
  try {
    const out=await stow([{item_id:'ore'}]);
    assert.equal(f.count('spacemolt_storage/deposit'),1,'never re-sent');
    assert.deepEqual(out.detail.moved,[{item_id:'ore',quantity:7}]);
    assert.equal(out.status,'done',out.why);
  } finally {f.close();}
});

test('a deposit whose reply is lost and that did not land says the reply was lost, not that it did not clear',async()=>{
  const f=world(action=>{if(action==='spacemolt_storage/deposit')throw new SpacemoltError('mutation_timeout','No action_result');return undefined;});
  try {
    const out=await stow([{item_id:'ore',quantity:2}]);
    assert.equal(f.count('spacemolt_storage/deposit'),1);
    assert.equal(out.status,'refused');
    assert.equal(out.detail.short[0]?.why,'reply lost on spacemolt_storage/deposit; state re-read');
  } finally {f.close();}
});

test('reading a base the game does not know is refused, naming the code',async()=>{
  const f=world(action=>{if(action==='spacemolt_storage/view')throw new SpacemoltError('base_not_found','No such base');return undefined;});
  try {
    const out=await storage('nowhere');
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/base_not_found/);
  } finally {f.close();}
});

test('a withdraw the game refuses for size is retried once at the fitted quantity',async()=>{
  // The store's rows carry no size, so the pilot asks for 48 and the game says "Need 96 but only 75":
  // size 2, so 37 fit.
  const f=world((action,real)=>{
    if(action!=='spacemolt_storage/view')return undefined;
    return real(action,{}).then(reply=>{
      const body:{items:{size?:number}[]}=Reflect.get(Object(reply),'structuredContent');
      for(const row of body.items)delete row.size;
      return reply;
    });
  },{cargoCapacity:100,cargoUsed:25,store:[{item_id:'osmium_ore',quantity:48}]});
  try {
    const out=await withdraw([{item_id:'osmium_ore',quantity:48}]);
    assert.equal(f.count('spacemolt_storage/withdraw'),2,'one refused, one retried');
    assert.deepEqual(out.detail.moved,[{item_id:'osmium_ore',quantity:37}]);
    assert.equal(out.status,'partial');
  } finally {f.close();}
});

test('a view reply off the spec is failed, naming the action, and is not a defect',async()=>{
  const f=world(action=>action==='spacemolt_storage/view'?Promise.resolve({structuredContent:{action:'view_storage',base_id:'sol_base',hint:'',items:'nope',locations:[],ships:[]}}):undefined);
  try {
    const out=await storage();
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/spacemolt_storage\/view: reply off spec/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a dock the counter could not confirm is refused with its message, not a defect',async()=>{
  // Undocked at a POI with a station; `dock` answers OK and the ship does not dock.
  const f=world(action=>action==='spacemolt/dock'?Promise.resolve({}):undefined,{pois:[{id:'station',base_id:'sol_base'}]});
  try {
    f.account.server.location.docked_at=null;
    await f.account.refresh();
    const out=await stow([{item_id:'ore'}]);
    assert.equal(out.status,'refused');
    assert.match(out.why??'',/Dock not confirmed by a live read/);
    assert.equal(f.count('spacemolt_storage/deposit'),0);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a store re-read off the spec after a stow keeps what moved, and says the store was not re-read',async()=>{
  // The first view decodes; the one after the move does not. The ore has landed either way.
  let views=0;
  const f=world(action=>action==='spacemolt_storage/view'&&++views>1
    ?Promise.resolve({structuredContent:{action:'view_storage',base_id:'sol_base',hint:'',items:'nope',locations:[],ships:[]}}):undefined);
  try {
    const out=await stow([{item_id:'ore'}]);
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.moved,[{item_id:'ore',quantity:7}]);
    assert.match(out.why??'',/store not re-read: spacemolt_storage\/view: reply off spec/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});

test('a view reply missing fields the code does not read still stows, withdraws and reads',async()=>{
  // The live server omits spec-required fields (U12: get_base); a whole-reply decode refused real stores.
  const f=world((action,real)=>action==='spacemolt_storage/view'
    ?real(action,{}).then(reply=>{const {hint:_hint,action:_action,...rest}=(reply as {structuredContent:Record<string,unknown>}).structuredContent;return {structuredContent:rest};}):undefined);
  try {
    const read=await storage();
    assert.equal(read.status,'done',read.why);
    const stowed=await stow([{item_id:'ore'}]);
    assert.equal(stowed.status,'done',stowed.why);
    assert.deepEqual(stowed.detail.moved,[{item_id:'ore',quantity:7}]);
    assert.equal(stowed.why,undefined,'the re-read after the move decoded');
    const took=await withdraw([{item_id:'ore',quantity:3}]);
    assert.equal(took.status,'done',took.why);
    assert.deepEqual(took.detail.moved,[{item_id:'ore',quantity:3}]);
  } finally {f.close();}
});

test('a view reply missing a field the code reads is failed, naming the action',async()=>{
  const f=world(action=>action==='spacemolt_storage/view'?Promise.resolve({structuredContent:{base_id:'sol_base',items:[{quantity:3}],locations:[],ships:[]}}):undefined);
  try {
    const out=await stow([{item_id:'ore'}]);
    assert.equal(out.status,'failed');
    assert.match(out.why??'',/spacemolt_storage\/view: reply off spec/);
    assert.deepEqual(f.defects(),[]);
  } finally {f.close();}
});
