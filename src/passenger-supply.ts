import {SpacemoltError} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';
import {industryLocations} from './locations.ts';

const cabin='economy_passenger_cabin';
const unavailableCodes=new Set(['not_in_faction','facility_required','insufficient_intel_level','insufficient_facility_level','permission_denied','access_denied','not_authenticated','unauthorized']);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** Intel is a dated lead, never a remote purchase quote or proof of current stock. */
export async function discoverPassengerSupply(systemId:string|undefined,maxJumps:number,command:IndustryCommand,locations=industryLocations) {
  const candidates:Record<string,unknown>[]=[],rejected:{base_id?:string;reason:string}[]=[];
  const evidence={item_id:cabin,source:'faction_trade_intel',observed_at:new Date().toISOString(),max_route_jumps:maxJumps,candidates,rejected,
    limitation:'Faction reports may be stale or incomplete. Current availability, taxes, travel cost and docking access are unknown. Obtain a fresh onsite purchase quote before fitting; no travel or purchase is performed by discovery.'};
  if(!systemId||!Number.isInteger(maxJumps)||maxJumps<1||maxJumps>2)return {...evidence,status:'unavailable',reason:'Current system and productive Logistics route allowance required'};
  let intel:Record<string,any>;
  try {intel=details(await command('spacemolt_intel/query_trade_intel',{item_id:cabin,limit:6}));}
  catch(error) {
    if(!(error instanceof SpacemoltError)||error.pendingCommand||!unavailableCodes.has(error.code))throw error;
    return {...evidence,status:'unavailable',reason:`Faction item trade intelligence unavailable: ${error.code}: ${error.message}`};
  }
  if(!Array.isArray(intel.entries)||intel.entries.length>6||!finite(intel.intel_level)||intel.intel_level<2)return {...evidence,status:'unavailable',reason:'Bounded item-level faction trade intelligence unavailable'};
  const ids=[...new Set<string>(intel.entries.map((row:any)=>row?.base_id).filter((id:unknown)=>typeof id==='string'&&id.trim()))];
  const directory=ids.length?await locations(systemId,{max_jumps:maxJumps,limit:30,observed_destination_ids:ids}):undefined;
  for(const row of intel.entries) {
    const match=directory?.destination_matches?.find(item=>item.requested_id===row?.base_id);
    const station=match?.station;
    const item=Array.isArray(row?.items)?row.items.filter((item:any)=>item?.item_id===cabin):[];
    let reason:string|undefined;
    if(!match||match.status!=='resolved'||!station||station.base_id!==row.base_id)reason=`Station identity unresolved: ${match?.status??'missing'}`;
    else if(row.system_id!==station.system_id)reason='Intel system conflicts with current station directory';
    else if(!Number.isInteger(station.hops)||station.hops!>maxJumps||station.hops!<0)reason='Station exceeds current Logistics route allowance';
    else if(item.length!==1||!finite(item[0].sell_volume)||item[0].sell_volume<1||!finite(item[0].best_sell)||item[0].best_sell<=0||!Number.isInteger(row.submitted_at_tick)||row.submitted_at_tick<0)reason='No complete dated cabin sell-side supply report';
    if(reason){rejected.push({base_id:row?.base_id,reason});continue;}
    candidates.push({base_id:station!.base_id,poi_id:station!.poi_id,system_id:station!.system_id,station_name:station!.station_name,hops:station!.hops,
      reported_supply:{sell_volume:item[0].sell_volume,best_sell:item[0].best_sell,submitted_at_tick:row.submitted_at_tick},
      availability:'unknown',all_in_cost:null,requires_fresh_onsite_quote:true});
  }
  return {...evidence,status:candidates.length?'leads':'no_established_supply',intel_level:intel.intel_level,total_reports:intel.total,
    coverage:'At most six item-filtered reports; absence is not proof of no supply elsewhere'};
}
