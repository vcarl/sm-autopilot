import type {GameState} from '@spacemolt/lib';
import {DockBlocked,dockAt} from './dock.ts';
import {mineToFull,type MineYieldRow} from './mine.ts';
import {miningInventory} from './mining-inventory.ts';
import type {Mood} from './mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {ServiceBlocked,serviceShip,type ServiceOutcome} from './servicing.ts';
import {settleCargo,type SettleOutcome} from './settle-cargo.ts';
import {ArrivalUnresolved,TravelBlocked,travelTo,type TravelOptions} from './travel.ts';

export interface GatherPlan {
  home:{system_id:string;poi_id:string;base_id:string};
  site:{system_id:string;poi_id:string};
  mood:Mood;
  /** The pilot's own cargo — cabins, spares. Never offered at the counter. */
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
  settled:SettleOutcome|null;
  serviced:ServiceOutcome|null;
  reason?:string;
}

/** The refusals the steps raise by name: a world condition, not a broken script. */
const blocking=(error:unknown)=>error instanceof TravelBlocked||error instanceof DockBlocked||
  error instanceof ServiceBlocked||error instanceof ArrivalUnresolved;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** What the closing read must agree with before the job may call itself done. */
function differences(state:GameState,plan:GatherPlan,settled:SettleOutcome):string[] {
  const {ship,location}=state??{};
  if(!ship||!location)return ['authoritative ship and location unavailable at the end of the job'];
  const out:string[]=[];
  if(location.in_transit)out.push('still in transit');
  if(location.docked_at!==plan.home.base_id)
    out.push(`docked at ${location.docked_at??'nothing'}, not ${plan.home.base_id}`);
  const accounted=new Set([...plan.keep??[],...settled.held.map(row=>row.item_id)]);
  for(const [item_id,quantity] of Object.entries(miningInventory(state)))
    if(quantity>0&&!accounted.has(item_id))out.push(`hold still carries ${quantity} ${item_id}`);
  if(ship.fuel<ship.max_fuel)out.push(`fuel ${ship.fuel} of ${ship.max_fuel}`);
  if(ship.hull<ship.max_hull)out.push(`hull ${ship.hull} of ${ship.max_hull}`);
  return out;
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

  let stop=await attempt('travel',async()=>{await travelTo(account,command,plan.site,legOptions);});
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
    settled=await settleCargo(account,command,{keep:plan.keep});
    if(settled.unsettled.length)return {outcome:'blocked',
      reason:settled.unsettled.map(row=>`${row.item_id}: ${row.gap}`).join('; ')};
  });
  if(stop)return stop;

  stop=await attempt('service',async()=>{serviced=await serviceShip(account,command,{mood:plan.mood});});
  if(stop)return stop;

  stop=await attempt('verify',async()=>{
    await account.refresh();
    const gaps=differences(account.state,plan,settled!);
    if(gaps.length)return {outcome:'failed',reason:gaps.join('; ')};
  });
  if(stop)return stop;
  return {outcome:'done',steps,yield:mined,settled,serviced};
}
