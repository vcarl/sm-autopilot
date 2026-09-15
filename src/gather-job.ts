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
export interface GatherStep {name:string;outcome:StepOutcome;reason?:string}
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
  reason?:string;
}

/** The refusals the steps raise by name: a world condition, not a broken script. */
const blocking=(error:unknown)=>error instanceof TravelBlocked||error instanceof DockBlocked||
  error instanceof ServiceBlocked||error instanceof ArrivalUnresolved;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** What the closing read must agree with before the job may call itself done. */
function differences(state:GameState,plan:GatherPlan,settled:SettleOutcome,own:Set<string>):string[] {
  const {ship,location}=state??{};
  if(!ship||!location)return ['authoritative ship and location unavailable at the end of the job'];
  const out:string[]=[];
  if(location.in_transit)out.push('still in transit');
  if(location.docked_at!==plan.home.base_id)
    out.push(`docked at ${location.docked_at??'nothing'}, not ${plan.home.base_id}`);
  const accounted=new Set([...own,...settled.held.map(row=>row.item_id)]);
  for(const [item_id,quantity] of Object.entries(miningInventory(state)))
    if(quantity>0&&!accounted.has(item_id))out.push(`hold still carries ${quantity} ${item_id}`);
  if(ship.fuel<ship.max_fuel)out.push(`fuel ${ship.fuel} of ${ship.max_fuel}`);
  if(ship.hull<ship.max_hull)out.push(`hull ${ship.hull} of ${ship.max_hull}`);
  return out;
}

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
  plan:GatherPlan,options:TravelOptions={}):Promise<GatherOutcome> {
  const steps:GatherStep[]=[];
  let mined:MineYieldRow[]=[],settled:SettleOutcome|null=null,serviced:ServiceOutcome|null=null;
  const legOptions={...options,mood:plan.mood};
  const attempt=async(name:string,run:()=>Promise<Omit<GatherStep,'name'>|void>) => {
    let report:Omit<GatherStep,'name'>|void;
    try {report=await run();}
    catch(error){report={outcome:blocking(error)?'blocked':'failed',reason:message(error)};}
    const {outcome,reason}=report??{outcome:'done' as StepOutcome};
    steps.push({name,outcome,...reason===undefined?{}:{reason}});
    return outcome==='done'?null:{outcome,steps,yield:mined,settled,serviced,
      reason:`${name} ${outcome}: ${reason}`} satisfies GatherOutcome;
  };

  // The hold at the opening read is the pilot's own — cabins, fitted spares, whatever was
  // already aboard — so the closing read expects it to still be there at the end.
  const own=new Set(plan.keep??[]);
  let stop=await attempt('travel',async()=>{
    await account.refresh();
    for(const item_id of Object.keys(miningInventory(account.state)))own.add(item_id);
    await travelTo(account,command,plan.site,legOptions);
  });
  if(stop)return stop;

  stop=await attempt('mine',async()=>{
    const dug=await mineToFull(account,command);
    mined=dug.yield;
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
    const gaps=differences(account.state,plan,settled!,own);
    if(gaps.length)return {outcome:'failed',reason:gaps.join('; ')};
  });
  if(stop)return stop;
  return {outcome:'done',steps,yield:mined,settled,serviced};
}
