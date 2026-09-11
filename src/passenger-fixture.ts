import {executionFixture} from './execution-fixture.ts';
import {resolveContext} from './execution-policy.ts';

/** Offline passenger server behavior around the real shared executor. */
export function passengerFixture(t:any,options:{autoDeliver?:boolean;missingFare?:boolean;destination?:string}={}) {
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Logistics',mood:'Focused',objective:'Deliver passengers to one observed destination and return serviced'},f.execution.context);
  const passenger={citizen_id:'passenger',name:'Passenger',bio:'Fixture citizen',destination:options.destination??'other',destination_name:'Other',destination_system:'system',class:'economy',ticks_remaining:30,base_fare:8};
  let rows:any[]=[],onBoard:(()=>void)|undefined;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params:any={}):Promise<any>=>{
    const reply=await send(tool,action,params);
    const key=tool+'/'+action;
    let result:any;
    if(key==='spacemolt/list_passengers')result={count:rows.length,passengers:structuredClone(rows),berths:{economy:{free:2-rows.length,total:2},business:{free:0,total:0},first:{free:0,total:0}}};
    if(key==='spacemolt/list_station_passengers')result={station:'base',count:1,waiting:[{...passenger,estimated_fare:8}]};
    if(key==='spacemolt/load_passenger') {
      rows.push({...passenger});result={count:1,loaded:[{...passenger}],total_fare:8};onBoard?.();
    }
    if(key==='spacemolt/dock'&&f.state.location.docked_at==='other'&&options.autoDeliver!==false&&rows.length) {
      const delivered=rows;rows=[];f.state.player.credits+=107;
      result={passenger_arrivals:{delivered,...(options.missingFare?{}:{fare_collected:7})}};
    }
    if(key==='spacemolt/unload_passenger') {
      rows=rows.filter(row=>row.citizen_id!==params.id);f.state.player.credits+=107;
      result={kind:'single',delivered:true,...(options.missingFare?{}:{fare_collected:7})};
    }
    return result===undefined?reply:{structuredContent:result};
  };
  return {...f,onBoard:(callback:()=>void)=>{onBoard=callback;},passengers:()=>structuredClone(rows)};
}
