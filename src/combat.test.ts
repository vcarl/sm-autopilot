import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError, type Account} from '@spacemolt/lib';
import {combat, battleDecision} from './combat.ts';
import {prepareCombat} from './combat-fit.ts';
import {CommandBoundary} from './command-boundary.ts';

function fixture() {
  const state:any={player:{id:'pilot',credits:200000},ship:{id:'ship',armor:3,shield_recharge:1,fuel:120,max_fuel:120,hull:105,max_hull:105,shield:35,max_shield:35,cargo_used:1,cargo_capacity:100,weapon_slots:1,defense_slots:1,cpu_used:0,cpu_capacity:12,power_used:0,power_capacity:24,speed:2},
    location:{docked_at:'base',poi_id:'station',system_id:'system'},cargo:[{item_id:'original',quantity:1,size:1}],modules:[{module_id:'weapon',type_id:'autocannon_i',slot:'weapon',ammo_type:'autocannon',current_ammo:500,stats:{damage:10,cooldown:1,reach:2}}],skills:{},missions:{active:[]}};
  const account={state,get ship(){return state.ship;},get location(){return state.location;},get credits(){return state.player.credits;},get cargo(){return state.cargo;},async refresh(){}} as unknown as Account;
  const calls:{action:string;params:any}[]=[],records:any[]=[];
  let started=false,tick=0,now=0,stance='fire';
  const target:any={creature_id:'grazer',role:'grazer',hull:55,max_hull:55,name:'Grazer',species:'phase_lurker',in_combat:false};
  const boundary=new CommandBoundary();
  const command=async(action:string,params:any={})=>boundary.run(async(sent,completed)=>{
    sent();calls.push({action,params});
    let result:any={};
    if(action==='spacemolt_battle/status') {
      if(!started||tick>3)throw new SpacemoltError('not_in_battle','No active battle');
      result={battle_id:'battle',is_participant:true,tick_duration:0,combat_state:{max_weapon_reach:3},participants:[{player_id:'pilot',side_id:0,hull_pct:100,shield_pct:tick===0?100:88,zone:tick===0?'outer':tick===1?'mid':'engaged',stance},{player_id:target.creature_id,kind:'creature',side_id:1,hull_pct:100,zone_distance:6-tick}]};
    }
    if(action==='spacemolt/inspect')result={catalog:{items:[{id:params.id,slot:'weapon',damage:10,cpu_usage:2,power_usage:5,size:10}]}};
    if(action==='spacemolt/get_system')result={system:{pois:[{id:'belt',type:'asteroid_belt'}],connections:[{system_id:state.location.system_id==='system'?'remote':'system'}]}};
    if(action==='spacemolt/find_route'){const steps=state.location.system_id===params.id?[]:[{system_id:params.id,jumps:1}];result={found:true,target_system:params.id,total_jumps:steps.length,estimated_fuel:2*steps.length,fuel_per_jump:2,route:[{system_id:state.location.system_id,jumps:0},...steps]};}
    if(action==='spacemolt/jump'){state.location.system_id=params.id;state.ship.fuel-=2;}
    if(action==='spacemolt/undock')state.location.docked_at=null;
    if(action==='spacemolt/travel'){state.location.poi_id=params.id;state.ship.fuel--;}
    if(action==='spacemolt/dock')state.location.docked_at='base';
    if(action==='spacemolt/get_nearby')result={creatures:[target]};
    if(action==='spacemolt/scan')result={success:true,target_id:target.creature_id};
    if(action==='spacemolt/hunt')started=true;
    if(action==='spacemolt_battle/stance')stance=params.id;
    if(action==='spacemolt_battle/summary')result={status:'completed',outcome:'victory',winning_side:0};
    if(action==='spacemolt_salvage/wrecks')result={wrecks:started?[{id:'carcass',victim_id:target.creature_id,cargo:[{item_id:'meat',quantity:2,size:1}]},{id:'other',victim_id:'other',cargo:[]}]:[]};
    if(action==='spacemolt_salvage/loot'){state.cargo.push({item_id:params.item_id,quantity:params.quantity,size:1});state.ship.cargo_used+=params.quantity;}
    if(action==='spacemolt_storage/view')result={items:[]};
    if(action==='spacemolt_market/estimate_purchase')result={unfilled:0,total_cost:3000};
    completed();return {structuredContent:result};
  });
  return {account,command,state,calls,records,target,deps:{save:(r:any)=>records.push(r),now:()=>now,sleep:async(ms:number)=>{now+=ms;tick=Math.floor(now/10000);}}};
}

