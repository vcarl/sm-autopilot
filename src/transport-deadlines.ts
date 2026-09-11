import type {Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';

type Wire=Record<string,any>;
const tick=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const identity=(value:unknown):value is string=>typeof value==='string'&&value.length>0;

/** Observe current commitments only; waiting offers never establish a deadline. */
export async function observeTransportDeadlines(account:Account,command:IndustryCommand,receipt:Wire|undefined):Promise<Wire> {
  const evidence:Wire={status:'blocked',observed_tick:null,clock_source:'spacemolt_shipping/active',blockers:[],selected:[],
    limitation:'Positive remaining deadlines establish current validity, not sufficient time for the remaining route.'};
  try {
    await account.refresh();
    const active=details(await command('spacemolt_shipping/active',{}));evidence.clock_observation=active;
    if(active.action!=='active'||!Array.isArray(active.shipments)||!tick(active.tick))throw new Error('Fresh authoritative shipping clock unavailable');
    evidence.observed_tick=active.tick;
    if(!receipt||(receipt.kind==='passengers'&&Array.isArray(receipt.loaded)&&receipt.loaded.length===0)||(receipt.kind==='freight'&&!receipt.custody)) {
      evidence.status='not_applicable';return evidence;
    }
    if(!identity(receipt.ship_id)||receipt.ship_id!==account.ship?.id)throw new Error('Selected transport custody belongs to a different or unverified ship');
    if(receipt.kind==='passengers') {
      if(!Array.isArray(receipt.loaded)||!Array.isArray(receipt.delivered)||
        [...receipt.loaded,...receipt.delivered].some(row=>!identity(row.citizen_id)||row.destination!==receipt.destination)||
        new Set(receipt.loaded.map((row:Wire)=>row.citizen_id)).size!==receipt.loaded.length||
        new Set(receipt.delivered.map((row:Wire)=>row.citizen_id)).size!==receipt.delivered.length||
        receipt.delivered.some((row:Wire)=>!receipt.loaded.some((loaded:Wire)=>loaded.citizen_id===row.citizen_id)))throw new Error('Recorded passenger custody identities are incomplete or inconsistent');
      const selected=receipt.loaded.filter((row:Wire)=>!receipt.delivered.some((delivered:Wire)=>delivered.citizen_id===row.citizen_id));
      if(!selected.length){evidence.status='not_applicable';return evidence;}
      const result=details(await command('spacemolt/list_passengers',{}));evidence.observation=result;
      if(!Array.isArray(result.passengers)||result.count!==result.passengers.length||result.passengers.some((row:Wire)=>!identity(row.citizen_id)||!identity(row.destination))||new Set(result.passengers.map((row:Wire)=>row.citizen_id)).size!==result.passengers.length)throw new Error('Current passenger custody list is incomplete or ambiguous');
      evidence.selected=selected.map((row:Wire)=>result.passengers.find((current:Wire)=>current.citizen_id===row.citizen_id)??{citizen_id:row.citizen_id,status:'missing'});
      if(evidence.selected.some((row:Wire)=>row.destination!==receipt.destination||!positive(row.ticks_remaining)))throw new Error('Selected passenger is missing, changed destination, or has an unavailable or expired deadline');
    } else if(receipt.kind==='freight') {
      const result=active;evidence.observation=result;
      if(!identity(receipt.shipment_id)||!identity(receipt.package_id)||!Array.isArray(result.shipments))throw new Error('Current freight custody list or recorded identity unavailable');
      const matches=result.shipments.filter((row:Wire)=>row.contract?.id===receipt.shipment_id);evidence.selected=matches;
      if(matches.length!==1)throw new Error('Selected freight contract is missing or ambiguous');
      const selected=matches[0],contract=selected.contract;
      if(selected.role!=='carrier'||selected.package_in_your_cargo!==true||contract.status!=='in_transit'||contract.package_id!==receipt.package_id||
        contract.contractor?.kind!=='player'||contract.contractor.id!==account.state.player?.id||contract.destination_base_id!==receipt.destination?.base_id)throw new Error('Selected personal freight custody or destination is no longer established');
      const item=receipt.package_id.startsWith('package:')?receipt.package_id:`package:${receipt.package_id}`;
      const cargo=account.cargo?.filter(row=>row.item_id===item);
      if(!Array.isArray(account.cargo)||cargo?.length!==1||cargo[0]!.quantity!==1)throw new Error('Selected freight package is not uniquely present in canonical cargo');
      if(selected.late!==false||!positive(selected.ticks_to_deadline))throw new Error('Selected freight deadline is unavailable or expired');
    } else throw new Error('Unknown transport custody kind');
    evidence.status='ready';
  } catch(error) {
    evidence.blockers.push(error instanceof Error?error.message:String(error));
  }
  return evidence;
}
