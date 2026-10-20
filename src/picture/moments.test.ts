/** The moment scorer (`moments.ts`) and its catalogue (`catalogue.ts`): the model, not the picture. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ACTIONS,FLEET_PUSH_ACTIONS,OK_PUSH_ACTIONS,OK_PUSH_TYPES,TYPED_NOTIFICATION_TYPES} from '@spacemolt/lib';
import type {JournalLine} from '../run-record.ts';
import {CATEGORY,EXCLUDED_QUERIES} from './catalogue.ts';
import {DULL_RARITY,fightsOf,foeOf,fromFrames,fromJournal,INVOLVEMENT,MAX_SPAN_MS,moments,momentsIn,pictured,poisOf,readSince,score,speciesKey,type MomentEvent,type Scored} from './moments.ts';

const T0=Date.parse('2026-10-17T00:00:00.000Z');
const iso=(s:number)=>new Date(T0+s*1000).toISOString();
const ev=(s:number,type:string,o:Partial<MomentEvent>={}):MomentEvent=>({at:iso(s),ms:T0+s*1000,type,variant:null,category:CATEGORY.get(type)??'uncatalogued',
  involvement:1,delta:{},identities:[],note:null,facts:{},approximate:false,...o});
const last=(es:Scored[])=>es.at(-1)!;

test('every catalogued push, variant and command has a category, and every command is catalogued or excluded',()=>{
  assert.equal(TYPED_NOTIFICATION_TYPES.length,59);
  for(const t of TYPED_NOTIFICATION_TYPES)assert.ok(CATEGORY.has(t),`push ${t} has no category`);
  for(const a of OK_PUSH_ACTIONS)assert.ok(CATEGORY.has(`ok:${a}`),`ok action ${a}`);
  for(const a of OK_PUSH_TYPES)assert.ok(CATEGORY.has(`ok:${a}`),`ok type ${a}`);
  for(const a of FLEET_PUSH_ACTIONS)assert.ok(CATEGORY.has(`fleet:${a}`),`fleet ${a}`);
  const keys=Object.keys(ACTIONS);
  assert.equal(keys.length,296);
  for(const k of keys)assert.ok(CATEGORY.has(k)!==EXCLUDED_QUERIES.has(k),`${k}: ${CATEGORY.has(k)?'both catalogued and excluded':'neither catalogued nor excluded'}`);
  for(const k of EXCLUDED_QUERIES)assert.equal(ACTIONS[k]?.kind,'query',`${k} is excluded but not a query`);
});

test('an uncatalogued type scores at weight 1 and says so',()=>{
  const [e]=score([ev(0,'brand_new_push')]);
  assert.equal(e?.category,'uncatalogued');
  assert.equal(e?.score,0.5); // 1 × (rarity 1, halved: it changed nothing and named nothing new) × 1 × 1
});

test('an event that changed nothing and named nothing new keeps half its rarity; any change or new name keeps it whole',()=>{
  const [dull,moved,named]=score([ev(0,'a_push'),ev(1,'b_push',{delta:{credits:5}}),ev(2,'c_push',{identities:[{kind:'item',id:'ore'}]})]);
  assert.equal(dull?.rarity,DULL_RARITY);assert.equal(moved?.rarity,1);assert.equal(named?.rarity,1);
});

test('rarity: a never-seen type is maximal, a common one is not, and no event is scored against what came after it',()=>{
  const stream=[...Array.from({length:50},(_,i)=>ev(i*600,'mining_yield',{delta:{cargo:1}})),ev(50*600,'skill_level_up',{delta:{level:1}}),ev(51*600,'mining_yield',{delta:{cargo:1}})];
  const all=score(stream);
  assert.equal(all[0]?.rarity,1);
  assert.equal(all[50]?.rarity,1);
  assert.ok(last(all).rarity<0.2,`a 50th mining tick has rarity ${last(all).rarity}`);
  const prefix=score(stream.slice(0,30));
  assert.deepEqual(prefix,all.slice(0,30)); // the future changes nothing already scored
});

test('change is relative to this pilot\'s typical size: typical counts nothing, four times typical counts fully',()=>{
  const history=(size:number)=>Array.from({length:6},(_,i)=>ev(i*3600,'spacemolt/sell',{delta:{credits:size}}));
  const at=(size:number,typical:number)=>last(score([...history(typical),ev(7*3600,'spacemolt/sell',{delta:{credits:size}})])).change;
  assert.equal(at(100,100),0);
  assert.ok(Math.abs(at(400,100)-1)<1e-9);
  assert.ok(Math.abs(at(250,100)-0.5)<1e-9);
  assert.equal(at(400,1000),0); // the same 400 credits is nothing to a pilot who moves thousands
  assert.equal(score([ev(0,'spacemolt/sell',{delta:{credits:5}})])[0]?.change,0.5); // a field with no history yet
  assert.equal(score([ev(0,'spacemolt/jump',{delta:{system:1}})])[0]?.change,0.5); // a jump is categorical
});

test('first time: an identity counts once, the first time it is seen',()=>{
  const sys={kind:'system' as const,id:'sol'};
  const [a,b,c]=score([ev(0,'spacemolt/jump',{identities:[sys]}),ev(3600,'spacemolt/jump',{identities:[sys]}),
    ev(7200,'spacemolt/jump',{identities:[sys,{kind:'system',id:'vega'},{kind:'item',id:'ore'}]})]);
  assert.equal(a?.first,0.5);assert.equal(b?.first,0);assert.equal(c?.first,1);
});

test('involvement: the pilot\'s own, nearby, and broadcast',()=>{
  const at='2026-10-17T00:00:00.000Z',frames=[
    {at,dir:'in',frame:{type:'logged_in',payload:{player:{id:'me',username:'Kvothe',credits:10},ship:{hull:80}}}},
    {at,dir:'in',frame:{type:'chat_message',payload:{channel:'private',sender:'Ann',sender_id:'p2',content:'hi',target_id:'me'}}},
    {at,dir:'in',frame:{type:'chat_message',payload:{channel:'system',sender:'Ann',sender_id:'p2',content:'hi'}}},
    {at,dir:'in',frame:{type:'chat_message',payload:{channel:'global',sender:'Ann',sender_id:'p2',content:'hi'}}},
    {at,dir:'in',frame:{type:'battle_alert',payload:{battle_id:'b',system_id:'sol',message:'A battle'}}},
    {at,dir:'in',frame:{type:'ok',payload:{type:'new_forum_post',thread_id:'t',title:'x'}}},
    {at,dir:'in',frame:{type:'battle_damage',payload:{attacker_id:'p2',target_id:'p3',hull_hit:5}}},
    {at,dir:'in',frame:{type:'battle_damage',payload:{attacker_id:'p2',target_id:'me',hull_hit:5}}},
    {at,dir:'in',frame:{type:'skill_level_up',payload:{skill_id:'gunnery',new_level:12}}},
    {at,dir:'in',frame:{type:'battle_started',payload:{battle_id:'b',participants:[{player_id:'p2'},{player_id:'p3'}]}}},
    {at,dir:'in',frame:{type:'battle_left',payload:{player_id:'p2',reason:'destroyed'}}}];
  assert.deepEqual(fromFrames(frames).map(e=>[e.type,e.involvement]),[['chat_message',INVOLVEMENT.self],['chat_message',INVOLVEMENT.nearby],['chat_message',INVOLVEMENT.global],
    ['battle_alert',INVOLVEMENT.nearby],['ok',INVOLVEMENT.global],['battle_damage',INVOLVEMENT.nearby],['battle_damage',INVOLVEMENT.self],['skill_level_up',INVOLVEMENT.self],
    ['battle_started',INVOLVEMENT.nearby],['battle_left',INVOLVEMENT.nearby]]); // a battle and a departure the pilot is not in
  assert.deepEqual(fightsOf(fromFrames(frames)),[]); // and no fight of its own
  // Live 2026-10-19 (kvothe 06:02Z): the pirate's alert listed the pilot as a participant.
  const mine={at,dir:'in',frame:{type:'battle_alert',payload:{battle_id:'c',system_id:'sol',participants:[{player_id:'p2'},{player_id:'me'}]}}};
  assert.deepEqual(fromFrames([frames[0]!,mine]).map(e=>e.involvement),[INVOLVEMENT.self]);
  assert.deepEqual(fromFrames([mine]).map(e=>e.involvement),[INVOLVEMENT.nearby]); // with no login seen, an alert is not taken as ours
  assert.ok(INVOLVEMENT.self>INVOLVEMENT.nearby&&INVOLVEMENT.nearby>INVOLVEMENT.global);
});

const scored=(s:number,points:number,type='battle_ended'):Scored=>({...ev(s,type),score:points,rarity:0,change:0,first:0,habituation:1});

/** A quiet background: a lone small event every ten minutes, so the scope's median excitement is low. */
const quiet=(from:number,to:number)=>Array.from({length:Math.floor((to-from)/600)},(_,i)=>scored(from+300+i*600,0.1,'spacemolt/refuel'));
const byStart=<T extends {start:string}>(ms:readonly T[]):T[]=>[...ms].sort((x,y)=>Date.parse(x.start)-Date.parse(y.start));

