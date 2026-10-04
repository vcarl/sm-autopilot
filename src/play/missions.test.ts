import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readJournal} from '../run-record.ts';
import {abandonMission,acceptMission,completeMissions,missions} from './missions.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

type Wrap=(action:string,send:()=>Promise<unknown>)=>Promise<unknown>;
function world(options:WorldOptions={},wrap?:Wrap) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,cargo:[],...options});
  let who:Pilot={mood:'Focused'};
  bind({account:game.account as unknown as Account,command:wrap?(action,params)=>wrap(action,()=>game.command(action,params)):game.command,
    pilot:()=>who,emit:()=>{}});
  return game;
}
/** One active mission as `get_active_missions` lists it, with the objective's progress row. */
const row=(over:Record<string,unknown>={})=>({mission_id:'a1',title:'Deliver ore',type:'delivery',
  description:'',difficulty:1,accepted_at:'',issuing_base:'sol_base',expires_in_ticks:100,
  percent_complete:0,rewards:{credits:1_000},
  objectives:[{description:'20 ore to Sol Base',item_id:'ore',item_name:'ore',type:'deliver',
    current:0,required:20,completed:false,in_cargo:0,in_storage:340,target_base:'sol_base'}],...over});

test('an expired mission is reported stuck, and abandonMission frees the slot',async()=>{
  const f=world();
  try {
    f.taken.push(row({mission_id:'dead',title:'Old run',expires_in_ticks:0}));
    const board=await missions();
    assert.equal(board.status,'done',board.why);
    const seen=board.detail.active.find(m=>m.mission_id==='dead')!;
    assert.equal(seen.stuck,'expired');
    assert.equal(seen.progress,'0/20 ore');
    assert.match(board.did,/Held: Old run — next: expired/);
    const out=await abandonMission('dead');
    assert.equal(out.status,'done',out.why);
    assert.match(out.did,/abandoned "Old run" \(expired\); 0 of 5 active, 5 slot\(s\) free/);
    assert.equal(f.taken.length,0);
    // Idempotent: the end state already holds, so nothing is sent a second time.
    const again=await abandonMission('dead');
    assert.equal(again.status,'done');
    assert.equal(f.count('spacemolt/abandon_mission'),1);
  } finally {unbind();}
});

test('completeMissions withdraws from the store here and turns the mission in',async()=>{
  const f=world({cargoCapacity:40});
  try {
    f.taken.push(row());
    const out=await completeMissions();
    assert.equal(out.status,'done',out.why);
    assert.equal(f.count('spacemolt_storage/withdraw'),1,'the ore is not aboard until it is withdrawn');
    assert.match(out.did,/withdrew 20 ore from the store here/);
    assert.match(out.did,/completed for 1000 cr/);
    assert.equal(out.detail.completed.length,1);
    assert.equal(f.taken.length,0,'the slot is free');
    assert.equal(f.store.find(r=>r.item_id==='ore')!.quantity,320);
  } finally {unbind();}
});

test('abandonMission refuses a completable mission unless forced',async()=>{
  const f=world();
  try {
    f.taken.push(row({mission_id:'ready',title:'Paid run',percent_complete:100}));
    const out=await abandonMission('ready');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/completable here/);
    assert.equal(f.count('spacemolt/abandon_mission'),0,'nothing was sent');
    const forced=await abandonMission('ready',{force:true});
    assert.equal(forced.status,'done',forced.why);
    assert.equal(f.taken.length,0);
  } finally {unbind();}
});

// Live 2026-10-04 (kvothe 22:02Z, run 8389807d): a five-stop circuit flown out of order into the run cap.
test('a mission with several objectives leads with the first one not completed',async()=>{
  const f=world();
  try {
    const stop=(n:number,completed:boolean)=>({description:`Visit capital ${n}`,type:'visit',current:completed?1:0,required:1,completed,target_base:`capital_${n}`});
    f.taken.push(row({title:'Five Capitals',objectives:[stop(1,true),stop(2,false),stop(3,false)]}));
    const board=await missions();
    assert.equal(board.detail.active[0]!.next,'Visit capital 2 → capital_2 [2 of 3]');
    assert.equal(Object.keys(board.detail.active[0]!)[0],'next');
    assert.match(board.did,/Held: Five Capitals — next: Visit capital 2 → capital_2 \[2 of 3\]$/);
  } finally {unbind();}
});

test('a mission whose goods are elsewhere is stuck, and the store cannot unstick it',async()=>{
  const f=world();
  try {
    // Five of them: a full board, which is the only time abandoning is the way forward.
    for(let n=0;n<5;n++)f.taken.push(row({mission_id:n?`away${n}`:'away',title:`Far run ${n}`,
      objectives:[{description:'20 ore to Deep Range',item_id:'ore',type:'deliver',
        current:0,required:20,completed:false,in_cargo:0,in_storage:0,target_base:'deep_range'}]}));
    const board=await missions();
    assert.equal(board.detail.slots_free,0);
    assert.match(board.detail.active[0]!.stuck!,/wants deep_range; docked at sol_base/);
    const out=await completeMissions();
    assert.equal(f.count('spacemolt_storage/withdraw'),0);
    assert.match(out.why!,/^Far run 0 — next: 20 ore to Deep Range \(0\/20\) → deep_range;/);
    assert.match(out.next[0]!,/abandonMission\('away'\)/);
  } finally {unbind();}
});

