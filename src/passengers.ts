import type {Account} from '@spacemolt/lib';
import type {Home} from './execution-policy.ts';
import {details,type IndustryCommand} from './industry.ts';

type Wire=Record<string,any>;
export interface PassengerReceipt {
  kind:'passengers';status:'running'|'completed'|'blocked'|'interrupted'|'needs_reconciliation';
  destination:string;origin?:string;ship_id?:string;before?:{passengers:Wire[];cargo:Wire[]};
  loaded:Wire[];delivered:Wire[];onboard:Wire[];fare_collected:number|null;
  pending_action?:{action:string;params:Wire};last_receipt?:unknown;reason?:string;
}
export interface PassengerControls {
  checkpoint:()=>Promise<void>;
  record:(receipt:PassengerReceipt)=>void;
  validateRoute:(destination:string)=>Promise<void>;
  travel:(destination:string)=>Promise<{dock_receipts:unknown[]}>;
}
const ids=(rows:Wire[])=>rows.map(row=>row.citizen_id);
const sumCargo=(rows:Wire[],id:string)=>rows.filter(row=>row.item_id===id).reduce((total,row)=>total+row.quantity,0);
function validRows(rows:unknown):rows is Wire[] {
  return Array.isArray(rows)&&rows.every(row=>typeof row.citizen_id==='string'&&typeof row.destination==='string')&&new Set(ids(rows)).size===rows.length;
}
async function onboard(command:IndustryCommand) {
  const result=details(await command('spacemolt/list_passengers',{}));
  if(!validRows(result.passengers)||result.count!==result.passengers.length)throw new Error('Passenger custody observation unavailable');
  return result;
}
function preserve(receipt:PassengerReceipt,account:Account,rows:Wire[]) {
  if(account.ship?.id!==receipt.ship_id)throw new Error('Ship identity changed during passenger transport');
  if(!Array.isArray(account.cargo))throw new Error('Cargo custody unavailable');
  for(const item of receipt.before!.cargo)if(sumCargo(account.cargo,item.item_id)<sumCargo(receipt.before!.cargo,item.item_id))throw new Error('Starting cargo lost during passenger transport');
  for(const original of receipt.before!.passengers)if(!rows.some(row=>row.citizen_id===original.citizen_id&&row.destination===original.destination))throw new Error('Unrelated passenger custody changed');
}

