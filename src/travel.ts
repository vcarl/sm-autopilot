import {SpacemoltError,type GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {routeSteps} from './normal-route.ts';
import {resolveFuelReserve,type Mood,type StandingFuelPolicy} from './mood-policy.ts';
import {dockAt} from './dock.ts';
import {position,reconcileMove,type Position,type Reconciliation} from './reconcile.ts';

export class TravelBlocked extends Error {}
export interface FuelRouteEvidence {
  kind:'available_fuel'|'capacity';
  actualFuel:number;
  quotedCost:number;
  effectiveReserve:number;
  requiredFuel:number;
  /** Required minus available fuel; capacityShortfall measures tank infeasibility separately. */
  shortfall:number;
  capacityShortfall?:number;
  destination:TravelDestination;
  observed:{ship:GameState['ship'];location:GameState['location']};
  quoteOrigin:NonNullable<GameState['location']>;
}

export class FuelRouteShortfall extends TravelBlocked {
  readonly evidence:FuelRouteEvidence;
  constructor(evidence:FuelRouteEvidence) {
    const {actualFuel,requiredFuel,shortfall}=evidence;
    super(evidence.kind==='capacity'?
      `fuel_below_route_minimum: route and reserve exceed tank capacity; shortfall ${shortfall} fuel units; capacity shortfall ${evidence.capacityShortfall} fuel units`:
      `fuel_below_route_minimum: have ${actualFuel}, need ${requiredFuel}; shortfall ${shortfall} fuel units`);
    // Later refreshes and caller mutations must not rewrite a refusal's observations.
    this.evidence=structuredClone(evidence);
  }
}
export class ArrivalUnresolved extends Error {
  /** Set when the reconciling read below showed the world moved the ship (S41, C13). */
  moved?:Reconciliation;
}
/** The server's own refusal when a battle owns the ship: `in_battle`. The move is refused and
 * never retreated from here. Breaking off is a combat decision with consequences, and this
 * codebase leaves combat to the pilot (the reason the `may_attack` permission was deleted);
 * a mover that quietly fled a fight would be making that call for it. What the mover owes the
 * pilot instead is a refusal that names the battle and the call that ends it. */
export class InBattle extends TravelBlocked {
  constructor(detail:string) {
    super(`in_battle: a battle holds the ship, so it cannot travel or jump: ${detail}. `+
      `disengage() breaks off and waits for the battle to actually end, then travel again`);
  }
}
/** One refused move is evidence; a second with nothing changed is a loop. On 2026-09-24 a
 * pilot re-issued the same refused `travel` nine times over two and a half minutes while a
 * Slag-Tortoise shot it from hull 61 to 29, and lost three uninsured ships that way. So the
 * refusal is remembered here, at the seam every caller moves through, and re-answered without
 * touching the wire until the battle demonstrably ends: a confirmed `disengage`, a
 * `battle_ended`/`player_died` push, or a move the server accepted. */
let battleHolds=false;
export const battleEnded=()=>{battleHolds=false;};
const refusedInBattle=(error:unknown)=>error instanceof SpacemoltError&&error.code==='in_battle';

/** Whether a battle holds the ship, in the one line a pilot has to read before anything else.
 * On 2026-09-25 a pilot woke at hull 3/80 inside a battle left over from the previous shift and
 * died a second after its first move, because nothing it read said it was in a fight. A refusal
 * from `battle/status` IS "no battle"; anything else is a fight, and the ship cannot travel,
 * jump or undock until it ends.
 *
 * It lives here, beside `battleHolds`, because this is the module that owns whether a battle
 * holds the ship: an authoritative read is the best answer there is, so it sets the flag the
 * refused-move memory below is built on rather than becoming a second copy of it. */
export interface BattleNow {opponent:string;tick:number}
export async function battleNow(send:ReadinessCommand):Promise<BattleNow|undefined> {
  try {
    const status=details(await send('spacemolt_battle/status',{})) as Record<string,any>;
    if(!status?.battle_id){battleHolds=false;return undefined;}
    battleHolds=true;
    const rows=(status.participants??[]) as Record<string,any>[];
    const theirs=rows.find(row=>row.kind!=='player'||row.is_npc);
    return {opponent:String(theirs?.username??theirs?.player_id??'an unnamed opponent'),
      tick:Number(status.tick_duration??0)};
  } catch {battleHolds=false;return undefined;}
}


export interface TravelDestination {system_id:string;poi_id?:string;base_id?:string}
export interface TravelOptions {
  mood?:Mood;
  /** The mood this leg is quoted on, read as each quote is taken. The runtime imposes Tired
   * between any two commands and Tired carries its own fuel reserve, so a route already under
   * way must be quoted against the mood in force now — the mood it departed under refuses the
   * resupply leg the crossing exists to allow. Defaults to `mood`, which is what a caller with
   * no live pilot record has. Same shape as `GatherOptions.moodNow`, for the same reason. */
  moodNow?:()=>Mood;
  /** Internal standing policy; tightens the mood, never a model-facing allocation. */
  standingPolicy?:StandingFuelPolicy;
  /** Internal script allocations only; cannot override a mood's reserve. */
  reserve?:number;maxJumps?:number|null;
  checkpoint?:(settled?:boolean)=>Promise<void>;
  beforeMove?:()=>Promise<void>;
  refuel?:(minimum:number)=>Promise<void>;
  onJump?:()=>void;
  now?:()=>number;sleep?:(ms:number)=>Promise<void>;
  maxWaitMs?:number;pollMs?:number;liveReadMs?:number;
}

/** The wait ran out, and the read it ran out on is the deadline's own authoritative one. A
 * ship sitting somewhere it was never sent is an unsolicited move, and the refusal names
 * which kind (C13) rather than leaving the caller to work it out. */
async function unresolved(account:ReadinessAccount,from:Position) {
  const drift=await reconcileMove(account,from,{read:false});
  if(!drift.moved)return new ArrivalUnresolved('Arrival not verified within travel wait bound; reconcile before further movement');
  const error=new ArrivalUnresolved(`Arrival not verified: unsolicited move (${drift.cause}): ${drift.evidence}`);
  error.moved=drift;
  return error;
}

/** Account.refresh always queries get_status. A cargo/hull push must never postpone it. */
export async function waitForArrival(account:ReadinessAccount,predicate:(state:GameState)=>boolean,options:TravelOptions={}) {
  const now=options.now??Date.now,sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+(options.maxWaitMs??600000);
  let liveAt=now();
  await account.refresh();
  const departed=position(account.state);
  let authoritative=true;
  while(true) {
    // Pushes can suggest arrival, but only a status read can confirm it.
    if(predicate(account.state)&&!authoritative) {
      await account.refresh();liveAt=now();authoritative=true;
    }
    if(predicate(account.state))break;
    await options.checkpoint?.();
    const remaining=deadline-now();
    if(remaining<=0)throw await unresolved(account,departed);
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
  if(battleHolds)throw new InBattle('a battle already refused this ship\'s last move and nothing has ended it since');
  if(options.mood!==undefined&&options.reserve!==undefined)throw new TravelBlocked('Travel mood cannot be combined with a numeric reserve');
  if(options.standingPolicy!==undefined&&options.mood===undefined)throw new TravelBlocked('A standing fuel policy requires a travel mood');
  if(options.mood===undefined&&options.reserve===undefined)throw new TravelBlocked('Travel requires a mood or an internal script allocation');
  /** The reserve the next quote is taken against, read then rather than once at departure:
   * the mood moves mid-route and the reserve is what the mood picks. */
  const fuelReserve=():number=>{
    try {return options.mood!==undefined?resolveFuelReserve(options.moodNow?.()??options.mood,options.standingPolicy):options.reserve!;}
    catch(error){throw new TravelBlocked(String(error));}
  };
  let reserve=fuelReserve();
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
  let jumps=0,retries=1,refueled=false;
  /** A move re-sent after a lost reply (the runtime re-issues a jump once on reconnect) is
   * answered "You are already in Grumium" when the first one landed. That refusal is the goal
   * met, not a failure — but only when a fresh read shows the ship where this leg sent it. */
  const goalMet=async(error:unknown,goal:(s:GameState)=>boolean)=>{
    if(!/\balready\b/i.test(String((error as Error)?.message??error)))return false;
    try {await account.refresh();} catch {return false;}
    return goal(account.state);
  };
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
      current.location!.docked_at!==location!.docked_at||current.ship?.id!==ship.id||current.ship.fuel!==ship.fuel||current.ship.cargo_used!==ship.cargo_used||
      current.ship.max_fuel!==ship.max_fuel)
      throw new TravelBlocked('Ship load, fuel or location changed while quoting route');
    if((result.fuel_available!==undefined&&result.fuel_available!==ship.fuel)||(result.cargo_used!==undefined&&result.cargo_used!==ship.cargo_used))throw new TravelBlocked('Route quote does not match current fuel or cargo');
    // Objective travel admits this finite route, not an unlimited rerouting loop.
    maxJumps??=steps.length;
    // The reserve belongs to this quote, read after the route command that may have imposed the
    // mood it is read from: the crossing lands in a command's own return, never between legs.
    reserve=fuelReserve();
    return {steps,cost:result.estimated_fuel as number,required:result.estimated_fuel+reserve,origin:location!,ship};
  };
  while(!arrived(account.state)) {
    await checkpoint();
    let plan=await quote();
    const fuelShortfall=(kind:FuelRouteEvidence['kind'])=>new FuelRouteShortfall({
      kind,actualFuel:account.state.ship!.fuel,quotedCost:plan.cost,effectiveReserve:reserve,
      requiredFuel:plan.required,shortfall:plan.required-account.state.ship!.fuel,
      ...(kind==='capacity'?{capacityShortfall:plan.required-account.state.ship!.max_fuel}:{}),
      destination,observed:{ship:account.state.ship,location:account.state.location},quoteOrigin:plan.origin,
    });
    const requireCapacity=()=>{
      if(!Number.isFinite(account.state.ship!.max_fuel))throw new TravelBlocked('Canonical tank capacity required for routing');
      if(plan.required>account.state.ship!.max_fuel)throw fuelShortfall('capacity');
    };
    requireCapacity();
    if(account.state.ship!.fuel<plan.required&&account.state.location!.docked_at&&options.refuel&&!refueled) {
      refueled=true;await options.refuel(plan.required);await checkpoint();plan=await quote();
      requireCapacity();
    }
    const requireFuel=()=>{
      const fuel=account.state.ship?.fuel;
      if(typeof fuel!=='number'||!Number.isFinite(fuel))throw new TravelBlocked('Canonical fuel required before departure');
      if(fuel<plan.required)throw fuelShortfall('available_fuel');
    };
    requireFuel();
    await checkpoint();
    await options.beforeMove?.();
    // Hooks may await other work while the server changes. Revalidate the quote
    // before undocking as well as before the jump/travel command.
    await account.refresh();
    const departure=account.state;
    if(!stable(departure)||departure.location!.system_id!==plan.origin.system_id||departure.location!.poi_id!==plan.origin.poi_id||
      departure.location!.docked_at!==plan.origin.docked_at||departure.ship?.id!==plan.ship.id||departure.ship.cargo_used!==plan.ship.cargo_used||
      departure.ship.max_fuel!==plan.ship.max_fuel)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    // A stale quote cannot establish a fuel crossing. Classify fuel only after
    // its non-fuel context is validated, then retain the fuel-change guard.
    requireFuel();
    if(departure.ship!.fuel!==plan.ship.fuel)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    // Undocking is refused `in_battle` just as the move is, and reaches the pilot the same way.
    if(account.state.location!.docked_at)
      try {await command('spacemolt/undock',{});}
      catch(error) {
        if(refusedInBattle(error)) {battleHolds=true;throw new InBattle((error as SpacemoltError).message);}
        if(!await goalMet(error,s=>!s.location?.docked_at))throw error;
      }
    const next=plan.steps[0];
    if(next) {
      const system=details(await command('spacemolt/get_system',{})).system;
      if(!system?.connections?.some((c:any)=>(typeof c==='string'?c:c.system_id)===next))throw new TravelBlocked('Route is not a verified normal connection');
    }
    await checkpoint();
    await account.refresh();
    const current=account.state;
    if(!stable(current)||current.location!.system_id!==plan.origin.system_id||current.location!.poi_id!==plan.origin.poi_id||current.location!.docked_at||
      current.ship?.id!==plan.ship.id||current.ship.cargo_used!==plan.ship.cargo_used||current.ship.max_fuel!==plan.ship.max_fuel)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    requireFuel();
    if(current.ship!.fuel!==plan.ship.fuel)throw new TravelBlocked('Route origin, load or fuel changed before departure');
    const target=next??destination.poi_id;
    if(!target)throw new TravelBlocked('Route does not reach destination');
    try {await command(next?'spacemolt/jump':'spacemolt/travel',{id:target});battleHolds=false;}
    catch(error) {
      if(refusedInBattle(error)) {battleHolds=true;throw new InBattle((error as SpacemoltError).message);}
      if(!await goalMet(error,s=>next?stable(s)&&s.location!.system_id===next:arrived(s))) {
        if(!retryable(error)||retries--<=0)throw error;
        await waitForArrival(account,stable,waits);
        continue;
      }
      battleHolds=false;
    }
    if(next){jumps++;options.onJump?.();}
    await waitForArrival(account,s=>next?stable(s)&&s.location!.system_id===next:arrived(s),waits);
  }
  await checkpoint();
  if(destination.base_id) {
    await checkpoint();
    // One dock path for every caller: satisfied docks, lost replies and queued docks included.
    await dockAt(account,command,destination.base_id,waits);
    if(!arrived(account.state))throw new Error('Docking identity not verified');
  }
  return {jumps,location:structuredClone(account.state.location)};
}
