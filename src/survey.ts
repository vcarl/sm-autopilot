import {fetchStations, type StationList, type StationSummary} from '@spacemolt/lib';
import {appendFileSync,mkdirSync} from 'node:fs';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';

export interface SurveyParams {
  station_ids:string[];
  max_total_jumps?:number;
  min_fuel_reserve?:number;
  credit_reserve?:number;
  return_to_origin?:boolean;
}
interface SurveyDependencies {stations?:()=>Promise<StationList>;record?:(row:Record<string,unknown>)=>void;now?:()=>number}
const details=(reply:any):any=>reply?.structuredContent??reply?.delta?.details??reply??{};
const recordDefault=(row:Record<string,unknown>)=>{
  mkdirSync(new URL('../runtime/',import.meta.url),{recursive:true});
  appendFileSync(new URL('../runtime/surveys.jsonl',import.meta.url),JSON.stringify(row)+'\n',{mode:0o600});
};
function routeSteps(route:any,from:string,to:string):string[] {
  if(route.found!==true||route.target_system!==to||!Number.isInteger(route.total_jumps)||route.total_jumps<0||route.total_jumps>2||!Array.isArray(route.route))throw new Error('Survey route must contain 0..2 normal jumps');
  if(route.route.length!==route.total_jumps+1||route.route[0]?.system_id!==from||route.route.at(-1)?.system_id!==to||route.route.some((r:any,i:number)=>r.via_wormhole||r.jumps!==i||typeof r.system_id!=='string'))throw new Error('Survey route is inconsistent or uses a wormhole');
  if(!Number.isFinite(route.estimated_fuel)||route.estimated_fuel<0||!Number.isFinite(route.fuel_per_jump)||route.fuel_per_jump<0)throw new Error('Survey route lacks a fuel quote');
  return route.route.slice(1).map((r:any)=>r.system_id);
}

/** Discovery is a caller-provided read-only query routine using the same account.
 * No trade, service purchase, retry or failure-recovery movement occurs here. */
