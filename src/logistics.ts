import {SpacemoltError,type Account} from '@spacemolt/lib';
import {details,type IndustryCommand} from './industry.ts';
import type {Home} from './execution-policy.ts';
import {observeObligations,admitProductiveSortie} from './obligations.ts';
import {routeSteps} from './survey.ts';
import {miningInventory as cargoInventory} from './mining-inventory.ts';
import {snapshotSkills,skillProgress} from './progression.ts';

type Wire=Record<string,any>;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const packageItem=(id:string)=>id.startsWith('package:')?id:`package:${id}`;
const count=(items:Wire[],id:string)=>items.filter(item=>item.item_id===id).reduce((sum,item)=>sum+item.quantity,0);
export interface FreightPolicy {stations:Home[];credit_reserve:number;max_route_jumps:number;max_liability:number}
export interface FreightControls {
  checkpoint:()=>Promise<void>;
  record:(receipt:FreightReceipt)=>void;
  travel:(base_id:string)=>Promise<unknown>;
  validateRoute:(base_id:string)=>Promise<void>;
}
export interface FreightReceipt {
  status:'running'|'completed'|'blocked'|'needs_reconciliation';reason?:string;
  shipment_id:string;package_id:string;origin:Home;destination:Home;ship_id:string;
  assessment:Wire;starting_cargo:Record<string,number>;skills_before:ReturnType<typeof snapshotSkills>;
  skill_progress?:ReturnType<typeof skillProgress>;pending_action?:{action:string;params:Wire};
  acceptance?:Wire;custody?:Wire;delivery?:Wire;last_receipt?:Wire;
  payout?:number;accounting_unverified?:string;profile_after?:Wire;obligations_after?:unknown;
}

