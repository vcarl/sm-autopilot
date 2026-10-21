/** A refused call by the pilot — a raw `account().commands` send or a play function — asks with the fixes for its code
 * when someone can answer; otherwise the fixes come back as pasteable calls. The runtime's own sends never ask. */
import {SpacemoltError,type Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Effect} from 'effect';
import type {ReadinessCommand} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {fixesFor} from './fixes.ts';
import {useCatalog} from './industry/crafting.ts';
import {buildFactionFacility} from './industry/facilities/facilities.ts';
import {Game} from './game.ts';
import {account,answer,bind,edge,jobEffect,onBinding,unbind,type Question} from './runtime.ts';

const INSPECT='You must be docked at that base to inspect its details.';
/** The game, with `inspect` and `faction_build` answered as the live server does: refused away from the base they need. */
const wrap=(command:ReadinessCommand,docked:()=>string|null):ReadinessCommand=>async(action,params)=>{
  if(action==='spacemolt/inspect')
    return docked()===params?.id?{structuredContent:{base_id:params?.id}}:Promise.reject(new SpacemoltError('not_docked_at_base',INSPECT));
  if(action==='spacemolt_facility/faction_build')return docked()
    ?{structuredContent:{facility_id:'f1',base_id:docked(),rent_per_cycle:0}}
    :Promise.reject(new SpacemoltError('not_docked','You must be docked at a station to perform this action.'));
  if(action==='spacemolt_facility/types')return {structuredContent:{facility_type:params?.facility_type,build_cost:5000}};
  return command(action,params);
};
/** Undocked at sol_base's POI. `pick` answers each question with the first choice starting with it; `asks:false` binds
 * nobody to answer. */
function world(pick='skip',{asks=true,docked=false}={}) {
  const game=bridgeWorld({services:['refuel','repair','storage']});
  if(!docked)game.account.server.location.docked_at=null;
  const asked:Question[]=[];
  bind({account:game.account as unknown as Account,command:wrap(game.command,()=>game.account.server.location.docked_at),
    pilot:()=>({mood:'Focused' as const}),emit:()=>{},
    ...asks?{onAsk:(question:Question)=>{asked.push(question);answer(question.choices?.find(c=>c.startsWith(pick))??'skip');}}:{}});
  return {...game,asked};
}
const raw=(action:string,params:Record<string,unknown>)=>{
  const [tool='',name='']=action.split('/');
  return (account().commands as any)[tool][name](params) as Promise<unknown>;
};

test('a raw command refused away from its base asks to go there; the way taken flies, docks and sends it again',async()=>{
  const f=world('goTo');
  try {
    const reply=await raw('spacemolt/inspect',{id:'range_base'});
    assert.deepEqual(f.asked.map(q=>q.choices),[["goTo('range_base') to dock there, then send it again",'skip']]);
    assert.match(f.asked[0]!.question,/^spacemolt\/inspect refused: not_docked_at_base — /);
    assert.deepEqual(reply,{structuredContent:{base_id:'range_base'}});
    assert.equal(f.account.server.location.docked_at,'range_base');
  } finally {unbind();}
});

test('a play function refused not docked asks to dock at the base here, then runs again',async()=>{
  const f=world('goTo');
  try {
    const out=await buildFactionFacility('faction_lockbox');
    assert.deepEqual(f.asked[0]?.choices,["goTo('sol_base') to dock there, then send it again",'skip']);
    assert.equal(out.status,'done',out.why);
    assert.equal(f.account.server.location.docked_at,'sol_base');
  } finally {unbind();}
});

test('with ask:false, or nobody to answer, nothing pauses and the fixes are pasteable calls',async()=>{
  let f=world('goTo');
  try {
    const refused=Effect.gen(function*() {
      const sent=yield* Effect.result((yield* Game).command('spacemolt/inspect',{id:'range_base'}));
      return sent._tag==='Failure'?{status:'refused' as const,did:'saw nothing',why:sent.failure.message,detail:{}}:{status:'done' as const,did:'saw',detail:{}};
    });
    const out=await edge(jobEffect('look','range_base',refused,{ask:false}));
    assert.equal(f.asked.length,0);
    assert.equal(out.status,'refused');
    assert.deepEqual(out.next,["goTo('range_base')"]);
  } finally {unbind();}
  f=world('goTo',{asks:false});
  try {
    await assert.rejects(raw('spacemolt/inspect',{id:'range_base'}),
      (error:unknown)=>error instanceof SpacemoltError&&error.code==='not_docked_at_base'&&error.message===`${INSPECT}\nnext: goTo('range_base')`);
    assert.equal(f.account.server.location.docked_at,null,'nothing was flown');
  } finally {unbind();}
});

test('the runtime\'s own sends never ask and never offer fixes',async()=>{
  const f=world('goTo');
  try {
    assert.deepEqual(await onBinding(fixesFor({action:'spacemolt_intel/query_trade_intel',params:{},code:'not_docked',message:'x'})),[]);
    assert.equal(f.asked.length,0);
  } finally {unbind();}
});