export async function surveyMarkets(params:SurveyParams,account:ReadinessAccount,auditedCommand:ReadinessCommand,discover:()=>Promise<unknown>,deps:SurveyDependencies={}) {
  const maxJumps=params.max_total_jumps??6,fuelReserve=params.min_fuel_reserve??10,creditReserve=params.credit_reserve??150000,returnHome=params.return_to_origin??true;
  if(!Array.isArray(params.station_ids)||!params.station_ids.length||params.station_ids.length>3||params.station_ids.some(id=>typeof id!=='string'||!id))throw new Error('Select 1..3 public station IDs');
  if(!Number.isInteger(maxJumps)||maxJumps<0||maxJumps>8||![fuelReserve,creditReserve].every(n=>Number.isFinite(n)&&n>=0)||typeof returnHome!=='boolean')throw new Error('Invalid survey budget');
  const now=deps.now??Date.now,record=deps.record??recordDefault,started=now();
  await account.refresh();
  const baseline=structuredClone(account.state),origin=baseline.location;
  if(!origin?.docked_at||!origin.poi_id||!baseline.ship||!baseline.player)throw new Error('Survey must start docked with canonical ship state');
  const checkShip=()=>{
    const {ship,player}=account.state;
    if(!ship||!player||ship.incapacitated||ship.hull<baseline.ship!.hull||ship.hull<ship.max_hull||player.credits<creditReserve)throw new Error('Ship condition or wallet reserve does not permit survey travel');
  };
  checkShip();
  const directory=await (deps.stations??(()=>fetchStations('https://game.spacemolt.com')))();
  const targets:StationSummary[]=params.station_ids.map(id=>{
    const station=directory.stations.find(s=>[s.id,s.base_id,s.poi_id].includes(id));
    if(!station||station.wrecked||!station.system_id||!station.poi_id)throw new Error(`Unknown or unavailable public station: ${id}`);
    return station;
  });
  const home={base_id:origin.docked_at,poi_id:origin.poi_id,system_id:origin.system_id};
  const actions:Record<string,unknown>[]=[],comparisons:Record<string,unknown>[]=[],skipped:Record<string,unknown>[]=[];
  let jumps=0;
  const command:ReadinessCommand=async(action,params)=>{
    const at=now(),fuel=account.state.ship!.fuel;
    const result=await auditedCommand(action,params);await account.refresh();
    actions.push({action,params,seconds:(now()-at)/1000,fuel_used:fuel-account.state.ship!.fuel});
    return result;
  };
  const quote=async(destination:typeof home)=>{
    if(account.state.location!.system_id===destination.system_id)return {steps:[] as string[],fuel:0,perJump:0};
    const result=details(await command('spacemolt/find_route',{id:destination.poi_id}));
    const steps=routeSteps(result,account.state.location!.system_id,destination.system_id);
    if(result.target_poi!==destination.poi_id)throw new Error('Survey route did not resolve target station POI');
    return {steps,fuel:result.estimated_fuel,perJump:result.fuel_per_jump};
  };
  record({event:'survey_started',at:new Date(started).toISOString(),params,baseline});
  try {
    // Origin quotes establish bounded return routes before leaving. Cargo never
    // increases in this read-only survey, so a rounded-up per-jump quote suffices.
    const originQuotes=new Map<string,Awaited<ReturnType<typeof quote>>>();
    for(const target of targets)originQuotes.set(target.base_id,await quote(target));
    const perJump=Math.ceil(Math.max(0,...[...originQuotes.values()].map(q=>q.perJump)))+1;
    const requiredFuel=fuelReserve+maxJumps*perJump+2*(targets.length+(returnHome?1:0));
    if(account.state.ship!.fuel<requiredFuel)throw new Error(`Survey fuel budget requires ${requiredFuel}, available ${account.state.ship!.fuel}`);
    const move=async(destination:typeof home,route:Awaited<ReturnType<typeof quote>>,reserveJumps:number)=>{
      checkShip();
      if(jumps+route.steps.length+reserveJumps>maxJumps||account.state.ship!.fuel<route.fuel+reserveJumps*perJump+fuelReserve+2)throw new Error('Survey leg exceeds remaining jump or fuel budget');
      if(account.state.location!.docked_at===destination.base_id)return;
      await command('spacemolt/undock',{});
      for(const [index,next] of route.steps.entries()){
        checkShip();
        if(account.state.ship!.fuel<(route.steps.length-index+reserveJumps)*Math.max(perJump,route.perJump)+fuelReserve+2)throw new Error('Survey jump would breach remaining fuel reserve');
        const system=details(await command('spacemolt/get_system',{})).system;
        if(!(system?.connections??[]).some((c:any)=>(typeof c==='string'?c:c.system_id)===next))throw new Error('Survey jump is not a verified normal connection');
        await command('spacemolt/jump',{id:next});jumps++;
        if(account.state.location!.system_id!==next||account.state.location!.in_transit)throw new Error('Survey jump arrival not verified');
      }
      if(account.state.location!.poi_id!==destination.poi_id)await command('spacemolt/travel',{id:destination.poi_id});
      if(account.state.location!.poi_id!==destination.poi_id)throw new Error('Survey station arrival not verified');
      await command('spacemolt/dock',{});
      if(account.state.location!.docked_at!==destination.base_id)throw new Error('Survey docking not verified');
    };
    for(const target of targets){
      const route=await quote(target),homeJumps=returnHome?originQuotes.get(target.base_id)!.steps.length:0;
      if(jumps+route.steps.length+homeJumps>maxJumps){skipped.push({station:target.base_id,reason:'Remaining jump budget must preserve return'});break;}
      await move(target,route,homeJumps);
      const discovery=await discover();
      await account.refresh();
      if(account.state.location!.docked_at!==target.base_id)throw new Error('Discovery callback changed station');
      comparisons.push({station:target.base_id,station_name:target.name,system_id:target.system_id,at:new Date(now()).toISOString(),discovery});
    }
    if(returnHome&&account.state.location!.docked_at!==home.base_id)await move(home,await quote(home),0);
    const travel=actions.filter(a=>['spacemolt/jump','spacemolt/travel'].includes(String(a.action)));
    const result={event:'survey',at:new Date(now()).toISOString(),status:skipped.length?'partial':'completed',comparisons,skipped,total_jumps:jumps,seconds:(now()-started)/1000,travel_seconds:travel.reduce((n,a)=>n+Number(a.seconds),0),travel_fuel_units:travel.reduce((n,a)=>n+Number(a.fuel_used),0),fuel_liability_units:Math.max(0,baseline.ship!.fuel-account.state.ship!.fuel),cash_delta:account.state.player!.credits-baseline.player!.credits,ending_station:account.state.location!.docked_at,returned_to_origin:account.state.location!.docked_at===home.base_id,actions,warning:'Market observations require fresh execution quotes. Travel fuel remains an unpriced liability; survey makes no service purchases.'};
    record(result);return result;
  }catch(error){record({event:'survey_interrupted',at:new Date(now()).toISOString(),error:error instanceof Error?error.message:String(error),comparisons,actions,location:account.state.location});throw error;}
}
