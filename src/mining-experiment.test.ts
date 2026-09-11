import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {GameState} from '@spacemolt/lib';
import {miningExperiment} from './mining-experiment.ts';

function fixture(yieldQuantity:number) {
  const state={player:{credits:1000},location:{docked_at:'base',poi_id:'station',system_id:'system'},ship:{id:'ship',cpu_used:2,cpu_capacity:20,power_used:5,power_capacity:20,fuel:120,max_fuel:120,hull:80,max_hull:80,shield:0,max_shield:0,cargo_capacity:100,cargo_used:10,utility_slots:2},cargo:[{item_id:'ore',quantity:10,size:1}],modules:[{module_id:'laser',type_id:'mining_laser_i',slot:'utility',cpu_usage:2,power_usage:5,stats:{mining_power:10}}]} as unknown as GameState;
  const calls:{action:string;params:Record<string,unknown>}[]=[];
  const account={state,async refresh(){}};
  const command=async(action:string,params:Record<string,unknown>)=> {
    calls.push({action,params});
    if(action==='spacemolt/get_system')return {structuredContent:{system:{pois:[{id:'station'},{id:'belt'}]}}};
    if(action==='spacemolt/undock')state.location!.docked_at=null;
    if(action==='spacemolt/travel'){state.location!.poi_id=String(params.id);state.ship!.fuel--;}
    if(action==='spacemolt/dock')state.location!.docked_at='base';
    if(action==='spacemolt/mine'){state.cargo![0]!.quantity+=yieldQuantity;state.ship!.cargo_used+=yieldQuantity;state.ship!.fuel--;return {command:'mine',tick:123,delta:{cargo:state.cargo}};}
    if(action==='spacemolt_market/view_market')return {structuredContent:{items:[{item_id:'ore',buy_orders:[{quantity:5,price:10}]}]}};
    if(action==='spacemolt/sell'){state.cargo![0]!.quantity-=Number(params.quantity);state.ship!.cargo_used-=Number(params.quantity);state.player!.credits+=Number(params.quantity)*10;}
    if(action==='spacemolt/refuel'){const cost=(120-state.ship!.fuel)*3;state.player!.credits-=cost;state.ship!.fuel=120;return {cost,fuel:120,source:'station'};}
    return {};
  };
  return {account,command,calls};
}

test('measured sale preserves original ore and fully accounts for fuel service',async()=>{
  const f=fixture(7), records:Record<string,unknown>[]=[];
  const result=await miningExperiment({poi_id:'belt',cycles:1,credit_reserve:100,max_service_spend:20,refuel_unit_quote:3},f.account,f.command,{record:r=>records.push(r)});
  assert.equal(result.status,'completed');
  assert.ok('cash_delta' in result);
  assert.equal(f.account.state.cargo![0]!.quantity,12);
  assert.deepEqual(f.calls.find(c=>c.action==='spacemolt/sell')?.params,{id:'ore',quantity:5,auto_list:false});
  assert.equal(result.cash_delta,41);
  assert.equal(result.realized_profit,41);
  assert.equal(result.fuel_liability_units,0);
  assert.deepEqual(result.unsold,{ore:2});
  assert.deepEqual(result.yields,{ore:7});
  assert.ok(Number.isFinite(Date.parse(result.at)));
  assert.ok(records.some(r=>r.event==='mining_experiment'));
});

test('no-yield mining stops after one attempt, returns to origin and reports unpriced fuel',async()=>{
  const f=fixture(0);
  const result=await miningExperiment({poi_id:'belt',cycles:20,credit_reserve:100},f.account,f.command,{record:()=>{}});
  assert.equal(f.calls.filter(c=>c.action==='spacemolt/mine').length,1);
  assert.equal(f.calls.filter(c=>c.action==='spacemolt/sell').length,0);
  assert.equal(f.account.state.location!.docked_at,'base');
  assert.equal(f.account.state.cargo![0]!.quantity,10);
  assert.ok('stop_reason' in result);
  assert.equal(result.stop_reason,'no_yield');
  assert.equal(result.fuel_liability_units,3);
  assert.equal(result.realized_profit,null);
});


