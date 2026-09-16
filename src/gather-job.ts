import type {GameState} from '@spacemolt/lib';
import {DockBlocked,dockAt} from './dock.ts';
import {mineToFull,type MineYieldRow} from './mine.ts';
import {miningInventory} from './mining-inventory.ts';
import type {Mood} from './mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {ServiceBlocked,serviceShip,type ServiceOutcome} from './servicing.ts';
import type {SettleOutcome} from './settle-cargo.ts';
import {details} from './response-details.ts';
import {replyLost} from './command-boundary.ts';
import {ArrivalUnresolved,TravelBlocked,travelTo,type TravelOptions} from './travel.ts';
import {movedOutcome,position,reconcileMove,type Position,type Reconciliation} from './reconcile.ts';

export interface GatherPlan {
  home:{system_id:string;poi_id:string;base_id:string};
  site:{system_id:string;poi_id:string};
  mood:Mood;
  /** The pilot's own cargo — cabins, spares. Never moved by the job, even if this trip
   * mined more of it. The hold as it stood at the job's opening read is added to this. */
  keep?:string[];
}
/** `blocked` is a world the pilot can answer at a juncture; `failed` needs a reading. */
export type StepOutcome='done'|'blocked'|'failed';
/** The job's steps, in the order they run. The list is also the resume ladder. */
export const STEPS=['travel','mine','return','dock','settle','service','verify'] as const;
export type GatherStepName=typeof STEPS[number];
export interface GatherStep {name:string;outcome:StepOutcome;reason?:string}
export interface GatherOptions extends TravelOptions {
  /** This job was already under way when the runner died. The world, not the record, says
   * where it had got to: the entry read below picks the step and the ones before it are
   * skipped rather than re-sent. */
  resume?:boolean;
  /** Each step as it ends, with the numbers that step moved. The job keeps no opinion about
   * what is done with them: `jobs/gather.ts` writes the run record and the journal line. */
  onStep?:(step:GatherStep,moved:{yield:MineYieldRow[];deposited?:MineYieldRow[]})=>void;
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
function differences(state:GameState,plan:GatherPlan,settled:SettleOutcome|null,own:Set<string>):string[] {
  const {ship,location}=state??{};
  if(!ship||!location)return ['authoritative ship and location unavailable at the end of the job'];
  const out:string[]=[];
  if(location.in_transit)out.push('still in transit');
  if(location.docked_at!==plan.home.base_id)
    out.push(`docked at ${location.docked_at??'nothing'}, not ${plan.home.base_id}`);
  // No settlement at all is a job resumed past its counter: this trip's take is already
  // stowed, so the hold has nothing left for the closing read to account for.
  const accounted=new Set([...own,...settled?.held.map(row=>row.item_id)??[]]);
  for(const [item_id,quantity] of Object.entries(miningInventory(state)))
    if(quantity>0&&!accounted.has(item_id))out.push(`hold still carries ${quantity} ${item_id}`);
  if(ship.fuel<ship.max_fuel)out.push(`fuel ${ship.fuel} of ${ship.max_fuel}`);
  if(ship.hull<ship.max_hull)out.push(`hull ${ship.hull} of ${ship.max_hull}`);
  return out;
}

/** Where a job that was already under way re-enters, read from the world and nothing else.
 *
 * Every step of a gather job is named for an end state and already sends nothing when that
 * state holds (S42): `travelTo` to a POI the ship is at, `mineToFull` on a full hold,
 * `dockAt` on a dock the ship has, a deposit bounded by what the hold still shows, a
 * service with no fuel or hull due. So resuming is not a special mode — it is entering the
 * same ladder at the rung the world implies, which is what makes it safe to re-run.
 *
 * The one thing the world cannot say is whether a job had begun at all: docked at home with
 * a clear hold is both a gather job's start and its end. Only the runner's record breaks
 * that tie, which is why this is asked for by `resume` and never inferred.
 */
export function entryStep(state:GameState,plan:GatherPlan,take:number):GatherStepName|{blocked:string} {
  const {ship,location}=state??{};
  if(!ship||!location)return {blocked:'authoritative ship and location unavailable'};
  const here=`${location.system_id}/${location.poi_id??'nowhere'}`;
  if(location.in_transit)
    return location.transit_dest_poi_id===plan.site.poi_id?'travel':'return';
  if(location.docked_at)
    return location.docked_at!==plan.home.base_id
      ?{blocked:`docked at ${location.docked_at}, which is neither this job's home ${plan.home.base_id} nor a step of it`}
      :take>0?'settle':'service';
  if(location.system_id===plan.site.system_id&&location.poi_id===plan.site.poi_id)
    return ship.cargo_used>=ship.cargo_capacity?'return':'mine';
  if(location.system_id===plan.home.system_id&&location.poi_id===plan.home.poi_id)return 'dock';
  return {blocked:`at ${here}, which is neither the site ${plan.site.system_id}/${plan.site.poi_id} nor home ${plan.home.system_id}/${plan.home.poi_id}`};
}

/** Two measures of the same hold, summed per item: a resumed job's take plus what it mines. */
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

/** Stow this job's take in the station store. Nothing is ever offered at the market
 * counter: a gather job ends with the resources kept for later use, and selling them is
 * a separate counter the agent chooses on its own. Only the mine step's measured yield
 * moves, bounded by what the authoritative read still shows aboard, so the cargo the
 * pilot arrived with — cabins, fitted spares — is untouched by construction (C8). A
 * station with no store leaves the take in the hold, reported as `held`, which is an
 * honest end to the trip and not a failure.
 */
async function stowYield(account:ReadinessAccount,command:ReadinessCommand,
  mined:MineYieldRow[],keep:string[]=[]):Promise<SettleOutcome> {
  const own=new Set(keep);
  await account.refresh();
  const credits=account.state.player?.credits??0;
  const outcome:SettleOutcome={sold:[],deposited:[],held:[],unsettled:[],
    credits_before:credits,credits_after:credits};
  const rows=mined.filter(row=>row.quantity>0&&!own.has(row.item_id));
  if(!rows.length)return outcome;
  const dock=account.state.location?.docked_at??null;
  if(!dock)throw new Error('Stowing a take requires a docked ship; no station store is reachable');
  const stored=await hasStorage(command);
  let carried=miningInventory(account.state),drift='';

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
  const {resume,onStep,...travelOptions}=options;
  // maxJumps null: each leg may cross systems, bounded by the mood's fuel reserve rather
  // than a jump count, as travel is.
  const legOptions={maxJumps:null as number|null,...travelOptions,mood:plan.mood};
  // The hold at the opening read is the pilot's own — cabins, fitted spares, whatever was
  // already aboard — so the closing read expects it to still be there at the end.
  const own=new Set(plan.keep??[]);
  let from=0;
  // Where the last step left the pilot. Every step reads before it decides, so this is what
  // the next step's reconciling read is measured against.
  let expected:Position|null=null,moved:Reconciliation|undefined;

  if(resume) {
    // Reconcile before deciding anything: the world moved while the runner was gone.
    await account.refresh();
    // A resumed job never saw its own departure, so `keep` is the whole of what it may
    // treat as the pilot's own; everything else aboard is this job's take.
    const aboard=Object.entries(miningInventory(account.state))
      .filter(([item_id,quantity])=>quantity>0&&!own.has(item_id))
      .map(([item_id,quantity])=>({item_id,quantity}));
    const entry=entryStep(account.state,plan,aboard.length);
    if(typeof entry!=='string') {
      steps.push({name:'resume',outcome:'blocked',reason:entry.blocked});
      return {outcome:'blocked',steps,yield:[],settled:null,serviced:null,
        reason:`resume blocked: ${entry.blocked}`};
    }
    from=STEPS.indexOf(entry);
    if(from>STEPS.indexOf('travel'))mined=addYield([],aboard);
    expected=position(account.state);
  }

  const attempt=async(name:GatherStepName,run:()=>Promise<Omit<GatherStep,'name'>|void>) => {
    if(STEPS.indexOf(name)<from)return null; // its end state already holds; send nothing
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
    await account.refresh();
    for(const item_id of Object.keys(miningInventory(account.state)))own.add(item_id);
    await travelTo(account,command,plan.site,legOptions);
  });
  if(stop)return stop;