test('a moment\'s span adapts: a 40-second fight is short, a 12-minute spree is one long moment, an hour apart is two',()=>{
  const fight=[0,10,20,30,40].map(s=>scored(3600+s,2)),spree=Array.from({length:13},(_,i)=>scored(9000+i*60,1,'spacemolt/sell'));
  const found=momentsIn([...quiet(0,14_400),...fight,...spree].sort((x,y)=>x.ms-y.ms),iso(0),iso(14_400)).filter(m=>m.raw>1);
  const [a,b]=byStart(found);
  assert.ok(a&&b&&found.length===2);
  assert.deepEqual([a.start,a.end,a.events.length],[iso(3600),iso(3640),5]); // the opening shots too
  assert.deepEqual([b.start,b.end,b.events.filter(e=>e.type==='spacemolt/sell').length],[iso(9000),iso(9720),13]); // and the one quiet refuel inside it
  assert.equal(a.raw,10);assert.ok(Math.abs(b.raw-13.1)<1e-9);
});

test('peaks, not plateaus: a steady loop is the floor, and a rise above it is the moment',()=>{
  const loop=Array.from({length:240},(_,i)=>scored(i*60,1,'battle_ended')),sale=[scored(7230,4,'spacemolt/sell'),scored(7250,4,'spacemolt/sell')];
  const [best]=momentsIn([...loop,...sale].sort((x,y)=>x.ms-y.ms),iso(0),iso(14_400));
  assert.equal(best?.lead.type,'spacemolt/sell');
  assert.ok(best&&Date.parse(best.end)-Date.parse(best.start)<=10*60_000,`the rise spans ${best?.start}..${best?.end}`);
});

test('a moment is at most 12 minutes: a longer run above the line keeps its best 12 minutes round the peak',()=>{
  const spree=Array.from({length:61},(_,i)=>scored(3600+i*60,i>=25&&i<=35?3:2.5,'spacemolt/sell'));
  const [m]=momentsIn([...quiet(0,43_200),...spree].sort((x,y)=>x.ms-y.ms),iso(0),iso(43_200));
  assert.ok(m);
  assert.equal(Date.parse(m.end)-Date.parse(m.start),MAX_SPAN_MS);
  assert.ok(m.start<=iso(3600+25*60)&&m.end>=iso(3600+35*60),'the rich middle is kept');
});

test('lead, supporting and earlier: the best event, the best of up to two other categories, and what came before the moment',()=>{
  const burst=[scored(3600,1,'spacemolt/jump'),scored(3610,3,'player_died'),scored(3620,2,'battle_ended'),scored(3630,2.5,'battle_ended'),scored(3640,0.5,'spacemolt/sell')];
  const before=[scored(600,0.4,'mining_yield'),scored(900,0.3,'spacemolt/sell'),scored(1200,0.2,'action_error')];
  const [m]=momentsIn([...before,...quiet(4000,20_000),...burst].sort((x,y)=>x.ms-y.ms),iso(0),iso(20_000));
  assert.equal(m?.lead.type,'player_died');
  assert.deepEqual(m?.supporting.map(e=>[e.type,e.score]),[['battle_ended',2.5],['spacemolt/jump',1]]);
  assert.deepEqual(m?.earlier.map(e=>e.type),['mining_yield']); // economy is in the moment; system is never shown; the quiet refuels come after
});

