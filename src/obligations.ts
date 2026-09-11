import type {Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';

export interface Obligations {
  observed_at:string;
  missions:unknown;
  freight:Record<string,any>;
  passengers:Record<string,any>;
  production:Record<string,any>;
}

export class ObligationObservationError extends Error {}

/** Preserve server identities, destinations and deadlines, including unrecognized fields. */
export async function observeObligations(account:Account,command:IndustryCommand):Promise<Obligations> {
  const freight=details(await command('spacemolt_shipping/active',{}));
  const passengers=details(await command('spacemolt/list_passengers',{}));
  const production=details(await command('spacemolt/craft',{}));
  if(!Array.isArray(freight.shipments)||!Array.isArray(passengers.passengers)
    ||passengers.count!==passengers.passengers.length
    ||production.kind!=='queue'||!(Array.isArray(production.jobs)?production.total_jobs===production.jobs.length:production.jobs===null&&production.total_jobs===0)) {
    throw new ObligationObservationError('Incomplete obligation observation; missing lists cannot establish an empty hold or queue');
  }
  return structuredClone({observed_at:new Date().toISOString(),missions:account.state.missions,freight,
    passengers:{...passengers,observation_scope:'onboard_ship',
      station_offers:{status:'not_observed',reason:'This count covers passengers aboard our ship. It does not establish whether passengers are waiting at the station.'}},production});
}

export function admitProductiveSortie(obligations:Obligations,activity:string) {
  const transporting=obligations.freight.shipments.some((s:Record<string,any>)=>
    s.package_in_your_cargo!==false||!['shipper','recipient','invited_carrier'].includes(s.role));
  if(transporting||obligations.passengers.passengers.length) {
    throw new Error(`${activity} sortie blocked by active freight or onboard passengers; resolve transport commitments before productive sorties. Return preserves them but does not deliver them.`);
  }
}