  stop=await attempt('mine',async()=>{
    const dug=await mineToFull(account,command);
    mined=addYield(mined,dug.yield);
    if(dug.outcome==='failed')return {outcome:'failed',reason:dug.reason};
    // A site that gave nothing is not a trip to finish; one that gave something is.
    if(dug.outcome==='depleted')return {outcome:mined.length?'done':'blocked',reason:dug.reason};
  });
  if(stop)return stop;

  stop=await attempt('return',async()=>{
    await travelTo(account,command,{system_id:plan.home.system_id,poi_id:plan.home.poi_id},legOptions);
  });
  if(stop)return stop;

  stop=await attempt('dock',async()=>{await dockAt(account,command,plan.home.base_id,options);});
  if(stop)return stop;

  stop=await attempt('settle',async()=>{
    settled=await stowYield(account,command,mined,plan.keep);
    if(settled.unsettled.length)return {outcome:'blocked',
      reason:settled.unsettled.map(row=>`${row.item_id}: ${row.gap}`).join('; ')};
  });
  if(stop)return stop;

  stop=await attempt('service',async()=>{serviced=await serviceShip(account,command,{mood:plan.mood});});
  if(stop)return stop;

  stop=await attempt('verify',async()=>{
    await account.refresh();
    const gaps=differences(account.state,plan,settled,own);
    if(gaps.length)return {outcome:'failed',reason:gaps.join('; ')};
  });
  if(stop)return stop;
  return {outcome:'done',steps,yield:mined,settled,serviced};
}