/** One destination; the shared executor owns travel, defense, spending and cleanup. */
export async function transportPassengers(account:Account,command:IndustryCommand,params:{destination:string;resume?:PassengerReceipt},controls:PassengerControls):Promise<PassengerReceipt> {
  const receipt:PassengerReceipt=params.resume?structuredClone(params.resume):{kind:'passengers',status:'running',destination:params.destination,loaded:[],delivered:[],onboard:[],fare_collected:0};
  if(receipt.destination!==params.destination)return {...receipt,status:'blocked',reason:'Resume destination cannot change'};
  if(receipt.pending_action||receipt.status==='needs_reconciliation')return {...receipt,status:'needs_reconciliation',reason:'Unresolved passenger effect; automatic replay disabled'};
  if(receipt.status==='completed')return receipt;
  const save=()=>controls.record(structuredClone(receipt));
  const mutate=async(action:string,params:Wire)=>{
    await controls.checkpoint();receipt.pending_action={action,params};save();
    const result=details(await command(action,params));receipt.last_receipt=result;save();return result;
  };
  try {
    await controls.checkpoint();
    const initial=await onboard(command);
    if(!params.resume) {
      if(!account.location?.docked_at||!account.ship?.id||!Array.isArray(account.cargo))throw new Error('Boarding requires observed dock, ship and cargo');
      receipt.origin=account.location.docked_at;receipt.ship_id=account.ship.id;
      receipt.before={passengers:structuredClone(initial.passengers),cargo:structuredClone(account.cargo)};
      if(initial.passengers.some((row:Wire)=>row.destination===params.destination))throw new Error('Existing passengers share destination; their automatic delivery must be planned separately');
      if(params.destination===receipt.origin)throw new Error('Passenger destination must differ from boarding station');
      const station=details(await command('spacemolt/list_station_passengers',{}));
      if(!validRows(station.waiting)||station.count!==station.waiting.length)throw new Error('Station passenger observation unavailable');
      const candidates=station.waiting.filter((row:Wire)=>row.destination===params.destination);
      const berths=initial.berths;
      if(!berths||!['economy','business','first'].every(key=>Number.isInteger(berths[key]?.free)&&berths[key].free>=0))throw new Error('Passenger berth capacity unavailable');
      if(!candidates.some((row:Wire)=>berths[row.class]?.free>0))throw new Error('No observed passengers for destination with available berth capacity');
      await controls.validateRoute(params.destination);
      const loaded=await mutate('spacemolt/load_passenger',{id:params.destination});
      if(!validRows(loaded.loaded)||loaded.count!==loaded.loaded.length||!loaded.loaded.length||loaded.loaded.some((row:Wire)=>row.destination!==params.destination||!candidates.some((candidate:Wire)=>candidate.citizen_id===row.citizen_id)||!Number.isFinite(row.ticks_remaining)))throw new Error('Accepted boarding identities or deadlines unavailable');
      receipt.loaded=structuredClone(loaded.loaded);save();
      const observed=await onboard(command);receipt.onboard=structuredClone(observed.passengers);
      preserve(receipt,account,observed.passengers);
      if(loaded.loaded.some((row:Wire)=>!observed.passengers.some((actual:Wire)=>actual.citizen_id===row.citizen_id&&actual.destination===params.destination))||observed.passengers.length!==initial.passengers.length+loaded.loaded.length)throw new Error('Accepted boarding does not match actual onboard passengers');
      delete receipt.pending_action;save();
    } else {
      if(!receipt.before||!receipt.loaded.length)throw new Error('Resume lacks original passenger custody');
      preserve(receipt,account,initial.passengers);receipt.onboard=structuredClone(initial.passengers);
      for(const row of receipt.loaded)if(!receipt.delivered.some(delivered=>delivered.citizen_id===row.citizen_id)&&!initial.passengers.some((actual:Wire)=>actual.citizen_id===row.citizen_id))throw new Error('Previously boarded passenger missing without delivery evidence');
    }
    for(const passenger of receipt.onboard.filter(row=>receipt.loaded.some(loaded=>loaded.citizen_id===row.citizen_id))) {
      if(!Number.isFinite(passenger.ticks_remaining)||passenger.ticks_remaining<=0)throw new Error('Boarded passenger deadline is unavailable or expired; preserve custody for reassessment');
    }
    await controls.checkpoint();
    await controls.validateRoute(params.destination);
    let dockReceipts:unknown[]=[];
    if(account.location?.docked_at!==params.destination) {
      // Docking itself can deliver passengers, so lost travel evidence blocks replay.
      receipt.pending_action={action:'travel',params:{destination:params.destination}};save();
      const arrival=await controls.travel(params.destination);dockReceipts=arrival.dock_receipts;
      receipt.last_receipt=arrival;save();
    }
    if(account.location?.docked_at!==params.destination)throw new Error('Passenger destination arrival unverified');
    const arrived=await onboard(command);receipt.onboard=structuredClone(arrived.passengers);
    preserve(receipt,account,arrived.passengers);
    for(const raw of dockReceipts) {
      const summary=details(raw).passenger_arrivals;
      if(!summary)continue;
      if((summary.stranded??[]).length)throw new Error('Docking reported stranded passengers');
      const delivered=summary.delivered??[];
      if(!validRows(delivered))throw new Error('Malformed passenger arrival evidence');
      if(!delivered.length)continue;
      if(delivered.some((row:Wire)=>row.destination!==receipt.destination||!receipt.loaded.some(loaded=>loaded.citizen_id===row.citizen_id)||receipt.delivered.some(previous=>previous.citizen_id===row.citizen_id)))throw new Error('Dock fare includes unrelated or repeated delivery; attribution unavailable');
      if(typeof summary.fare_collected!=='number'||!Number.isFinite(summary.fare_collected)||summary.fare_collected<0){receipt.fare_collected=null;throw new Error('Dock delivery fare unavailable');}
      if(delivered.some((row:Wire)=>arrived.passengers.some((actual:Wire)=>actual.citizen_id===row.citizen_id)))throw new Error('Delivered passengers remain onboard');
      receipt.delivered.push(...structuredClone(delivered));receipt.fare_collected!+=summary.fare_collected;save();
    }
    for(const loaded of receipt.loaded)if(!receipt.delivered.some(row=>row.citizen_id===loaded.citizen_id)&&!arrived.passengers.some((row:Wire)=>row.citizen_id===loaded.citizen_id))throw new Error('Passenger disappeared without authoritative delivery evidence');
    delete receipt.pending_action;save();
    for(const passenger of receipt.loaded.filter(row=>!receipt.delivered.some(delivered=>delivered.citizen_id===row.citizen_id))) {
      const current=receipt.onboard.find(row=>row.citizen_id===passenger.citizen_id);
      if(!current||!Number.isFinite(current.ticks_remaining)||current.ticks_remaining<=0)throw new Error('Passenger deadline expired before unloading; preserve custody for reassessment');
      const beforeUnload=receipt.onboard;
      const result=await mutate('spacemolt/unload_passenger',{id:passenger.citizen_id});
      const observed=await onboard(command);receipt.onboard=structuredClone(observed.passengers);preserve(receipt,account,observed.passengers);
      if(result.kind!=='single'||result.delivered!==true||observed.passengers.some((row:Wire)=>row.citizen_id===passenger.citizen_id)||observed.passengers.length!==beforeUnload.length-1||beforeUnload.some(row=>row.citizen_id!==passenger.citizen_id&&!observed.passengers.some((actual:Wire)=>actual.citizen_id===row.citizen_id)))throw new Error('Passenger disembarkation delivery unverified');
      if(typeof result.fare_collected!=='number'||!Number.isFinite(result.fare_collected)||result.fare_collected<0){receipt.fare_collected=null;throw new Error('Delivered passenger fare unavailable');}
      receipt.delivered.push(structuredClone(passenger));receipt.fare_collected!+=result.fare_collected;
      delete receipt.pending_action;save();await controls.checkpoint();
    }
    receipt.status='completed';delete receipt.reason;save();return receipt;
  } catch(error) {
    receipt.status=receipt.pending_action?'needs_reconciliation':receipt.loaded.length?'interrupted':'blocked';
    receipt.reason=error instanceof Error?error.message:String(error);save();return receipt;
  }
}


