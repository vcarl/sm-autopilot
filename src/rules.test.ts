import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateRules,PolicyDenied,type Rule} from './rules.ts';
import {resolveContext} from './execution-policy.ts';
import {executionCatalog} from './execution.ts';
import {gatherFixture} from './gather-fixture.ts';
import {executionFixture} from './execution-fixture.ts';
import {validateAction} from './policy.ts';
import {battleDecision} from './combat.ts';
import type {IndustryCommand} from './industry.ts';

const has=(decision:{reasons:{id:string}[]},id:string)=>decision.reasons.some(reason=>reason.id===id);

test('rules compose all denials, unique evidence, tightest margins and strongest exit; trusted attention never broadens authority',()=>{
  const contributions:Rule[]=[
    {id:'owner',when:()=>true,then:()=>({allowed:false,reason:'owner bound',limits:{max_ticks:8,retreat_hull_fraction:.9},obligations:['preserve_custody'],exit:'next_checkpoint'})},
    {id:'operator',when:()=>true,then:()=>({allowed:true,reason:'urgent return',limits:{max_ticks:12,retreat_hull_fraction:.95},obligations:['preserve_custody','record_unfinished'],exit:'return_now'})},
  ];
  const decision=evaluateRules({phase:'checkpoint'},[...contributions,contributions[0]!]);
  assert.equal(decision.allowed,false);
  assert.deepEqual(decision.limits,{max_ticks:8,retreat_hull_fraction:.95});
  assert.deepEqual(decision.obligations,['preserve_custody','record_unfinished']);
  assert.equal(decision.reasons.length,2);assert.equal(decision.exit,'return_now');
  const focused=resolveContext({stance:'Industry',mood:'Focused',objective:'Gather ore'});
  const opportunity=resolveContext({mood:'Opportunistic'},focused);
  const attention={related:false,safe:true,bounded:true,advantage:20,switchingCost:5};
  assert.equal(evaluateRules({phase:'checkpoint',action:'gather',context:focused,attention,custody:false}).allowed,false);
  assert.equal(evaluateRules({phase:'checkpoint',action:'gather',context:opportunity,attention,custody:false}).allowed,true);
  for(const facts of [{custody:true},{attention:{...attention,safe:false}},{attention:{...attention,bounded:false}},{attention:{...attention,advantage:undefined}},{attention:{...attention,switchingCost:20}},{tired:true}]) {
    assert.equal(evaluateRules({phase:'checkpoint',action:'gather',context:opportunity,attention,custody:false,...facts}).allowed,false);
  }
  const locked={...focused,authority:{mood:'Focused' as const},permissions:{wildlife:false}};
  assert.throws(()=>resolveContext({mood:'Aggressive',wildlife:true},locked),error=>error instanceof PolicyDenied&&has(error.decision,'authority.mood'));
  assert.equal(resolveContext({mood:'Tired'},locked).mood,'Tired');
  assert.throws(()=>resolveContext({limits:{max_ticks:100}},focused),error=>error instanceof PolicyDenied&&has(error.decision,'limits.tighten'));
  for(const [action,params,id] of [
    ['spacemolt/refuel',{target:'other'},'command.self_service'],
    ['spacemolt_storage/deposit',{credits:1},'command.storage'],
    ['spacemolt/craft',{source:'faction'},'command.craft_storage'],
  ] as const)assert.throws(()=>validateAction(action,params),error=>error instanceof PolicyDenied&&has(error.decision,id));
  for(const action of ['toString','constructor','__proto__'])assert.equal(evaluateRules({phase:'catalog',context:focused,action}).allowed,false);
  const status={participants:[{player_id:'self',hull_pct:100,zone:'outer'},{player_id:'target'}],combat_state:{}};
  const firing=battleDecision(status,'self','target',false,.9);
  assert.equal(firing.retreat,false);assert.equal(firing.advance,true);
  const retreat=battleDecision(status,'self','target',false,.9,undefined,{emptyWeapon:true});
  assert.equal(retreat.retreat,true);assert.equal(retreat.decision.exit,'return_now');assert.ok(has(retreat.decision,'battle.retreat'));
});

test('actual execution checkpoints reject unrelated Focused work and Tired, preserve fixed catalog/custody, and persist rule receipts',async t=>{
  const f=gatherFixture(t);await f.choose();
  const catalog=JSON.stringify(executionCatalog(f.execution.context));
  const send=f.account.send.bind(f.account);
  let diversionDenied=false;
  f.account.send=async(tool,action,params)=>{
    if(action==='get_poi') {
      const command=(f.execution as unknown as {command:IndustryCommand}).command;
      await assert.rejects(command('spacemolt/sell',{item_id:'ore',quantity:1}),error=>{
        diversionDenied=error instanceof PolicyDenied&&has(error.decision,'attention.focused');return diversionDenied;
      });
    }
    const result=await send(tool,action,params);
    if(action==='mine')f.execution.signal('Tired during gathering');
    return result;
  };
  const job:any=await f.execution.dispatch('gather',{poi_id:'belt',cycles:2});
  assert.equal(diversionDenied,true);
  assert.equal(f.calls.some(call=>call.key==='spacemolt/sell'),false);
  assert.equal(f.calls.filter(call=>call.key==='spacemolt/mine').length,1);
  assert.equal(f.state.location.docked_at,'base');
  assert.equal(f.state.ship.fuel,f.state.ship.max_fuel);
  assert.equal(JSON.stringify(executionCatalog(f.execution.context)),catalog);
  const stored=JSON.parse(readFileSync(f.store.path,'utf8')).jobs.find((row:any)=>row.id===job.id);
  for(const id of ['attention.focused','stop.productive','budget.owner'])assert.ok(stored.decisions.some((row:any)=>has(row.decision,id)),id);
  assert.ok(stored.decisions.some((row:any)=>row.phase==='terminal'&&row.decision.exit==='return_now'));
  assert.deepEqual(stored.decisions,job.decisions);
  const hunt=executionFixture(t);await hunt.choose();
  const completed:any=await hunt.execution.dispatch('hunt',{poi_id:'belt'});
  assert.ok(completed.decisions.some((row:any)=>row.phase==='battle'));
  assert.ok(completed.decisions.some((row:any)=>has(row.decision,'terminal.principal')));
  await assert.rejects(hunt.execution.dispatch('hunt',{poi_id:'belt'}),error=>error instanceof PolicyDenied&&has(error.decision,'stop.productive'));  const reserve=executionFixture(t);await reserve.choose();reserve.execution.context.limits.credit_reserve=195000;
  const observe=reserve.account.send.bind(reserve.account);
  reserve.account.send=async(tool,action,params)=>{const reply=await observe(tool,action,params);if(action==='inspect')reserve.state.player.credits=190000;return reply;};
  const blocked:any=await reserve.execution.dispatch('hunt',{poi_id:'belt'});
  assert.equal(reserve.calls.some(row=>row.key==='spacemolt/hunt'),false);
  assert.ok(blocked.decisions.some((row:any)=>row.phase==='checkpoint'&&has(row.decision,'allocation.wallet')));

});