/** Missing package visibility does not erase its liability; size is checked after acceptance. */
export async function assessFreight(account:Account,command:IndustryCommand,params:{shipment_id?:string},policy:FreightPolicy):Promise<Wire> {
  if(!finite(policy.credit_reserve)||!finite(policy.max_liability)||!Number.isInteger(policy.max_route_jumps)||policy.max_route_jumps<0)throw new Error('Invalid resolved freight policy');
  await account.refresh();
  const profile=details(await command('spacemolt_shipping/profile',{carrier:'player'}));
  const board=details(await command('spacemolt_shipping/list',{eligible_as:'player',per_page:50,sort:'distance'}));
  if(!Array.isArray(board.shipments))throw new Error('Shipping board unavailable');
  const reference=(id:string)=>policy.stations.find(station=>station.base_id===id);
  if(!params.shipment_id)return {status:'observed',profile,policy,candidates:board.shipments.map((row:Wire)=>{
    const origin=reference(row.contract?.origin_base_id),destination=reference(row.contract?.destination_base_id);
    const blockers:string[]=[];
    if(!origin||!destination)blockers.push('Origin or destination is absent from observed station directory');
    if(origin&&origin.base_id!==account.location?.docked_at)blockers.push('Start docked at contract origin');
    if(row.eligible===false)blockers.push(row.reason??'Carrier is not eligible');
    if(!finite(row.contract?.failure_debt)||row.contract.failure_debt>policy.max_liability)blockers.push('Contract exceeds resolved contingent-liability allocation');
    return {...row,origin,destination,blockers,readiness:blockers.length?'blocked':'requires_targeted_assessment',
      observed_same_system:origin&&destination?origin.system_id===destination.system_id:undefined,
      next_action:blockers.length?'Resolve blockers or compare another candidate':'Call job__assess with kind freight and this shipment_id before transport'};
  }),limitation:'First 50 board entries only; server eligibility is not local readiness. Stored contract route_hops may be stale for mobile stations. Targeted assessment verifies current route, capacity and obligations before acceptance.'};
  const contract=details(await command('spacemolt_shipping/get',{shipment_id:params.shipment_id})).contract;
  if(!contract||contract.id!==params.shipment_id||typeof contract.package_id!=='string')throw new Error('Contract identity unavailable');
  const blockers:string[]=[],unknowns:string[]=[];
  const origin=reference(contract.origin_base_id),destination=reference(contract.destination_base_id);
  if(!origin||!destination||origin.base_id===destination.base_id)blockers.push('Observe distinct origin and destination stations');
  if(account.location?.docked_at!==origin?.base_id||account.location?.system_id!==origin?.system_id||account.location?.poi_id!==origin?.poi_id||account.location?.in_transit)blockers.push('Start docked at the observed contract origin');
  if(contract.status!=='posted')blockers.push('Only a new posted contract can be accepted; existing commitments require explicit reconciliation');
  const listing=board.shipments.find((row:Wire)=>row.contract?.id===contract.id);
  if(listing?.eligible===false)blockers.push(listing.reason??'Carrier is not eligible');
  if(!listing)unknowns.push('Contract not on first board page; server acceptance still determines eligibility');
  if(!profile.capacity||typeof profile.debt_blocks_acceptance!=='boolean')blockers.push('Carrier capacity/debt evidence unavailable');
  else {
    if(profile.debt_blocks_acceptance)blockers.push(profile.debt_block_reason??'Freight debt blocks acceptance');
    const capacity=profile.capacity;
    if(capacity.active_contracts_unlimited!==true&&(!finite(capacity.active_contract_limit)||!finite(capacity.active_contracts)||capacity.active_contracts>=capacity.active_contract_limit))blockers.push('Carrier contract capacity unavailable or exhausted');
    if(capacity.liability_unlimited!==true&&(!finite(capacity.remaining_aggregate_liability)||!finite(capacity.single_package_liability_limit)||contract.reserved_exposure>Math.min(capacity.remaining_aggregate_liability,capacity.single_package_liability_limit)))blockers.push('Carrier liability capacity unavailable or insufficient');
  }
  if(!finite(contract.failure_debt)||!finite(contract.reserved_exposure)||contract.failure_debt>policy.max_liability)blockers.push('Contract exceeds resolved contingent-liability allocation');
  if(!finite(account.credits)||account.credits<policy.credit_reserve)blockers.push('Wallet reserve unavailable');
  const ship=account.ship;
  if(!ship||![ship.cargo_capacity,ship.cargo_used,ship.fuel,ship.hull,ship.max_hull,ship.shield,ship.max_shield].every(finite)||ship.incapacitated||ship.hull!==ship.max_hull||ship.shield!==ship.max_shield)blockers.push('Service and verify ship condition before freight');
  let inspection:Wire|undefined;
  try {inspection=details(await command('spacemolt/inspect',{id:packageItem(contract.package_id)}));}
  catch(error){if(!(error instanceof SpacemoltError))throw error;unknowns.push(`Package not visible before acceptance: ${error.code}`);}
  const packageSize=inspection?.kind==='package'&&packageItem(inspection.package?.package_id??'')===packageItem(contract.package_id)&&finite(inspection.package?.size)?inspection.package.size:undefined;
  if(packageSize===undefined)unknowns.push('Package size unverified: accepting creates a commitment; no withdrawal or departure until storage size/capacity is verified');
  else if(!ship||ship.cargo_capacity-ship.cargo_used<packageSize)blockers.push('Insufficient free cargo for inspected package');
  let route:Wire|undefined;
  if(destination&&account.location?.system_id!==destination.system_id) {
    route=details(await command('spacemolt/find_route',{id:destination.system_id}));
    try {if(routeSteps(route,account.location!.system_id,destination.system_id).length>policy.max_route_jumps)blockers.push('Route exceeds resolved jump allocation');}
    catch(error){blockers.push(String(error));}
    if(!ship||!finite(route.estimated_fuel)||ship.fuel<route.estimated_fuel+17)blockers.push('Outbound route breaches fuel reserve');
  }
  const obligations=await observeObligations(account,command);
  try{admitProductiveSortie(obligations,'Freight');}catch(error){blockers.push(String(error));}
  return {status:blockers.length?'blocked':'ready_to_accept',blockers,unknowns,contract,origin,destination,profile,package_size:packageSize,route,policy,obligations,
    deadline_ticks:listing?.deadline_ticks,liability:{failure_debt:contract.failure_debt,reserved_exposure:contract.reserved_exposure},
    limitation:'Liability is contingent, not cash spending. Route timing and future payout are not guaranteed; loaded-cargo route is rechecked before departure.'};
}

