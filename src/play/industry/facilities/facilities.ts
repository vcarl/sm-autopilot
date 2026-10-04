/** Owning production. Not a separate specialty: the stage the Industry career grows into once
 * a bench's margins are proven, so the pilot who already stands at the counter keeps the fee
 * instead of paying it. A build grants corporation_management xp once, and a facility bills rent
 * every cycle (100 ticks, ~17 min) from your wallet, everywhere it stands, whether or not you
 * are there to see it.
 */
import type {FacilityBuildResponse,FacilityListResponse,FacilityOwnedResponse,FacilityPersonalBuildResponse,
  FacilityTypeDetailResponse,FacilityTypeListResponse,FacilityTypeSummary,OwnedFacilityEntry,
  ViewStorageResponse} from '@spacemolt/lib';
import {details} from '../../../response-details.ts';
import {acct,admit,command,job,pilot} from '../../runtime.ts';
import type {Outcome} from '../../types.ts';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
/** Fallback only: a live `owned` read carries its own `grace_cycles`; this is what to assume
 * the one time it does not. */
const DEFAULT_GRACE_CYCLES=260;

/** The owned entry beside the one number the game does not compute: how many cycles the
 * wallet covers at the TOTAL rent across every facility you own, everywhere — not this one's
 * rent alone, because the wallet that pays it is the same wallet for all of them. */
export type Owned=OwnedFacilityEntry&{runway_cycles:number};

/** A facility at this station worth queuing a job at: yours, or public with a fee. `id` is
 * what the owner verbs below and a bench's `at` option take. */
export interface Rentable {
  id:string;type:string;name:string;recipe_id?:string;labour?:number;fee_per_run?:number;public:boolean;
}

/** This base's store, item rows only — `buildFacility` escrows materials out of here, never
 * the hold. */
async function storeRows():Promise<{item_id:string;quantity:number}[]> {
  return ((details(await command('spacemolt_storage/view',{})) as ViewStorageResponse).items??[])
    .map(row=>({item_id:row.item_id,quantity:row.quantity}));
}

type Facilities={owned:Owned[];here:Rentable[];buildable:FacilityTypeSummary[]};

/** Your facilities everywhere, what is rentable at this station, and what you could build
 * here. Reads only (`facility/owned`, `facility/list`, `facility/types` for the production and
 * personal categories) — never `job_list`, which fails for a facility you are not docked at.
 * Each read is independent: one failing does not fail the others, and `did` says which.
 * `next` warns when the rent runway is under the game's own grace period. */
export function facilities():Promise<Outcome<Facilities>> {
  return job<Facilities>('facilities','',async()=>{
    const failed:string[]=[];
    let owned:Owned[]=[],graceCycles=DEFAULT_GRACE_CYCLES,runwayCycles=Infinity;
    try {
      const reply=details(await command('spacemolt_facility/owned',{})) as FacilityOwnedResponse;
      const totalRent=reply.rent?.total_rent_per_cycle??0;
      graceCycles=reply.rent?.grace_cycles??DEFAULT_GRACE_CYCLES;
      runwayCycles=totalRent>0?Math.floor((acct().state.player?.credits??0)/totalRent):Infinity;
      owned=(reply.facilities??[]).map(entry=>({...entry,runway_cycles:runwayCycles}));
    } catch(error){failed.push(`owned: ${message(error)}`);}

    const docked=acct().state.location?.docked_at;
    let here:Rentable[]=[];
    if(docked) {
      try {
        const reply=details(await command('spacemolt_facility/list',{})) as FacilityListResponse;
        const mine=new Set((reply.player_facilities??[]).map(entry=>entry.facility_id));
        const seen=new Set<string>();
        for(const entry of [...reply.station_facilities??[],...reply.player_facilities??[],
          ...reply.faction_facilities??[],...reply.public_facilities??[]]) {
          if(seen.has(entry.facility_id))continue;
          seen.add(entry.facility_id);
          const fee=entry.production?.rental_fee_per_run;
          const isPublic=entry.production?.public===true;
          // L5 station facilities (repair, market...) carry no fee and are not public: skip
          // them unless they are mine — owning one still belongs in the count.
          if(!mine.has(entry.facility_id)&&!(isPublic&&fee))continue;
          here.push({id:entry.facility_id,type:entry.type,name:entry.name,...entry.recipe_id===undefined?{}:{recipe_id:entry.recipe_id},
            ...entry.labor_per_cycle===undefined?{}:{labour:entry.labor_per_cycle},...fee===undefined?{}:{fee_per_run:fee},public:isPublic});
        }
      } catch(error){failed.push(`here: ${message(error)}`);}
    }

    // ponytail: two category reads (production, personal) rather than one unfiltered browse.
    // An unfiltered `types` answers the discovery view (categories and pagination, no rows),
    // and this pilot can build neither an infrastructure, faction, nor service type anyway.
    const buildable:FacilityTypeSummary[]=[];
    for(const category of ['production','personal'] as const) {
      try {
        const reply=details(await command('spacemolt_facility/types',{category,per_page:50})) as FacilityTypeListResponse;
        buildable.push(...(reply.types??[]).filter(type=>type.buildable!==false));
      } catch(error){failed.push(`${category} types: ${message(error)}`);}
    }

    const did=[owned.length?`${owned.length} facilit${owned.length===1?'y':'ies'} owned`:'none owned',
      docked?`${here.length} rentable here`:'not docked: here is empty',
      `${buildable.length} buildable here`,...failed].join('; ');
    return {status:'done',did,detail:{owned,here,buildable},
      next:owned.length&&runwayCycles<graceCycles
        ?[`rent runway ${runwayCycles} cycles is under the ${graceCycles}-cycle grace; earn or pay down arrears`]:[]};
  });
}

