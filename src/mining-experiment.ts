import {snapshotSkills,skillProgress} from './progression.ts';
import type {GameState} from '@spacemolt/lib';
import {appendFileSync, mkdirSync} from 'node:fs';
import {ensureReadiness, type ReadinessAccount, type ReadinessCommand} from './readiness.ts';

export interface MiningExperimentParams {
  poi_id: string;
  /** Optional destination system, at most two normal jumps from the return station. */
  target_system_id?: string;
  cycles?: number;
  /** Newly mined item IDs to preserve in personal station storage for crafting. */
  retain_items?: string[];
  credit_reserve?: number;
  max_service_spend?: number;
  min_fuel_reserve?: number;
  min_free_cargo?: number;
  /** Conservative total quote covering a full tank at the return station, including tax.
   * Station API cannot enforce this as an atomic price cap. Omit if unknown. */
  refuel_quote?: number;
  /** Caller-observed current station price per fuel unit, including tax. */
  refuel_unit_quote?: number;
}
interface Dependencies { record?: (event:Record<string,unknown>)=>void; now?: ()=>number }
const details = (reply:any):any => reply?.structuredContent ?? reply?.delta?.details ?? reply ?? {};
const inventory = (state:GameState) => Object.fromEntries((state.cargo??[]).map(i=>[i.item_id,i.quantity]));
const snapshot = (state:GameState) => structuredClone({credits:state.player?.credits,ship:state.ship,cargo:state.cargo,modules:state.modules,location:state.location,skills:snapshotSkills(state)});
function defaultRecord(event:Record<string,unknown>) {
  mkdirSync(new URL('../runtime/',import.meta.url),{recursive:true});
  appendFileSync(new URL('../runtime/mining-experiments.jsonl',import.meta.url),JSON.stringify(event)+'\n',{mode:0o600});
}

