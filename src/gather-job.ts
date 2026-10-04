import type {GameState} from '@spacemolt/lib';
import {Data,Effect,Result,Schedule} from 'effect';
import {DockBlocked,dockAtEffect} from './dock.ts';
import {Game,SeamFailed,attempt,field,isGameError,message,type GameError} from './play/game.ts';
import {mineToFullEffect,type MineOptions,type MineYieldRow} from './mine.ts';
import {causeText} from './command-boundary.ts';
import {miningInventory} from './mining-inventory.ts';
import type {Mood} from './mood-policy.ts';
import type {ReadinessAccount} from './readiness.ts';
import {ServiceBlocked,serviceShipEffect,type ServiceOutcome,type ServiceUnsafe} from './servicing.ts';
import type {SettleOutcome} from './settle-cargo.ts';
import {ArrivalUnresolved,TravelBlocked,travelToEffect,type TravelOptions} from './travel.ts';
import {movedOutcome,position,reconcileMoveEffect,type Position,type Reconciliation} from './reconcile.ts';
import {replyBody} from './storage.ts';

export interface GatherPlan {
  home:{system_id:string;poi_id:string;base_id:string};
  site:{system_id:string;poi_id:string};
  mood:Mood;
}
/** `blocked` is a world the pilot can answer at a juncture; `failed` needs a reading. */
export type StepOutcome='done'|'blocked'|'failed';
export type GatherStepName='travel'|'mine'|'return'|'dock'|'settle'|'service'|'verify';
export interface GatherStep {name:string;outcome:StepOutcome;reason?:string}
export interface GatherOptions extends TravelOptions {
  /** Each step as it ends, with the numbers that step moved. The job keeps no opinion about
   * what is done with them: `jobs/gather.ts` writes the run record and the journal line. */
  onStep?:(step:GatherStep,moved:{yield:MineYieldRow[];deposited?:MineYieldRow[]})=>void;
  /** The mining loop's own hooks: a stop reason per tick and a running-yield line. */
  mine?:MineOptions;
  /** The mood in force now, read when the service step starts. The runtime imposes Tired
   * between any two commands, so the mood the job was planned under is stale by the time the
   * ship is home — and Tired's service margin is the one a resupply needs.
   * Defaults to `plan.mood`, which is what a caller with no live pilot record has. */
  moodNow?:()=>Mood;
}
export interface GatherOutcome {
  outcome:StepOutcome;
  steps:GatherStep[];
  /** The mine step's cargo delta, kept even when a later step ends the job. */
  yield:MineYieldRow[];
  /** Where this job's take ended up: `deposited` into the station store, or `held`
   * because the station has none. `sold` is always empty and the wallet never moves —
   * a gather job keeps its resources; selling is the agent's own call at its juncture. */
  settled:SettleOutcome|null;
  serviced:ServiceOutcome|null;
  /** Present when the world moved the pilot with no command behind it (C13). */
  moved?:Reconciliation;
  reason?:string;
}

/** The refusals the steps raise by name: a world condition, not a broken script. */
const blocking=(error:unknown)=>error instanceof TravelBlocked||error instanceof DockBlocked||
  error instanceof ServiceBlocked||error instanceof ArrivalUnresolved;
/** Stowing needs a dock to stow at; the settle step reads it as a failure, as it always did. */
class NotDocked extends Data.TaggedError('NotDocked')<{readonly message:string}> {}
type Report=Omit<GatherStep,'name'>;
type StepError=GameError|SeamFailed|DockBlocked|NotDocked|TravelBlocked|ArrivalUnresolved|ServiceBlocked|ServiceUnsafe;
/** A step's failure as the value the old `catch` saw: the lib's own error under a tag. */
const raw=(error:StepError):unknown=>error instanceof SeamFailed||isGameError(error)?error.cause:error;
/** The legs that once ran behind a Promise seam (travel, dock, service) judged any throw as the
 * step's own failure, a die included, and still do: a dropped socket mid-service fails the step, not the job. */
const judged=<A,E,R>(leg:Effect.Effect<A,E,R>)=>leg.pipe(Effect.catchDefect(cause=>Effect.fail(new SeamFailed({cause}))));

