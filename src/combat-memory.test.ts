/** The combat memory: the battle frames the runner used to drop, folded into the numbers that
 * decide whether to take the next fight — and `player_died` reaching the buffer the pilot reads. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pendingAlerts} from './alerts.ts';
import {pushJournal} from './bridge.ts';
import {CAP,THIN,TICK_MS,combatLine,readCombat,resetCombatFold,statsFor,writeFight,
  type FightRecord} from './combat-memory.ts';
import {readJournal} from './run-record.ts';

const temp=()=>mkdtempSync(join(tmpdir(),'spacemolt-combat-'));

/** An account whose pushes the test fires by hand, as `push-journal.test.ts` does, plus the
 * identity the damage frames are attributed by: `attacker_id`/`target_id` name hulls, and
 * without knowing which one is ours a shot belongs to neither direction. */
function stub(id='me',currentTick=41_208) {
  const handlers=new Map<string,(payload:Record<string,unknown>)=>void>();
  return {player:{id},currentTick,
    on(type:string,handler:(payload:Record<string,unknown>)=>void) {handlers.set(type,handler);return ()=>{};},
    fire(type:string,payload:Record<string,unknown>) {
      const handler=handlers.get(type);
      assert.ok(handler,`nothing is registered for ${type}`);
      handler!(payload);
    }};
}

/** One fight against a Slag-Tortoise: two ticks at `inner`, one at `outer` after backing off.
 * Their shots at us: 3 of 4 hit at inner, 1 of 3 at outer. Ours at them: 2 of 3 at inner. */
function slagFight(account:ReturnType<typeof stub>,ending:'victory'|'stalemate',shots=true) {
  const rows=(zone:string)=>[{player_id:'me',side_id:2,kind:'player',ship_class:'shuttle',hull_pct:80,zone},
    {player_id:'t1',side_id:1,kind:'creature',is_npc:true,username:'Slag-Tortoise',ship_class:'tortoise',hull_pct:60,zone}];
  const hit=(t:number,from:string,to:string,ok:boolean)=>account.fire('battle_damage',
    {tick:t,attacker_id:from,target_id:to,hit_success:ok,hull_hit:ok?4:0,shield_hit:0,
      total_damage:ok?4:0,damage_type:'kinetic',weapons_fired:['autocannon_i']});
  account.fire('battle_update',{battle_id:'b-1',tick:1,your_side_id:2,your_stance:'fire',
    your_zone:'inner',auto_pilot:false,participants:rows('inner'),sides:[]});
  if(shots){hit(1,'t1','me',true);hit(1,'t1','me',true);hit(1,'me','t1',true);hit(1,'me','t1',false);}
  account.fire('battle_update',{battle_id:'b-1',tick:2,your_side_id:2,your_stance:'brace',
    your_zone:'inner',auto_pilot:false,participants:rows('inner'),sides:[]});
  if(shots){hit(2,'t1','me',true);hit(2,'t1','me',false);hit(2,'me','t1',true);}
  account.fire('battle_update',{battle_id:'b-1',tick:3,your_side_id:2,your_stance:'flee',
    your_zone:'outer',auto_pilot:false,participants:rows('outer'),sides:[]});
  if(shots){hit(3,'t1','me',true);hit(3,'t1','me',false);hit(3,'t1','me',false);}
  account.fire('battle_ended',{battle_id:'b-1',reason:ending,duration:3,ships_destroyed:1,
    total_damage:60,winning_side:ending==='victory'?2:-1,
    participants:[{player_id:'me',side_id:2,damage_dealt:30,damage_taken:60,kill_count:1,survived:true},
      {player_id:'t1',side_id:1,damage_dealt:60,damage_taken:30,kill_count:0,survived:ending!=='victory'}]});
}

