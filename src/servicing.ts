import type {Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';
import {canonicalReadinessBlockers,ensureReadiness,inspectReadiness} from './readiness.ts';

export interface ServiceBudget {maxSpend:number;creditReserve:number}
export interface ServiceClock {now?:()=>number;sleep?:(ms:number)=>Promise<void>}
/** Service and wait only at the verified dock. A stop request does not cancel cleanup. */
export async function serviceShip(account:Account,command:IndustryCommand,budget:ServiceBudget,defend:()=>Promise<void>,clock:ServiceClock={}) {
  await account.refresh();
  const origin=account.location?.docked_at,shipId=account.ship?.id;
  if(!origin||!shipId)throw new Error('Dock with authoritative ship state before servicing');
  const initialBlockers=canonicalReadinessBlockers(account.state);
  if(initialBlockers.length)throw new Error(initialBlockers.join('; '));
  const cargo=structuredClone(account.cargo!),modules=structuredClone(account.state.modules!);
  const verify=()=>{
    if(account.location?.docked_at!==origin||account.location.in_transit||account.ship?.id!==shipId)throw new Error('Ship or docking changed during service verification');
    const blockers=canonicalReadinessBlockers(account.state);
    if(blockers.length)throw new Error(blockers.join('; '));
    const quantity=(rows:typeof cargo,id:string)=>rows.filter(row=>row.item_id===id).reduce((sum,row)=>sum+row.quantity,0);
    if(cargo.some(row=>quantity(account.cargo!,row.item_id)<quantity(cargo,row.item_id))||
      modules.some(row=>!account.state.modules!.some(current=>current.module_id===row.module_id&&current.type_id===row.type_id)))throw new Error('Starting cargo or fitted equipment lost during servicing');
  };
  verify();
  const base=details(await command('spacemolt/get_base',{}));
  verify();
  const ship=account.ship!,quotedFuel=ship.fuel,quotedMaxFuel=ship.max_fuel;
  const checkedCommand:IndustryCommand=async(action,params)=>{
    verify();
    if(action==='spacemolt/refuel'&&(account.ship!.fuel!==quotedFuel||account.ship!.max_fuel!==quotedMaxFuel))throw new Error('Fuel requirement changed after service quote; reassessment required before spending');
    const result=await command(action,params);
    verify();
    return result;
  };
  const price=base.fuel_price_all_in;
  const refuel=Number.isFinite(price)&&price>=0?(ship.max_fuel-ship.fuel)*price:undefined;
  const result=await ensureReadiness(account,checkedCommand,{minFuel:ship.max_fuel,minHull:ship.max_hull,
    creditReserve:budget.creditReserve,maxServiceSpend:budget.maxSpend,serviceQuotes:{refuel}},true);
  if(!result.verification.ready)throw new Error(result.verification.blockers.join('; ')||'Servicing did not reach readiness');
  // The pinned get_base contract has no all-in ship-repair price. Never guess one.
  const now=clock.now??Date.now,sleep=clock.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const started=now();
  for(;;) {
    verify();
    const current=account.ship!;
    if(current.hull<current.max_hull||current.fuel<current.max_fuel)throw new Error('Hull or fuel changed during service verification');
    const verification=inspectReadiness(account.state,{minFuel:current.max_fuel,minHull:current.max_hull,creditReserve:budget.creditReserve});
    if(!verification.ready)throw new Error(verification.blockers.join('; ')||'Servicing did not retain readiness');
    if(current.shield>=current.max_shield)return {...result,verification,shield_wait_ms:now()-started};
    if(now()-started>=120000)throw new Error('Shields not restored within 120 seconds; remain docked with readiness blocked');
    await sleep(2000);
    await account.refresh();
    await defend();
  }
}
