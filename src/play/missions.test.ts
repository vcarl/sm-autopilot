import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount} from '../readiness.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {abandonMission,completeMissions,missions} from './missions.ts';
import {bind,unbind,type Pilot} from './runtime.ts';

function world(options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargoUsed:0,cargo:[],...options});
  let who:Pilot={mood:'Focused'};
  bind({account:game.account as unknown as ReadinessAccount,command:game.command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
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
    assert.match(board.did,/stuck here: Old run \(expired\)/);
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
    assert.match(out.did,/Far run 0: .*wants deep_range/);
    assert.match(out.next[0]!,/abandonMission\('away'\)/);
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
