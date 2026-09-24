/** The pushes the game sends without being asked: which reach the journal, which are
 * buffered for the next wake, and what the operator reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MAX_AGE_MS,PER_TYPE,markAlertsDelivered,pendingAlerts,readAlerts,recordAlert} from './alerts.ts';
import {PUSH_PER_MINUTE,PUSH_TYPES,pushJournal,pushScalars,serve} from './bridge.ts';
import {renderLine} from './journal-lines.ts';
import type {ReadinessAccount} from './readiness.ts';
import {readJournal,watchJournal} from './run-record.ts';
import {bridgeWorld} from './test-support/bridge-world.ts';

const temp=()=>mkdtempSync(join(tmpdir(),'spacemolt-push-'));

/** An account whose pushes the test fires by hand: the whole path is driven through `on`. */
function stub() {
  const handlers=new Map<string,(payload:Record<string,unknown>)=>void>();
  return {
    on(type:string,handler:(payload:Record<string,unknown>)=>void) {handlers.set(type,handler);return ()=>{};},
    registered:()=>[...handlers.keys()],
    fire(type:string,payload:Record<string,unknown>) {
      const handler=handlers.get(type);
      assert.ok(handler,`nothing is registered for ${type}`);
      handler!(payload);
    },
  };
}

const lines=(runtime:string)=>readJournal(runtime);
const RENT={base_id:'hera_outpost',base_name:'Hera Outpost',credits_owed:4200,
  missed_cycles:2,grace_cycles:4,message:'Rent is overdue at Hera Outpost.'};

test('an allowlisted push reaches the journal as its ids and scalars, never its body', () => {
  const runtime=temp(),account=stub();
  pushJournal(account,runtime);
  account.fire('battle_alert',{battle_id:'b-7',message:'You are under attack',
    // The nested halves of the frame: a journal that took these would grow by kilobytes a line.
    participants:[{player_id:'x',ship:{hull:90}}],sides:[{side:'a'},{side:'b'}]});
  const [entry]=lines(runtime);
  assert.deepEqual(entry,{at:entry!.at,event:'push',push:'battle_alert',battle_id:'b-7',
    message:'You are under attack'});
  assert.equal(JSON.stringify(entry).includes('participants'),false,'no frame body in the journal');
  // The same discipline, isolated: every nested value is dropped and strings are clipped.
  assert.deepEqual(pushScalars({id:'x',n:3,ok:true,rows:[1,2],deep:{a:1},nothing:null,long:'y'.repeat(80)}),
    {id:'x',n:3,ok:true,long:'y'.repeat(60)});
});

test('the plumbing and the noise are never registered, so nothing double-counts', () => {
  const account=stub();
  pushJournal(account,temp());
  assert.deepEqual(account.registered(),[...PUSH_TYPES]);
  // The lib's own correlator consumes these and the command seam already journals the reply.
  for(const plumbing of ['action_result','action_error','reconnected'])
    assert.equal(account.registered().includes(plumbing),false,`${plumbing} must stay with the correlator`);
  // A frame nobody allowlisted has no handler at all: it arrives and is dropped by the lib.
  assert.equal(account.registered().includes('chat_message'),false);
  assert.equal(account.registered().includes('battle_damage'),false);
});

test('a movement nobody asked for is attributed, and the pilot\'s own is left to the command seam', () => {
  const runtime=temp(),account=stub();
  pushJournal(account,runtime);
  // Towed by a fleet leader: not an action this client can send, which is what makes the
  // attribution safe rather than a guess about timing.
  account.fire('ok',{action:'fleet_dock',base:'Hera Outpost',base_id:'hera_outpost'});
  account.fire('ok',{type:'auto_dock',message:'Docked to run that command.'});
  // The pilot's own travel, its own hunt kill notice, and a global broadcast: all already
  // accounted for, or never about this pilot.
  account.fire('ok',{action:'travel',destination:'belt_ix',arrival_tick:9001});
  account.fire('ok',{message:'You killed a drifter.'});
  account.fire('ok',{type:'new_forum_post',thread_id:'t-1',title:'patch notes'});
  // Unsolicited news that is not movement keeps the plain push line.
  account.fire('ok',{type:'shipment_overdue',shipment_id:'s-3',late_fee:120});
  assert.deepEqual(lines(runtime).map(entry=>[entry.event,entry.cause??entry.push]),
    [['unsolicited_move','fleet_dock'],['unsolicited_move','auto_dock'],['push','ok']]);
  assert.match(String(lines(runtime)[0]!.evidence),/base_id=hera_outpost/);
});

test('a chatty channel cannot flood the journal or the drain', () => {
  const runtime=temp(),account=stub();
  let ms=0;
  pushJournal(account,runtime,()=>ms);
  for(let n=0;n<PUSH_PER_MINUTE+40;n++)account.fire('mining_yield',{item_id:'iron_ore',quantity:n});
  assert.equal(lines(runtime).length,PUSH_PER_MINUTE,'the window is the ceiling');
  // The window is a minute, not a lifetime: the next one starts fresh.
  ms=60_001;
  account.fire('mining_yield',{item_id:'iron_ore',quantity:99});
  assert.equal(lines(runtime).length,PUSH_PER_MINUTE+1);
});