test('each code in the table builds its own ways',async()=>{
  const f=world();
  const fixes=(code:string,message='',params:Record<string,unknown>={},action='spacemolt/craft')=>
    onBinding(fixesFor({action,params,code,message})).then(rows=>rows.map(({id,choice,call,params:again})=>({id,choice,call,...again?{params:again}:{}})));
  try {
    assert.deepEqual((await fixes('not_docked')).map(row=>row.call),["goTo('sol_base')"],'the base at this POI');
    assert.deepEqual((await fixes('not_docked_at_base','',{id:'range_base'})).map(row=>row.call),["goTo('range_base')"]);
    // Verbatim from gameserver handlers/crafting.go:510.
    assert.deepEqual(await fixes('invalid_recipe',"Multiple recipes produce 'steel_plate'. Specify a recipe_id: [refine_steel basic_iron_smelting]",{id:'steel_plate',quantity:1}),[
      {id:'refine_steel',choice:'send it again with id refine_steel',call:"account().commands.spacemolt.craft({id:'refine_steel',quantity:1})",params:{id:'refine_steel',quantity:1}},
      {id:'basic_iron_smelting',choice:'send it again with id basic_iron_smelting',call:"account().commands.spacemolt.craft({id:'basic_iron_smelting',quantity:1})",params:{id:'basic_iron_smelting',quantity:1}}]);
    // Verbatim from crafting.go:504; live 10-21 the pilot typed forge_vanadian_steel.
    const notFound=(id:string)=>`Recipe '${id}' not found. Use 'catalog' with type=recipes to see all available recipes and their IDs.`;
    const recipe=(id:string,out:string)=>({id,name:id,category:'Refining',description:'',crafting_time:1,inputs:[],outputs:[{item_id:out,quantity:1}]});
    useCatalog(async()=>({version:'test',items:[],recipes:[recipe('refine_steel','steel_plate'),recipe('forge_nickel_steel','nickel_steel'),
      recipe('forge_vanadium_steel','vanadium_steel')]}) as never);
    assert.deepEqual((await fixes('invalid_recipe',notFound('forge_vanadian_steel'),{id:'forge_vanadian_steel',quantity:25})).map(row=>row.call),[
      "account().commands.spacemolt.craft({id:'forge_vanadium_steel',quantity:25})","account().commands.spacemolt.craft({id:'forge_nickel_steel',quantity:25})",
      "account().commands.spacemolt.craft({id:'refine_steel',quantity:25})"],'the nearest first');
    assert.deepEqual(await fixes('invalid_recipe',notFound('maul'),{id:'maul'}),[],'no word of it in any recipe, no guess');
    assert.deepEqual(await fixes('no_faction_storage'),[{id:'faction_lockbox',choice:"buildFactionFacility('faction_lockbox') here for 5000 cr, then send it again",
      call:"buildFactionFacility('faction_lockbox')"}],'a way that spends says what');
    assert.deepEqual(await fixes('skill_required'),[]);
  } finally {unbind();}
});

// Live 2026-10-21 (kvothe 12:49Z): a raw faction_build answered under construction, said only in its hint, and the
// pilot logged the lockbox online.
test('a mutation\'s hint reaches the pilot, with its build state: a flight line, and first in a play function\'s next',async()=>{
  const game=bridgeWorld({services:['refuel','repair','storage']}),said:string[]=[];
  const hint="Facility is under construction. Use action 'faction_list' to check progress.";
  const built={action:'faction_build',facility_id:'f1',base_id:'sol_base',rent_per_cycle:208,under_construction:true,hint};
  bind({account:game.account as unknown as Account,pilot:()=>({mood:'Focused' as const}),emit:text=>{said.push(text);},
    command:async(action,params)=>action==='spacemolt_facility/faction_build'?built
      // A read's hint says how to browse: the pilot holds its reply.
      :action==='spacemolt_facility/types'?{action:'types',hint:'Use filters to browse.'}:game.command(action,params)});
  try {
    assert.deepEqual(await raw('spacemolt_facility/faction_build',{facility_type:'faction_lockbox'}),built);
    await raw('spacemolt_facility/types',{});
    assert.deepEqual(said.filter(text=>text.startsWith('  hint')),[`  hint spacemolt_facility/faction_build: under_construction; ${hint}`]);
    const out=await buildFactionFacility('faction_lockbox');
    assert.equal(out.did,'faction_lockbox under construction at sol_base as f1');
    assert.deepEqual(out.next,[`under_construction; ${hint}`]);
  } finally {unbind();}
});

test('an unknown facility type or item offers the catalog ids nearest it, from the copy on disk',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-fixes-')),game=bridgeWorld({services:['storage']});
  writeFileSync(join(runtime,'catalog.json'),JSON.stringify({catalog:{
    facilities:[{id:'trade_nexus',name:'Trade Nexus'},{id:'trade_ledger',name:'Trade Ledger'},{id:'intel_terminal',name:'Intel Terminal'}],
    items:[{id:'iron_ore',base_value:4},{id:'vanadium_ore',base_value:30},{id:'vanadium_steel',base_value:200}]}}));
  bind({account:game.account as unknown as Account,command:game.command,runtime,pilot:()=>({mood:'Focused' as const}),emit:()=>{}});
  const ids=(code:string,message:string,params:Record<string,unknown>,action:string)=>
    onBinding(fixesFor({action,params,code,message})).then(rows=>rows.map(row=>row.id));
  try {
    // Verbatim from handlers/facility.go:1536 and exchange.go:195.
    assert.deepEqual(await ids('not_found',"Facility type 'trade_ledgr' not found. Use action 'types' to browse available types, or filter with category (e.g. category=production) or name (e.g. name=fuel cell).",
      {facility_type:'trade_ledgr'},'spacemolt_facility/types'),['trade_ledger','trade_nexus']);
    assert.deepEqual(await ids('invalid_item',"Unknown item 'vanadum_steel'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').",
      {item_id:'vanadum_steel',quantity:1},'spacemolt_market/estimate_purchase'),['vanadium_steel']);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
