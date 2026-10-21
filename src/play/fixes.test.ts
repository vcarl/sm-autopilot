/** A refused call by the pilot — a raw `account().commands` send or a play function — asks with the fixes for its code
 * when someone can answer; otherwise the fixes come back as pasteable calls. The runtime's own sends never ask. */
import {SpacemoltError,type Account} from '@spacemolt/lib';
import assert from 'node:assert/strict';
import test from 'node:test';
import {Effect} from 'effect';
import type {ReadinessCommand} from '../readiness.ts';
import {bridgeWorld} from '../test-support/bridge-world.ts';
import {fixesFor} from './fixes.ts';
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
    assert.deepEqual(await fixes('invalid_recipe',"Recipe 'maul' not found. Use 'catalog' with type=recipes to see all available recipes and their IDs.",{id:'maul'}),[],
      'no list, no guess');
    assert.deepEqual(await fixes('no_faction_storage'),[{id:'faction_lockbox',choice:"buildFactionFacility('faction_lockbox') here for 5000 cr, then send it again",
      call:"buildFactionFacility('faction_lockbox')"}],'a way that spends says what');
    assert.deepEqual(await fixes('skill_required'),[]);
  } finally {unbind();}
});