test('the operator reads a push as one line', () => {
  // Stamped in the reader's own local time, as every other line is.
  const at='2026-09-23T18:35:00.000Z';
  const rendered=(entry:Record<string,unknown>)=>renderLine({at,...entry})!.replace(/^\d\d:\d\d /,'');
  assert.equal(rendered({event:'push',push:'skill_level_up',skill_id:'mining',level:4}),
    'push skill_level_up skill_id=mining level=4');
  assert.equal(rendered({event:'push',push:'battle_alert',battle_id:'b-7',message:'You are under attack'}),
    'push battle_alert battle_id=b-7 — You are under attack');
  assert.equal(rendered({event:'unsolicited_move',cause:'auto_dock',evidence:'message=Docked to run that command.'}),
    'moved (auto_dock): message=Docked to run that command.');
  assert.match(renderLine({at,event:'push',push:'mining_yield'})!,/^\d\d:\d\d push mining_yield$/);
});

test('a facility alert collapses by base, keeps the latest numbers, and is delivered once', () => {
  const runtime=temp();
  recordAlert(runtime,'facility_rent_warning','base:hera_outpost',{...RENT});
  recordAlert(runtime,'facility_rent_warning','base:hera_outpost',{...RENT,missed_cycles:3});
  recordAlert(runtime,'facility_rent_warning','base:far_reach',{base_id:'far_reach',base_name:'Far Reach'});
  const waiting=pendingAlerts(runtime);
  assert.deepEqual(waiting.map(item=>[item.key,item.n,item.body.missed_cycles]),
    [['base:hera_outpost',2,3],['base:far_reach',1,undefined]],'one item a base, last write wins');
  assert.equal(waiting[0]!.first_at<=waiting[0]!.at,true,'the first sighting is kept');
  markAlertsDelivered(runtime,waiting);
  assert.deepEqual(pendingAlerts(runtime),[],'told once');
  assert.equal(readAlerts(runtime).length,2,'and still on the record');
  // A frame after the hand-over is new news, not a collapse into something already told.
  recordAlert(runtime,'facility_rent_warning','base:hera_outpost',{...RENT,missed_cycles:4});
  assert.deepEqual(pendingAlerts(runtime).map(item=>item.body.missed_cycles),[4]);
});

test('the alert buffer is bounded by count and by age, undelivered included', () => {
  const runtime=temp();
  for(let n=0;n<PER_TYPE+5;n++)
    recordAlert(runtime,'base_raid_update',`base:b${n}`,{base_id:`b${n}`});
  const kept=readAlerts(runtime);
  assert.equal(kept.length,PER_TYPE);
  assert.equal(kept.at(-1)!.key,`base:b${PER_TYPE+4}`,'the newest of a type survives the ceiling');
  // Old news is noise even unread: the journal keeps the history, the buffer keeps the deadline.
  const stale=temp();
  const then=Date.now()-MAX_AGE_MS-60_000;
  recordAlert(stale,'facility_rent_warning','base:old',{base_id:'old'},()=>new Date(then));
  assert.equal(pendingAlerts(stale).length,1);
  recordAlert(stale,'facility_reclaimed','base:new',{base_id:'new'});
  assert.deepEqual(readAlerts(stale).map(item=>item.key),['base:new']);
  // Nothing on disk is nothing to say, and a torn file is the same answer.
  assert.deepEqual(readAlerts(join(stale,'nowhere')),[]);
});

test('a push with no run in flight survives to the next juncture\'s menu call', async () => {
  const runtime=temp(),account=stub();
  pushJournal(account,runtime);
  account.fire('facility_rent_warning',RENT);
  account.fire('base_destroyed',{base_id:'far_reach',base_name:'Far Reach',attacker_id:'a-1',
    attacker_name:'Vex',owner_id:'me',system_id:'sol'});
  assert.equal(existsSync(join(runtime,'alerts.json')),true,'buffered on disk, not in a run');
  // A fresh bridge, as a restart or the next juncture would have it: one `menu` call is the
  // whole of what `juncture_context()` asks for.
  const world=bridgeWorld();
  const dispatch=serve(world.account as unknown as ReadinessAccount,world.command,
    {pilot:()=>({stance:'Prospector' as const,mood:'Focused' as const}),runtime});
  try {
    const menu=await dispatch('menu') as any;
    assert.deepEqual(menu.alerts.map((row:any)=>[row.type,row.key,row.body.base_name]),
      [['facility_rent_warning','base:hera_outpost','Hera Outpost'],
        ['base_destroyed','base:far_reach','Far Reach']]);
    assert.equal(menu.alerts[0].body.grace_cycles,4,'the deadline travels with it');
    // Handed over and stamped in the same breath: the juncture after this one is not told again.
    const again=await dispatch('menu') as any;
    assert.equal('alerts' in again,false,JSON.stringify(again.alerts));
    // The journal still has both, which is how the volume of a group gets measured.
    assert.deepEqual(lines(runtime).map(entry=>entry.push),['facility_rent_warning','base_destroyed']);
  } finally {watchJournal(null);}
});

test('the journal is written even when the alert buffer cannot be', () => {
  // `recordAlert` throwing must not cost the journal its line: the record comes first.
  const runtime=temp(),account=stub();
  pushJournal(account,runtime);
  account.fire('facility_reclaimed',{base_name:'Nameless',message:'gone'});
  assert.deepEqual(lines(runtime).map(entry=>[entry.event,entry.push]),[['push','facility_reclaimed']]);
  assert.equal(existsSync(join(runtime,'alerts.json')),false,'no base_id is no collapse key');
  assert.equal(readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').length,1);
});
