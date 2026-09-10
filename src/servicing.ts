import type {Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';
import {ensureReadiness} from './readiness.ts';

export interface ServiceBudget {maxSpend:number;creditReserve:number}
export interface ServiceClock {now?:()=>number;sleep?:(ms:number)=>Promise<void>}
/** Service and wait only at the verified dock. A stop request does not cancel cleanup. */
export async function serviceShip(account:Account,command:IndustryCommand,budget:ServiceBudget,defend:()=>Promise<void>,clock:ServiceClock={}) {
  await account.refresh();
  const origin=account.location?.docked_at,shipId=account.ship?.id;
  if(!origin||!shipId)throw new Error('Dock with authoritative ship state before servicing');
  const base=details(await command('spacemolt/get_base',{})),ship=account.ship!;
  const price=base.fuel_price_all_in;
  const refuel=Number.isFinite(price)&&price>=0?(ship.max_fuel-ship.fuel)*price:undefined;
  const result=await ensureReadiness(account,command,{minFuel:ship.max_fuel,minHull:ship.max_hull,
    creditReserve:budget.creditReserve,maxServiceSpend:budget.maxSpend,serviceQuotes:{refuel}},true);
  if(!result.verification.ready)throw new Error(result.verification.blockers.join('; ')||'Servicing did not reach readiness');
  // The pinned get_base contract has no all-in ship-repair price. Never guess one.
  const now=clock.now??Date.now,sleep=clock.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const started=now();
  for(;;) {
    if(account.location?.docked_at!==origin||account.location.in_transit||account.ship?.id!==shipId)throw new Error('Ship or docking changed during service verification');
    const current=account.ship;
    if(![current.shield,current.max_shield,current.hull,current.max_hull,current.fuel,current.max_fuel].every(Number.isFinite))throw new Error('Incomplete ship condition during service verification');
    if(current.hull<current.max_hull||current.fuel<current.max_fuel)throw new Error('Hull or fuel changed during service verification');
    if(current.shield>=current.max_shield)return {...result,shield_wait_ms:now()-started};
    if(now()-started>=120000)throw new Error('Shields not restored within 120 seconds; remain docked with readiness blocked');
    await sleep(2000);
    await account.refresh();
    await defend();
  }
}