export interface Built {facility_id:string;rent_per_cycle:number;ready_tick?:number}

/** Build a facility of `type` at this station: quarters first if the game asks for them, then
 * a workshop of your own. Owned already here → `done`, nothing sent. Refused, naming the
 * shortfall, when this station's store is short a build material or the price would breach
 * `credit_reserve`. Costs the build price at commit; construction pauses rent until it
 * completes; the build grants corporation_management xp once. */
export function buildFacility(type:string):Promise<Outcome<Built>> {
  return job<Built>('buildFacility',type,async()=>{
    const none={facility_id:'',rent_per_cycle:0};
    const refuse=(why:string,next:string[]=[])=>({status:'refused' as const,did:`did not build ${type}`,why,detail:none,next});
    const blocked=await admit('buildFacility');
    if(blocked)return refuse(blocked);

    const docked=acct().state.location?.docked_at;
    const before=(details(await command('spacemolt_facility/owned',{})) as FacilityOwnedResponse).facilities??[];
    const mine=before.find(entry=>entry.type===type&&entry.base_id===docked);
    if(mine)return {status:'done',did:`${type} already owned at ${docked} as ${mine.facility_id}`,
      detail:{facility_id:mine.facility_id,rent_per_cycle:mine.rent_per_cycle}};
    if(!docked)return refuse('buildFacility happens at a station and the ship is not docked');

    const typed=details(await command('spacemolt_facility/types',{facility_type:type})) as FacilityTypeDetailResponse;
    if(typed.kind!=='detail')return refuse(`no facility type '${type}'`);

    const store=await storeRows();
    const held=(item:string)=>store.find(row=>row.item_id===item)?.quantity??0;
    const short=(typed.build_materials??[]).map(row=>({...row,have:held(row.item_id)}))
      .filter(row=>row.have<row.quantity);
    if(short.length)
      return refuse(`${type} needs ${short.map(row=>`${row.item_id} ${row.have} of ${row.quantity}`).join(', ')} in ${docked}'s store`,
        short.map(row=>`buy('${row.item_id}', ${row.quantity-row.have}, {deliverTo:'storage'}) or stow it there`));

    const credits=acct().state.player?.credits??0;
    const reserve=pilot().permissions?.credit_reserve??0;
    if(credits-typed.build_cost<reserve)
      return refuse(`${type} costs ${typed.build_cost} cr; ${credits} less the ${reserve} credit reserve cannot cover it`);

    const action=typed.category==='personal'?'spacemolt_facility/personal_build':'spacemolt_facility/build';
    let built:FacilityBuildResponse|FacilityPersonalBuildResponse;
    try {built=details(await command(action,{facility_type:type})) as FacilityBuildResponse|FacilityPersonalBuildResponse;}
    catch(error){return {status:'failed',did:`did not build ${type}`,why:`${type} was not built at ${docked}: ${message(error)}`,detail:none};}

    const after=(details(await command('spacemolt_facility/owned',{})) as FacilityOwnedResponse).facilities??[];
    const landed=after.find(entry=>entry.facility_id===built.facility_id)??after.find(entry=>entry.type===type&&entry.base_id===docked);
    if(!landed)
      return {status:'failed',did:`did not build ${type}`,why:`${type} was committed at ${docked} but does not show in owned() yet`,detail:none};
    return {status:'done',did:`${type} built at ${docked} as ${landed.facility_id}, ${landed.rent_per_cycle} cr/cycle rent`,
      detail:{facility_id:landed.facility_id,rent_per_cycle:landed.rent_per_cycle}};
  });
}
