import type {Account} from '@spacemolt/lib';
import type {ExecutionContext,Home} from './execution-policy.ts';
import {details,type IndustryCommand} from './industry.ts';
import {routeSteps} from './normal-route.ts';
import {logisticsPolicy} from './logistics-policy.ts';

type Wire=Record<string,any>;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** A current-load operating estimate; projected return fuel is not a future server quote. */
export async function planTransportFuel(account:Account,command:IndustryCommand,destination:Home,homeObserved:Home&{hops?:number},context:ExecutionContext):Promise<Wire> {
  const evidence:Wire={observed_at:new Date().toISOString(),status:'blocked',blockers:[],route_quotes:[],reserve_fuel:17,
    reserve_basis:'Combined local travel and escape operating allowance',
    limitation:'Return projections assume the quoted fuel rate at current cargo load. They do not establish future fuel consumption, route duration, passenger deadlines, hazards, docking access or service availability.'};
  try {
    await account.refresh();
    const ship=account.ship,location=account.location;
    if(!ship?.id||!location?.system_id||location.in_transit||
      ![ship.fuel,ship.max_fuel,ship.cargo_used,ship.cargo_capacity].every(finite)||ship.fuel>ship.max_fuel||ship.cargo_used>ship.cargo_capacity)throw new Error('Transport fuel planning requires canonical ship fuel, cargo and stable location');
    evidence.current={ship_id:ship.id,system_id:location.system_id,poi_id:location.poi_id,docked_at:location.docked_at,
      fuel:ship.fuel,max_fuel:ship.max_fuel,cargo_used:ship.cargo_used,cargo_capacity:ship.cargo_capacity};
    if(!destination.base_id||!destination.system_id||!destination.poi_id||!context.home?.base_id||homeObserved?.base_id!==context.home.base_id||!homeObserved.system_id||!homeObserved.poi_id||!Number.isInteger(homeObserved.hops)||homeObserved.hops!<0||(context.stop_condition!=='objective'&&homeObserved.hops!>2))throw new Error('Transport fuel planning requires freshly resolved destination and remembered home within the explicit return bound');
    if((homeObserved.system_id===destination.system_id)!==(homeObserved.hops===0))throw new Error('Return home system and hop evidence disagree');
    evidence.destination=destination;evidence.home=homeObserved;
    const quote=async(target:string,maxJumps:number|null)=>{
      const result=details(await command('spacemolt/find_route',{id:target}));
      evidence.route_quotes.push({target_system:target,result});
      const steps=routeSteps(result,location.system_id,target,maxJumps);
      if(!finite(result.cargo_used)||result.cargo_used!==evidence.current.cargo_used||!finite(result.fuel_available)||result.fuel_available!==evidence.current.fuel)throw new Error('Route quote fuel or cargo does not match the current ship snapshot');
      return {kind:'actual_route_quote',fuel:result.estimated_fuel,jumps:steps.length,quote:result};
    };
    if(location.system_id===destination.system_id) {
      evidence.outbound={kind:'same_system',fuel:0,jumps:0};
      evidence.return=homeObserved.system_id===location.system_id?{kind:'same_system',fuel:0,jumps:0}:await quote(homeObserved.system_id,context.stop_condition==='objective'?null:2);
    } else {
      evidence.outbound=await quote(destination.system_id,logisticsPolicy(context).max_route_jumps);
      const average=evidence.outbound.fuel/evidence.outbound.jumps;
      // The pinned contract does not guarantee total fuel equals rate times hops.
      const rate=Math.max(evidence.outbound.quote.fuel_per_jump,average);
      evidence.return={kind:'loaded_cargo_hop_projection',fuel:homeObserved.hops!*rate,
        jumps:homeObserved.hops,fuel_per_jump:rate,quoted_fuel_per_jump:evidence.outbound.quote.fuel_per_jump,
        quoted_average_fuel_per_jump:average,cargo_used:ship.cargo_used,
        basis:'Fresh destination-to-home map hops multiplied by the larger of the quoted per-jump rate and outbound total divided by outbound jumps; reverse route and future cargo are not quoted'};
    }
    await account.refresh();
    if(account.ship?.id!==evidence.current.ship_id||account.location?.system_id!==evidence.current.system_id||account.location?.in_transit||
      account.location?.poi_id!==evidence.current.poi_id||account.location?.docked_at!==evidence.current.docked_at||account.ship?.max_fuel!==evidence.current.max_fuel||
      account.ship?.fuel!==evidence.current.fuel||account.ship?.cargo_used!==evidence.current.cargo_used||account.ship?.cargo_capacity!==evidence.current.cargo_capacity)throw new Error('Ship load, fuel or location changed while quoting transport; reassess before commitment');
    evidence.required_fuel=evidence.outbound.fuel+evidence.return.fuel+evidence.reserve_fuel;
    if(!finite(evidence.required_fuel))throw new Error('Combined itinerary fuel estimate is unavailable');
    evidence.projected_surplus=ship.fuel-evidence.required_fuel;
    if(evidence.projected_surplus<0)throw new Error('Current fuel does not cover outbound, return estimate and operating reserve');
    evidence.status='ready';
  } catch(error) {evidence.blockers.push(error instanceof Error?error.message:String(error));}
  return evidence;
}
