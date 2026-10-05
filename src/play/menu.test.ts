import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TICK_MS} from '../sighting-memory.ts';
import {journalRun,readJournal} from '../run-record.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {worldDb} from './world.ts';
import {leadCall,menuEffect,MOVES,MOVES_CHARS,renderMenu,threatsHere} from './menu.ts';
import {sell} from './market.ts';
import {tradeRun} from './trading/trading.ts';
import {orient} from './orient.ts';
import {bind,onBinding,runCalls,unbind,type Pilot} from './runtime.ts';

const menu=(runtime?:string)=>onBinding(menuEffect(runtime));

/** A world docked at sol_base, its runtime holding `books` as remembered (each `age` ticks before now). */
function world(record:Pilot,options:WorldOptions={},books:{base_id:string;age:number;system_id?:string;items:Record<string,unknown>[]}[]=[]) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-menu-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify(books.map(({base_id,age,system_id,items})=>({base_id,at:'',tick:TICK-age,
    ...system_id?{system_id}:{},items:items.map(row=>({best_buy:0,best_buy_qty:0,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[],...row}))}))));
  const game=bridgeWorld({services:['refuel','repair','storage'],store:[],...options});
  // The shared world serves no skills or tax read: the game refuses what it does not serve, and an assertion would be a defect.
  const command:typeof game.command=async(action,params)=>{
    if(action==='spacemolt/get_skills'||action==='spacemolt/get_tax_estimate')throw new SpacemoltError('unknown_action',`not served here: ${action}`);
    return game.command(action,params);
  };
  bind({account:game.account as unknown as Account,command,pilot:()=>record,runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
type Game=ReturnType<typeof world>;
const gens=(built:{moves:{gen:string}[]})=>built.moves.map(m=>m.gen);

// Gems sell here at 90; range_base, a jump away, bids 110 for them and 25 for ore that asks 10 here.
const HERE=[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50},
  {item_id:'ore',best_buy:5,best_buy_qty:50,best_sell:10,best_sell_qty:50}];
const RANGE=[{item_id:'gem',best_buy:110,best_buy_qty:50,best_sell:0,best_sell_qty:0},{item_id:'ore',best_buy:25,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
const TRADE:WorldOptions={cargo:[{item_id:'gem',quantity:5}],cargoUsed:5,cargoCapacity:20,markets:{sol_base:HERE,range_base:RANGE}};
const RANGE_BOOK={base_id:'range_base',age:0,system_id:'deep_range',items:RANGE};
/** A `run ended` line with one top-level call, `minutes` long, `ago` ms before now. */
const paid=(runtime:string,call:string,credits:number,minutes:number,ago=0,stops?:string[])=>journalRun(runtime,{phase:'ended',script:'index.ts',outcome:'done',
  at:new Date(Date.now()-ago).toISOString(),calls:[{fn:call.split('(')[0],call,credits,seconds:minutes*60,...stops?{stops}:{}}]});

test('best route: routes()\'s top row as the call, with its net, jumps and the age of each book',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},TRADE,[RANGE_BOOK]);
  try {
    const built=await menu(f.runtime);
    const route=built.moves.find(m=>m.gen==='route');
    assert.equal(route?.call,"tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})",JSON.stringify(built.moves));
    assert.equal(route!.facts.jumps,1);
    assert.deepEqual(route!.facts.books,['sol_base live','range_base 0t']);
    assert.ok(route!.facts.credits>0&&route!.facts.minutes>0,JSON.stringify(route!.facts));
    assert.match(route!.said,/^route: \+[\d,]+ cr net, 1 jumps, ~[\d.]+ min; books range_base 0t$/);
  } finally {f.close();}
});

