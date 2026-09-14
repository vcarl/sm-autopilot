import type {Home,ExecutionContext} from './execution-policy.ts';
import {industryLocations} from './locations.ts';

/** Directory reachability is necessary for shared return, not a fuel or arrival-time quote. */
export async function validateTransportReturn(destination:Home,context:ExecutionContext,locations:typeof industryLocations=industryLocations) {
  const maxJumps=context.stop_condition==='objective'?null:2;
  const evidence:Record<string,any>={checked_at:new Date().toISOString(),source:'public_station_directory_and_map',
    origin_system:destination.system_id,home_base_id:context.home?.base_id,max_jumps:maxJumps,status:'blocked',
    limitation:'Directory reachability only; fuel, service prices, docking access, hazards and delivery time are not established.'};
  if(!context.home?.base_id){evidence.reason='Transport return requires a remembered home';return evidence;}
  try {
    const ids=[...new Set([destination.base_id,context.home.base_id])];
    const observation=await locations(destination.system_id,{max_jumps:maxJumps,limit:30,observed_destination_ids:ids,refresh_map:true});
    evidence.observation=observation;
    if(observation.origin_system!==destination.system_id)throw new Error('Return directory origin does not match delivery system');
    const resolve=(id:string)=>{
      let station;
      if(observation.destination_matches!==undefined) {
        const matches=observation.destination_matches.filter(row=>row.requested_id===id);
        if(matches.length!==1||matches[0]!.status!=='resolved')throw new Error(`Transport station ${id} resolution: ${matches.length===1?matches[0]!.status:'missing or ambiguous'}`);
        station=matches[0]!.station;
      } else {
        const matches=observation.stations?.filter(row=>row.base_id===id)??[];
        if(matches.length!==1)throw new Error(`Transport station ${id} is missing or ambiguous`);
        station=matches[0];
      }
      if(station?.base_id!==id||!station.system_id||!station.poi_id||!Number.isInteger(station.hops)||station.hops! < 0||(maxJumps!==null&&station.hops! > maxJumps))throw new Error('Transport station exceeds explicit return bound or lacks canonical evidence');
      return station;
    };
    const currentDestination=resolve(destination.base_id);
    if(currentDestination.system_id!==destination.system_id||currentDestination.poi_id!==destination.poi_id)throw new Error('Delivery station moved since assessment; reassess before taking custody or traveling');
    evidence.destination=currentDestination;
    const station=resolve(context.home.base_id);
    evidence.status='reachable';evidence.home=station;
  } catch(error) {evidence.reason=error instanceof Error?error.message:String(error);}
  return evidence;
}

export function transportReceipt(result:unknown):Record<string,any>|undefined {
  const row=result as Record<string,any>|undefined;
  return row?.transport??(row?.partial?transportReceipt(row.partial):undefined);
}
