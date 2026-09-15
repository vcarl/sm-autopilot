import {SpacemoltError,type GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {routeSteps} from './normal-route.ts';
import {resolveFuelReserve,type Mood,type OperatorFuelPolicy} from './mood-policy.ts';

export class TravelBlocked extends Error {}
export class ArrivalUnresolved extends Error {}
export interface TravelDestination {system_id:string;poi_id?:string;base_id?:string}
export interface TravelOptions {
  mood?:Mood;
  /** Internal operator policy; tightens the mood, never a model-facing allocation. */
  operatorPolicy?:OperatorFuelPolicy;
  /** Internal script allocations only; cannot override a mood's reserve. */
  reserve?:number;maxJumps?:number|null;
  checkpoint?:(settled?:boolean)=>Promise<void>;
  beforeMove?:()=>Promise<void>;
  checkMove?:()=>void;
  refuel?:(minimum:number)=>Promise<void>;
  onJump?:()=>void;
  now?:()=>number;sleep?:(ms:number)=>Promise<void>;
  maxWaitMs?:number;pollMs?:number;liveReadMs?:number;
}

/** Account.refresh always queries get_status. A cargo/hull push must never postpone it. */
export async function waitForArrival(account:ReadinessAccount,predicate:(state:GameState)=>boolean,options:TravelOptions={}) {
  const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+(options.maxWaitMs??600000);
  let liveAt=now();
  await account.refresh();
  let authoritative=true;
  while(true) {
    // Pushes can suggest arrival, but only a status read can confirm it.
    if(predicate(account.state)&&!authoritative) {
      await account.refresh();liveAt=now();authoritative=true;
    }
    if(predicate(account.state))break;
    await options.checkpoint?.();
    const remaining=deadline-now();
    if(remaining<=0)throw new ArrivalUnresolved('Arrival not verified within travel wait bound; reconcile before further movement');
    await sleep(Math.min(options.pollMs??2000,remaining));
    authoritative=false;
    if(now()-liveAt>=(options.liveReadMs??30000)||now()>=deadline) {
      await account.refresh();liveAt=now();authoritative=true;
    }
  }
  await options.checkpoint?.(true);
  if(!predicate(account.state))throw new Error('Location changed at arrival checkpoint');
}

// Retry only definitive server rejections. Transport errors and pending commands
// remain the caller's reconciliation responsibility, even if a later read looks safe.
const retryable=(error:unknown)=>error instanceof SpacemoltError&&!error.pendingCommand&&
  ['in_transit','already_in_system','already_at_destination','not_connected','not_in_system','already_traveling'].includes(error.code);

/** One shared movement path; policy, spending and command ownership stay with the caller. */
export async function travelTo(account:ReadinessAccount,command:ReadinessCommand,destination:TravelDestination,options:TravelOptions={}) {
  if(options.mood!==undefined&&options.reserve!==undefined)throw new TravelBlocked('Travel mood cannot be combined with a numeric reserve');
  if(options.operatorPolicy!==undefined&&options.mood===undefined)throw new TravelBlocked('Operator fuel policy requires a travel mood');
  if(options.mood===undefined&&options.reserve===undefined)throw new TravelBlocked('Travel requires a mood or an internal script allocation');
  let reserve:number;
  try {reserve=options.mood!==undefined?resolveFuelReserve(options.mood,options.operatorPolicy):options.reserve!;}
  catch(error){throw new TravelBlocked(String(error));}
  let maxJumps=options.maxJumps===null?null:options.maxJumps??2;
  if(!destination.system_id||!Number.isFinite(reserve)||reserve<0||(maxJumps!==null&&(!Number.isSafeInteger(maxJumps)||maxJumps<0)))throw new TravelBlocked('Invalid travel destination or allocation');
  const stable=(s:GameState)=>Boolean(s.location?.system_id&&!s.location.in_transit);
  const arrived=(s:GameState)=>stable(s)&&s.location!.system_id===destination.system_id&&
    (!destination.poi_id||s.location!.poi_id===destination.poi_id);
  await account.refresh();
  const shipId=account.state.ship?.id;
  const checkpoint=async(settled=false)=>{
    await options.checkpoint?.(settled);
    if(account.state.ship?.id!==shipId)throw new Error('Ship changed during travel; reconcile before further movement');
  };
  const waits={...options,checkpoint};
  // A prior move owns transit until it settles; only then may we quote a new leg.
  if(!stable(account.state))await waitForArrival(account,stable,waits);
  else await checkpoint(true);
  const moveCheckpoint=async()=>{await checkpoint();options.checkMove?.();};
  let jumps=0,retries=1,refueled=false;
  const quote=async()=>{
    const location=structuredClone(account.state.location),ship=structuredClone(account.state.ship);
    if(!stable(account.state)||!ship||!Number.isFinite(ship.fuel))throw new TravelBlocked('Canonical location and fuel required for routing');
    const result=details(await command('spacemolt/find_route',{id:destination.system_id}));
    let steps:string[];
    try {steps=routeSteps(result,location!.system_id,destination.system_id,maxJumps===null?null:maxJumps-jumps);}
    catch(error){throw new TravelBlocked(String(error));}
    await account.refresh();
    const current=account.state;
    if(!stable(current)||current.location!.system_id!==location!.system_id||current.location!.poi_id!==location!.poi_id||
      current.location!.docked_at!==location!.docked_at||current.ship?.id!==ship.id||current.ship.fuel!==ship.fuel||current.ship.cargo_used!==ship.cargo_used)
      throw new TravelBlocked('Ship load, fuel or location changed while quoting route');
    if((result.fuel_available!==undefined&&result.fuel_available!==ship.fuel)||(result.cargo_used!==undefined&&result.cargo_used!==ship.cargo_used))throw new TravelBlocked('Route quote does not match current fuel or cargo');
    // Objective travel admits this finite route, not an unlimited rerouting loop.
    maxJumps??=steps.length;
    return {steps,required:result.estimated_fuel+reserve,origin:location!,ship};
  };
  while(!arrived(account.state)) {
    await moveCheckpoint();
    let plan=await quote();
    if(!Number.isFinite(account.state.ship!.max_fuel))throw new TravelBlocked('Canonical tank capacity required for routing');
    if(plan.required>account.state.ship!.max_fuel)throw new TravelBlocked(`fuel_below_route_minimum: route and reserve exceed tank capacity; shortfall ${plan.required-account.state.ship!.fuel} fuel units; capacity shortfall ${plan.required-account.state.ship!.max_fuel} fuel units`);
    if(account.state.ship!.fuel<plan.required&&account.state.location!.docked_at&&options.refuel&&!refueled) {
      refueled=true;await options.refuel(plan.required);await checkpoint();plan=await quote();
    }
    const requireFuel=()=>{
      const fuel=account.state.ship?.fuel;
      if(typeof fuel!=='number'||!Number.isFinite(fuel))throw new TravelBlocked('Canonical fuel required before departure');
      if(fuel<plan.required)throw new TravelBlocked(`fuel_below_route_minimum: have ${fuel}, need ${plan.required}; shortfall ${plan.required-fuel} fuel units`);
    };
    requireFuel();
    await moveCheckpoint();
    await options.beforeMove?.();
    // Hooks may await other work while the server changes. Revalidate the quote
    // before undocking as well as before the jump/travel command.
    await account.refresh();
    requireFuel();
    const departure=account.state;
    if(!stable(departure)||departure.location!.system_id!==plan.origin.system_id||departure.location!.poi_id!==plan.origin.poi_id||
      departure.location!.docked_at!==plan.origin.docked_at||departure.ship?.id!==plan.ship.id||departure.ship.cargo_used!==plan.ship.cargo_used||
      departure.ship.max_fuel!==plan.ship.max_fuel||departure.ship.fuel!==plan.ship.fuel)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    if(account.state.location!.docked_at)await command('spacemolt/undock',{});
    const next=plan.steps[0];
    if(next) {
      const system=details(await command('spacemolt/get_system',{})).system;
      if(!system?.connections?.some((c:any)=>(typeof c==='string'?c:c.system_id)===next))throw new TravelBlocked('Route is not a verified normal connection');
    }
    await moveCheckpoint();
    await account.refresh();
    requireFuel();
    const current=account.state;
    if(!stable(current)||current.location!.system_id!==plan.origin.system_id||current.location!.poi_id!==plan.origin.poi_id||current.location!.docked_at||
      current.ship?.id!==plan.ship.id||current.ship.cargo_used!==plan.ship.cargo_used||current.ship.max_fuel!==plan.ship.max_fuel||current.ship.fuel!==plan.ship.fuel||current.ship.fuel<plan.required)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    const target=next??destination.poi_id;
    if(!target)throw new TravelBlocked('Route does not reach destination');
    options.checkMove?.();
    try {await command(next?'spacemolt/jump':'spacemolt/travel',{id:target});}
    catch(error) {
      if(!retryable(error)||retries--<=0)throw error;
      await waitForArrival(account,stable,waits);
      continue;
    }
    if(next){jumps++;options.onJump?.();}
    await waitForArrival(account,s=>next?stable(s)&&s.location!.system_id===next:arrived(s),waits);
  }
  await moveCheckpoint();
  if(destination.base_id) {
    await moveCheckpoint();
    if(!account.state.location!.docked_at)await command('spacemolt/dock',{});
    await account.refresh();
    if(!arrived(account.state)||account.state.location!.docked_at!==destination.base_id)throw new Error('Docking identity not verified');
  }
  return {jumps,location:structuredClone(account.state.location)};
}
