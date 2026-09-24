import type {GameState} from '@spacemolt/lib';
import {DockBlocked,dockAt} from './dock.ts';
import {mineToFull,type MineOptions,type MineYieldRow} from './mine.ts';
import {miningInventory} from './mining-inventory.ts';
import type {Mood} from './mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {ServiceBlocked,serviceShip,type ServiceOutcome} from './servicing.ts';
import type {SettleOutcome} from './settle-cargo.ts';
import {details} from './response-details.ts';
import {replyLost} from './command-boundary.ts';
import {ArrivalUnresolved,TiredStop,TravelBlocked,travelTo,type TravelOptions} from './travel.ts';
import {movedOutcome,position,reconcileMove,type Position,type Reconciliation} from './reconcile.ts';

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
  /** The mood to fly the next leg on, read when that leg starts. The runtime imposes Tired
   * between any two commands, so the mood the job was planned under is stale by the time the
   * leg home is flown — and a leg flown on a stale mood is flown on the wrong fuel reserve.
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
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

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

/** The station's own store, probed once. No storage is not a failure; it is a full hold. */
const hasStorage=async(command:ReadinessCommand)=>{
  try {return Array.isArray(details(await command('spacemolt_storage/view',{})).items);}
  catch {return false;}
};

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
async function stowYield(account:ReadinessAccount,command:ReadinessCommand,
  mine:Set<string>):Promise<SettleOutcome> {
  await account.refresh();
  const credits=account.state.player?.credits??0;
  const outcome:SettleOutcome={sold:[],deposited:[],held:[],unsettled:[],
    credits_before:credits,credits_after:credits};
  let carried=miningInventory(account.state),drift='';
  const rows=Object.entries(carried).filter(([item_id,quantity])=>quantity>0&&mine.has(item_id))
    .map(([item_id,quantity])=>({item_id,quantity}));
  if(!rows.length)return outcome;
  const dock=account.state.location?.docked_at??null;
  if(!dock)throw new Error('Stowing a take requires a docked ship; no station store is reachable');
  const stored=await hasStorage(command);

  /** Send one deposit, then read the world. The reply's claim is not evidence. */
  const send=async(item_id:string,quantity:number)=>{
    const before=carried[item_id]??0;
    let lost='',rejected='';
    try {await command('spacemolt_storage/deposit',{item_id,quantity});}
    catch(error){if(replyLost(error))lost=message(error);else rejected=message(error);}
    if(rejected)return {moved:0,rejected,lost};
    await account.refresh();
    carried=miningInventory(account.state);
    if((account.state.location?.docked_at??null)!==dock)drift=`no longer docked at ${dock}`;
    return {moved:before-(carried[item_id]??0),rejected,lost};
  };

  for(const row of rows) {
    const quantity=Math.min(row.quantity,carried[row.item_id]??0);
    if(quantity<=0)continue;
    if(!stored||drift) {
      if(!drift){outcome.held.push({item_id:row.item_id,quantity});continue;}
      outcome.unsettled.push({item_id:row.item_id,quantity,quoted:null,
        gap:`stowing stopped: ${drift}`});
      continue;
    }
    let result=await send(row.item_id,quantity);
    // The reply is gone, not the outcome: a read says whether it landed, and only a read
    // showing nothing moved in an unchanged world earns exactly one re-issue.
    if(result.lost&&!result.moved&&!drift)result=await send(row.item_id,quantity);
    if(result.moved>0)outcome.deposited.push({item_id:row.item_id,quantity:result.moved});
    else outcome.unsettled.push({item_id:row.item_id,quantity,quoted:null,
      gap:result.rejected||`deposit did not clear: cargo -${result.moved}${result.lost?` after ${result.lost}`:''}`});
  }
  return outcome;
}

/** One gather job, dock to dock: out to the site, mine the hold full, home, settle, service.
 *
 * Every step is a proven primitive and each one's own outcome decides whether the next
 * runs — a blocked step ends the job at that step with the reason, a failed step ends it
 * failed, and nothing is re-issued here (each primitive reconciles its own lost reply).
 * The end state is a claim about the world, so an authoritative read closes the job:
 * docked at home, the hold settled, serviced to the mood's margins, or it is a failure
 * naming what differed.
 */
