import {evaluateRules,requireAllowed,deniedTexts,type Decision,type RuleFacts} from './rules.ts';
import type {Account} from '@spacemolt/lib';
import {details} from './response-details.ts';
import {type IndustryCommand} from './industry.ts';
import {requireCommandSpend} from './spending.ts';
import {canonicalReadinessBlockers} from './readiness.ts';

type Wire=Record<string,any>;
const cabin='economy_passenger_cabin';
const quantity=(rows:Wire[],id:string)=>rows.filter(row=>row.item_id===id).reduce((sum,row)=>sum+row.quantity,0);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export interface PassengerFitParams {execute?:boolean;max_spend?:number;credit_reserve?:number}
function completeQuote(quote:Wire) {
  return quote.quantity_requested===1&&quote.unfilled===0&&finite(quote.available)&&quote.available>=1&&
    [quote.total_cost,quote.subtotal,quote.sales_tax].every(finite)&&Array.isArray(quote.fills)&&
    quote.fills.every((fill:Wire)=>finite(fill?.quantity)&&finite(fill?.price_each))&&quote.fills.reduce((sum:number,fill:Wire)=>sum+fill.quantity,0)===1&&
    quote.subtotal===quote.fills.reduce((sum:number,fill:Wire)=>sum+fill.quantity*fill.price_each,0)&&
    quote.total_cost===quote.subtotal+quote.sales_tax;
}