test('the battle frames fold into the three metrics, and a thin sample says so',()=>{
  // RED before this commit: `bridge.ts`'s PUSH_TYPES listed neither `battle_update` nor
  // `battle_damage`, so `account.fire('battle_update',…)` asserted
  // "nothing is registered for battle_update" and no number existed to read.
  const runtime=temp(),account=stub();
  resetCombatFold();
  pushJournal(account,runtime);
  slagFight(account,'stalemate');

  const one=statsFor(readCombat(runtime),'Slag-Tortoise')!;
  // (a) average damage per tick, from the server's own fight totals over its own duration.
  assert.equal(one.taken_per_tick,20,'60 taken over 3 ticks');
  assert.equal(one.dealt_per_tick,10);
  // (b) measured accuracy by range band, in both directions, each carrying its shot count.
  assert.deepEqual(one.accuracy,{
    inner:{at_us:0.75,at_us_shots:4,at_them:0.67,at_them_shots:3},
    outer:{at_us:0.33,at_us_shots:3,at_them:undefined,at_them_shots:0}});
  // (c) an estimated win chance — withheld at one fight, because one fight is not a rate.
  assert.equal(one.fights,1);
  assert.equal(one.won,0);
  assert.equal(one.win_chance,undefined,'one fight offers counts, never a percentage');
  assert.equal(one.thin,true);
  assert.match(combatLine(one),/^0\/1 won \(1 fight, not a rate\), 20 dmg\/tick in, 10 out, they hit 75% inner\/33% outer, 0t old$/);
  // Our hull class rides along rather than being baked into the key: win chance is species
  // versus class, and the key cannot answer that until there is a second class to compare.
  assert.deepEqual(one.ship_classes,['shuttle']);
  const [fight]=readCombat(runtime);
  assert.equal(fight!.opponent_class,'tortoise');
  assert.deepEqual(fight!.stances,['fire','brace','flee'],'the stances actually in force, collapsed to changes');
  assert.equal(fight!.flee_ticks,1);
  assert.equal(fight!.tick,41_208,'the global tick at close, for the day a reader has one to diff');

  // Three fights is a rate. Two more, both won.
  for(const _ of [0,1]){resetCombatFold();slagFight(account,'victory');}
  const three=statsFor(readCombat(runtime),'Slag-Tortoise')!;
  assert.equal(three.fights,THIN);
  assert.equal(three.won,2);
  assert.equal(three.win_chance,2/3);
  assert.equal(three.thin,false);
  assert.equal(statsFor(readCombat(runtime),'Molt Grazer'),undefined,'never met, nothing claimed');

  // The frames are folded and dropped: the journal takes a battle_ended line and nothing else,
  // because a battle pushes one update a tick and a damage frame per shot.
  assert.deepEqual([...new Set(readJournal(runtime).map(entry=>entry.push))],['battle_ended']);
});

test('the combat store is bounded, evicts the oldest fight, and every fact reports its age',()=>{
  const runtime=temp();
  const record=(n:number,at:string):FightRecord=>({opponent:`beast-${n}`,ticks:1,by_range:{},
    dealt:1,taken:1,stances:['fire'],flee_ticks:0,ending:'victory',at});
  const now=Date.parse('2026-09-25T12:00:00.000Z');
  for(let n=0;n<CAP+5;n++)writeFight(runtime,record(n,new Date(now-n*TICK_MS).toISOString()));
  const kept=readCombat(runtime);
  assert.equal(kept.length,CAP,'bounded by count');
  assert.equal(kept[0]!.opponent,`beast-${CAP+4}`,'newest first');
  assert.equal(kept.some(row=>row.opponent==='beast-0'),false,'the oldest is evicted');
  // A remembered fact says how old it is, the way a remembered price carries its tick: ten
  // seconds of wall clock is one tick, so a fight 30 ticks back reads as 30 ticks old.
  const aged=statsFor(readCombat(runtime),'beast-30',now)!;
  assert.equal(aged.newest_ticks_old,30);
  assert.match(combatLine(aged),/30t old$/);
  // Two fights of the same opponent at different ages report the span, not one number.
  writeFight(runtime,record(30,new Date(now-100*TICK_MS).toISOString()));
  const span=statsFor(readCombat(runtime),'beast-30',now)!;
  assert.deepEqual([span.newest_ticks_old,span.oldest_ticks_old],[30,100]);
  // A torn or absent file is the same answer as no memory.
  assert.deepEqual(readCombat(join(runtime,'nowhere')),[]);
  // A fight the frames never named an opponent for is not written at all.
  writeFight(runtime,{...record(99,new Date(now).toISOString()),opponent:''});
  assert.equal(readCombat(runtime).length,CAP);
});

test('player_died reaches the alerts buffer, one item per wreck',()=>{
  // RED before this commit: `player_died` was in PUSH_TYPES but not the buffered set, and the
  // buffered set keyed on `base_id`, which `player_died` does not carry — so three ships were
  // lost on 2026-09-24 and `pendingAlerts(runtime)` was `[]`.
  const runtime=temp(),account=stub();
  pushJournal(account,runtime);
  const death=(wreck:string,ship:string)=>({cause:'combat',killer_name:'Slag-Tortoise',
    ship_lost:ship,clone_cost:1_500,insurance_payout:0,respawn_base:'sol_base',wreck_id:wreck,
    wreck_poi_id:'belt_ix',combat_log:{ticks:22}});
  account.fire('player_died',death('w-1','Kestrel'));
  account.fire('player_died',death('w-2','Kestrel II'));
  // The same death pushed twice collapses; a different hull does not.
  account.fire('player_died',death('w-2','Kestrel II'));
  assert.deepEqual(pendingAlerts(runtime).map(item=>[item.type,item.key,item.n,item.body.ship_lost]),
    [['player_died','wreck:w-1',1,'Kestrel'],['player_died','wreck:w-2',2,'Kestrel II']]);
  assert.equal(existsSync(join(runtime,'alerts.json')),true);
  // Scalars only: the nested combat log never reaches the buffer or the journal.
  assert.equal(readFileSync(join(runtime,'alerts.json'),'utf8').includes('combat_log'),false);
  assert.equal(pendingAlerts(runtime)[0]!.body.clone_cost,1_500,'what it cost travels with it');
});