export async function gatherJob(account:ReadinessAccount,command:ReadinessCommand,
  plan:GatherPlan,options:GatherOptions={}):Promise<GatherOutcome> {
  const steps:GatherStep[]=[];
  let mined:MineYieldRow[]=[],settled:SettleOutcome|null=null,serviced:ServiceOutcome|null=null;
  const {onStep,mine:mineOptions,moodNow,...travelOptions}=options;
  /** The mood this leg flies on, read as the leg starts rather than when the job was planned:
   * Tired arrives mid-job and carries its own fuel reserve, and the leg home is quoted against
   * the mood the pilot is in now. */
  const mood=()=>moodNow?.()??plan.mood;
  // maxJumps null: each leg may cross systems, bounded by the mood's fuel reserve rather
  // than a jump count, as travel is.
  //
  // `toBase` is the return leg, which ends at home's own base: that is the one place a Tired
  // pilot may still be flown, and the whole point of the stop. Every other leg refuses its
  // next move once Tired is imposed, so a crossing ends the route where the ship is sitting
  // rather than one job gate later.
  const legOptions=(toBase:boolean):TravelOptions=>({maxJumps:null as number|null,...travelOptions,mood:mood(),moodNow:mood,
    ...toBase?{}:{checkMove:()=>{
      if(mood()==='Tired')throw new TiredStop('Tired: this leg is not going to a base; only a base is admitted from here');
      travelOptions.checkMove?.();
    }}});
  // What this site gives, read from the world at the site itself (`V2Location.resources`).
  // That list, not the hold at departure, is what the job may stow.
  const gives=new Set<string>();
  // Where the last step left the pilot. Every step reads before it decides, so this is what
  // the next step's reconciling read is measured against.
  let expected:Position|null=null,moved:Reconciliation|undefined;

  const attempt=async(name:GatherStepName,run:()=>Promise<Omit<GatherStep,'name'>|void>) => {
    let report:Omit<GatherStep,'name'>|void;
    // Reconcile from live state before acting: the world moves between every look and every
    // act, and a step that mutates on a stale belief is the one thing this must not do.
    const drift=expected?await reconcileMove(account,expected):null;
    if(drift?.moved) {
      moved=drift;
      report={outcome:movedOutcome(drift.cause),reason:`unsolicited move (${drift.cause}): ${drift.evidence}`};
    } else {
      try {report=await run();}
      catch(error) {
        // A step's own refusal may already have done the reconciling (travel's arrival wait).
        const carried=error instanceof ArrivalUnresolved?error.moved:undefined;
        if(carried)moved=carried;
        report={outcome:carried?movedOutcome(carried.cause):blocking(error)?'blocked':'failed',
          reason:message(error)};
      }
    }
    const {outcome,reason}=report??{outcome:'done' as StepOutcome};
    const done:GatherStep={name,outcome,...reason===undefined?{}:{reason}};
    steps.push(done);
    onStep?.(done,{yield:mined,...settled?{deposited:(settled as SettleOutcome).deposited}:{}});
    if(outcome==='done')expected=position(account.state);
    return outcome==='done'?null:{outcome,steps,yield:mined,settled,serviced,
      ...moved?{moved}:{},reason:`${name} ${outcome}: ${reason}`} satisfies GatherOutcome;
  };

  let stop=await attempt('travel',async()=>{
    await travelTo(account,command,plan.site,legOptions(false));
    await account.refresh();
    for(const row of account.state.location?.resources??[])gives.add(String(row.item_id));
  });
  if(stop)return stop;

  stop=await attempt('mine',async()=>{
    const dug=await mineToFull(account,command,mineOptions);
    mined=addYield(mined,dug.yield);
    // A site that answered no resource list still gives what it just put in the hold.
    for(const row of dug.yield)gives.add(row.item_id);
    if(dug.outcome==='failed')return {outcome:'failed',reason:dug.reason};
    // Tired ends the dig and flies the safe leg home; the pilot's own stop ends the job here.
    if(dug.outcome==='stopped'&&dug.reason!=='tired')return {outcome:'blocked',reason:dug.reason};
    // A site that gave nothing is not a trip to finish; one that gave something is.
    if(dug.outcome==='depleted')return {outcome:mined.length?'done':'blocked',reason:dug.reason};
  });
  if(stop)return stop;

  stop=await attempt('return',async()=>{
    await travelTo(account,command,{system_id:plan.home.system_id,poi_id:plan.home.poi_id},legOptions(true));
  });
  if(stop)return stop;

  stop=await attempt('dock',async()=>{await dockAt(account,command,plan.home.base_id,options);});
  if(stop)return stop;

  stop=await attempt('settle',async()=>{
    settled=await stowYield(account,command,gives);
    if(settled.unsettled.length)return {outcome:'blocked',
      reason:settled.unsettled.map(row=>`${row.item_id}: ${row.gap}`).join('; ')};
  });
  if(stop)return stop;

  // The spend margin is the mood's too, and the mood by now is the one the crossing imposed:
  // Tired's row is "service only", so the planning mood's tighter budget is what refuses the
  // resupply the job just flew home for.
  stop=await attempt('service',async()=>{serviced=await serviceShip(account,command,{mood:mood()});});
  if(stop)return stop;

  stop=await attempt('verify',async()=>{
    await account.refresh();
    const gaps=differences(account.state,plan,settled,gives);
    if(gaps.length)return {outcome:'failed',reason:gaps.join('; ')};
  });
  if(stop)return stop;
  return {outcome:'done',steps,yield:mined,settled,serviced};
}
