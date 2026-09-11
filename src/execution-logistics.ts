import type {Account} from '@spacemolt/lib';
import type {Home,ExecutionContext} from './execution-policy.ts';
import type {IndustryCommand} from './industry.ts';
import {details} from './industry.ts';
import {routeSteps} from './survey.ts';
import {logisticsPolicy} from './logistics-policy.ts';

/** Revalidated after boarding/loading, when cargo can change route fuel cost. */
export async function validateTransportRoute(account:Account,command:IndustryCommand,destination:Home,context:ExecutionContext) {
  await account.refresh();
  const location=account.location,ship=account.ship;
  if(!location?.system_id||location.in_transit||!ship)throw new Error('Transport route requires current ship and stable location');
  if(location.system_id===destination.system_id) {
    if(!Number.isFinite(ship.fuel)||ship.fuel<17)throw new Error('Local transport breaches fuel reserve');
    return;
  }
  const route=details(await command('spacemolt/find_route',{id:destination.system_id}));
  const steps=routeSteps(route,location.system_id,destination.system_id);
  if(steps.length>logisticsPolicy(context).max_route_jumps)throw new Error('Transport route exceeds resolved mood jump allocation');
  if(!Number.isFinite(ship.fuel)||ship.fuel<route.estimated_fuel+17)throw new Error('Transport route breaches fuel reserve');
}

export function transportReceipt(result:unknown):Record<string,any>|undefined {
  const row=result as Record<string,any>|undefined;
  return row?.transport??(row?.partial?transportReceipt(row.partial):undefined);
}
