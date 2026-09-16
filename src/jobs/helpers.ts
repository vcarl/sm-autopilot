/** The moves a script may make between jobs: look, fly, dock, service, read the store, write
 * a line in the journal. Each one is a proven primitive with the pilot's own bounds already
 * applied, so a script never passes a mood, a reserve or a jump count of its own. */
import {dockAt,type DockResult} from '../dock.ts';
import {details} from '../response-details.ts';
import {journalRun} from '../run-record.ts';
import {serviceShip,type ServiceOutcome} from '../servicing.ts';
import {viewStorage,type StorageView} from '../storage.ts';
import {FuelRouteShortfall,travelTo} from '../travel.ts';
import type {ReadinessCommand} from '../readiness.ts';
import type {Ctx} from './ctx.ts';

/** `get_system` answers `kind:'transit'` with no system while the ship is under way. */
export const currentSystem=async(command:ReadinessCommand)=>
  details(await command('spacemolt/get_system',{})).system as Record<string,any>|undefined;
export const stations=(system:Record<string,any>|undefined)=>
  (system?.pois??[]) as Record<string,any>[];

export interface Where {
  system:{id?:string;name?:string};
  poi:{id?:string;name?:string};
  docked_at:{base_id:string;name:string|null}|null;
  in_transit:boolean;
  destination?:{system?:string;poi?:string};
  fuel?:number;max_fuel?:number;hull?:number;max_hull?:number;
  pois:{id:string;name:string;type:string}[];
  connections:Record<string,any>[];
}

/** The present, from an authoritative read: where the ship is, what it has left, and every
 * destination it may name — this system's POIs and the systems a jump reaches. */
export async function where(ctx:Ctx):Promise<Where> {
  await ctx.account.refresh();
  const {location,ship}=ctx.account.state;
  const system=await currentSystem(ctx.command);
  const rows=stations(system);
  const pois=rows.map(poi=>({id:poi.id,name:poi.name,type:poi.type}));
  // A station's base id is not the id of the POI it sits at: name the base itself.
  const base=rows.find(poi=>poi.base_id===location?.docked_at);
  return {
    system:{id:location?.system_id,name:system?.name},
    poi:{id:location?.poi_id,name:pois.find(poi=>poi.id===location?.poi_id)?.name},
    docked_at:location?.docked_at?{base_id:location.docked_at,name:base?.base_name??null}:null,
    in_transit:Boolean(location?.in_transit),
    ...location?.in_transit?{destination:{system:location.transit_dest_system_id,
      poi:location.transit_dest_poi_id}}:{},
    fuel:ship?.fuel,max_fuel:ship?.max_fuel,hull:ship?.hull,max_hull:ship?.max_hull,
    pois,connections:(system?.connections??[]) as Record<string,any>[],
  };
}

const elapsed=(started:number)=>Math.round((Date.now()-started)/1000);
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Where the server says a nameable id lives. A POI in another system is a route with jumps,
 * never a refusal, and a base id answers with the POI it sits at. */
export async function route(ctx:Ctx,id:string):Promise<Record<string,any>> {
  const answer=details(await ctx.command('spacemolt/find_route',{id}));
  if(!answer.found)throw new Error(String(answer.message??`No route to ${id}`));
  return answer;
}

export interface TravelReport {
  arrived:boolean;reason?:string;elapsed_s:number;
  location?:{system?:string;poi?:string;docked_at:string|null};
  fuel?:number;required_fuel?:number;shortfall?:number;
}

/** Fly to a named POI, jumping as the route needs. The mood's fuel reserve bounds the trip,
 * not a jump count, so a nearer site is admissible where a far one is not. */
export async function travel(ctx:Ctx,poiId:string):Promise<TravelReport> {
  if(!poiId)throw new Error('travel requires a poi_id');
  await ctx.account.refresh();
  if(!ctx.account.state.location?.system_id)
    throw new Error('Current system is unknown; observe before travelling');
  const started=Date.now();
  const found=details(await ctx.command('spacemolt/find_route',{id:poiId}));
  if(!found.found)return {arrived:false,reason:String(found.message??`No route to ${poiId}`),
    elapsed_s:elapsed(started)};
  try {
    const {location}=await travelTo(ctx.account,ctx.command,
      {system_id:String(found.target_system),poi_id:poiId},{mood:ctx.mood,maxJumps:null});
    return {arrived:true,location:{system:location?.system_id,poi:location?.poi_id,
      docked_at:location?.docked_at??null},fuel:ctx.account.state.ship?.fuel,elapsed_s:elapsed(started)};
  } catch(error) {
    if(error instanceof FuelRouteShortfall) {
      const {actualFuel,requiredFuel,shortfall}=error.evidence;
      return {arrived:false,reason:message(error),fuel:actualFuel,required_fuel:requiredFuel,
        shortfall,elapsed_s:elapsed(started)};
    }
    return {arrived:false,reason:message(error),elapsed_s:elapsed(started)};
  }
}

export interface DockReport {docked:boolean;docked_at?:string;already_docked?:boolean;reason?:string}

/** Dock at the station the ship is at. A dock it already has is success, not an error. */
export async function dock(ctx:Ctx,baseId?:string):Promise<DockReport> {
  try {
    const {docked_at,already_docked}:DockResult=await dockAt(ctx.account,ctx.command,baseId);
    return {docked:true,docked_at,already_docked};
  } catch(error){return {docked:false,reason:message(error)};}
}

/** Refuel and repair to the margins the mood allows, at the counter the ship is docked at. */
export const service=(ctx:Ctx):Promise<ServiceOutcome>=>
  serviceShip(ctx.account,ctx.command,{mood:ctx.mood});

/** Read the pilot's store here, or at a named base without travelling to it. */
export const storage=(ctx:Ctx,stationId?:string):Promise<StorageView>=>
  viewStorage(ctx.command,stationId);

/** One line in the pilot's journal, under the script's own event name. */
export const journal=(ctx:Ctx,entry:Record<string,unknown>,event='script'):void=>{
  if(ctx.runtime)journalRun(ctx.runtime,entry,event);
};

/** One step of one job, written down as it ends: the run record advances (N22) and the
 * journal gets a line a person can read (S45).
 *
 * Ids and quantities only. A step line is read in a chat window beside dozens of others, so
 * the reason is cut and the rows are capped rather than letting one step carry a paragraph.
 */
export function step(ctx:Ctx,job:string,name:string,
  outcome:'done'|'skipped'|'failed'|'blocked'='done',extra:Record<string,unknown>={}):void {
  ctx.progress({last_job:job,last_step:name});
  const {reason,...rest}=extra;
  journal(ctx,{job,step:name,outcome,...rest,
    ...Array.isArray(rest.yield)?{yield:(rest.yield as unknown[]).slice(0,4)}:{},
    ...reason===undefined?{}:{reason:String(reason).slice(0,120)}},'step');
}

/** Any command the game has, from a script: the one door to the library the jobs do not
 * cover. It asks the rules first, then sends through the same seam every job's command goes
 * through, so the run is journalled as a `command` line and the reply comes back whole.
 *
 * ponytail: the rules check is the whole discipline. Nothing here is idempotent and nothing
 * here watches the wallet beyond the credit reserve the rules already keep — a script that
 * buys twice buys twice. Read the outcome before sending the same mutation again.
 */
export async function command(ctx:Ctx,action:string,params:Record<string,unknown>={}):Promise<unknown> {
  await ctx.check(action);
  return ctx.command(action,params);
}