test('change is measured against the same type: a sale against past sales, a new type against the field',()=>{
  const refuels=Array.from({length:10},(_,i)=>ev(i*600,'spacemolt/refuel',{delta:{credits:-50}}));
  const sales=Array.from({length:5},(_,i)=>ev(7000+i*600,'spacemolt/sell',{delta:{credits:2000}}));
  const all=score([...refuels,...sales]);
  assert.equal(all[10]?.change,1); // the first sale: against refuels' 50 credits
  assert.ok(last(all).change<1e-9); // the fifth: against past sales
});

test('repetition is damped: an hour of mining ticks does not outscore one death',()=>{
  const history=Array.from({length:500},(_,i)=>ev(-86_400+i*10,'mining_yield',{delta:{cargo:3},identities:[{kind:'item',id:'iron_ore'}]}));
  const death=ev(600,'player_died',{delta:{ship:1},identities:[{kind:'opponent',id:'Crusher-Mantis'}]});
  const ticks=Array.from({length:360},(_,i)=>ev(3600+i*10,'mining_yield',{delta:{cargo:3},identities:[{kind:'item',id:'iron_ore'}]}));
  const all=score([...history,death,...ticks]),[best]=momentsIn(all,iso(0),iso(7300));
  assert.equal(best?.lead.type,'player_died');
  const window=all.filter(e=>e.ms>=T0),hour=window.filter(e=>e.type==='mining_yield').reduce((n,e)=>n+e.score,0);
  assert.ok(hour<(window.find(e=>e.type==='player_died')?.score??0),`an hour of ticks scores ${hour}`);
});

/** Lines cut from Kvothe's journal of 2026-10-16/17, trimmed to what the adapter reads. */
const KVOTHE:JournalLine[]=[
  {at:'2026-10-16T17:37:53.175Z',event:'command',run_id:'r1',tool:'spacemolt',action:'jump',params:{id:'tidewater'},ok:true,summary:'jumped',ms:50541},
  {at:'2026-10-16T17:41:23.046Z',event:'command',run_id:'r1',tool:'spacemolt',action:'travel',params:{id:'superposition_pocket'},ok:true,summary:'arrived',ms:29158},
  {at:'2026-10-16T17:41:30.000Z',event:'command',run_id:'r1',tool:'spacemolt',action:'get_system',params:{},ok:true,summary:'system',ms:20},
  {at:'2026-10-16T17:29:17.193Z',event:'command',run_id:'r1',tool:'spacemolt_battle',action:'status',params:{},ok:false,summary:'No active battle.',ms:21,code:'not_in_battle'}, // an excluded read, failed or not
  {at:'2026-10-16T17:30:54.347Z',event:'command',run_id:'r1',tool:'spacemolt',action:'hunt',params:{id:'crt_e642b3279fcbc6a5379101bfba3656ca'},ok:false,summary:'No action_result for mutation r18820 within 60000ms of its ack',ms:60014,code:'mutation_timeout',lost:true},
  {at:'2026-10-16T18:50:44.626Z',event:'command',run_id:'r2',tool:'spacemolt',action:'accept_mission',params:{id:'nebula_drift_hunt'},ok:true,summary:'Bounty logged. Six sift-rays.',ms:5209},
  {at:'2026-10-16T18:50:44.626Z',event:'mission',run_id:'r2',verb:'accepted',mission_id:'005447f070dabb31e30a2d724ded9e50',title:'Nebula Drift Hunt',type:'combat'},
  {at:'2026-10-16T18:51:45.553Z',event:'command',run_id:'r2',tool:'spacemolt',action:'hunt',params:{id:'crt_84a76d317a811bb8b1837b579bba0bcd'},ok:true,summary:'attack tick 2155931',ms:12335},
  {at:'2026-10-16T18:51:45.628Z',event:'command',run_id:'r2',tool:'spacemolt_battle',action:'advance',params:{},ok:true,summary:'advance Advancing toward the enemy.',ms:30},
  {at:'2026-10-16T18:54:13.839Z',event:'push',run_id:'r2',push:'battle_ended',battle_id:'309084cf7f2c0af77f04b5bb22d96f28',winning_side:2,reason:'victory',duration:3,total_damage:8,ships_destroyed:1},
  {at:'2026-10-16T18:54:24.283Z',event:'command',run_id:'r2',tool:'spacemolt_salvage',action:'loot',params:{id:'1e15b7b19d6481ed21024a984fb0f75d',item_id:'creature_carapace',quantity:1},ok:true,summary:'loot_wreck',ms:7729},
  {at:'2026-10-16T19:04:44.215Z',event:'command',run_id:'r2',tool:'spacemolt',action:'sell',params:{id:'verdigris_curd',quantity:5},ok:true,summary:'sell Sold 5x Verdigris Curd for 1650 credits from ILC Venture.',ms:9350},
  {at:'2026-10-16T19:04:44.216Z',event:'trade',run_id:'r2',side:'sell',item_id:'verdigris_curd',quantity:5,total:1650,unit_price:330},
  {at:'2026-10-16T17:18:56.448Z',event:'push',push:'battle_alert',battle_id:'2e400e380b4cee765f6507ae01669a00',system_id:'izar',message:'A battle is underway in Izar!'},
  {at:'2026-10-17T03:05:41.214Z',event:'command',query_id:'q1',tool:'spacemolt',action:'craft',params:{id:'basic_iron_smelting',quantity:1,dry_run:true},ok:true,summary:'craft Quote only',ms:13},
  {at:'2026-10-17T04:36:31.907Z',event:'unsolicited_move',cause:'mobile_capital_transit',evidence:'action=mobile_capital_transit message=The Mobile Capital has jumped. You are now in Starfall. system=starfall'},
  {at:'2026-10-15T19:21:03.951Z',event:'push',run_id:'r0',push:'player_died',killer_name:'Crusher-Mantis',respawn_base:'frontier_station',ship_lost:'toll',wreck_poi_id:'smiths_detour',wreck_system_id:'frostfeld',cause:'wildlife'},
  {at:'2026-10-16T01:42:34.211Z',event:'stranded',run_id:'r9',tired_by:'fuel 0 under the Focused reserve 24',fuel:0,hull:80,system:'unknown_edge',poi:'edgelight',docked_at:null},
];