test('again: the last paying loop as written, with each of its last runs\' credits and minutes; an old one, a mission, a loss, a sale only are not',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},{...TRADE,markets:{sol_base:[]}},[RANGE_BOOK]);
  const loop="tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})";
  try {
    paid(f.runtime,"tradeRun({stops:[{at:'old_base'}]})",9_000,10,13*3600_000);
    paid(f.runtime,loop,1_200,10,3600_000,['sol_base','range_base']);
    paid(f.runtime,loop,1_800,20,1800_000,['sol_base','range_base']);
    paid(f.runtime,"completeMissions()",5_000,1);
    paid(f.runtime,"sell([{item_id:'ore'}])",-50,1);
    paid(f.runtime,"tradeRun({stops:[{at:'range_base'}]})",700,2,0,['range_base']);
    const again=(await menu(f.runtime)).moves.find(m=>m.gen==='again');
    assert.equal(again?.call,loop);
    assert.deepEqual([again!.facts.credits,again!.facts.minutes,again!.facts.runs],[1_500,15,[{credits:1_200,minutes:10},{credits:1_800,minutes:20}]]);
    assert.match(again!.said,/^again: last 2: \+1,200 cr in 10 min, \+1,800 cr in 20 min; books now sol_base \S+, range_base \S+$/);
  } finally {f.close();}
});

test('a tradeRun and a sell keep the call as written on run ended, which is what again offers',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},TRADE,[RANGE_BOOK]);
  try {
    await sell([{item_id:'gem',quantity:5}]);
    assert.equal(runCalls().at(-1)?.call,"sell([{item_id:'gem',quantity:5}])");
    await tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]});
    assert.equal(runCalls().at(-1)?.call,"tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})");
  } finally {f.close();}
});

test('settle: goods in a store elsewhere carried to the best bid known; a bid that does not cover the fuel is not offered',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'},{cargo:[],cargoUsed:0,markets:{sol_base:[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:0,best_sell_qty:0}]}},
    [{base_id:'range_base',age:30,system_id:'deep_range',items:[{item_id:'scrap',best_buy:1,best_buy_qty:1}]}]);
  try {
    worldDb(f.runtime)!.prepare("INSERT INTO stores VALUES('range_base','gem',10,NULL,'x'),('sol_base','scrap',1,NULL,'x')").run();
    const built=await menu(f.runtime);
    const settle=built.moves.find(m=>m.gen==='settle');
    assert.equal(settle?.call,"tradeRun({stops:[{at:'range_base',buy:'gem',from:'store'},{at:'sol_base'}]})",JSON.stringify(built.moves));
    assert.equal(settle!.facts.credits,900-2*7,'two jumps there and back, 7 fuel a jump at 1 cr');
    assert.equal(settle!.said,'settle: 10 gem (store range_base) → sol_base bid 90×50, live; 2 jumps, +886 cr after fuel');
    assert.ok(!built.moves.some(m=>m.call.includes('scrap')),'1 scrap at a bid of 1, a jump away, is not worth the fuel');
  } finally {f.close();}
});

test('settle: goods aboard with the best bid here are a sell here',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'},{cargo:[{item_id:'gem',quantity:5}],cargoUsed:5,markets:{sol_base:HERE}});
  try {
    const built=await menu(f.runtime);
    assert.equal(built.moves.find(m=>m.gen==='settle')?.call,"sell([{item_id:'gem',quantity:5}])",JSON.stringify(built.moves));
  } finally {f.close();}
});

