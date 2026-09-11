import type {Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';
import {inspectReadiness} from './readiness.ts';
import {miningInventory,miningYield,measureMineYield} from './mining-inventory.ts';
import {snapshotSkills,skillProgress,type SkillSnapshot} from './progression.ts';
import type {ExecutionContext} from './execution-policy.ts';

type Wire=Record<string,any>;
const fuelReserve=10,freeCargo=10;
const knownCondition=(account:Account)=>Boolean(account.ship&&['fuel','max_fuel','hull','max_hull','shield','max_shield','cargo_used','cargo_capacity'].every(key=>Number.isFinite((account.ship as unknown as Wire)[key])&&(account.ship as unknown as Wire)[key]>=0));
export interface GatherParams {poi_id:string;cycles:number}
export interface GatherReceipt {
  status:'running'|'completed'|'blocked'|'interrupted';
  poi_id:string;system_id:string;ship_id:string;cycles_requested:number;cycles_completed:number;stop_reason:string;
  yields:Record<string,number>;retained_cargo:Record<string,number>;starting_cargo:Record<string,number>;
  unattributed_cargo_gains:Record<string,number>;
  yield_measurements:ReturnType<typeof measureMineYield>[];
  skills_before:SkillSnapshot;skill_progress:ReturnType<typeof skillProgress>;
  assessment:Wire;resource_observation?:Wire;inventory_verification?:string;
}

/** get_system exposes candidate types; only get_poi at arrival verifies resources. */
export async function observeGathering(account:Account,command:IndustryCommand) {
  const response=details(await command('spacemolt/get_system',{}));
  const system=response.system;
  if(!system||system.id!==account.location?.system_id||!Array.isArray(system.pois))throw new Error('Current system POIs unavailable for gathering');
  return {observed_at:new Date().toISOString(),system_id:system.id,
    candidates:system.pois.filter((poi:Wire)=>poi.type==='asteroid_belt').map((poi:Wire)=>({poi_id:poi.id,name:poi.name,type:poi.type})),
    limitation:'Local asteroid belts are candidates, not verified deposits or safe sites. Current get_poi resources and battle participation are checked after arrival; no remote resource or hostile-capability estimate is available.'};
}

export async function assessGathering(account:Account,command:IndustryCommand,context:ExecutionContext,params:GatherParams) {
  await account.refresh();
  const observation=await observeGathering(account,command);
  const blockers:string[]=[];
  if(!knownCondition(account))blockers.push('Complete canonical ship condition and cargo capacity required');
  if(!context.home||context.home.system_id!==observation.system_id)blockers.push('Choose a home in the current system; this gather consumer only visits local POIs');
  if(!account.location?.docked_at||account.location.in_transit)blockers.push('Start docked before a gathering sortie');
  if(!observation.candidates.some((poi:Wire)=>poi.poi_id===params.poi_id))blockers.push('Choose an observed local asteroid belt');
  const readiness=inspectReadiness(account.state,{requireMining:true,minFreeCargo:freeCargo,minFuel:params.cycles+fuelReserve+2,creditReserve:context.limits.credit_reserve});
  blockers.push(...readiness.blockers);
  if(readiness.actions.length)blockers.push('Prepare the mining fit before departure');
  if(!account.ship||account.ship.shield<account.ship.max_shield)blockers.push('Restore shields before departure');
  return {status:blockers.length?'blocked':'ready_to_verify_resources',blockers,observation,readiness,
    cycles:params.cycles,fuel_reserve:fuelReserve,min_free_cargo:freeCargo,credit_reserve:context.limits.credit_reserve,
    disposition:'Retain all newly gathered cargo. No sales, storage transfers, purchases or production.',
    limitation:'Admission permits one bounded local verification visit, not a promise of resources or a threat capability assessment.'};
}

export function verifyGatherInventory(receipt:GatherReceipt,account:Account) {
  if(account.ship?.id!==receipt.ship_id) {
    receipt.status='blocked';
    receipt.inventory_verification='Ship changed since gather admission; inventory provenance requires reconciliation';
    throw new Error(receipt.inventory_verification);
  }
  const cargo=miningInventory(account.state);
  receipt.retained_cargo=Object.fromEntries(Object.entries(receipt.yields).map(([item,quantity])=>[item,Math.min(quantity,Math.max(0,(cargo[item]??0)-(receipt.starting_cargo[item]??0)))]));
  receipt.skill_progress=skillProgress(receipt.skills_before,snapshotSkills(account.state));
  const preserved=Object.entries(receipt.starting_cargo).every(([item,quantity])=>(cargo[item]??0)>=quantity);
  const retained=Object.entries(receipt.yields).every(([item,quantity])=>receipt.retained_cargo[item]===quantity);
  receipt.inventory_verification=preserved&&retained?'Starting cargo preserved; measured new yield remains carried':'Starting cargo or gathered yield is missing; retention is not verified';
  if(!preserved||!retained){receipt.status='blocked';throw new Error(receipt.inventory_verification);}
}

/** The shared executor owns connection, checkpoints, defensive escape and cleanup. */
export async function gatherResources(account:Account,command:IndustryCommand,params:GatherParams,assessment:Wire,
  controls:{checkpoint:()=>Promise<void>;save:(receipt:GatherReceipt)=>void}) {
  const receipt:GatherReceipt={status:'running',poi_id:params.poi_id,system_id:account.location!.system_id,ship_id:account.ship!.id,
    cycles_requested:params.cycles,cycles_completed:0,stop_reason:'in_progress',yields:{},retained_cargo:{},unattributed_cargo_gains:{},
    starting_cargo:miningInventory(account.state),skills_before:snapshotSkills(account.state),skill_progress:[],assessment,yield_measurements:[]};
  const shipId=account.ship!.id;
  const save=()=>controls.save(structuredClone(receipt));
  save();
  try {
    if(assessment.status==='blocked') {receipt.status='blocked';receipt.stop_reason='admission_blocked';save();return receipt;}
    await controls.checkpoint();
    await command('spacemolt/undock',{});
    await controls.checkpoint();
    await command('spacemolt/travel',{id:params.poi_id});
    await controls.checkpoint();
    const atTarget=()=>account.ship?.id===shipId&&account.location?.system_id===receipt.system_id&&account.location?.poi_id===params.poi_id&&!account.location.in_transit&&!account.location.docked_at;
    if(!atTarget())throw new Error('Gather arrival or ship identity not verified');
    const poi=details(await command('spacemolt/get_poi',{}));
    receipt.resource_observation=poi;save();
    const resources=poi.resources??poi.poi?.resources;
    if(poi.active_battle) {
      receipt.stop_reason='active_battle_at_resource_site';
    } else if(poi.poi?.id!==params.poi_id||poi.poi?.system_id!==receipt.system_id||!Array.isArray(resources)||!resources.some((resource:Wire)=>typeof resource.resource_id==='string'&&Number.isFinite(resource.remaining)&&resource.remaining>0)) {
      receipt.stop_reason='resources_unverified_or_depleted';
    } else for(let cycle=0;cycle<params.cycles;cycle++) {
      await controls.checkpoint();
      await account.refresh();
      if(!atTarget())throw new Error('Gather location or ship changed; no further extraction');
      const readiness=inspectReadiness(account.state,{requireMining:true,minFreeCargo:freeCargo,minFuel:fuelReserve+2,creditReserve:assessment.credit_reserve});
      if(!knownCondition(account)||!readiness.ready||account.ship!.shield<account.ship!.max_shield){receipt.stop_reason='ship_reserve';break;}
      const before=miningInventory(account.state);
      let reply:unknown;
      try {reply=await command('spacemolt/mine',{});}
      catch(error) {
        const code=String((error as {code?:unknown})?.code??'');
        if(!['resource_depleted','no_resources','cargo_full'].includes(code))throw error;
        receipt.stop_reason=code;break;
      }
      if(!atTarget())throw new Error('Gather location or ship changed after mine; yield attribution is unverified');
      const result=details(reply);
      receipt.cycles_completed++;
      const changes=miningYield(before,miningInventory(account.state));
      const measurement=measureMineYield(before,miningInventory(account.state),reply,receipt,new Set(resources.map((resource:Wire)=>resource.resource_id)));
      receipt.yield_measurements.push(measurement);
      const gained:Record<string,number>=measurement.yields;
      for(const [item,quantity] of Object.entries(changes)) {
        const unattributed=quantity-(gained[item]??0);
        if(unattributed>0)receipt.unattributed_cargo_gains[item]=(receipt.unattributed_cargo_gains[item]??0)+unattributed;
      }
      for(const [item,quantity] of Object.entries(gained))receipt.yields[item]=(receipt.yields[item]??0)+quantity;
      verifyGatherInventory(receipt,account);save();
      // Persist the accepted cycle before a newly latched interruption takes over.
      await controls.checkpoint();
      if(!Object.keys(gained).length){receipt.stop_reason=result.kind==='filtered'?'filtered':'yield_unverified';break;}
      if(result.remaining===0){receipt.stop_reason='depleted';break;}
      receipt.stop_reason='cycle_limit';
    }
    receipt.status=Object.keys(receipt.yields).length&&receipt.stop_reason!=='yield_unverified'?'completed':'blocked';
    verifyGatherInventory(receipt,account);save();return receipt;
  } catch(error) {
    receipt.status='interrupted';receipt.stop_reason=String(error);save();throw error;
  }
}
