/** Getting somewhere and docking. One function; the id decides what it does. */
import type {FindRouteResponse,V2Location} from '@spacemolt/lib';
import {dockAt} from '../dock.ts';
import {details} from '../response-details.ts';
import {serviceShip} from '../servicing.ts';
import {FuelRouteShortfall,TravelBlocked,travelTo} from '../travel.ts';
import {acct,checkStop,command,job,pilot,step} from './runtime.ts';
import type {Outcome} from './types.ts';

export interface Trip {
  /** The quote the trip was admitted on: `target_system`, `target_poi`, `estimated_fuel`,
   * `total_jumps`. A base id resolves to its POI here, which is the arrival check. */
  route:FindRouteResponse;
  /** Where the ship is now (`GameState['location']`). */
  location:V2Location;
  jumps:number;
  /** True when the trip ended docked at the base the id named. */
  docked:boolean;
}

/** Where a nameable id lives, as the server answers it. A base id answers with the POI it
 * sits at (`target_poi`), which is what the arrival check must wait for (report 01, fix 1). */
export async function route(id:string):Promise<FindRouteResponse> {
  const answer=details(await command('spacemolt/find_route',{id})) as FindRouteResponse;
  if(!answer.found)throw new TravelBlocked(String(answer.message??`No route to ${id}`));
  return answer;
}

/** Fly to a POI, a base, or a system, jumping as many times as the route needs, and dock
 * when the target is a base. No argument means home (`pilot().home`); a run with no home
 * and no argument is refused.
 *
 * Over `find_route` + `jump`/`travel` + `dock` it adds: base ids resolved to their POI before
 * the arrival wait, the mood's fuel reserve, a refuel first when docked and short, no-go
 * systems refused, and one `partial` on stop instead of a wedged runner.
 *
 * Idempotent: already there (and docked, if a base) sends nothing and is `done`.
 * Tired: only a base is admitted (service there clears it); a POI or a system is `refused`. */
export function goTo(id?:string):Promise<Outcome<Trip>> {
  return job<Trip>('goTo',id??'home',async()=>{
    const who=pilot();
    const target=id??who.home;
    const none={route:{} as FindRouteResponse,location:acct().state.location as V2Location,jumps:0,docked:false};
    if(!target)return {status:'refused',did:'went nowhere',why:'no destination and no home set in pilot.json',detail:none};
    let quote:FindRouteResponse;
    try {quote=await route(target);}
    catch(error){return {status:'refused',did:`could not route to ${target}`,why:(error as Error).message,detail:none};}
    const detail=():Trip=>({route:quote,location:acct().state.location as V2Location,jumps:0,docked:false});
    if((who.permissions?.no_go??[]).includes(quote.target_system))
      return {status:'refused',did:`did not fly to ${target}`,why:`${quote.target_system} is in permissions.no_go`,detail:detail()};
    // A base id is what find_route resolved to a different POI; dock there on arrival.
    const isBase=quote.target_poi!==undefined&&quote.target_poi!==target;
    // A system id answers with a system and no POI of its own. Passing it on as a `poi_id`
    // is what the server rejects as "Unknown destination" after the jump was already flown
    // and paid for: a system is reached wherever in it the jump lands, so name no POI.
    const poi=quote.target_poi===undefined&&quote.target_system===target?undefined:quote.target_poi??target;
    if(who.mood==='Tired'&&!isBase)
      return {status:'refused',did:`did not fly to ${target}`,why:'Tired: only a base is admitted, to service there',detail:detail()};
    const {location}=acct().state;
    if(location?.system_id===quote.target_system&&(!poi||location.poi_id===poi)&&(!isBase||location.docked_at===target))
      return {status:'done',did:`already at ${target}${poi?'':` (${location.poi_id})`}`,detail:{...detail(),docked:Boolean(location.docked_at)}};
    step(`goTo ${poi??quote.target_system} ${quote.total_jumps?`${quote.total_jumps} jump(s)`:'same system'} ${quote.estimated_fuel} fuel quoted`);
    let jumps=0;
    try {
      const flown=await travelTo(acct(),command,{system_id:quote.target_system,...poi?{poi_id:poi}:{}},{
        mood:who.mood??'Cautious',maxJumps:null,
        checkpoint:async()=>checkStop(),
        onJump:()=>{jumps++;step(`jump ${jumps} of ${quote.total_jumps}, fuel ${acct().state.ship?.fuel}`);},
        refuel:async()=>{try {await serviceShip(acct(),command,{mood:who.mood??'Cautious',creditReserve:who.permissions?.credit_reserve??0});} catch {/* the fuel check after decides */}},
      });
      jumps=flown.jumps;
    } catch(error) {
      if(error instanceof FuelRouteShortfall) {
        const {actualFuel,requiredFuel,shortfall}=error.evidence;
        return {status:'refused',did:`did not fly to ${target}`,why:`fuel ${actualFuel}, need ${requiredFuel} with the ${who.mood} reserve; short ${shortfall}`,
          detail:detail(),next:['service() where you are docked, or a nearer destination']};
      }
      throw error;
    }
    let docked=false;
    // The dock is decided by the system's own listing, not the route heuristic: a system id
    // may also answer with a POI, and docking "at a system" would wedge here.
    const pois=poi?(details(await command('spacemolt/get_system',{})).system?.pois??[]) as {id:string;base_id?:string}[]:[];
    if(pois.some(row=>row.id===poi&&row.base_id===target)){await dockAt(acct(),command,target);docked=true;step(`docked at ${target}`);}
    return {status:'done',did:`arrived at ${target}${poi?'':` (${acct().state.location?.poi_id})`}${docked?' and docked':''} after ${jumps} jump(s)`,detail:{...detail(),jumps,docked}};
  });
}