/** Waiting offers have no deadline in the pinned contract; boarding supplies it. */
export async function assessPassengers(account:Account,command:IndustryCommand,params:{destination?:string},context:{stations:Home[]}) {
  if(!account.location?.docked_at)return {status:'blocked',reason:'Passenger assessment requires docking at the departure station',candidates:[]};
  const aboard=await onboard(command);
  const station=details(await command('spacemolt/list_station_passengers',{}));
  if(!validRows(station.waiting)||station.count!==station.waiting.length)throw new Error('Station passenger observation unavailable');
  const destinations=[...new Set<string>(station.waiting.map((row:Wire)=>row.destination))].filter(destination=>!params.destination||destination===params.destination);
  const candidates=destinations.map(destination=>{
    const passengers=station.waiting.filter((row:Wire)=>row.destination===destination);
    const target=context.stations.find(row=>row.base_id===destination);
    const berths=aboard.berths;
    const known=berths&&['economy','business','first'].every(key=>Number.isInteger(berths[key]?.free)&&berths[key].free>=0);
    const blockers:string[]=[];
    if(!target)blockers.push('Destination is absent from observed station directory');
    if(!known)blockers.push('Passenger berth capacity unavailable');
    else if(!passengers.some((row:Wire)=>berths[row.class]?.free>0))blockers.push('No free berth observed for these passenger classes');
    if(aboard.passengers.some((row:Wire)=>row.destination===destination))blockers.push('Existing passengers share this automatic delivery destination; plan their custody separately');
    if(destination===account.location?.docked_at)blockers.push('Destination matches departure station');
    return {destination,station:target,passengers:structuredClone(passengers),berths:structuredClone(berths),blockers};
  });
  return {status:candidates.some(row=>!row.blockers.length)?'assessed':'blocked',station:account.location.docked_at,
    candidates,onboard:structuredClone(aboard.passengers),
    reason:candidates.length?undefined:'No observed waiting passengers for the requested destination',
    limitations:['Route, fuel and spending bounds must be validated before boarding.','Waiting offers do not expose deadlines; actual ticks_remaining are recorded after boarding. Timely delivery is not guaranteed.','Estimated fares are offers; only accepted delivery fare_collected establishes earnings.']};
}