test('one wildlife sortie advances, verifies victory, loots only its victim and returns with original assets and fuel liability',async()=>{
  const f=fixture();
  f.state.missions.active=[{type:'distress_response',mission_id:'automatic'}];
  f.target.creature_id='fresh-individual';
  const result:any=await combat('hunt',{poi_id:'belt',species:'phase_lurker',target_system_id:'remote'},f.account,f.command,f.deps);
  assert.equal(f.calls.filter(c=>c.action==='spacemolt/hunt').length,1);
  assert.equal(f.calls.find(c=>c.action==='spacemolt/hunt')?.params.id,f.target.creature_id);
  assert.equal(f.calls.filter(c=>c.action==='spacemolt_battle/advance').length,2);
  assert.ok(result.fight.verified_victory);
  assert.equal(result.fight.retreated,false);
  assert.equal(f.state.location.docked_at,'base');
  assert.deepEqual(f.calls.filter(c=>c.action==='spacemolt/jump').map(c=>c.params.id),['remote','system']);
  assert.deepEqual(f.state.cargo[0],{item_id:'original',quantity:1,size:1});
  assert.deepEqual(f.calls.filter(c=>c.action==='spacemolt_salvage/loot').map(c=>c.params.id),['carcass']);
  assert.equal(result.cash_delta,0);
  assert.equal(result.fuel_liability_units,result.before.ship.fuel-result.after.ship.fuel);
  assert.ok(result.fuel_liability_units>0);
  assert.ok(f.records.some(r=>r.event==='battle_tick'));
});

test('starter gates prevent unsafe targets and spending; withdrawal stays latched and an unknown hunt is never followed by movement',async()=>{
  for(const change of [{role:'predator',species:'unknown'},{branded:true},{max_hull:1000},{in_combat:true}]) {
    const f=fixture();Object.assign(f.target,change);
    await combat('hunt',{poi_id:'belt',creature_id:'grazer'},f.account,f.command,f.deps);
    assert.ok(!f.calls.some(c=>c.action==='spacemolt/hunt'));
    assert.equal(f.state.location.docked_at,'base');
  }
  const f=fixture();f.state.modules=[];
  await assert.rejects(prepareCombat({weapon_id:'laser',execute:true,max_spend:100},f.account,f.command),/budget/);
  const blocked:any=await combat('prepare',{weapon_id:'laser',execute:true,max_spend:100},f.account,f.command,f.deps);
  assert.equal(blocked.status,'blocked');
  assert.ok(!f.calls.some(c=>c.action==='spacemolt/buy'));
  const status={tick_duration:1,combat_state:{},participants:[{player_id:'pilot',hull_pct:75,zone:'engaged'},{player_id:'grazer'}]};
  const first=battleDecision(status,'pilot','grazer',false,0.8);
  assert.equal(first.stance,'flee');status.participants[0]!.hull_pct=100;
  assert.equal(battleDecision(status,'pilot','grazer',first.retreat,0.8).stance,'flee');
  const changed=fixture();let observations=0;
  const declined:any=await combat('hunt',{poi_id:'belt',species:'phase_lurker'},changed.account,async(a,p)=>{
    const result=await changed.command(a,p);
    if(a==='spacemolt/get_nearby'&&++observations===2)result.structuredContent.pirates=[{pirate_id:'arrived-after-scan'}];
    return result;
  },changed.deps);
  assert.equal(declined.fight.status,'engagement_declined');
  assert.ok(!changed.calls.some(c=>c.action==='spacemolt/hunt'));
  assert.equal(changed.state.location.docked_at,'base');
  const unknown=fixture();
  await assert.rejects(combat('hunt',{poi_id:'belt',creature_id:'grazer'},unknown.account,async(a,p)=>{
    if(a==='spacemolt/hunt'){unknown.calls.push({action:a,params:p});throw new Error('connection lost after send');}
    return unknown.command(a,p);
  },unknown.deps),/connection lost/);
  assert.equal(unknown.calls.at(-1)?.action,'spacemolt/hunt');
  assert.equal(unknown.records.at(-1)?.event,'sortie_interrupted');
});
