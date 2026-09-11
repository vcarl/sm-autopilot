import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type Account,SpacemoltError} from '@spacemolt/lib';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';
import {resolveContext} from './execution-policy.ts';
export function executionFixture(t:any) {
  const directory=mkdtempSync(join(tmpdir(),'spacemolt-jobs-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const state:any={player:{id:'pilot',credits:200000},ship:{id:'ship',armor:3,shield_recharge:1,fuel:120,max_fuel:120,hull:105,max_hull:105,shield:35,max_shield:35,cargo_used:1,cargo_capacity:100,speed:2},location:{system_id:'system',poi_id:'station',docked_at:'base'},cargo:[{item_id:'original',quantity:1,size:1}],modules:[{module_id:'weapon',type_id:'autocannon_i',slot:'weapon',ammo_type:'autocannon',current_ammo:500,stats:{damage:10,cooldown:1,reach:2}}],skills:{},missions:{active:[{id:'existing-obligation'}]}};
  let fight=false,tick=0,now=0,stance='fire';
  const calls:any[]=[];
  const account={state,get ship(){return state.ship;},get credits(){return state.player.credits;},get cargo(){return state.cargo;},get location(){return state.location;},async refresh(){},async send(tool:string,action:string,params:any){
    const key=tool+'/'+action;calls.push({key,params});let result:any={};
    if(key==='spacemolt_shipping/active')result={action:'active',shipments:[],tick:0};
    if(key==='spacemolt/list_passengers')result={count:0,passengers:[]};
    if(key==='spacemolt/craft')result={kind:'queue',jobs:null,total_jobs:0};
    if(key==='spacemolt/get_base')result={fuel_price_all_in:3};
    if(key==='spacemolt/inspect')result={catalog:{items:[{id:params.id,damage:10}]}};
    if(key==='spacemolt/get_system')result={system:{pois:[{id:'belt',type:'asteroid_belt'}]}};
    if(key==='spacemolt_battle/status') {
      if(!fight||tick>3)throw new SpacemoltError('not_in_battle','no battle');
      result={battle_id:'battle',is_participant:true,combat_state:{},participants:[{player_id:'pilot',side_id:0,hull_pct:100,shield_pct:100,zone:'engaged',stance},{player_id:'quarry',side_id:1,hull_pct:100}]};
    }
    if(key==='spacemolt/get_nearby')result={creatures:[{creature_id:'quarry',species:'phase_lurker',role:'grazer',hull:55,max_hull:55}]};
    if(key==='spacemolt/scan')result={success:true};
    if(key==='spacemolt/hunt')fight=true;
    if(key==='spacemolt_battle/stance')stance=params.id;
    if(key==='spacemolt_battle/summary')result={battle_id:'battle',status:'completed',outcome:'victory',winning_side:0};
    if(key==='spacemolt/undock')state.location.docked_at=null;
    if(key==='spacemolt/travel'){state.location.poi_id=params.id;state.ship.fuel--;}
    if(key==='spacemolt/dock')state.location.docked_at=state.location.poi_id==='other'?'other':'base';
    if(key==='spacemolt/refuel'){const cost=(120-state.ship.fuel)*3;state.player.credits-=cost;state.ship.fuel=120;result={cost,fuel:120,source:'station'};}
    return {structuredContent:result};
  }} as unknown as Account;
  const store=new ExecutionStore(directory,'pilot');
  const context=resolveContext({objective:'One verified hunt',mood:'Aggressive'});context.permissions.wildlife=true;
  const execution=new Execution(account,store,context,{locations:async()=>({origin_system:'system',max_jumps:2,total_stations:2,stations:[{base_id:'base',poi_id:'station',system_id:'system',system_name:'System',station_name:'Base',services:['refuel'],hops:0},{base_id:'other',poi_id:'other',system_id:'system',system_name:'System',station_name:'Other',services:['refuel'],hops:0}],limitation:'fixture directory'}),combat:{save:()=>{},now:()=>now,sleep:async(ms)=>{now+=ms;tick=Math.floor(now/10000);}}});
  const choose=async()=>{await execution.dispatch('observe');await execution.dispatch('plan',{home_base_id:'base',home_rationale:'Services near wildlife and existing storage'});execution.handoff();};
  const attack=()=>{fight=true;tick=0;now=0;stance='fire';};
  return {execution,account,state,calls,store,directory,choose,attack};
}