test('missions: turn in what is done; else the best-paying offer with its issuer; full, the stuck one to drop for it; nothing to take, no drop',async()=>{
  const f=world({mood:'Focused',stance:'Carrier'},{cargo:[],cargoUsed:0});
  const mission=(id:string,percent:number,extra:Record<string,unknown>={})=>({mission_id:id,title:`Job ${id}`,type:'delivery',difficulty:1,
    percent_complete:percent,expires_in_ticks:360,rewards:{credits:2_000},objectives:[],...extra});
  try {
    f.board[0]={...f.board[0]!,giver:{name:'Kael Voss',title:'Quartermaster'},faction_name:'Solarian Confederacy',issuing_base:'Sol Base',
      warnings:['Hostile territory']} as never;
    let built=await menu(f.runtime);
    let row=built.moves.find(m=>m.gen==='missions');
    assert.equal(row?.call,"acceptMission('m1')",JSON.stringify(built.moves));
    assert.match(row!.said,/^mission: Deliver ore, \+1,000 cr, from Kael Voss \(Quartermaster\), Solarian Confederacy, Sol Base; first: 20 ore to Sol Base \(have 0\).*; Hostile territory$/);

    f.taken.push(mission('done',100));
    row=(await menu(f.runtime)).moves.find(m=>m.gen==='missions');
    assert.deepEqual([row?.call,row?.facts.credits],['completeMissions()',2_000]);

    f.taken.splice(0,1,...['a','b','c','d'].map(id=>mission(id,10)),
      mission('stuck',0,{objectives:[{description:'Bring 5 gem',item_id:'gem',required:5,current:0}]}));
    row=(await menu(f.runtime)).moves.find(m=>m.gen==='missions');
    assert.equal(row?.call,"abandonMission('stuck')",JSON.stringify(row));
    assert.match(row!.said,/^drop Job stuck \(needs 5 more gem\); a slot takes Deliver ore here, \+1,000 cr, from Kael Voss/);

    f.board.splice(0);
    assert.ok(!(await menu(f.runtime)).moves.some(m=>m.gen==='missions'),'an abandon with nothing to take is not offered');
  } finally {f.close();}
});