test('the journal adapter: commands are replies, trade and mission lines join the command before them, queries and excluded reads are left out',()=>{
  const got=fromJournal(KVOTHE,new Map([['309084cf7f2c0af77f04b5bb22d96f28','Veil-Ray']]));
  assert.ok(got.every(e=>e.approximate));
  const by=(type:string)=>got.find(e=>e.type===type||`${e.type}:${e.variant}`===type);
  assert.deepEqual(got.map(e=>e.type),['spacemolt/jump','spacemolt/travel','action_error','spacemolt/accept_mission','spacemolt/hunt','spacemolt_battle/advance','battle_ended',
    'spacemolt_salvage/loot','spacemolt/sell','battle_alert','ok','player_died','stranded']);
  assert.deepEqual([by('spacemolt/jump')?.delta,by('spacemolt/jump')?.identities,by('spacemolt/jump')?.category],[{system:1},[{kind:'system',id:'tidewater'}],'travel']);
  assert.deepEqual(by('spacemolt/travel')?.identities,[{kind:'poi',id:'superposition_pocket'}]);
  assert.deepEqual([by('action_error')?.variant,by('action_error')?.category],['spacemolt/hunt','system']);
  assert.deepEqual(by('spacemolt/accept_mission')?.delta,{mission:1});
  assert.equal(by('spacemolt_battle/advance')?.category,'combat');
  assert.deepEqual([by('battle_ended')?.delta,by('battle_ended')?.identities],[{damage:8},[{kind:'opponent',id:'Veil-Ray'}]]);
  assert.deepEqual([by('spacemolt_salvage/loot')?.delta,by('spacemolt_salvage/loot')?.identities],[{cargo:1},[{kind:'item',id:'creature_carapace'}]]);
  assert.deepEqual([by('spacemolt/sell')?.delta,by('spacemolt/sell')?.identities],[{credits:1650,cargo:-5},[{kind:'item',id:'verdigris_curd'}]]);
  assert.deepEqual([by('spacemolt/sell')?.facts.quantity,by('spacemolt/sell')?.facts.item_id,by('spacemolt/accept_mission')?.facts.title,by('battle_ended')?.facts.opponent],[5,'verdigris_curd','Nebula Drift Hunt','Veil-Ray']);
  assert.deepEqual([by('battle_alert')?.involvement,by('battle_alert')?.identities],[INVOLVEMENT.nearby,[{kind:'system',id:'izar'}]]);
  assert.deepEqual([by('ok:mobile_capital_transit')?.category,by('ok:mobile_capital_transit')?.delta],['travel',{system:1}]);
  assert.deepEqual([by('player_died')?.category,by('player_died')?.delta],['hazard',{ship:1}]);
  assert.deepEqual(by('player_died')?.identities.map(i=>`${i.kind}:${i.id}`).sort(),['opponent:Crusher-Mantis','poi:frontier_station','poi:smiths_detour','system:frostfeld']);
  assert.deepEqual([by('stranded')?.category,by('stranded')?.involvement,by('stranded')?.identities,by('stranded')?.note],['hazard',INVOLVEMENT.self,[{kind:'system',id:'unknown_edge'},{kind:'poi',id:'edgelight'}],'fuel 0 under the Focused reserve 24']); // the runtime's own line
});

test('the journal adapter names a trade\'s or job\'s base from where the pilot is docked, and a fight\'s opponent from its target command',()=>{
  const cmd=(at:string,tool:string,action:string,params:Record<string,unknown>={},summary='')=>({at,event:'command',run_id:'r1',tool,action,params,ok:true,summary,ms:10});
  const got=fromJournal([
    {at:'2026-10-17T01:00:00.000Z',event:'run',phase:'started',run_id:'r1',start_state:{docked_at:'ramens_rest'}},
    cmd('2026-10-17T01:00:10.000Z','spacemolt','sell',{id:'verdigris_curd',quantity:5}),
    cmd('2026-10-17T01:01:00.000Z','spacemolt','undock'),
    cmd('2026-10-17T01:02:00.000Z','spacemolt','sell',{id:'verdigris_curd',quantity:1}), // undocked: no base
    cmd('2026-10-17T01:05:00.000Z','spacemolt','travel',{id:'mobile_capital'},'arrived'),
    cmd('2026-10-17T01:05:10.000Z','spacemolt','dock',{},'dock tick 2155518'),
    {at:'2026-10-17T01:05:10.100Z',event:'line',run_id:'r1',text:'  docked at frontier_station',fn:'goTo'},
    cmd('2026-10-17T01:06:00.000Z','spacemolt','accept_mission',{id:'nebula_drift_hunt'},'Bounty logged.'),
    cmd('2026-10-17T01:07:00.000Z','spacemolt','refuel'), // holdings: not a trade or a job
    cmd('2026-10-17T01:10:00.000Z','spacemolt','hunt',{id:'crt_1'},'attack tick 1'),
    cmd('2026-10-17T01:10:20.000Z','spacemolt_battle','target',{},'target Target set to Veil-Ray.'),
    {at:'2026-10-17T01:11:00.000Z',event:'push',run_id:'r1',push:'battle_ended',battle_id:'gone1',reason:'victory'},
    {at:'2026-10-17T01:13:00.000Z',event:'push',run_id:'r1',push:'battle_ended',battle_id:'gone2',reason:'stalemate'}, // no target of its own
    cmd('2026-10-17T01:13:30.000Z','spacemolt_salvage','loot',{id:'w1',item_id:'creature_carapace',quantity:1},'loot_wreck'),
    cmd('2026-10-17T01:40:00.000Z','spacemolt_salvage','loot',{id:'w2',item_id:'creature_carapace',quantity:1},'loot_wreck'), // long after the last fight
  ]);
  const base=(type:string)=>got.filter(e=>e.type===type).map(e=>e.facts.base_id??null);
  assert.deepEqual(base('spacemolt/sell'),['ramens_rest',null]);
  assert.deepEqual(base('spacemolt/accept_mission'),['frontier_station']);
  assert.deepEqual(base('spacemolt/refuel'),[null]);
  assert.deepEqual(got.filter(e=>e.type==='spacemolt_salvage/loot').map(e=>e.facts.wreck_of??null),['Veil-Ray',null]); // the wreck is the last recent fight's
  assert.deepEqual(got.filter(e=>e.type==='battle_ended').map(e=>[e.facts.opponent??null,e.identities]),[['Veil-Ray',[{kind:'opponent',id:'Veil-Ray'}]],[null,[]]]);
  assert.equal(fromJournal([cmd('2026-10-17T01:10:20.000Z','spacemolt_battle','target',{},'target Target set to Veil-Ray.'),
    {at:'2026-10-17T01:11:00.000Z',event:'push',run_id:'r1',push:'battle_ended',battle_id:'kept',reason:'victory'}],new Map([['kept','Void Eel']]))[1]?.facts.opponent,'Void Eel'); // combat.json first
});