/** One contract, no retries: the caller owns servicing, return, and uncertain-command recovery. */
export async function transportFreight(account:Account,command:IndustryCommand,params:{shipment_id:string;resume?:FreightReceipt;policy?:FreightPolicy},assessment:Wire,controls:FreightControls):Promise<FreightReceipt> {
  if(assessment.contract?.id!==params.shipment_id||(!params.resume&&assessment.status!=='ready_to_accept'))throw new Error(`Fresh freight admission required: ${(assessment.blockers??['contract identity or readiness unavailable']).join('; ')}`);
  if(params.resume&&(params.resume.shipment_id!==params.shipment_id||params.resume.status==='completed'||params.resume.pending_action||params.resume.accounting_unverified||!params.resume.acceptance))throw new Error('Only known accepted freight without unresolved commands can resume');
  if(params.resume&&!params.policy)throw new Error('Resumed freight requires the current resolved policy');
  const policy=params.policy??assessment.policy as FreightPolicy;
  const contract=assessment.contract,item=packageItem(contract.package_id);
  const receipt:FreightReceipt=params.resume?structuredClone(params.resume):{status:'running',shipment_id:contract.id,package_id:contract.package_id,origin:assessment.origin,destination:assessment.destination,ship_id:account.ship!.id,assessment,
    starting_cargo:cargoInventory(account.state),skills_before:snapshotSkills(account.state)};
  receipt.status='running';delete receipt.reason;receipt.assessment={...assessment,policy};
  const destination=policy.stations.find(station=>station.base_id===receipt.destination.base_id);
  if(!destination)throw new Error('Observe current freight destination before continuation');
  receipt.destination=structuredClone(destination);
  const save=()=>controls.record(structuredClone(receipt));
  const verifyShip=()=>{
    if(account.ship?.id!==receipt.ship_id)throw new Error('Ship changed during freight');
    const cargo=cargoInventory(account.state);
    if(Object.entries(receipt.starting_cargo).some(([id,n])=>(cargo[id]??0)<n))throw new Error('Starting cargo is missing');
  };
  const mutation=async(action:string,params:Wire,verify:(reply:Wire)=>Promise<void>)=>{
    await controls.checkpoint();verifyShip();receipt.pending_action={action,params};save();
    const reply=details(await command(action,params));receipt.last_receipt=reply;save();
    await verify(reply);delete receipt.pending_action;save();await controls.checkpoint();
  };
  save();
  try {
    await controls.checkpoint();verifyShip();
    if(!params.resume&&account.location?.docked_at!==receipt.origin.base_id)throw new Error('Origin changed before freight acceptance');
    if(!finite(account.credits)||account.credits<policy.credit_reserve)throw new Error('Current wallet breaches freight reserve');
    const fresh=details(await command('spacemolt_shipping/get',{shipment_id:contract.id})).contract;
    if(!fresh||['id','package_id','origin_base_id','destination_base_id','failure_debt','reserved_exposure'].some(key=>fresh[key]!==contract[key])||fresh.status!==(params.resume?'in_transit':'posted'))throw new Error('Freight contract changed; reassess before acceptance or continuation');
    if(!finite(fresh.failure_debt)||!finite(fresh.reserved_exposure)||fresh.failure_debt>policy.max_liability)throw new Error('Current freight liability exceeds resolved allocation');
    const personallyAccepted=(value:Wire)=>value?.status==='in_transit'&&value.contractor?.kind==='player'&&value.contractor?.id===account.state.player?.id;
    if(params.resume&&!personallyAccepted(fresh))throw new Error('Personal carrier identity not verified for continuation');
    if(!params.resume)await mutation('spacemolt_shipping/accept',{shipment_id:contract.id,carrier:'player'},async reply=>{
      receipt.acceptance=reply;save();
      if(reply.action!=='accept'||!personallyAccepted(reply.contract)||['id','package_id','origin_base_id','destination_base_id','failure_debt','reserved_exposure'].some(key=>reply.contract[key]!==contract[key]))throw new Error('Personal contract acceptance not verified');
    });
    if(count(account.cargo??[],item)!==1) {
      if(account.location?.docked_at!==receipt.origin.base_id||receipt.custody)throw new Error('Expected loaded package is missing; do not repeat withdrawal');
      const storage=details(await command('spacemolt_storage/view',{})).items;
      if(!Array.isArray(storage))throw new Error('Accepted package storage unavailable');
      const packageRow=storage.find((row:Wire)=>row.item_id===item);
      const size=finite(packageRow?.size)?packageRow.size:assessment.package_size;
      if(count(storage,item)!==1||!finite(size)||!account.ship||account.ship.cargo_capacity-account.ship.cargo_used<size)throw new Error('Accepted package size, storage custody or free capacity unverified; commitment retained');
      const cargoBefore=count(account.cargo??[],item);
      if(cargoBefore!==0)throw new Error('Package already aboard; do not repeat withdrawal');
      await mutation('spacemolt_storage/withdraw',{item_id:item,quantity:1},async()=>{
        const after=details(await command('spacemolt_storage/view',{})).items;
        if(!Array.isArray(after)||count(after,item)!==0||count(account.cargo??[],item)!==1)throw new Error('Package withdrawal custody not verified');
        receipt.custody={source:'personal_storage_to_cargo',item_id:item,quantity:1,size};
      });
    } else if(!params.resume)throw new Error('Unexpected package already aboard after acceptance; verify custody before continuation');
    const active=await observeObligations(account,command);
    const carrying=active.freight.shipments.find((row:Wire)=>row.contract?.id===contract.id);
    if(!carrying||carrying.role!=='carrier'||carrying.package_in_your_cargo!==true||carrying.contract?.status!=='in_transit')throw new Error('Active personal freight custody unavailable');
    receipt.custody={...receipt.custody,active:carrying};save();
    if(!finite(carrying.ticks_to_deadline)||carrying.late||carrying.ticks_to_deadline<=0)throw new Error('Freight deadline already expired; preserve commitment for reassessment');
    await controls.checkpoint();await controls.validateRoute(receipt.destination.base_id);
    await controls.travel(receipt.destination.base_id);await controls.checkpoint();verifyShip();
    if(account.location?.docked_at!==receipt.destination.base_id||account.location.system_id!==receipt.destination.system_id||count(account.cargo??[],item)!==1)throw new Error('Freight destination/custody not verified');
    await mutation('spacemolt_shipping/deliver',{shipment_id:contract.id},async reply=>{
      receipt.delivery=reply;save();
      if(reply.action!=='deliver'||reply.contract?.id!==contract.id||reply.contract?.status!=='delivered'||count(account.cargo??[],item)!==0)throw new Error('Freight delivery and package removal not verified');
      const payout=reply.carrier_payout??reply.contract.carrier_payout;
      if(!finite(payout)||(reply.carrier_payout!==undefined&&reply.contract.carrier_payout!==undefined&&reply.carrier_payout!==reply.contract.carrier_payout)) {
        receipt.accounting_unverified='Delivered contract omitted or contradicted authoritative carrier payout';throw new Error(receipt.accounting_unverified);
      }
      receipt.payout=payout;
    });
    const delivered=details(await command('spacemolt_shipping/get',{shipment_id:contract.id})).contract;
    if(delivered?.id!==contract.id||delivered.status!=='delivered')throw new Error('Terminal contract not verified');
    receipt.profile_after=details(await command('spacemolt_shipping/profile',{carrier:'player'}));
    receipt.obligations_after=await observeObligations(account,command);verifyShip();
    if((receipt.obligations_after as Awaited<ReturnType<typeof observeObligations>>).freight.shipments.some((row:Wire)=>row.contract?.id===contract.id&&(row.contract.status!=='delivered'||row.package_in_your_cargo)))throw new Error('Final freight obligations contradict delivery');
    receipt.skill_progress=skillProgress(receipt.skills_before,snapshotSkills(account.state));receipt.status='completed';save();
  } catch(error) {
    receipt.status=receipt.pending_action||receipt.accounting_unverified?'needs_reconciliation':'blocked';receipt.reason=String(error);save();
  }
  return receipt;
}