/** One measured bounded sortie; transport failures propagate without retry or navigation. */
export async function miningExperiment(params:MiningExperimentParams, account:ReadinessAccount, auditedCommand:ReadinessCommand, dependencies:Dependencies = {}) {
  const cycles=params.cycles??3, reserve=params.credit_reserve??150000, serviceBudget=params.max_service_spend??0;
  const fuelReserve=params.min_fuel_reserve??10, freeCargo=params.min_free_cargo??10;
  if(!params.poi_id || !Number.isInteger(cycles)||cycles<1||cycles>20)throw new Error('poi_id and cycles in 1..20 required');
  if(![reserve,serviceBudget,fuelReserve,freeCargo,...(params.refuel_quote===undefined?[]:[params.refuel_quote]),...(params.refuel_unit_quote===undefined?[]:[params.refuel_unit_quote])].every(n=>Number.isFinite(n)&&n>=0))throw new Error('Invalid mining experiment budget or reserve');
  if(params.retain_items!==undefined&&(!Array.isArray(params.retain_items)||params.retain_items.some(item=>typeof item!=='string'||!item.trim())))throw new Error('retain_items must be an array of item IDs');
  const retainItems=new Set(params.retain_items??[]);
  const now=dependencies.now??Date.now, record=dependencies.record??defaultRecord;
  const started=now(), id=`mining-${started}`;
  await account.refresh();
  const baseline=snapshot(account.state), origin=account.state.location;
  if(!origin?.docked_at||!origin.poi_id)return {status:'blocked',reason:'Start docked at a station with a known POI'};
  const originPoi=origin.poi_id, originBase=origin.docked_at, originSystem=origin.system_id;
  const targetSystem=params.target_system_id??originSystem;
  if(typeof targetSystem!=='string'||!targetSystem.trim())throw new Error('Target system must be a nonempty ID');
  const crossSystem=targetSystem!==originSystem;
  const routeEvidence:Record<string,unknown>[]=[];
  const actions:Record<string,unknown>[]=[], yields:Record<string,number>={}, retained:Record<string,number>={}, sales:Record<string,unknown>[]=[];
  let stopReason='cycle_limit';
  const command:ReadinessCommand=async(action,p)=>{
    const before=snapshot(account.state), at=now();
    record({event:'mining_action_started',id,at,action,params:p});
    const reply=await auditedCommand(action,p);
    await account.refresh();
    const after=snapshot(account.state);
    const measurement={action,params:p,seconds:(now()-at)/1000,credits_delta:(after.credits??0)-(before.credits??0),fuel_used:(before.ship?.fuel??0)-(after.ship?.fuel??0),before_cargo:before.cargo,after_cargo:after.cargo,result:details(reply)};
    actions.push(measurement);record({event:'mining_action',id,...measurement});
    return reply;
  };
  record({event:'mining_experiment_started',id,params,baseline});
  try {
    const routeSteps=(route:any,from:string,to:string):string[]=>{
      if(route.found!==true||route.target_system!==to||!Number.isInteger(route.total_jumps)||route.total_jumps<1||route.total_jumps>2||!Array.isArray(route.route))throw new Error('Mining route must be found and contain 1..2 normal jumps');
      if(route.route.length!==route.total_jumps+1||route.route[0]?.system_id!==from||route.route.at(-1)?.system_id!==to||route.route.some((step:any,index:number)=>step.via_wormhole||step.jumps!==index||typeof step.system_id!=='string'))throw new Error('Mining route is inconsistent or includes a wormhole');
      if(!Number.isFinite(route.estimated_fuel)||route.estimated_fuel<0||!Number.isFinite(route.fuel_per_jump)||route.fuel_per_jump<0)throw new Error('Mining route fuel estimate unavailable');
      return route.route.slice(1).map((step:any)=>step.system_id);
    };
    const jumpRoute=async(steps:string[])=>{
      for(const next of steps){
        const system=details(await command('spacemolt/get_system',{})).system;
        if(!system||!(system.connections??[]).some((connection:any)=>(typeof connection==='string'?connection:connection.system_id)===next))throw new Error('Next mining route jump is not a verified normal connection');
        await command('spacemolt/jump',{id:next});
        if(account.state.location?.system_id!==next||account.state.location?.in_transit)throw new Error('Mining route jump arrival not verified');
      }
    };
    let outboundSteps:string[]=[],returnFuel=0;
    // Cargo can raise jump fuel after mining. Budget a full hold margin rather
    // than assuming the lighter outbound quote also prices the loaded return.
    const cargoMarginPerJump=Math.max(2,Math.ceil((account.state.ship?.cargo_capacity??0)/10));
    let requiredFuel=fuelReserve+2;
    if(crossSystem){
      const outbound=details(await command('spacemolt/find_route',{id:params.poi_id}));
      outboundSteps=routeSteps(outbound,originSystem,targetSystem);
      if(outbound.target_poi!==params.poi_id)throw new Error('Route did not resolve the requested mining POI');
      returnFuel=outbound.estimated_fuel+outboundSteps.length*cargoMarginPerJump+2;
      requiredFuel=fuelReserve+outbound.estimated_fuel+returnFuel+cycles+2;
      routeEvidence.push({phase:'preflight',outbound,return_fuel_budget:returnFuel,cargo_margin_per_jump:cargoMarginPerJump,required_fuel:requiredFuel,note:'Return initially budgets the reverse normal route plus full-hold cargo margin and local travel; server return quote is revalidated at destination.'});
    }else{
      const system=details(await command('spacemolt/get_system',{})).system;
      if(!system||!(system.pois??[]).some((p:any)=>(p.id??p.poi_id)===params.poi_id)||params.poi_id===originPoi)return {status:'blocked',reason:'Target must be a different known POI in the current system'};
    }
    const ready=await ensureReadiness(account,command,{requireMining:true,minFreeCargo:freeCargo,minFuel:requiredFuel,creditReserve:reserve},true);
    if(!ready.verification.ready)return {status:'blocked',readiness:ready,route_evidence:routeEvidence};
    const miningBaseline=inventory(account.state);
    await command('spacemolt/undock',{});
    if(crossSystem){
      await jumpRoute(outboundSteps);
      const destination=details(await command('spacemolt/get_system',{})).system;
      if(!destination||(destination.pois??[]).every((p:any)=>(p.id??p.poi_id)!==params.poi_id))throw new Error('Mining POI not found in destination system');
      const returnQuote=details(await command('spacemolt/find_route',{id:originPoi}));
      const returnSteps=routeSteps(returnQuote,targetSystem,originSystem);
      if(returnQuote.target_poi!==originPoi)throw new Error('Return route did not resolve original station POI');
      returnFuel=returnQuote.estimated_fuel+returnSteps.length*cargoMarginPerJump+2;
      routeEvidence.push({phase:'destination_return_quote',quote:returnQuote,return_fuel_budget:returnFuel});
      if(account.state.ship!.fuel<returnFuel+fuelReserve+1)throw new Error('Destination fuel cannot cover quoted return and reserve');
    }
    if(account.state.location?.poi_id!==params.poi_id)await command('spacemolt/travel',{id:params.poi_id});
    if(account.state.location?.poi_id!==params.poi_id||account.state.location?.system_id!==targetSystem||account.state.location?.in_transit)throw new Error('Mining target arrival not verified');
    for(let i=0;i<cycles;i++) {
      const ship=account.state.ship!;
      if(ship.fuel<=fuelReserve+returnFuel||ship.hull<ship.max_hull||ship.incapacitated||ship.cargo_capacity-ship.cargo_used<freeCargo){stopReason='ship_reserve';break;}
      const before=inventory(account.state);
      let result:any;
      try {result=details(await command('spacemolt/mine',{}));}
      catch(error) {
        const code=String((error as {code?:unknown})?.code??'');
        if(!['resource_depleted','no_resources','cargo_full'].includes(code))throw error;
        stopReason=code;break;
      }
      const after=inventory(account.state);
      // Live mutation receipts may omit details entirely. Canonical cargo is
      // the yield authority, including sorties that produce multiple resources.
      const gained=Object.entries(after).map(([item,quantity])=>[item,Math.max(0,quantity-(before[item]??0))] as const).filter(([,quantity])=>quantity>0);
      if(!gained.length){stopReason='no_yield';break;}
      for(const [item,quantity] of gained)yields[item]=(yields[item]??0)+quantity;
      if(result.remaining===0){stopReason='depleted';break;}
    }
    if(crossSystem){
      const returnQuote=details(await command('spacemolt/find_route',{id:originPoi}));
      const steps=routeSteps(returnQuote,targetSystem,originSystem);
      if(returnQuote.target_poi!==originPoi||account.state.ship!.fuel<returnQuote.estimated_fuel+steps.length*cargoMarginPerJump+fuelReserve+2)throw new Error('Loaded return route fails fuel/target validation');
      routeEvidence.push({phase:'loaded_return_quote',quote:returnQuote});
      await jumpRoute(steps);
    }
    if(account.state.location?.poi_id!==originPoi)await command('spacemolt/travel',{id:originPoi});
    await command('spacemolt/dock',{});
    if(account.state.location?.docked_at!==originBase||account.state.location?.poi_id!==originPoi||account.state.location?.system_id!==originSystem)throw new Error('Return docking not verified');
    for(const [item,mined] of Object.entries(yields)) {
      const available=Math.min(mined,Math.max(0,(inventory(account.state)[item]??0)-(miningBaseline[item]??0)));
      if(retainItems.has(item)) {
        if(available<=0)continue;
        const storedQuantity=(reply:any)=>(details(reply).items??[]).filter((i:any)=>i.item_id===item).reduce((n:number,i:any)=>n+Number(i.quantity),0);
        const storageBefore=storedQuantity(await command('spacemolt_storage/view',{}));
        const cargoBefore=inventory(account.state)[item]??0;
        await command('spacemolt_storage/deposit',{item_id:item,quantity:available});
        const storageAfter=storedQuantity(await command('spacemolt_storage/view',{}));
        if(cargoBefore-(inventory(account.state)[item]??0)!==available||storageAfter-storageBefore!==available)throw new Error('Retained mining inventory was not verified in personal station storage');
        retained[item]=available;
        continue;
      }
      const market=details(await command('spacemolt_market/view_market',{}));
      const book=(market.items??[]).find((i:any)=>i.item_id===item);
      const demand=(book?.buy_orders??[]).reduce((sum:number,o:any)=>sum+Math.max(0,Number(o.quantity??0)),0);
      const quantity=Math.min(available,demand);
      if(quantity<=0)continue;
      const before=inventory(account.state)[item]??0, credits=account.state.player!.credits;
      const receipt=details(await command('spacemolt/sell',{id:item,quantity,auto_list:false}));
      const sold=before-(inventory(account.state)[item]??0);
      if(sold<0||sold>available)throw new Error('Sale exceeded measured new mining inventory');
      sales.push({item_id:item,requested:quantity,sold,credits:account.state.player!.credits-credits,receipt});
    }
    const refuelQuote=params.refuel_unit_quote===undefined?params.refuel_quote:(account.state.ship!.max_fuel-account.state.ship!.fuel)*params.refuel_unit_quote;
    const quoteEvidence={source:'caller',unit_quote:params.refuel_unit_quote,total_quote:refuelQuote,limitation:'Station service has no atomic price cap; actual spend is verified after service.'};
    let service:unknown={status:'not_needed'};
    if(account.state.ship!.fuel<baseline.ship!.fuel) {
      service=await ensureReadiness(account,command,{minFuel:account.state.ship!.max_fuel,minHull:baseline.ship!.hull,creditReserve:reserve,maxServiceSpend:serviceBudget,serviceQuotes:{refuel:refuelQuote}},true);
    }
    const end=snapshot(account.state);
    const unsold=Object.fromEntries(Object.entries(yields).map(([item,q])=>[item,Math.max(0,q-(retained[item]??0)-sales.filter(s=>s.item_id===item).reduce((n,s)=>n+Number(s.sold),0))]));
    const fuelLiability=Math.max(0,baseline.ship!.fuel-end.ship!.fuel), hullLiability=Math.max(0,baseline.ship!.hull-end.ship!.hull);
    const elapsed=(now()-started)/1000, cashDelta=end.credits!-baseline.credits!;
    const result={event:'mining_experiment',at:new Date(now()).toISOString(),id,status:'completed',origin_station:originBase,system_id:originSystem,target_system_id:targetSystem,route_evidence:routeEvidence,travel_seconds:actions.filter(a=>['spacemolt/travel','spacemolt/jump'].includes(String(a.action))).reduce((n,a)=>n+Number(a.seconds),0),travel_fuel_units:actions.filter(a=>['spacemolt/travel','spacemolt/jump'].includes(String(a.action))).reduce((n,a)=>n+Number(a.fuel_used),0),poi_id:params.poi_id,stop_reason:stopReason,seconds:elapsed,baseline,end,skill_context:{skills:baseline.skills},skill_progress:skillProgress(baseline.skills,end.skills),yields,sales,retained,unsold,inventory_accounting:'Retained storage and unsold cargo are not booked as profit; cash includes only actual receipts and costs.',actions,service,quote_evidence:quoteEvidence,cash_delta:cashDelta,fuel_liability_units:fuelLiability,hull_liability_units:hullLiability,
      realized_profit: fuelLiability===0&&hullLiability===0?cashDelta:null,
      source_measurements:Object.entries(yields).map(([item,quantity])=>({item_id:item,poi_id:params.poi_id,system_id:targetSystem,quantity,sortie_seconds:elapsed,quantity_per_sortie_second:elapsed>0?quantity/elapsed:null,shared_sortie_cash_cost:Math.max(0,sales.reduce((n,s)=>n+Number(s.credits),0)-cashDelta),unpriced_fuel_units:fuelLiability,warning:'Mixed-resource sortie costs are shared, not independently attributable per item.'}))};
    record(result);return {...result,actions:actions.map(a=>({action:a.action,params:a.params,seconds:a.seconds,credits_delta:a.credits_delta,fuel_used:a.fuel_used}))};
  } catch(error) {
    record({event:'mining_experiment_interrupted',id,error:error instanceof Error?error.message:String(error),baseline,end:snapshot(account.state),actions,yields,sales,retained,route_evidence:routeEvidence});
    throw error;
  }
}