/** What the closing read must agree with before the job may call itself done. */
function differences(state:GameState,plan:GatherPlan,settled:SettleOutcome|null,mine:Set<string>):string[] {
  const {ship,location}=state??{};
  if(!ship||!location)return ['authoritative ship and location unavailable at the end of the job'];
  const out:string[]=[];
  if(location.in_transit)out.push('still in transit');
  if(location.docked_at!==plan.home.base_id)
    out.push(`docked at ${location.docked_at??'nothing'}, not ${plan.home.base_id}`);
  // Only the site's own resources are this job's to account for; a station with no store
  // leaves them aboard and says so in `held`. Everything else is the pilot's business.
  const held=new Set(settled?.held.map(row=>row.item_id)??[]);
  for(const [item_id,quantity] of Object.entries(miningInventory(state)))
    if(quantity>0&&mine.has(item_id)&&!held.has(item_id))out.push(`hold still carries ${quantity} ${item_id}`);
  if(ship.fuel<ship.max_fuel)out.push(`fuel ${ship.fuel} of ${ship.max_fuel}`);
  if(ship.hull<ship.max_hull)out.push(`hull ${ship.hull} of ${ship.max_hull}`);
  return out;
}

/** Two measures of the same hold, summed per item. */
const addYield=(rows:MineYieldRow[],more:MineYieldRow[]):MineYieldRow[]=>{
  const totals:Record<string,number>={};
  for(const row of [...rows,...more])totals[row.item_id]=(totals[row.item_id]??0)+row.quantity;
  return Object.entries(totals).sort(([a],[b])=>a<b?-1:1)
    .map(([item_id,quantity])=>({item_id,quantity}));
};

/** The station's own store, probed once. No storage is not a failure; it is a full hold: a
 * refusal is no store. A lost reply is not an answer, so the read is retried, and one still lost
 * ends the settle step in its own words rather than passing for "no store". */
const hasStorage=Effect.gen(function*() {
  const game=yield* Game;
  const viewed=yield* Effect.result(game.command('spacemolt_storage/view',{}).pipe(
    Effect.retry({times:2,schedule:Schedule.exponential('1 second'),while:error=>error._tag==='ReplyLost'})));
  if(Result.isFailure(viewed)&&viewed.failure._tag==='ReplyLost')return yield* viewed.failure;
  return Result.isSuccess(viewed)&&Array.isArray(field(replyBody(viewed.success),'items'));
});

/** Stow what the site gives in the station store. Nothing is ever offered at the market
 * counter: a gather job ends with the resources kept for later use, and selling them is
 * a separate counter the agent chooses on its own.
 *
 * What moves is every hold row whose item is one of the site's own resources — whichever
 * trip mined it, including one an interrupted run left aboard — and nothing else, so the
 * pilot's cabins, spares and mission goods stay put without a keep list or a guess about
 * what the hold held at departure (C8). A station with no store leaves the take in the
 * hold, reported as `held`, which is an honest end to the trip and not a failure.
 */