test('completing nothing is refused, not done: "missions done" must not carry forward',async()=>{
  const f=world();
  try {
    f.taken.push(row({objectives:[{description:'20 ore to Sol Base',item_id:'ore',item_name:'ore',
      type:'deliver',current:0,required:20,completed:false,in_cargo:0,in_storage:0,target_base:'sol_base'}]}));
    const out=await completeMissions();
    assert.equal(out.status,'refused');
    assert.match(out.did,/^nothing completable/);
    assert.equal(out.why,'Deliver ore — next: 20 ore to Sol Base (0/20) → sol_base');
    assert.equal(out.detail.completed.length,0);
  } finally {unbind();}
});

test('abandonMission refuses an id the account never had, and stays idempotent for a real one',async()=>{
  const f=world();
  try {
    f.taken.push(row({mission_id:'gone',title:'Old run',expires_in_ticks:0}));
    assert.equal((await abandonMission('gone')).status,'done');
    // Genuinely gone: seen active, now abandoned, so the end state already holds.
    assert.equal((await abandonMission('gone')).status,'done');
    const out=await abandonMission('??');
    assert.equal(out.status,'refused','a placeholder id is not a success');
    assert.match(out.why!,/never active on this account/);
    assert.equal(f.count('spacemolt/abandon_mission'),1,'nothing was sent for the unknown id');
  } finally {unbind();}
});

// Live 2026-09-28 (kvothe): an accept of a mission already held read as a plain `done` in the
// journal, and the Trade Run that expired at 09:47Z left no line at all.
test('the journal says when an accept found the mission already active, and when one seen active expires',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-missions-'));
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,cargo:[]});
  bind({account:game.account as unknown as Account,command:game.command,pilot:()=>({mood:'Focused'}),runtime,emit:()=>{}});
  const events=()=>readJournal(runtime).filter(e=>e.event==='mission').map(e=>[e.verb,e.mission_id]);
  try {
    game.taken.push(row({mission_id:'held',title:'Held run'}),row({mission_id:'late',title:'Trade Run',expires_in_ticks:100}));
    const again=await acceptMission('held');
    assert.equal(again.status,'done','an accept that already holds is not a refusal');
    assert.deepEqual(events(),[['already_active','held']]);
    // Seen active above; now past its deadline, the way `get_active_missions` shows it.
    game.taken.splice(1,1,row({mission_id:'late',title:'Trade Run',expires_in_ticks:0}));
    await missions();
    await missions();
    assert.deepEqual(events(),[['already_active','held'],['expired','late']],'said once');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

/** What a wrapped command was asked: the actions a world's server saw the pilot send. */
const sentCount=(sent:string[],action:string)=>sent.filter(a=>a===action).length;

test('an accept the server refuses is refused, naming the action and the code, and sent once',async()=>{
  const sent:string[]=[];
  const f=world({},async(action,send)=>{
    sent.push(action);
    if(action==='spacemolt/accept_mission')throw new SpacemoltError('mission_unavailable','Another pilot took it.');
    return send();
  });
  try {
    const out=await acceptMission('m1');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/spacemolt\/accept_mission: mission_unavailable — Another pilot took it\./);
    assert.equal(sentCount(sent,'spacemolt/accept_mission'),1);
    assert.equal(f.taken.length,0);
  } finally {unbind();}
});

test('an accept whose reply is lost is failed, says so, and is never re-sent',async()=>{
  for(const lost of [new ConnectionClosedError('closed'),new SpacemoltError('mutation_timeout','no result')]) {
    const sent:string[]=[];
    world({},async(action,send)=>{
      sent.push(action);
      if(action==='spacemolt/accept_mission')throw lost;
      return send();
    });
    try {
      const out=await acceptMission('m1');
      assert.equal(out.status,'failed');
      assert.match(out.why!,/reply lost on spacemolt\/accept_mission; state re-read/);
      assert.equal(sentCount(sent,'spacemolt/accept_mission'),1,'a mutation is sent once');
    } finally {unbind();}
  }
});