test('an opponent named like a known species is that species, in the journal and the frames alike; its wreck is a creature\'s',()=>{
  const species=new Set(['veil_ray','drift_ray']);
  assert.equal(speciesKey('Veil-Ray'),'veil_ray');assert.equal(speciesKey(' Drift  Ray '),'drift_ray');
  const journal=fromJournal([
    {at:'2026-10-17T01:10:20.000Z',event:'command',run_id:'r1',tool:'spacemolt_battle',action:'target',params:{},ok:true,summary:'target Target set to Veil-Ray.'},
    {at:'2026-10-17T01:11:00.000Z',event:'push',run_id:'r1',push:'battle_ended',battle_id:'b1',reason:'victory'},
    {at:'2026-10-17T01:11:30.000Z',event:'command',run_id:'r1',tool:'spacemolt_salvage',action:'loot',params:{id:'w1',item_id:'creature_carapace',quantity:1},ok:true,summary:'loot_wreck'},
    {at:'2026-10-17T01:20:00.000Z',event:'push',run_id:'r1',push:'battle_ended',battle_id:'b2',reason:'victory'}],new Map([['b2','Cutthroat Pirate']]),species);
  assert.deepEqual(journal[1]?.identities,[{kind:'opponent',id:'Veil-Ray'},{kind:'species',id:'veil_ray'}]); // [0] is the target command
  assert.deepEqual([journal[2]?.facts.wreck_of,journal[2]?.facts.wreck_foe,journal[2]?.identities.some(i=>i.kind==='species')],['Veil-Ray','creature',true]);
  assert.deepEqual(journal[3]?.identities,[{kind:'opponent',id:'Cutthroat Pirate'}]); // no species of that name
  assert.deepEqual([foeOf(journal[1]!),foeOf(journal[3]!)],['creature',null]);
  const frames=fromFrames([frame('2026-10-17T05:01:10.000Z','in',{type:'battle_damage',payload:{attacker_id:'crt_1',attacker_name:'Drift Ray',target_id:'me',hull_hit:6}})],species);
  assert.deepEqual(frames[0]?.identities.map(i=>`${i.kind}:${i.id}`),['opponent:Drift Ray','species:drift_ray']);
});

const frame=(at:string,dir:'in'|'out',f:Record<string,unknown>,freighter?:string)=>({at,dir,frame:f,...freighter?{freighter}:{}});
const FRAMES=[
  frame('2026-10-17T05:00:00.000Z','in',{type:'welcome',payload:{version:'v0.612.0'}}),
  frame('2026-10-17T05:00:01.000Z','in',{type:'logged_in',payload:{player:{id:'me',username:'Kvothe',credits:1000},ship:{hull:80,fuel:100,cargo_used:3},system:{id:'the_telescope'},poi:{id:'mobile_capital'}}}),
  frame('2026-10-17T05:00:02.000Z','out',{tool:'spacemolt',action:'jump',payload:{id:'starfall'},request_id:'q1'}),
  frame('2026-10-17T05:00:02.100Z','in',{type:'result',request_id:'q1',payload:{result:'queued',structuredContent:{pending:true}}}),
  frame('2026-10-17T05:00:50.000Z','in',{type:'action_result',request_id:'q1',payload:{command:'jump',tick:9,result:{location:{system_id:'starfall',poi_id:'starfall_star'},ship:{fuel:95},
    details:{action:'jumped',system:'Starfall',system_id:'starfall',from_system:'the_telescope'}}}}),
  frame('2026-10-17T05:00:51.000Z','out',{tool:'spacemolt',action:'get_system',request_id:'q2'}),
  frame('2026-10-17T05:00:51.100Z','in',{type:'result',request_id:'q2',payload:{result:'Starfall',structuredContent:{system_id:'starfall'}}}),
  frame('2026-10-17T05:01:00.000Z','out',{tool:'spacemolt_battle',action:'stance',payload:{stance:'fire'},request_id:'q3'}),
  frame('2026-10-17T05:01:00.100Z','in',{type:'result',request_id:'q3',payload:{result:'Firing',structuredContent:{stance:'fire',battle_id:'b1'}}}),
  frame('2026-10-17T05:01:10.000Z','in',{type:'battle_damage',payload:{attacker_id:'crt_1',attacker_name:'Veil-Ray',target_id:'me',target_name:'Kvothe',hull_hit:6}}),
  frame('2026-10-17T05:01:20.000Z','in',{type:'mining_yield',payload:{resource_id:'iron_ore',quantity:4}}),
  frame('2026-10-17T05:01:30.000Z','in',{type:'ok',payload:{action:'fleet_jump',destination:'vega',arrival_tick:20}}),
  frame('2026-10-17T05:01:40.000Z','in',{type:'fleet',payload:{action:'fleet_invite',fleet_id:'f1',leader_name:'Ann',leader_id:'p2'}}),
  frame('2026-10-17T05:01:50.000Z','out',{tool:'spacemolt',action:'sell',payload:{id:'iron_ore',quantity:4},request_id:'q4'}),
  frame('2026-10-17T05:01:51.000Z','in',{type:'action_error',request_id:'q4',payload:{command:'sell',tick:12,code:'not_docked',message:'Not docked'}}),
  frame('2026-10-17T05:02:00.000Z','in',{type:'action_result',payload:{command:'player_died',tick:13,result:{player:{credits:900},ship:{hull:100},location:{system_id:'frostfeld'}}}}),
  frame('2026-10-17T05:02:10.000Z','in',{type:'mining_yield',payload:{resource_id:'gold_ore',quantity:9}},'hauler'),
];