const stowYield=(account:ReadinessAccount,mine:Set<string>)=>Effect.gen(function*() {
  const game=yield* Game;
  const refresh=attempt('refresh',()=>account.refresh());
  yield* refresh;
  const credits=account.state.player?.credits??0;
  const outcome:SettleOutcome={sold:[],deposited:[],held:[],unsettled:[],
    credits_before:credits,credits_after:credits};
  let carried=miningInventory(account.state),drift='';
  const rows=Object.entries(carried).filter(([item_id,quantity])=>quantity>0&&mine.has(item_id))
    .map(([item_id,quantity])=>({item_id,quantity}));
  if(!rows.length)return outcome;
  const dock=account.state.location?.docked_at??null;
  if(!dock)return yield* new NotDocked({message:'Stowing a take requires a docked ship; no station store is reachable'});
  const stored=yield* hasStorage;

  /** Send one deposit, then read the world. The reply's claim is not evidence. */
  const send=(item_id:string,quantity:number)=>Effect.gen(function*() {
    const before=carried[item_id]??0;
    let lost='';
    const sent=yield* Effect.result(game.command('spacemolt_storage/deposit',{item_id,quantity}));
    if(Result.isFailure(sent)) {
      const said=message(sent.failure.cause);
      if(sent.failure._tag!=='ReplyLost')return {moved:0,rejected:said,lost};
      lost=said;
    }
    yield* refresh;
    carried=miningInventory(account.state);
    if((account.state.location?.docked_at??null)!==dock)drift=`no longer docked at ${dock}`;
    return {moved:before-(carried[item_id]??0),rejected:'',lost};
  });

  for(const row of rows) {
    const quantity=Math.min(row.quantity,carried[row.item_id]??0);
    if(quantity<=0)continue;
    if(!stored||drift) {
      if(!drift){outcome.held.push({item_id:row.item_id,quantity});continue;}
      outcome.unsettled.push({item_id:row.item_id,quantity,quoted:null,
        gap:`stowing stopped: ${drift}`});
      continue;
    }
    // The reply is gone, not the outcome: the read above says whether it landed, and a deposit
    // that moved nothing is reported, never re-sent (docs/EFFECT.md: a mutation re-observes).
    const result=yield* send(row.item_id,quantity);
    if(result.moved>0)outcome.deposited.push({item_id:row.item_id,quantity:result.moved});
    else outcome.unsettled.push({item_id:row.item_id,quantity,quoted:null,
      gap:result.rejected||`deposit did not clear: cargo -${result.moved}${result.lost?` after ${result.lost}`:''}`});
  }
  return outcome;
});

/** One gather job, dock to dock: out to the site, mine the hold full, home, settle, service.
 *
 * Every step is a proven primitive and each one's own outcome decides whether the next
 * runs — a blocked step ends the job at that step with the reason, a failed step ends it
 * failed, and nothing is re-issued here (each primitive reconciles its own lost reply).
 * The end state is a claim about the world, so an authoritative read closes the job:
 * docked at home, the hold settled, serviced to the mood's margins, or it is a failure
 * naming what differed. Every command goes through `Game`.
 */