/** Only the named economy cabin and known basic mining laser replacement are authorized. */
export async function preparePassengers(params:PassengerFitParams,account:Account,command:IndustryCommand) {
  const maxSpend=params.max_spend??0,reserve=params.credit_reserve??150000;
  if(!finite(maxSpend)||!finite(reserve))throw new Error('Invalid passenger fitting budget');
  await account.refresh();
  const blockers:string[]=[],plan:Wire[]=[],policy_decisions:Decision[]=[];
  const decide=(facts:RuleFacts)=>{const decision=evaluateRules(facts);policy_decisions.push(decision);return decision;};
  const costDecision=(amount:number,spent=0)=>decide({phase:'command',action:'spacemolt/buy',paid:true,budget:{gross_spend:spent,max_spend:maxSpend,credit_reserve:reserve},affordability:{amount,available:maxSpend-spent,credits:account.credits,reserve}});
  const blocked=()=>{const policy_decision=decide({phase:'checkpoint',action:'prepare',readiness:blockers});return {status:policy_decision.allowed?'quoted':'blocked',policy_decisions,blockers,plan,estimated_spend:null};};
  const ship=account.ship,location=account.location,modules=account.state.modules,cargo=account.cargo;
  if(!ship||!location?.docked_at||!Array.isArray(modules)||!Array.isArray(cargo)||!finite(account.credits)) {
    blockers.push('Observed docked ship, modules, cargo and credits required');return blocked();
  }
  blockers.push(...canonicalReadinessBlockers(account.state));
  if(blockers.length)return blocked();
  const passengers=details(await command('spacemolt/list_passengers',{}));
  const classes=['economy','business','first'];
  const validBerths=(berths:Wire)=>classes.every(key=>Number.isInteger(berths?.[key]?.total)&&berths[key].total>=0&&Number.isInteger(berths[key].free)&&berths[key].free>=0&&berths[key].free<=berths[key].total);
  if(!Array.isArray(passengers.passengers)||passengers.count!==passengers.passengers.length||
    (passengers.berths===undefined?passengers.count!==0:!validBerths(passengers.berths))) {
    blockers.push('Authoritative passenger berth capacity unavailable');return blocked();
  }
  // The pinned optional berths block is absent on ships with no accommodation.
  if(passengers.berths?.economy.total>0){decide({phase:'checkpoint',action:'prepare',readiness:blockers});return {status:'ready',policy_decisions,blockers,plan,estimated_spend:0,actual_spend:0,berths:passengers.berths};}
  const item=details(await command('spacemolt/inspect',{id:cabin})).catalog?.items?.find((row:Wire)=>row.id===cabin);
  if(!item||item.slot!=='utility'||![item.size,item.cpu_usage,item.power_usage].every(finite)||!Number.isInteger(item.passenger_economy_berths)||item.passenger_economy_berths<=0) {
    blockers.push('Economy cabin identity, utility slot, berth capacity or fitting requirements unavailable');return blocked();
  }
  const skills=()=>Object.entries(item.required_skills??{}).every(([id,level])=>finite(level)&&finite(account.state.skills?.[id]?.level)&&account.state.skills![id]!.level>=level);
  if(!skills())blockers.push('Required economy cabin skills are unmet or unavailable');
  const utilities=modules.filter(row=>row.slot==='utility');
  const removed=utilities.length>=ship.utility_slots?utilities.find(row=>row.type_id==='mining_laser_i'):undefined;
  if(utilities.length>=ship.utility_slots&&!removed)blockers.push('No free utility slot; only an observed Mining Laser I may be preserved and replaced');
  if(removed&&![removed.size,removed.cpu_usage,removed.power_usage].every(finite))blockers.push('Mining laser removal requirements unavailable');
  if(utilities.length-(removed?1:0)+1>ship.utility_slots)blockers.push('One mining laser replacement cannot provide a utility slot');
  if(ship.cpu_used-(removed?.cpu_usage??0)+item.cpu_usage>ship.cpu_capacity||ship.power_used-(removed?.power_usage??0)+item.power_usage>ship.power_capacity)blockers.push('Economy cabin exceeds available CPU or power');
  const storage=details(await command('spacemolt_storage/view',{})).items;
  if(!Array.isArray(storage)){blockers.push('Personal storage observation unavailable');return blocked();}
  const source=quantity(cargo,cabin)>=1?'cargo':quantity(storage,cabin)>=1?'storage':'buy';
  if(ship.cargo_used+(source==='cargo'?0:item.size)+(removed?.size??0)>ship.cargo_capacity)blockers.push('Insufficient cargo to stage cabin and preserve removed mining laser');
  let quote:Wire|undefined;
  if(source==='buy') {
    quote=details(await command('spacemolt_market/estimate_purchase',{item_id:cabin,quantity:1}));
    if(!completeQuote(quote))blockers.push('Complete economy cabin purchase quote unavailable');
    else blockers.push(...deniedTexts(costDecision(quote.total_cost)));
  }
  plan.push({action:source==='cargo'?'use_cargo':source==='storage'?'spacemolt_storage/withdraw':'spacemolt/buy',item_id:cabin,quantity:1,quote});
  if(removed)plan.push({action:'spacemolt/uninstall_mod',id:removed.module_id,preserve_in_cargo:removed.type_id});
  plan.push({action:'spacemolt/install_mod',id:cabin});
  const estimatedSpend=source==='buy'?(completeQuote(quote!)?quote!.total_cost:null):0;
  const admission=decide({phase:'checkpoint',action:'prepare',readiness:blockers});
  if(!admission.allowed||params.execute!==true)return {status:admission.allowed?'quoted':'blocked',policy_decisions,blockers,plan,estimated_spend:estimatedSpend};
  const originalModules=structuredClone(modules),originalCargo=structuredClone(cargo),shipId=ship.id,station=location.docked_at;
  let spent=0,removedVerified=false,installed=false;
  const verify=()=>{
    const current=account.ship,fit=account.state.modules,held=account.cargo;
    if(!current||current.id!==shipId||account.location?.docked_at!==station||!Array.isArray(fit)||!Array.isArray(held))throw new Error('Passenger fitting ship, dock or custody changed');
    const invalid=canonicalReadinessBlockers(account.state);
    if(invalid.length)throw new Error(invalid.join('; '));
    if(!skills())throw new Error('Passenger fitting requirements no longer verified');
    for(const module of originalModules)if(!(removedVerified&&module.module_id===removed?.module_id)&&!fit.some(row=>row.module_id===module.module_id&&row.type_id===module.type_id))throw new Error('Unrelated fitted equipment was not preserved');
    for(const row of originalCargo)if(quantity(held,row.item_id)<quantity(originalCargo,row.item_id)-(installed&&row.item_id===cabin?1:0))throw new Error('Starting cargo was not preserved');
    if(removedVerified&&quantity(held,'mining_laser_i')!==quantity(originalCargo,'mining_laser_i')+1)throw new Error('Removed mining laser custody lost');
    requireAllowed(costDecision(0,spent));
  };
  verify();
  const cabinBefore=quantity(account.cargo!,cabin);
  if(source!=='cargo'&&account.ship!.cargo_used+item.size>account.ship!.cargo_capacity)throw new Error('Cabin staging cargo capacity changed');
  if(source==='buy') {
    const fresh=details(await command('spacemolt_market/estimate_purchase',{item_id:cabin,quantity:1}));
    if(!completeQuote(fresh))requireAllowed(decide({phase:'checkpoint',action:'prepare',readiness:['Fresh cabin purchase quote is incomplete']}));
    requireAllowed(costDecision(fresh.total_cost,spent));
    verify();
    const reply=await command('spacemolt/buy',{id:cabin,quantity:1,deliver_to:'cargo',auto_list:false});
    spent+=requireCommandSpend('spacemolt/buy',reply);await account.refresh();verify();
    if(spent>fresh.total_cost||quantity(account.cargo!,cabin)!==cabinBefore+1)throw new Error('Cabin purchase cost or cargo receipt does not match quote');
  } else if(source==='storage') {
    await command('spacemolt_storage/withdraw',{item_id:cabin,quantity:1});await account.refresh();verify();
    const after=details(await command('spacemolt_storage/view',{})).items;
    if(!Array.isArray(after)||quantity(storage,cabin)-quantity(after,cabin)!==1||quantity(account.cargo!,cabin)!==cabinBefore+1)throw new Error('Cabin withdrawal custody unverified');
  }
  if(removed) {
    verify();
    if(account.ship!.cargo_used+removed.size>account.ship!.cargo_capacity)throw new Error('No cargo capacity to preserve mining laser');
    await command('spacemolt/uninstall_mod',{id:removed.module_id});await account.refresh();
    if(account.state.modules?.some(row=>row.module_id===removed.module_id)||quantity(account.cargo!,'mining_laser_i')!==quantity(originalCargo,'mining_laser_i')+1)throw new Error('Mining laser removal not verified in cargo');
    removedVerified=true;verify();
  }
  verify();
  const readyShip=account.ship!;
  if(readyShip.cpu_used+item.cpu_usage>readyShip.cpu_capacity||readyShip.power_used+item.power_usage>readyShip.power_capacity||account.state.modules!.filter(row=>row.slot==='utility').length>=readyShip.utility_slots||quantity(account.cargo!,cabin)<1)throw new Error('Cabin requirements changed before installation');
  const beforeInstall=quantity(account.cargo!,cabin),moduleIds=account.state.modules!.map(row=>row.module_id);
  await command('spacemolt/install_mod',{id:cabin});await account.refresh();
  const fitted=account.state.modules?.filter(row=>row.type_id===cabin&&!moduleIds.includes(row.module_id));
  if(fitted?.length!==1||fitted[0]!.slot!=='utility'||quantity(account.cargo!,cabin)!==beforeInstall-1)throw new Error('Exact economy cabin installation and cargo consumption unverified');
  installed=true;verify();
  const after=details(await command('spacemolt/list_passengers',{}));
  if(!validBerths(after.berths)||after.berths.economy.total<item.passenger_economy_berths)throw new Error('Installed economy cabin did not establish passenger berths');
  return {status:'fitted',policy_decisions,blockers,plan,estimated_spend:estimatedSpend,actual_spend:spent,module_id:fitted[0]!.module_id,berths:after.berths};
}
