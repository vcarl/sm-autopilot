import assert from 'node:assert/strict';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TICK_MS} from '../sighting-memory.ts';
import {readJournal} from '../run-record.ts';
import {bridgeWorld,TICK,type WorldOptions} from '../test-support/bridge-world.ts';
import {heldEffect,threatsHere} from './state.ts';
import {sell} from './market.ts';
import {tradeRun} from './trading/trading.ts';
import {orient} from './orient.ts';
import {bind,onBinding,runCalls,unbind,type Pilot} from './runtime.ts';

const state=(runtime?:string)=>onBinding(heldEffect(runtime));

/** A world docked at sol_base, its runtime holding `books` as remembered (each `age` ticks before now). */
function world(record:Pilot,options:WorldOptions={},books:{base_id:string;age:number;system_id?:string;items:Record<string,unknown>[]}[]=[]) {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-state-'));
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

// Gems sell here at 90; range_base, a jump away, bids 110 for them and 25 for ore that asks 10 here.
const HERE=[{item_id:'gem',best_buy:90,best_buy_qty:50,best_sell:100,best_sell_qty:50},
  {item_id:'ore',best_buy:5,best_buy_qty:50,best_sell:10,best_sell_qty:50}];
const RANGE=[{item_id:'gem',best_buy:110,best_buy_qty:50,best_sell:0,best_sell_qty:0},{item_id:'ore',best_buy:25,best_buy_qty:50,best_sell:0,best_sell_qty:0}];
const TRADE:WorldOptions={cargo:[{item_id:'gem',quantity:5}],cargoUsed:5,cargoCapacity:20,markets:{sol_base:HERE,range_base:RANGE}};
const RANGE_BOOK={base_id:'range_base',age:0,system_id:'deep_range',items:RANGE};
test('a tradeRun and a sell keep the call as written on run ended',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},TRADE,[RANGE_BOOK]);
  try {
    await sell([{item_id:'gem',quantity:5}]);
    assert.equal(runCalls().at(-1)?.call,"sell([{item_id:'gem',quantity:5}])");
    await tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]});
    assert.equal(runCalls().at(-1)?.call,"tradeRun({stops:[{at:'sol_base',buy:'ore'},{at:'range_base'}]})");
  } finally {f.close();}
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

test('the state carries each held mission by its next step, with the jumps to a base it knows',async()=>{
  const f=world({mood:'Focused',stance:'Trader'},{cargoUsed:0});
  try {
    writeFileSync(join(f.runtime,'places.json'),JSON.stringify({range_base:'deep_range'}));
    const visit=(base:string,completed:boolean)=>({description:`Visit ${base}`,type:'visit',required:1,current:completed?1:0,completed,target_base:base});
    f.taken.push({mission_id:'c1',title:'Circuit',type:'diplomacy',difficulty:1,percent_complete:50,expires_in_ticks:360,rewards:{credits:1},
      objectives:[visit('sol_base',true),visit('range_base',false)]});
    const before=Date.now(),built=await state(f.runtime);
    assert.equal(built.held?.max,5);
    assert.equal(built.held?.missions[0]?.next,'Visit range_base → range_base, 1 jump [2 of 2]');
    const due=Date.parse(built.held!.missions[0]!.expires_at!);
    assert.ok(due>=before+360*TICK_MS&&due<=Date.now()+360*TICK_MS,built.held!.missions[0]!.expires_at);
  } finally {f.close();}
});

// The state is read-only: a read refused or lost leaves its section out, and neither is a bug, so neither writes a `defect` line.
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

// The state is the juncture's context: one that does not build is a pilot flying blind. Every read it makes is a section it can do without.
for(const [name,fault] of [['refused',()=>new SpacemoltError('rate_limited','slow down')],['lost',()=>new ConnectionClosedError()]] as const)
  for(const action of ['spacemolt/get_map','spacemolt/get_active_missions'])
    test(`a ${name} ${action} leaves its section out, the state still builds, nothing it sends is a mutation, and no defect is written`,async()=>{
      const record:Pilot={mood:'Focused',stance:'Trader'};
      const f=world(record,TRADE,[RANGE_BOOK]);
      try {
        const sent=faulty(f,record,asked=>asked===action?fault():undefined);
        const built=await state(f.runtime);
        assert.ok(sent.includes(action),action);
        assert.ok(action==='spacemolt/get_map'?built.held:!built.held,JSON.stringify(built));
        assert.deepEqual(sent.filter(asked=>!READS.test(asked.split('/')[1]??'')),[]);
        assert.deepEqual(defects(f.runtime),[]);
      } finally {f.close();}
    });

test('a bug in a read leaves only that section out, and journals a defect line naming it',async()=>{
  for(const action of ['spacemolt/get_map','spacemolt/get_active_missions']) {
    const record:Pilot={mood:'Focused',stance:'Trader'};
    const f=world(record,TRADE,[RANGE_BOOK]);
    try {
      faulty(f,record,asked=>asked===action?new TypeError(`bug in ${action}`):undefined);
      await state(f.runtime);
      const lines=defects(f.runtime);
      assert.ok(lines.length>=1&&lines.every(line=>typeof line.fn==='string'&&String(line.why).includes(action)),`${action}: ${JSON.stringify(lines)}`);
    } finally {f.close();}
  }
});

// Every juncture reads the state, and that reads the active missions: an expiry is still one line.
test('a mission seen running and then expired is journalled expired once, however many times the state is read',async()=>{
  const f=world({mood:'Focused',stance:'Prospector'});
  const row=(expires_in_ticks:number)=>({mission_id:'state-late',title:'Late run',type:'delivery',description:'',difficulty:1,accepted_at:'',
    issuing_base:'sol_base',expires_in_ticks,percent_complete:0,rewards:{credits:1_000},objectives:[]});
  const expired=()=>readJournal(f.runtime).filter(line=>line.event==='mission'&&line.verb==='expired'&&line.mission_id==='state-late');
  try {
    f.taken.push(row(100));
    await state(f.runtime);
    f.taken.splice(0,1,row(0));
    await state(f.runtime);
    await state(f.runtime);
    assert.equal(expired().length,1,JSON.stringify(expired()));
  } finally {f.close();}
});