export const gatherJobEffect=(account:ReadinessAccount,
  plan:GatherPlan,options:GatherOptions={})=>Effect.gen(function*() {
  const steps:GatherStep[]=[];
  let mined:MineYieldRow[]=[],settled:SettleOutcome|null=null,serviced:ServiceOutcome|null=null;
  const {onStep,mine:mineOptions,moodNow,...travelOptions}=options;
  const refresh=attempt('refresh',()=>account.refresh());
  /** The mood in force now, read when it is needed rather than when the job was planned. */
  const mood=()=>moodNow?.()??plan.mood;
  // maxJumps null: each leg may cross systems, bounded by the tank covering the route rather
  // than a jump count, as travel is.
  const legOptions=():TravelOptions=>({maxJumps:null,...travelOptions});
  // What this site gives, read from the world at the site itself (`V2Location.resources`).
  // That list, not the hold at departure, is what the job may stow.
  const gives=new Set<string>();
  // Where the last step left the pilot. Every step reads before it decides, so this is what
  // the next step's reconciling read is measured against.
  let expected:Position|null=null,moved:Reconciliation|undefined;

  const step=(name:GatherStepName,run:Effect.Effect<Report|void,StepError,Game>)=>Effect.gen(function*() {
    let report:Report|void;
    // Reconcile from live state before acting: the world moves between every look and every
    // act, and a step that mutates on a stale belief is the one thing this must not do. A
    // failure here is the job's, not the step's: it rejects the whole job.
    const here=expected;
    const drift=here?yield* reconcileMoveEffect(account,here):null;
    if(drift?.moved) {
      moved=drift;
      report={outcome:movedOutcome(drift.cause),reason:`unsolicited move (${drift.cause}): ${drift.evidence}`};
    } else {
      const ran=yield* Effect.result(run);
      if(Result.isSuccess(ran))report=ran.success;
      else {
        const error=raw(ran.failure);
        // A step's own refusal may already have done the reconciling (travel's arrival wait).
        const carried=error instanceof ArrivalUnresolved?error.moved:undefined;
        if(carried)moved=carried;
        report={outcome:carried?movedOutcome(carried.cause):blocking(error)?'blocked':'failed',
          reason:message(error)};
      }
    }
    const {outcome,reason}:Report=report??{outcome:'done'};
    const done:GatherStep={name,outcome,...reason===undefined?{}:{reason}};
    steps.push(done);
    const stowed=settled;
    onStep?.(done,{yield:mined,...stowed?{deposited:stowed.deposited}:{}});
    if(outcome==='done')expected=position(account.state);
    return outcome==='done'?null:{outcome,steps,yield:mined,settled,serviced,
      ...moved?{moved}:{},reason:`${name} ${outcome}: ${reason}`} satisfies GatherOutcome;
  });

  let stop=yield* step('travel',Effect.gen(function*() {
    yield* judged(travelToEffect(account,plan.site,legOptions()));
    yield* refresh;
    for(const row of account.state.location?.resources??[])gives.add(String(row.item_id));
  }));
  if(stop)return stop;

  stop=yield* step('mine',Effect.gen(function*() {
    // The yield of the ticks that landed, as the reads after each one measured it: a refusal
    // after them must not drop what is already aboard from the report.
    let landed:MineYieldRow[]=[];
    const onCycle=(rows:MineYieldRow[],cycles:number)=>{landed=rows;mineOptions?.onCycle?.(rows,cycles);};
    const sent=yield* Effect.result(mineToFullEffect(account,{...mineOptions,onCycle}));
    const took=Result.isSuccess(sent)?sent.success.yield:landed;
    mined=addYield(mined,took);
    // A site that answered no resource list still gives what it just put in the hold.
    for(const row of took)gives.add(row.item_id);
    // Live F-U02 (TestPilot.cv, 2026-10-02): `no_mining` read as a broken script, and its why said
    // "mine failed: mine failed: …". A refusal is a world the pilot can answer, in the server's code.
    if(Result.isFailure(sent)) {
      const error=sent.failure;
      return error._tag==='ReplyLost'?{outcome:'failed',reason:`${error.action}: ${causeText(error.cause)}`} satisfies Report:
        {outcome:'blocked',reason:`${error.code}: ${error.message}`} satisfies Report;
    }
    const dug=sent.success;
    const why=dug.reason===undefined?{}:{reason:dug.reason};
    if(dug.outcome==='failed')return {outcome:'failed',...why} satisfies Report;
    // Tired ends the dig and flies the safe leg home; the pilot's own stop ends the job here.
    if(dug.outcome==='stopped'&&dug.reason!=='tired')return {outcome:'blocked',...why} satisfies Report;
    // A site that gave nothing is not a trip to finish; one that gave something is.
    if(dug.outcome==='depleted')return {outcome:mined.length?'done':'blocked',...why} satisfies Report;
  }));
  if(stop)return stop;

  stop=yield* step('return',judged(travelToEffect(account,{system_id:plan.home.system_id,poi_id:plan.home.poi_id},legOptions())).pipe(Effect.asVoid));
  if(stop)return stop;

  stop=yield* step('dock',judged(dockAtEffect(account,plan.home.base_id,options)).pipe(Effect.asVoid));
  if(stop)return stop;

  stop=yield* step('settle',Effect.gen(function*() {
    const stowed=yield* stowYield(account,gives);
    settled=stowed;
    if(stowed.unsettled.length)return {outcome:'blocked',
      reason:stowed.unsettled.map(row=>`${row.item_id}: ${row.gap}`).join('; ')} satisfies Report;
  }));
  if(stop)return stop;

  // The spend margin is the mood's too, and the mood by now is the one the crossing imposed:
  // Tired's row is "service only", so the planning mood's tighter budget is what refuses the
  // resupply the job just flew home for.
  stop=yield* step('service',Effect.gen(function*() {
    serviced=yield* judged(serviceShipEffect(account,{mood:mood()}));
  }));
  if(stop)return stop;

  stop=yield* step('verify',Effect.gen(function*() {
    yield* refresh;
    const gaps=differences(account.state,plan,settled,gives);
    if(gaps.length)return {outcome:'failed',reason:gaps.join('; ')} satisfies Report;
  }));
  if(stop)return stop;
  return {outcome:'done',steps,yield:mined,settled,serviced} satisfies GatherOutcome;
});