test('an abandon the server refuses is refused with its code; a lost reply is failed and not re-sent',async()=>{
  const sent:string[]=[];
  let fail:Error=new SpacemoltError('mission_not_found','No active mission a1');
  const f=world({},async(action,send)=>{
    sent.push(action);
    if(action==='spacemolt/abandon_mission')throw fail;
    return send();
  });
  try {
    f.taken.push(row());
    const refused=await abandonMission('a1');
    assert.equal(refused.status,'refused');
    assert.match(refused.why!,/spacemolt\/abandon_mission: mission_not_found — No active mission a1/);
    fail=new SpacemoltError('mutation_timeout','no result');
    const lost=await abandonMission('a1');
    assert.equal(lost.status,'failed');
    assert.match(lost.why!,/reply lost on spacemolt\/abandon_mission; state re-read/);
    assert.equal(sentCount(sent,'spacemolt/abandon_mission'),2,'one send per call, never a re-send');
  } finally {unbind();}
});

// The world's own server refuses a complete whose objectives are unmet (`mission_incomplete`), even when the
// board says 100%: the loop names that mission's code and carries on.
test('completeMissions names the server\'s refusal of one mission and still turns in the next',async()=>{
  const sent:string[]=[];
  const f=world({},async(action,send)=>{sent.push(action);return send();});
  try {
    f.taken.push(row({mission_id:'unmet',title:'Not yet',percent_complete:100}),
      row({mission_id:'paid',title:'Paid run',percent_complete:100,objectives:[]}));
    const out=await completeMissions();
    assert.equal(out.status,'partial');
    assert.match(out.why!,/unmet: mission_incomplete — Objective not met: 20 ore to Sol Base/);
    assert.match(out.did,/completed 1 mission\(s\) for 1000 cr/);
    assert.equal(sentCount(sent,'spacemolt/complete_mission'),2);
  } finally {unbind();}
});

test('completeMissions with a refused complete only is refused, naming the code',async()=>{
  const f=world();
  try {
    f.taken.push(row({percent_complete:100}));
    const out=await completeMissions();
    assert.equal(out.status,'refused');
    assert.match(out.why!,/a1: mission_incomplete — Objective not met/);
    assert.equal(out.detail.completed.length,0);
  } finally {unbind();}
});

test('a complete whose reply is lost is not re-sent, and the re-read says the mission is gone',async()=>{
  const sent:string[]=[];
  const f=world({},async(action,send)=>{
    sent.push(action);
    const reply=await send();
    if(action==='spacemolt/complete_mission')throw new SpacemoltError('mutation_timeout','no result');
    return reply;
  });
  try {
    f.taken.push(row({percent_complete:100,objectives:[]}));
    const out=await completeMissions();
    assert.equal(out.status,'failed','a lost reply stays failed, whatever else the loop saw');
    assert.match(out.why!,/a1: reply lost on spacemolt\/complete_mission; state re-read; no longer active/);
    assert.equal(sentCount(sent,'spacemolt/complete_mission'),1);
    assert.equal(f.taken.length,0,'it did land');
  } finally {unbind();}
});

test('a mission row whose read field is malformed is left out of the count; one merely missing fields still counts',async()=>{
  const f=world();
  try {
    f.taken.push(row({mission_id:'ok'}),{mission_id:'bare',percent_complete:0},{mission_id:'broken',title:'Bad ticks',expires_in_ticks:'soon'});
    const board=await missions();
    assert.equal(board.status,'done',board.why);
    assert.deepEqual(board.detail.active.map(m=>m.mission_id),['ok','bare']);
  } finally {unbind();}
});

test('a board row with no title or type is still listed and can still be accepted',async()=>{
  const sent:string[]=[];
  world({},async(action,send)=>{
    sent.push(action);
    if(action==='spacemolt/accept_mission')return {structuredContent:{mission_id:'bare'}};
    if(action!=='spacemolt/get_missions')return send();
    return {structuredContent:{missions:[{mission_id:'bare',objectives:[{item_id:'ore',quantity:5,description:'5 ore'}],rewards:{credits:700}}]}};
  });
  try {
    const board=await missions();
    assert.equal(board.detail.board.length,1);
    assert.match(board.next[0]!,/acceptMission\('bare'\) — bare, 700 cr/);
    const out=await acceptMission('bare');
    assert.match(out.did,/^accepted "bare": 700 cr/);
    assert.notEqual(out.why,'not on the board here');
    assert.equal(sentCount(sent,'spacemolt/accept_mission'),1);
  } finally {unbind();}
});

test('a withdraw that only partly finished is said as that, and the complete is still sent once',async()=>{
  const sent:string[]=[];
  // The hold has room for 12 of the 20: the withdraw comes back partial, and the complete the server then refuses is still sent.
  const f=world({cargoCapacity:12},async(action,send)=>{sent.push(action);return send();});
  try {
    f.taken.push(row());
    const out=await completeMissions();
    assert.doesNotMatch(out.did,/withdrew 20 ore/);
    assert.match(out.did,/Deliver ore: withdraw partial: /);
    assert.equal(sentCount(sent,'spacemolt_storage/withdraw'),1,'one withdraw');
    assert.equal(sentCount(sent,'spacemolt/complete_mission'),1);
  } finally {unbind();}
});
