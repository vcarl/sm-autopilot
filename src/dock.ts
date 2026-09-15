import {SpacemoltError,type GameState} from '@spacemolt/lib';
import {replyLost} from './command-boundary.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {waitForArrival,type TravelOptions} from './travel.ts';

export class DockBlocked extends Error {}
export interface DockResult {docked:true;docked_at:string;already_docked:boolean}

const settled=(state:GameState)=>Boolean(state.location?.system_id&&!state.location.in_transit);

/** One dock path. A lost reply is reconciled by a live read in either direction —
 * never re-sent blind, and never re-sent at all while the mutation is queued. */
export async function dockAt(account:ReadinessAccount,command:ReadinessCommand,baseId?:string,options:TravelOptions={}):Promise<DockResult> {
  await waitForArrival(account,settled,options);
  const confirm=(already:boolean):DockResult|null=>{
    const docked=account.state.location?.docked_at;
    if(!docked)return null;
    if(baseId&&docked!==baseId)throw new DockBlocked(`Docked at ${docked}, not ${baseId}; undock before docking elsewhere`);
    return {docked:true,docked_at:docked,already_docked:already};
  };
  const existing=confirm(true);
  if(existing)return existing;
  if(!account.state.location!.poi_id)throw new DockBlocked('No station here to dock at; travel to a station first');
  let reissues=1;
  while(true) {
    let already=false;
    try {await command('spacemolt/dock',{});}
    catch(error) {
      already=error instanceof SpacemoltError&&error.code==='already_docked';
      const queued=error instanceof SpacemoltError&&Boolean(error.pendingCommand);
      if(!already&&!replyLost(error))throw error;
      await account.refresh();
      const landed=confirm(already);
      if(landed)return landed;
      if(already||queued||reissues--<=0)throw error;
      continue;
    }
    await account.refresh();
    const landed=confirm(false);
    if(!landed)throw new DockBlocked('Dock not confirmed by a live read; reconcile before further movement');
    return landed;
  }
}