test('variety: at most four moves, never two from one generator; the objective\'s move keeps the last slot',async()=>{
  // Five generators fire: a route, a loop to repeat, a store to settle, a mission done, and (told to explore) a system.
  const f=world({mood:'Focused',stance:'Trader',objective:'explore the frontier'},TRADE,[RANGE_BOOK]);
  try {
    worldDb(f.runtime)!.prepare("INSERT INTO stores VALUES('range_base','gem',10,NULL,'x')").run();
    paid(f.runtime,"tradeRun({stops:[{at:'range_base',buy:'gem'},{at:'sol_base'}]})",50_000,10);
    f.taken.push({mission_id:'done',title:'Done',type:'delivery',difficulty:1,percent_complete:100,expires_in_ticks:360,rewards:{credits:900_000},objectives:[]});
    const built=await menu(f.runtime);
    assert.equal(built.moves.length,MOVES,JSON.stringify(built.moves));
    assert.equal(new Set(gens(built)).size,built.moves.length,JSON.stringify(gens(built)));
    assert.deepEqual(gens(built),['missions','again','route','explore'],'explore earns nothing, and still holds the objective\'s slot over settle');
    assert.equal(built.moves.at(-1)?.call,"goTo('deep_range')");
    assert.deepEqual(built.moves.map(m=>m.id),['m1','m2','m3','m4']);
    const text=renderMenu(built);
    assert.ok(text.length<=MOVES_CHARS,`${text.length}`);
    assert.match(text,/^m1 `/);
  } finally {f.close();}
});

test('no same-system goTo rows: a docked pilot with POIs around it and no explore objective is offered none',async()=>{
  // Audit 10-04 (kvothe): 181 of 411 rows were same-system POIs at "route quotes 0 fuel", the quote to the system itself.
  const f=world({mood:'Focused',stance:'Prospector',objective:'obtain credits'},{cargoUsed:6,pois:[{id:'moon',type:'planet'}]});
  try {
    const built=await menu(f.runtime);
    assert.ok(!built.moves.some(m=>m.call.startsWith('goTo(')),JSON.stringify(built.moves));
    assert.ok(!JSON.stringify(built).includes('0 fuel'),JSON.stringify(built));
  } finally {f.close();}
});

test("an objective that says \"skill\" is not a hunting objective, and the phase named first leads",()=>{
  // Live 2026-09-24. Unanchored, the earliest match anywhere in this sentence was `kill` at index
  // 13 — inside "skill" — so every objective that mentioned skills read as a hunt.
  const objective="Train every skill to level 5. First run: orient() and note() the current level of "
    +"every skill. Then close the gaps in this order: a gatherUntil mining trip (mining, piloting, "
    +"navigation) -> sell at a rich counter or a tradeRun (trading) -> exploreNearby on unvisited "
    +"systems (exploration) -> hunts at a creature habitat -> a pirate fight -> craft at a workshop";
  assert.equal(leadCall({mood:'Focused',stance:'Prospector',objective}),'gatherUntil');
  assert.equal(leadCall({mood:'Focused',stance:'Hunter',objective}),'gatherUntil');
  assert.equal(leadCall({mood:'Focused',stance:'Prospector',objective:'cull the fauna at the belt'}),'hunt');
  assert.equal(leadCall({mood:'Focused',stance:'Hunter'}),'hunt');
  assert.equal(leadCall({mood:'Focused',stance:'Hunter',objective:'sell at the store, then explore'}),'tradeRun');
  assert.equal(leadCall({mood:'Focused',stance:'Scout',objective:'determine what is out there before anything else'}),'goTo');
  assert.equal(leadCall({mood:'Focused',stance:'Trader',objective:'Find and complete missions'}),'acceptMission');
});

test('a fight at the POI is a threat; docked, the same brawl outside is not',()=>{
  const location={system_id:'sol',poi_id:'belt',nearby_players:[{player_id:'p1',username:'Raider',in_combat:true}]} as never;
  assert.deepEqual(threatsHere(location,null),['Raider']);
  assert.deepEqual(threatsHere(location,'sol_base'),[]);
});

// Live 2026-09-25: a pilot woke at hull 3/80 inside a battle left over from the previous shift
// and died a second after its first move. `orient` answered where it was, what it held and what
// it owed, and never that it was in a fight — so the fight goes first, ahead of every other fact.
test('orient leads with the battle holding the ship',async()=>{
  const grazer={creature_id:'c1',species:'molt_grazer',name:'Molt Grazer'};
  const f=world({mood:'Focused',stance:'Hunter'},{wildlife:{creatures:[grazer],polls:20,damage:0}});
  try {
    const calm=await orient();
    assert.ok(!calm.did.includes('IN BATTLE'),calm.did);
    assert.equal(calm.detail.battle,undefined);
    await f.command('spacemolt/hunt',{id:'c1'});
    const out=await orient();
    assert.match(out.did,/^IN BATTLE with Molt Grazer \(battle tick \d+\): disengage\(\) or fight it;/);
    assert.equal(out.detail.battle?.opponent,'Molt Grazer');
  } finally {f.close();}
});

test('the menu carries each held mission by its next step, with the jumps to a base it knows',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(f.runtime,'places.json'),JSON.stringify({range_base:'deep_range'}));
    const visit=(base:string,completed:boolean)=>({description:`Visit ${base}`,type:'visit',required:1,current:completed?1:0,completed,target_base:base});
    f.taken.push({mission_id:'c1',title:'Circuit',type:'diplomacy',difficulty:1,percent_complete:50,expires_in_ticks:360,rewards:{credits:1},
      objectives:[visit('sol_base',true),visit('range_base',false)]});
    const before=Date.now(),built=await menu(f.runtime);
    assert.equal(built.held?.max,5);
    assert.equal(built.held?.missions[0]?.next,'Visit range_base → range_base, 1 jump [2 of 2]');
    const due=Date.parse(built.held!.missions[0]!.expires_at!);
    assert.ok(due>=before+360*TICK_MS&&due<=Date.now()+360*TICK_MS,built.held!.missions[0]!.expires_at);
  } finally {f.close();}
});

// The menu is read-only: a read refused or lost leaves its section out, and neither is a bug, so neither writes a `defect` line.
const READS=/^(get_|view|find_route|list|browse_|inspect|query_|estimate_)/;
function faulty(f:Game,record:Pilot,fault:(action:string)=>unknown) {
  const sent:string[]=[];
  const command:typeof f.command=async(action,params)=>{
    sent.push(action);
    const failure=fault(action);
    if(failure)throw failure;
    return f.command(action,params);
  };
  bind({account:f.account as unknown as Account,command,pilot:()=>record,runtime:f.runtime,emit:()=>{}});
  return sent;
}
const defects=(runtime:string)=>readJournal(runtime).filter(line=>line.event==='defect');

// The menu is the juncture's context: one that does not build is a pilot flying blind. Every read it makes is a section it can do without.
for(const [name,fault] of [['refused',()=>new SpacemoltError('rate_limited','slow down')],['lost',()=>new ConnectionClosedError()]] as const)
  for(const action of ['spacemolt/get_base','spacemolt/find_route','spacemolt/get_map','spacemolt_market/view_market',
    'spacemolt/get_active_missions','spacemolt/get_missions'])
    test(`a ${name} ${action} leaves its section out, the menu still builds, nothing it sends is a mutation, and no defect is written`,async()=>{
      const record:Pilot={mood:'Focused',stance:'Trader'};
      const f=world(record,TRADE,[RANGE_BOOK]);
      try {
        const sent=faulty(f,record,asked=>asked===action?fault():undefined);
        const built=await menu(f.runtime);
        assert.ok(sent.includes(action),action);
        assert.ok(Array.isArray(built.moves),JSON.stringify(built));
        assert.deepEqual(sent.filter(asked=>!READS.test(asked.split('/')[1]??'')),[]);
        assert.deepEqual(defects(f.runtime),[]);
      } finally {f.close();}
    });

test('a bug in a read leaves only that section out, and journals a defect line naming it',async()=>{
  for(const action of ['spacemolt/get_map','spacemolt/get_active_missions','spacemolt/get_missions']) {
    const record:Pilot={mood:'Focused',stance:'Trader'};
    const f=world(record,TRADE,[RANGE_BOOK]);
    try {
      faulty(f,record,asked=>asked===action?new TypeError(`bug in ${action}`):undefined);
      const built=await menu(f.runtime);
      assert.ok(Array.isArray(built.moves),action);
      const lines=defects(f.runtime);
      assert.ok(lines.length>=1&&lines.every(line=>typeof line.fn==='string'&&String(line.why).includes(action)),`${action}: ${JSON.stringify(lines)}`);
    } finally {f.close();}
  }
});

// Every juncture builds a menu, and the menu reads the active missions: an expiry is still one line.
test('a mission seen running and then expired is journalled expired once, however many menus are built',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'});
  const row=(expires_in_ticks:number)=>({mission_id:'menu-late',title:'Late run',type:'delivery',description:'',difficulty:1,accepted_at:'',
    issuing_base:'sol_base',expires_in_ticks,percent_complete:0,rewards:{credits:1_000},objectives:[]});
  const expired=()=>readJournal(f.runtime).filter(line=>line.event==='mission'&&line.verb==='expired'&&line.mission_id==='menu-late');
  try {
    f.taken.push(row(100));
    await menu(f.runtime);
    f.taken.splice(0,1,row(0));
    await menu(f.runtime);
    await menu(f.runtime);
    assert.equal(expired().length,1,JSON.stringify(expired()));
  } finally {f.close();}
});

test('the live server\'s null for an empty list, and a board row that does not read, are not a failed build',async()=>{
  const record:Pilot={mood:'Cautious',stance:'Trader'};
  const f=world(record);
  try {
    const command:typeof f.command=async(action,params)=>{
      const res:any=await f.command(action,params);
      if(action==='spacemolt_market/view_market'||action==='spacemolt_storage/view')(res.structuredContent??res).items=null;
      if(action==='spacemolt/get_missions')res.structuredContent.missions=[{title:'no id'},
        {mission_id:'t1',title:'Sell ore',type:'sell',difficulty:1,objectives:null,rewards:{credits:9}}];
      return res;
    };
    bind({account:f.account as unknown as Account,command,pilot:()=>record,runtime:f.runtime,emit:()=>{}});
    const built=await menu(f.runtime);
    assert.ok(built.moves.some(m=>m.call==="acceptMission('t1')"),JSON.stringify(built));
    assert.deepEqual(defects(f.runtime),[]);
  } finally {f.close();}
});