test('the frames adapter: replies join their command by request_id, acks and excluded reads drop, state sections become deltas',()=>{
  const got=fromFrames(FRAMES);
  assert.ok(got.every(e=>!e.approximate));
  assert.deepEqual(got.map(e=>[e.type,e.variant,e.category]),[['spacemolt/jump',null,'travel'],['spacemolt_battle/stance',null,'combat'],['battle_damage',null,'combat'],
    ['mining_yield',null,'extraction'],['ok','fleet_jump','travel'],['fleet','fleet_invite','faction'],['action_error','spacemolt/sell','system'],['action_result','player_died','hazard']]);
  const [jump,,shot,ore,,,,died]=got;
  assert.deepEqual(jump?.delta,{fuel:-5,system:1});
  assert.deepEqual(jump?.identities,[{kind:'system',id:'starfall'},{kind:'poi',id:'starfall_star'}]);
  assert.deepEqual([shot?.delta,shot?.identities,shot?.involvement],[{hull:-6},[{kind:'opponent',id:'Veil-Ray'}],INVOLVEMENT.self]); // the pilot's own name is no identity
  assert.deepEqual([ore?.delta,ore?.identities],[{cargo:4},[{kind:'item',id:'iron_ore'}]]);
  assert.deepEqual(died?.delta,{credits:-100,hull:20,system:1});
});