test('canonical mixed-resource gains are measured when mine response has no details',async()=>{
  const f=fixture(2);
  const command=async(action:string,params:Record<string,unknown>)=>{
    const reply=await f.command(action,params);
    if(action==='spacemolt/mine'){
      const cargo=f.account.state.cargo!;
      const carbon=cargo.find(i=>i.item_id==='carbon_ore');
      if(carbon)carbon.quantity++;else cargo.push({item_id:'carbon_ore',item_name:'Carbon Ore',quantity:1,size:1});
      f.account.state.ship!.cargo_used++;
    }
    return reply;
  };
  const result=await miningExperiment({poi_id:'belt',cycles:2,credit_reserve:100},f.account,command,{record:()=>{}});
  assert.ok('yields' in result);
  assert.deepEqual(result.yields,{ore:4,carbon_ore:2});
  assert.equal(result.stop_reason,'cycle_limit');
  assert.deepEqual(result.unsold,{ore:0,carbon_ore:2});
  assert.equal(f.account.state.cargo!.find(i=>i.item_id==='ore')!.quantity,10);
});


test('retaining crafting inputs deposits only new ore and does not book stored stock as profit',async()=>{
  const f=fixture(7);
  let stored=30;
  const deposits:Record<string,unknown>[]=[];
  const command=async(action:string,params:Record<string,unknown>)=>{
    if(action==='spacemolt_storage/view')return {structuredContent:{items:[{item_id:'ore',quantity:stored}]}};
    if(action==='spacemolt_storage/deposit'){
      deposits.push(params);
      stored+=Number(params.quantity);
      f.account.state.cargo![0]!.quantity-=Number(params.quantity);
      f.account.state.ship!.cargo_used-=Number(params.quantity);
      return {};
    }
    return f.command(action,params);
  };
  const result=await miningExperiment({poi_id:'belt',cycles:1,retain_items:['ore'],credit_reserve:100,max_service_spend:20,refuel_unit_quote:3},f.account,command,{record:()=>{}});
  assert.ok('retained' in result);
  assert.deepEqual(deposits,[{item_id:'ore',quantity:7}]);
  assert.equal(f.account.state.cargo![0]!.quantity,10);
  assert.equal(stored,37);
  assert.equal(f.calls.filter(c=>c.action==='spacemolt/sell').length,0);
  assert.deepEqual(result.retained,{ore:7});
  assert.deepEqual(result.unsold,{ore:0});
  assert.equal(result.cash_delta,-9);
  assert.equal(result.realized_profit,-9);
});

test('cross-system sortie validates normal routes, returns to exact station and accounts for jump fuel/time',async()=>{
  const f=fixture(7);
  let now=0;
  const command=async(action:string,params:Record<string,unknown>)=>{
    now+=1000;
    const state=f.account.state;
    const here=state.location!.system_id;
    if(action==='spacemolt/find_route'){
      const target=params.id==='belt'?'remote':'system';
      return {structuredContent:{found:true,target_system:target,target_poi:params.id,total_jumps:1,estimated_fuel:here==='remote'?5:4,fuel_per_jump:5,route:[{system_id:here,jumps:0},{system_id:target,jumps:1}]}};
    }
    if(action==='spacemolt/get_system')return {structuredContent:{system:{pois:[{id:here==='remote'?'belt':'station'}],connections:[{system_id:here==='remote'?'system':'remote'}]}}};
    if(action==='spacemolt/jump'){
      now+=19000;state.ship!.fuel-=here==='remote'?5:4;state.location!.system_id=String(params.id);state.location!.poi_id='entrance';return {};
    }
    if(action==='spacemolt/travel')now+=9000;
    return f.command(action,params);
  };
  const result=await miningExperiment({poi_id:'belt',target_system_id:'remote',cycles:1,credit_reserve:100,max_service_spend:40,refuel_unit_quote:3},f.account,command,{now:()=>now,record:()=>{}});
  assert.ok('travel_fuel_units' in result);
  assert.equal(result.travel_fuel_units,11);
  assert.equal(result.travel_seconds,60);
  assert.equal(result.realized_profit,50-(4+5+2+1)*3);
  assert.equal(result.fuel_liability_units,0);
  assert.equal(result.target_system_id,'remote');
  assert.equal(f.account.state.location!.system_id,'system');
  assert.equal(f.account.state.location!.poi_id,'station');
  assert.equal(f.account.state.location!.docked_at,'base');
  assert.equal(result.route_evidence.length,3);
  const bad=fixture(1);
  await assert.rejects(miningExperiment({poi_id:'belt',target_system_id:'remote'},bad.account,async(action,params)=>{
    if(action==='spacemolt/find_route')return {found:true,target_system:'remote',target_poi:'belt',total_jumps:1,estimated_fuel:1,fuel_per_jump:1,route:[{system_id:'system',jumps:0},{system_id:'remote',jumps:1,via_wormhole:true}]};
    return bad.command(action,params);
  },{record:()=>{}}),/wormhole/);
  assert.equal(bad.calls.some(call=>call.action==='spacemolt/undock'),false);
});
