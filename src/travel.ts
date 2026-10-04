import type {GameState} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {Game,GameLive,attempt,classify,field,message,rawError,type GameError} from './play/game.ts';
import {routeSteps} from './normal-route.ts';
import {dockAtEffect} from './dock.ts';
import {position,reconcileMove,type Position,type Reconciliation} from './reconcile.ts';

export class TravelBlocked extends Error {readonly _tag:string='TravelBlocked';}
export interface FuelRouteEvidence {
  kind:'available_fuel'|'capacity';
  actualFuel:number;
  quotedCost:number;
  /** The quoted route cost: admission keeps no reserve on top (the reserve is where Tired begins). */
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
      `fuel_below_route_minimum: route exceeds tank capacity; shortfall ${shortfall} fuel units; capacity shortfall ${evidence.capacityShortfall} fuel units`:
      `fuel_below_route_minimum: have ${actualFuel}, need ${requiredFuel}; shortfall ${shortfall} fuel units`);
    // Later refreshes and caller mutations must not rewrite a refusal's observations.
    this.evidence=structuredClone(evidence);
  }
}
/** The game did not confirm where the ship is: a world condition (a timeout, an unsolicited move, a
 * ship or place that changed under the move), never a bug, so it is a failure, not a defect. */
export class ArrivalUnresolved extends Error {
  readonly _tag='ArrivalUnresolved';
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

/** Whether a battle holds the ship, in the one line a pilot has to read before anything else.
 * On 2026-09-25 a pilot woke at hull 3/80 inside a battle left over from the previous shift and
 * died a second after its first move, because nothing it read said it was in a fight. A refusal
 * from `battle/status` IS "no battle"; anything else is a fight, and the ship cannot travel,
 * jump or undock until it ends.
 *
 * It lives here, beside `battleHolds`, because this is the module that owns whether a battle
 * holds the ship: an authoritative read is the best answer there is, so it sets the flag the
 * refused-move memory below is built on rather than becoming a second copy of it. A lost reply
 * is no answer either, so it reads as no battle too; a defect (a bug) is not swallowed. */
export interface BattleNow {opponent:string;tick:number}
/** A reply's body, as `details()` finds it. The live server omits spec fields, so it is read with
 * `field()`, never decoded: a decode failure would turn "no battle" into an error. */
const payload=(reply:unknown):unknown=>field(reply,'structuredContent')??field(field(reply,'delta'),'details')??reply;
export const battleNowEffect=()=>Effect.gen(function*() {
  const sent=yield* Effect.result((yield* Game).command('spacemolt_battle/status',{}));
  // Every tag of GameError (a refusal of any kind, a lost reply) is "no battle": the union is exhausted here.
  if(Result.isFailure(sent)){battleHolds=false;return undefined;}
  const status=payload(sent.success);
  if(!field(status,'battle_id')){battleHolds=false;return undefined;}
  battleHolds=true;
  const participants=field(status,'participants');
  const rows:readonly unknown[]=Array.isArray(participants)?participants:[];
  const theirs=rows.find(row=>field(row,'kind')!=='player'||field(row,'is_npc'));
  return {opponent:String(field(theirs,'username')??field(theirs,'player_id')??'an unnamed opponent'),
    tick:Number(field(status,'tick_duration')??0)};
});
/** The Promise twin of `battleNowEffect`, for callers not yet converted. */
export async function battleNow(send:ReadinessCommand):Promise<BattleNow|undefined> {
  const exit=await Effect.runPromiseExit(battleNowEffect().pipe(Effect.provide(GameLive({send}))));
  if(exit._tag==='Failure')throw rawError(exit.cause); // bridge: U30, U33 (their conversion calls the twin and deletes this)
  return exit.value;
}

export interface TravelDestination {system_id:string;poi_id?:string;base_id?:string}
/** A leg is admitted when the tank covers its quoted route, and nothing more. The mood's fuel
 * reserve is not a travel margin: it is the line under which the runtime imposes Tired
 * (`crossed` in play/runtime.ts), and Tired's own rules send the pilot to service. A margin
 * added here kept fuel above that line forever, so Tired never fired and a pilot with 26 fuel
 * was refused a 4-fuel trip for want of Focused's 24 (operator's decision, 2026-09-26). */
export interface TravelOptions {
  maxJumps?:number|null;
  checkpoint?:(settled?:boolean)=>Promise<void>;
  beforeMove?:()=>Promise<void>;
  refuel?:(minimum:number)=>Promise<void>;
  /** `refuel` as an Effect, for an Effect caller: it wins over `refuel` when both are given. */
  refuelWith?:(minimum:number)=>Effect.Effect<void,never,Game>;
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
  if(!predicate(account.state))throw new ArrivalUnresolved('Location changed at arrival checkpoint');
}


/** A Promise step of travel's: the lib's refusal or a lost reply is its tag, travel's own refusals thrown from
 * it (a pilot stop is a `TravelBlocked`, an unconfirmed arrival `ArrivalUnresolved`) are failures as they are,
 * and anything else is a defect. */
export const travelStep=<A>(label:string,body:()=>Promise<A>)=>Effect.tryPromise({try:body,
  catch:cause=>cause instanceof TravelBlocked||cause instanceof ArrivalUnresolved?cause:classify(label)(cause)});

// Retry only definitive server rejections. A lost reply (transport, pending command) stays the
// caller's reconciliation responsibility, even if a later read looks safe.
const retryable=(error:GameError)=>error._tag!=='ReplyLost'&&
  ['in_transit','already_in_system','already_at_destination','not_connected','not_in_system','already_traveling'].includes(error.code);

type Located=GameState&{location:NonNullable<GameState['location']>};
type Quote=Parameters<typeof routeSteps>[0];
/** routeSteps refuses with a plain Error; the refusal is named TravelBlocked, as a value. */
const namedSteps=(...args:Parameters<typeof routeSteps>)=>Effect.try({try:()=>routeSteps(...args),catch:error=>new TravelBlocked(String(error))});
const blocked=(why:string)=>Effect.fail(new TravelBlocked(why));
const bool=(v:unknown)=>typeof v==='boolean'?v:undefined,str=(v:unknown)=>typeof v==='string'?v:undefined,num=(v:unknown)=>typeof v==='number'?v:undefined;
/** The quote as routeSteps reads it, each field kept only when it has the type the spec gives it:
 * the live server omits and mistypes fields, and routeSteps refuses a quote missing any it needs. */
const quoteOf=(reply:unknown):Quote=>{
  const route=field(reply,'route');
  const rows:readonly unknown[]=Array.isArray(route)?route:[];
  return {found:bool(field(reply,'found')),target_system:str(field(reply,'target_system')),total_jumps:num(field(reply,'total_jumps')),
    estimated_fuel:num(field(reply,'estimated_fuel')),fuel_per_jump:num(field(reply,'fuel_per_jump')),
    route:Array.isArray(route)?rows
      .map(r=>({system_id:str(field(r,'system_id')),jumps:num(field(r,'jumps')),via_wormhole:Boolean(field(r,'via_wormhole'))})):undefined};
};
const stable=(s:GameState):s is Located=>Boolean(s.location?.system_id&&!s.location.in_transit);

/** One shared movement path; policy, spending and command ownership stay with the caller. Every game
 * command goes through `Game`, so a refusal is a tag: `InBattle` ends in travel's own `InBattle`, any
 * other refusal or lost reply fails with its tag, and a lost reply is never re-sent. Travel's own
 * refusals (`TravelBlocked`, `FuelRouteShortfall`, `InBattle`) and the dock's `DockBlocked` are failures,
 * so a caller that wants them reads the error channel; the unconverted Promise callers still branch on
 * `instanceof` through `rawError`. `ArrivalUnresolved` and `Stopped` (thrown from a checkpoint) cross from
 * the Promise seams through `travelStep`, so they are failures too; anything else a hook throws is a defect. */
export const travelToEffect=(account:ReadinessAccount,destination:TravelDestination,options:TravelOptions)=>Effect.gen(function*() {
  const game=yield* Game;
  if(battleHolds)return yield* Effect.fail(new InBattle('a battle already refused this ship\'s last move and nothing has ended it since'));
  let maxJumps=options.maxJumps===null?null:options.maxJumps??2;
  if(!destination.system_id||(maxJumps!==null&&(!Number.isSafeInteger(maxJumps)||maxJumps<0)))return yield* blocked('Invalid travel destination or allocation');
  const arrived=(s:GameState)=>stable(s)&&s.location.system_id===destination.system_id&&
    (!destination.poi_id||s.location.poi_id===destination.poi_id);
  const refresh=()=>attempt('refresh',()=>account.refresh());
  yield* refresh();
  const shipId=account.state.ship?.id;
  const checkpoint=async(settled=false)=>{
    await options.checkpoint?.(settled);
    if(account.state.ship?.id!==shipId)throw new ArrivalUnresolved('Ship changed during travel; reconcile before further movement');
  };
  const hold=(settled?:boolean)=>travelStep('checkpoint',()=>checkpoint(settled));
  const waits={...options,checkpoint};
  const settle=(predicate:(state:GameState)=>boolean)=>travelStep('waitForArrival',()=>waitForArrival(account,predicate,waits)); // bridge: U08 (waitForArrival stays a Promise for dockAtEffect's arrival wait)
  // The live ship, re-read where the old code asserted it: the quote proved it a moment ago.
  const shipNow=()=>{const ship=account.state.ship;return ship?Effect.succeed(ship):blocked('Canonical fuel required before departure');};
  // A prior move owns transit until it settles; only then may we quote a new leg.
  if(!stable(account.state))yield* settle(stable);
  else yield* hold(true);
  let jumps=0,retries=1,refueled=false;
  /** A move re-sent after a lost reply (the runtime re-issues a jump once on reconnect) is
   * answered "You are already in Grumium" when the first one landed. That refusal is the goal
   * met, not a failure — but only when a fresh read shows the ship where this leg sent it. */
  const goalMet=(error:GameError,goal:(s:GameState)=>boolean)=>Effect.gen(function*() {
    if(!/\balready\b/i.test(error._tag==='ReplyLost'?message(error.cause):error.message))return false;
    if(Result.isFailure(yield* Effect.result(refresh())))return false;
    return goal(account.state);
  });
  const quote=()=>Effect.gen(function*() {
    const location=structuredClone(account.state.location),ship=structuredClone(account.state.ship);
    if(!location||!stable(account.state)||!ship||!Number.isFinite(ship.fuel))return yield* blocked('Canonical location and fuel required for routing');
    const reply=payload(yield* game.command('spacemolt/find_route',{id:destination.system_id}));
    const result=quoteOf(reply);
    const steps=yield* namedSteps(result,location.system_id,destination.system_id,maxJumps===null?null:maxJumps-jumps);
    yield* refresh();
    const current=account.state;
    if(!stable(current)||current.location.system_id!==location.system_id||current.location.poi_id!==location.poi_id||
      current.location.docked_at!==location.docked_at||current.ship?.id!==ship.id||current.ship.fuel!==ship.fuel||current.ship.cargo_used!==ship.cargo_used||
      current.ship.max_fuel!==ship.max_fuel)
      return yield* blocked('Ship load, fuel or location changed while quoting route');
    // The raw values: a mistyped one must still refuse, so it is never narrowed away.
    const fuelSaid=field(reply,'fuel_available'),cargoSaid=field(reply,'cargo_used');
    if((fuelSaid!==undefined&&fuelSaid!==ship.fuel)||(cargoSaid!==undefined&&cargoSaid!==ship.cargo_used))return yield* blocked('Route quote does not match current fuel or cargo');
    // Objective travel admits this finite route, not an unlimited rerouting loop.
    maxJumps??=steps.length;
    // routeSteps proved the estimate a finite number above.
    return {steps,cost:Number(result.estimated_fuel),required:Number(result.estimated_fuel),origin:location,ship};
  });
  while(!arrived(account.state)) {
    yield* hold();
    let plan=yield* quote();
    const fuelShortfall=(kind:FuelRouteEvidence['kind'])=>Effect.gen(function*() {
      const ship=yield* shipNow();
      return yield* Effect.fail(new FuelRouteShortfall({
        kind,actualFuel:ship.fuel,quotedCost:plan.cost,
        requiredFuel:plan.required,shortfall:plan.required-ship.fuel,
        ...(kind==='capacity'?{capacityShortfall:plan.required-ship.max_fuel}:{}),
        destination,observed:{ship:account.state.ship,location:account.state.location},quoteOrigin:plan.origin,
      }));
    });
    const requireCapacity=()=>Effect.gen(function*() {
      const ship=yield* shipNow();
      if(!Number.isFinite(ship.max_fuel))return yield* blocked('Canonical tank capacity required for routing');
      if(plan.required>ship.max_fuel)return yield* fuelShortfall('capacity');
    });
    yield* requireCapacity();
    const refuelWith=options.refuelWith,refuel=options.refuel;
    if((yield* shipNow()).fuel<plan.required&&account.state.location?.docked_at&&(refuelWith||refuel)&&!refueled) {
      refueled=true;
      yield* refuelWith?refuelWith(plan.required):travelStep('refuel',async()=>{await refuel?.(plan.required);});
      yield* hold();plan=yield* quote();
      yield* requireCapacity();
    }
    const requireFuel=()=>Effect.gen(function*() {
      const fuel=account.state.ship?.fuel;
      if(typeof fuel!=='number'||!Number.isFinite(fuel))return yield* blocked('Canonical fuel required before departure');
      if(fuel<plan.required)return yield* fuelShortfall('available_fuel');
    });
    yield* requireFuel();
    yield* hold();
    yield* travelStep('beforeMove',async()=>{await options.beforeMove?.();});
    // Hooks may await other work while the server changes. Revalidate the quote
    // before undocking as well as before the jump/travel command.
    yield* refresh();
    const departure=account.state;
    if(!stable(departure)||departure.location.system_id!==plan.origin.system_id||departure.location.poi_id!==plan.origin.poi_id||
      departure.location.docked_at!==plan.origin.docked_at||departure.ship?.id!==plan.ship.id||departure.ship.cargo_used!==plan.ship.cargo_used||
      departure.ship.max_fuel!==plan.ship.max_fuel)return yield* blocked('Route origin, load or fuel changed before departure');
    // A stale quote cannot establish a fuel crossing. Classify fuel only after
    // its non-fuel context is validated, then retain the fuel-change guard.
    yield* requireFuel();
    if(departure.ship.fuel!==plan.ship.fuel)return yield* blocked('Route origin, load or fuel changed before departure');
    // Undocking is refused `in_battle` just as the move is, and reaches the pilot the same way.
    if(departure.location.docked_at) {
      const undocked=yield* Effect.result(game.command('spacemolt/undock',{}));
      if(Result.isFailure(undocked)) {
        const failure=undocked.failure;
        if(failure._tag==='InBattle') {battleHolds=true;return yield* Effect.fail(new InBattle(failure.message));}
        if(!(yield* goalMet(failure,s=>!s.location?.docked_at)))return yield* failure;
      }
    }
    const next=plan.steps[0];
    if(next) {
      const connections=field(field(payload(yield* game.command('spacemolt/get_system',{})),'system'),'connections');
      const rows:readonly unknown[]=Array.isArray(connections)?connections:[];
      if(!rows.some(c=>(typeof c==='string'?c:field(c,'system_id'))===next))return yield* blocked('Route is not a verified normal connection');
    }
    yield* hold();
    yield* refresh();
    const current=account.state;
    if(!stable(current)||current.location.system_id!==plan.origin.system_id||current.location.poi_id!==plan.origin.poi_id||current.location.docked_at||
      current.ship?.id!==plan.ship.id||current.ship.cargo_used!==plan.ship.cargo_used||current.ship.max_fuel!==plan.ship.max_fuel)return yield* blocked('Route origin, load or fuel changed before departure');
    yield* requireFuel();
    if(current.ship.fuel!==plan.ship.fuel)return yield* blocked('Route origin, load or fuel changed before departure');
    const target=next??destination.poi_id;
    if(!target)return yield* blocked('Route does not reach destination');
    const moved=yield* Effect.result(game.command(next?'spacemolt/jump':'spacemolt/travel',{id:target}));
    if(Result.isSuccess(moved))battleHolds=false;
    else {
      const failure=moved.failure;
      if(failure._tag==='InBattle') {battleHolds=true;return yield* Effect.fail(new InBattle(failure.message));}
      if(!(yield* goalMet(failure,s=>next?stable(s)&&s.location.system_id===next:arrived(s)))) {
        if(!retryable(failure)||retries--<=0)return yield* failure;
        yield* settle(stable);
        continue;
      }
      battleHolds=false;
    }
    if(next){jumps++;options.onJump?.();}
    yield* settle(s=>next?stable(s)&&s.location.system_id===next:arrived(s));
  }
  yield* hold();
  const baseId=destination.base_id;
  if(baseId) {
    yield* hold();
    // One dock path for every caller: satisfied docks, lost replies and queued docks included.
    yield* dockAtEffect(account,baseId,waits);
    if(!arrived(account.state))return yield* Effect.fail(new ArrivalUnresolved('Docking identity not verified'));
  }
  return {jumps,location:structuredClone(account.state.location)};
});

/** The Promise twin of `travelToEffect`, for callers not yet converted: a failure exit throws the
 * raw error, so a refusal reaches them as the lib's `SpacemoltError` and travel's own classes as
 * themselves. */
export async function travelTo(account:ReadinessAccount,command:ReadinessCommand,destination:TravelDestination,options:TravelOptions={}) {
  const exit=await Effect.runPromiseExit(travelToEffect(account,destination,options).pipe(Effect.provide(GameLive({send:command}))));
  if(exit._tag==='Failure')throw rawError(exit.cause); // bridge: U11, U26 (their conversion calls the twin and deletes this)
  return exit.value;
}