test('moments() reads a runtime: the journal when no frames reach back, the frames when they do',()=>{
  const dir=mkdtempSync(join(tmpdir(),'spacemolt-moments-')),runtime=join(dir,'runtime');
  try {
    mkdirSync(runtime);
    writeFileSync(join(runtime,'gameplay.jsonl'),KVOTHE.map(l=>JSON.stringify(l)).join('\n')+'\n');
    const span={start:'2026-10-16T17:00:00.000Z',end:'2026-10-16T20:00:00.000Z'};
    const [j]=moments(runtime,[span]);
    assert.equal(j?.source,'journal');
    assert.ok(j?.moments.every(m=>m.approximate&&m.start>=span.start&&m.end<=span.end));
    assert.ok(j?.moments.some(m=>m.lead.type==='spacemolt/sell'||m.lead.type==='battle_ended'));
    writeFileSync(join(runtime,'frames.jsonl'),FRAMES.map(l=>JSON.stringify(l)).join('\n')+'\n');
    const late={start:'2026-10-17T05:00:00.000Z',end:'2026-10-17T05:05:00.000Z'};
    const [f,early]=moments(runtime,[late,span]);
    assert.equal(f?.source,'frames');assert.equal(early?.source,'journal');
    assert.equal(f?.moments[0]?.lead.type,'action_result'); // the death
    assert.deepEqual(moments(runtime,[{start:'2026-10-18T00:00:00.000Z',end:'2026-10-18T01:00:00.000Z'}])[0]?.moments,[]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

/** Kvothe's frames of 2026-10-19 06:00:00-06:04:40Z, in and out, behind the session's login (05:03Z); replies trimmed to what is read. */
const DEATH_FRAMES=readFileSync(new URL('../test-support/frames-kvothe-2026-10-19.jsonl',import.meta.url),'utf8').trim().split('\n').map(l=>JSON.parse(l) as JournalLine);

// Live 2026-10-19 (kvothe 06:03Z): a pirate's battle at Kael Arsenal, the station's guns destroyed the Dust Devil, and the pilot
// respawned in a Cobble. The death scored twice (its push and an action_result), the Cobble stood in for the Dust Devil, and the
// pirate's Eviction Notice, named only by the battle's opening frame, reached no reference.
test('a death in battle, from the live frames: one event, the ship and place at it, the battle\'s opponent on its frames',()=>{
  const got=fromFrames(DEATH_FRAMES),of=(type:string)=>got.filter(e=>e.type===type),ids=(e:MomentEvent|undefined)=>e?.identities.map(i=>`${i.kind}:${i.id}`);
  const rows:[string,unknown,unknown][]=[
    ['one death, the push',got.filter(e=>e.category==='hazard').map(e=>[e.type,e.variant]),[['player_died',null]]],
    ['the ship and place at the death',of('player_died')[0]?.pilot,{system:'xamidimura',poi:'kael_arsenal',docked_at:null,ship_class:'dust_devil',poi_type:null}],
    ['the ship at the battle\'s opening, from its own participant row',of('battle_started')[0]?.pilot?.ship_class,'dust_devil'],
    ['the respawn, after it',of('spacemolt/undock')[0]?.pilot,{system:'first_step',poi:'mobile_capital',docked_at:null,ship_class:'cobble',poi_type:null}],
    ['the station\'s shot carries the battle\'s other side',ids(of('battle_damage')[0]),['opponent:Kael Arsenal Station','ship_class:eviction_notice','player:e505e6ed397cbc56a7d098249792f59d','opponent:Commodore']],
    ['the pilot\'s own participant row is no identity',got.some(e=>e.identities.some(i=>i.id==='dust_devil')),false],
    ['the fight',fightsOf(got),[{battle_id:'8c72b3c372fbf0a0414c983c75c565c4',ending:'defeat',opponent:'Commodore'}]],
    ['the other side flies a ship: its kind, pilot and ship name, on the death too',[of('battle_started')[0],of('player_died')[0]].map(e=>[e?.facts.foe_kind,e?.facts.foe_name,e?.facts.foe_ship]),
      [['pirate','Commodore','Eviction Notice'],['pirate','Commodore','Eviction Notice']]],
    ['the station is no participant: it is the gunner, with its distinct weapons',[of('battle_damage')[0]?.facts.gunner,of('battle_damage')[0]?.facts.weapons],['Kael Arsenal Station','Harpoon Emplacement|Scrap Flak Battery']],
    ['the scans name their ship classes',of('scan_detected').map(e=>e.facts.scanner_ship_class),['lemming','lemming','lawn_dart','lawn_dart']],
  ];
  for(const [what,actual,want] of rows)assert.deepEqual(actual,want,what);
});

// Live 2026-10-19 (kvothe 08:41Z): a battle nearby between a creature and a drone listed the creature by its instance id, and the
// picture called it "Crt Dc1f7b404a048a10e48d7168f2632098". A participant is named by its username; a shooter that is one is no gunner.
test('a battle\'s participants are named by username, and only a shooter outside the battle is a gunner',()=>{
  const at='2026-10-19T08:41:46.022Z',frames=[
    {at,dir:'in',frame:{type:'logged_in',payload:{player:{id:'me',username:'Kvothe'}}}},
    {at,dir:'in',frame:{type:'battle_alert',payload:{battle_id:'n',system_id:'nashira',participants:[{player_id:'crt_dc1f7b404a048a10e48d7168f2632098',username:'Patina-Grazer',kind:'creature',is_npc:true},
      {player_id:'5ad04c15f30f6d1994393c9285ee918c',username:'Combat Drone 137',ship_class:'dialectic',ship_name:'Dialectic',kind:'player'}]}}},
    {at,dir:'in',frame:{type:'battle_started',payload:{battle_id:'b',participants:[{player_id:'me',username:'Kvothe'},{player_id:'p2',username:'Ann',ship_class:'lemming',kind:'player'}]}}},
    {at,dir:'in',frame:{type:'battle_damage',payload:{attacker_id:'p2',attacker_name:'Ann',target_id:'me',weapons_fired:['Autocannon']}}}];
  const [alert,started,shot]=fromFrames(frames);
  assert.deepEqual(alert?.identities.filter(i=>i.kind==='opponent').map(i=>i.id),['Patina-Grazer','Combat Drone 137']);
  assert.deepEqual([alert?.facts.foe_name,started?.facts.foe_kind,started?.facts.foe_name,started?.facts.foe_ship],[undefined,'player','Ann',undefined]); // not the pilot's battle; no ship_name
  assert.deepEqual([shot?.facts.gunner,shot?.facts.foe_name],[undefined,'Ann']);
  assert.deepEqual([alert?.facts.other_side,started?.facts.other_side],['creature',undefined]); // the other side of a battle heard of, not of the pilot's own
  const ships=fromFrames([frames[0]!,{at,dir:'in',frame:{type:'battle_alert',payload:{battle_id:'m',participants:[{player_id:'a',username:'A',side_id:1,ship_class:'lemming'},
    {player_id:'b',username:'B',side_id:1,ship_class:'cobble'},{player_id:'c',username:'C',side_id:2,ship_class:'crimson_stiletto'}]}}}]);
  assert.equal(ships[0]?.facts.other_side,'crimson_stiletto'); // the first ship's other side, by its class
});

// Live 2026-10-19 (kvothe 7b7030a8): a mission done at Bharani Star drew "the lights of Bharani Star", an empty window. The
// location section says the POI is a sun, which a picture can draw.
test('the pilot at an event carries its POI\'s kind from the location section',()=>{
  const at='2026-10-19T08:47:44.000Z',got=fromFrames([{at,dir:'in',frame:{type:'logged_in',payload:{player:{id:'me',username:'Kvothe'}}}},
    {at,dir:'in',frame:{type:'action_result',payload:{command:'jump',result:{location:{system_id:'bharani',poi_id:'bharani_star',poi_type:'sun',docked_at:null}}}}}]);
  assert.equal(got.at(-1)?.pilot?.poi_type,'sun');
});

/** Scored events for `pictured`: the pilot's own unless said otherwise. */
const act=(s:number,type:string,points:number,o:Partial<Scored>={}):Scored=>({...ev(s,type,o),score:points,rarity:0,change:0,first:0,habituation:1,...o});

// Carl, 2026-10-19: a flight's picture shows what the pilot mostly did; a fight it was in, its death or a first find overrides.
test('pictured: the category of most of the pilot\'s own commands, travel and upkeep only when it did nothing else, its best-scoring event leading',()=>{
  const jumps=Array.from({length:9},(_,i)=>act(i*60,'spacemolt/jump',0.3)),refuels=[act(700,'spacemolt/refuel',0.2),act(710,'spacemolt/refuel',0.2)];
  const mines=[act(1000,'spacemolt/mine',0.2),act(1001,'mining_yield',0.9),act(1100,'spacemolt/mine',0.3),act(1200,'spacemolt/mine',0.1)];
  const sales=[act(1300,'spacemolt/sell',2),act(1400,'spacemolt/sell',1)];
  const all=[...jumps,...refuels,...mines,...sales],m=pictured([],all);
  assert.equal(m?.lead.type,'mining_yield'); // three mines outvote two sales; a push is no vote, but it can be the best of its category
  assert.deepEqual(m?.events.map(e=>e.category),mines.map(()=>'extraction'));
  assert.equal(pictured([],[...jumps,...refuels])?.lead.category,'travel');
  assert.equal(pictured([],refuels)?.lead.category,'holdings');
  assert.equal(pictured([],[act(0,'chat_message',3,{category:'social'})]),null); // a message is no act
  assert.equal(pictured([],[]),null);
});

test('pictured: a fight the pilot was in, its death or a find naming something new overrides, as the moment holding it',()=>{
  const mines=[act(0,'spacemolt/mine',0.2),act(60,'spacemolt/mine',0.2),act(120,'spacemolt/mine',0.2)];
  const death=act(500,'player_died',6),alert=act(400,'battle_alert',2,{involvement:INVOLVEMENT.nearby});
  const fight={start:iso(400),end:iso(500),score:6,raw:6,approximate:false,events:[alert,death],lead:death,supporting:[],earlier:[],identities:[]};
  assert.equal(pictured([fight],[...mines,alert,death]),fight);
  assert.equal(pictured([fight],[...mines,alert])?.lead.category,'extraction'); // a battle only heard of overrides nothing
  const found=act(300,'drone_survey',1,{first:0.5}),seen={...fight,events:[found],lead:found};
  assert.equal(pictured([seen],[...mines,found]),seen);
  assert.equal(pictured([seen],[...mines,{...found,first:0}])?.lead.category,'extraction');
});

// Live 2026-10-18 (kvothe 3db6ff6c): five hours of 226 jumps, 41 gas harvests at Market Prime's gas plume, 25 trades, 13 mission acts
// and 6 crafts drew the deposit of argon at the station; the flight was the harvest. The frames are the live ones, cut to the window
// and the fields read, one in four travel and upkeep acts kept (test-support/frames-kvothe-3db6ff6c.jsonl).
test('pictured, from the live frames: 3db6ff6c is the gas harvest',()=>{
  const lines=readFileSync(new URL('../test-support/frames-kvothe-3db6ff6c.jsonl',import.meta.url),'utf8').trim().split('\n').map(l=>JSON.parse(l) as JournalLine);
  const all=score(fromFrames(lines)),lo='2026-10-18T16:37:34.581Z',hi='2026-10-18T21:50:23.593Z',inScope=all.filter(e=>e.at>=lo&&e.at<=hi);
  const m=pictured(momentsIn(all,lo,hi),inScope);
  assert.equal(m?.lead.category,'extraction');
  assert.deepEqual([m?.lead.pilot?.poi_type,m?.lead.pilot?.system],['gas_cloud','market_prime']);
  assert.ok(inScope.filter(e=>e.type==='spacemolt/jump').length>inScope.filter(e=>e.type==='spacemolt/mine').length); // travel was still the most frequent act
});

test('poisOf reads every POI\'s type, class and system from the frames\' get_system replies',()=>{
  const at='2026-10-19T08:00:00.000Z',pois=[{id:'betelgeuse_prime_star',type:'sun',class:'M2Ia'},{id:'first_step_prime',type:'planet',class:'arid'},{id:'gate',type:'jump_gate'}];
  const got=poisOf([{at,dir:'in',frame:{type:'result',payload:{structuredContent:{system:{id:'first_step',pois}}}}},{at,dir:'in',frame:{type:'ok',payload:{}}}]);
  assert.deepEqual(Object.fromEntries(got),{betelgeuse_prime_star:{type:'sun',class:'M2Ia',system:'first_step'},first_step_prime:{type:'planet',class:'arid',system:'first_step'},
    gate:{type:'jump_gate',class:null,system:'first_step'}});
});

// Live 2026-10-19 (kvothe): the whole frame log, 506 MB, was read for every scene, 2.6 GB resident; it grows ~225 MB a day.
test('readSince: the frames give the same events and POIs with the unread replies left unparsed',()=>{
  const runtime=join(mkdtempSync(join(tmpdir(),'spacemolt-frames-')),'runtime');
  try {
    mkdirSync(runtime,{recursive:true});
    writeFileSync(join(runtime,'frames.jsonl'),readFileSync(new URL('../test-support/frames-kvothe-2026-10-19.jsonl',import.meta.url)));
    const read=readSince(runtime,'');
    assert.ok(read.length<DEATH_FRAMES.length-40,`only ${DEATH_FRAMES.length-read.length} lines left unparsed`); // 45 get_status replies
    assert.deepEqual(fromFrames(read),fromFrames(DEATH_FRAMES));
    assert.deepEqual(poisOf(read),poisOf(DEATH_FRAMES));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('readSince: lines before the horizon are skipped and no older file is opened; ids restart per connection; long lines keep their characters',()=>{
  const runtime=join(mkdtempSync(join(tmpdir(),'spacemolt-frames-')),'runtime');
  try {
    mkdirSync(runtime,{recursive:true});
    const line=(at:string,dir:string,frame:Record<string,unknown>)=>JSON.stringify({at,dir,frame});
    // Opened, it would throw: a directory where the oldest rotated file would be.
    mkdirSync(join(runtime,'frames.2026-10-01T00-00-00Z.jsonl'));
    writeFileSync(join(runtime,'frames.2026-10-10T00-00-00Z.jsonl'),[line('2026-10-09T00:00:00.000Z','in',{type:'ok',payload:{action:'old'}}),
      line('2026-10-09T12:00:00.000Z','in',{type:'ok',payload:{action:'kept'}})].join('\n')+'\n');
    const long='é'.repeat(700_000); // 1.4 MB of two-byte characters: past the read buffer and across its edges
    writeFileSync(join(runtime,'frames.jsonl'),[
      line('2026-10-10T00:00:01.000Z','out',{tool:'spacemolt',action:'get_status',request_id:'r1'}),
      line('2026-10-10T00:00:02.000Z','in',{type:'result',payload:{result:'status'},request_id:'r1'}),
      line('2026-10-10T00:00:03.000Z','out',{tool:'spacemolt',action:'get_system',request_id:'r2'}),
      line('2026-10-10T00:00:04.000Z','in',{type:'result',payload:{result:long},request_id:'r2'}),
      line('2026-10-10T00:00:05.000Z','out',{tool:'spacemolt',action:'jump',request_id:'r1'}), // a new connection's r1
      line('2026-10-10T00:00:06.000Z','in',{type:'result',payload:{result:'jumped'},request_id:'r1'})].join('\n')); // no final newline
    const read=readSince(runtime,'2026-10-09T06:00:00.000Z');
    assert.deepEqual(read.map(l=>l.at),['2026-10-09T12:00:00.000Z','2026-10-10T00:00:01.000Z','2026-10-10T00:00:03.000Z','2026-10-10T00:00:04.000Z',
      '2026-10-10T00:00:05.000Z','2026-10-10T00:00:06.000Z']);
    assert.equal((read[3]?.frame as {payload:{result:string}}).payload.result,long);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});
