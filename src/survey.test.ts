import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {GameState,StationList} from '@spacemolt/lib';
import {surveyMarkets} from './survey.ts';

function fixture(){
  const account={state:{player:{credits:200000},ship:{fuel:100,max_fuel:100,hull:80,max_hull:80},cargo:[{item_id:'ore',quantity:10}],location:{system_id:'a',poi_id:'a_station',docked_at:'a_base'}} as unknown as GameState,async refresh(){}};
  const stations=async()=>({stations:[{id:'b_station',base_id:'b_base',poi_id:'b_station',system_id:'b',name:'B',wrecked:false}],empires:[]} as unknown as StationList);
  const calls:string[]=[];
  const command=async(action:string,params:Record<string,unknown>)=>{
    calls.push(action);
    const state=account.state;
    if(action==='spacemolt/find_route'){
      const to=String(params.id).slice(0,1),from=state.location!.system_id;
      return {structuredContent:{found:true,target_system:to,target_poi:params.id,total_jumps:from===to?0:1,estimated_fuel:from===to?0:2,fuel_per_jump:2,route:from===to?[{system_id:from,jumps:0}]:[{system_id:from,jumps:0},{system_id:to,jumps:1}]}};
    }
    if(action==='spacemolt/get_system')return {structuredContent:{system:{connections:[{system_id:state.location!.system_id==='a'?'b':'a'}]}}};
    if(action==='spacemolt/undock')state.location!.docked_at=null;
    if(action==='spacemolt/jump'){state.location!.system_id=String(params.id);state.ship!.fuel-=2;}
    if(action==='spacemolt/travel'){state.location!.poi_id=String(params.id);state.ship!.fuel--;}
    if(action==='spacemolt/dock')state.location!.docked_at=state.location!.system_id+'_base';
    return {};
  };
  return {account,stations,calls,command};
}

test('survey discovers at verified station and returns with measured fuel liability without trading assets',async()=>{
  const f=fixture(),rows:Record<string,unknown>[]=[];
  const result=await surveyMarkets({station_ids:['b_base']},f.account,f.command,async()=>{
    assert.equal(f.account.state.location!.docked_at,'b_base');return {candidates:[{recipe_id:'new'}]};
  },{stations:f.stations,record:r=>rows.push(r)});
  assert.equal(result.total_jumps,2);
  assert.equal(result.returned_to_origin,true);
  assert.equal(result.travel_fuel_units,6);
  assert.equal(result.fuel_liability_units,6);
  assert.equal(result.cash_delta,0);
  assert.equal(result.comparisons.length,1);
  assert.equal(f.account.state.cargo![0]!.quantity,10);
  assert.ok(!f.calls.some(action=>/buy|sell|refuel|repair/.test(action)));
  assert.ok(rows.some(row=>row.event==='survey'));
});

test('insufficient fuel blocks movement and an ambiguous jump failure never triggers recovery commands',async()=>{
  const f=fixture();f.account.state.ship!.fuel=11;
  await assert.rejects(surveyMarkets({station_ids:['b_base']},f.account,f.command,async()=>({}),{stations:f.stations,record:()=>{}}),/fuel budget/);
  assert.ok(!f.calls.includes('spacemolt/undock'));
  const broken=fixture();let jumps=0;
  const command=async(action:string,params:Record<string,unknown>)=>{
    if(action==='spacemolt/jump'){jumps++;throw new Error('unknown outcome');}
    return broken.command(action,params);
  };
  await assert.rejects(surveyMarkets({station_ids:['b_base']},broken.account,command,async()=>({}),{stations:broken.stations,record:()=>{}}),/unknown outcome/);
  assert.equal(jumps,1);
  assert.ok(!broken.calls.includes('spacemolt/travel'));
  assert.ok(!broken.calls.includes('spacemolt/dock'));
});
