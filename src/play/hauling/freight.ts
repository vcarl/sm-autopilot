/** Sealed-package freight: accept a contract, carry the package, deliver it. Builds the
 * carrier tier (probationary → licensed at 5 deliveries → trusted → prime), which is the
 * only thing that raises the liability you may carry. */
import type {CarrierProfile,ShipmentContract,ShippingActiveContract,ShippingActiveResponse,ShippingContractResponse,ShippingListResponse,ShippingListing,ShippingProfileResponse,ShippingSettlementResponse,V2CargoItem} from '@spacemolt/lib';
import {resolveFuelReserve} from '../../mood-policy.ts';
import {details} from '../../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step} from '../runtime.ts';
import {withdraw} from '../storage.ts';
import {goTo,route} from '../travel.ts';
import type {Outcome} from '../types.ts';

/** The board here, filtered to what you may take and can carry, beside your carrier record. */
export interface Board {
  /** `ShippingListing.eligible` already says whether your tier allows it; `reason` says why not. */
  listings:(ShippingListing&{
    /** Fuel `find_route` quotes to the destination, and whether the deadline is reachable. */
    fuel:number;reachable:boolean;
    /** Package size against your free cargo. */
    fits:boolean;
    /** `reserved_exposure`: what carrying it puts against your tier's allowance. */
    liability:number;
    /** `base_reward` less the fuel bill at this base's `fuel_price_all_in`. */
    net:number;
  })[];
  profile:ShippingProfileResponse;
  active:ShippingActiveContract[];
}

/** Every sealed package occupies exactly 100 cargo, whatever is inside (docs/guides/packages). */
export const PACKAGE_CARGO=100;
/** Shipping payloads take the raw id; storage and cargo carry it as `package:<id>`. */
const bare=(id:string)=>id.replace(/^package:/,'');
const stored=(id:string)=>`package:${bare(id)}`;
const liabilityOf=(contract:ShipmentContract)=>contract.reserved_exposure??contract.appraised_value??0;
const freeCargo=()=>{const ship=acct().state.ship;return (ship?.cargo_capacity??0)-(ship?.cargo_used??0);};
const aboard=(packageId:string)=>((acct().state.cargo??[]) as V2CargoItem[]).some(row=>row.item_id===stored(packageId));

const readProfile=async():Promise<ShippingProfileResponse>=>
  details(await command('spacemolt_shipping/profile',{})) as ShippingProfileResponse;
const readActive=async():Promise<ShippingActiveContract[]>=>
  ((details(await command('spacemolt_shipping/active',{})) as ShippingActiveResponse).shipments??[])
    .filter(row=>row.role==='carrier'||row.role==='invited_carrier');

/** The allowance a contract of this liability has to fit inside: the tier's per-package and
 * remaining-aggregate limits, and the standing cap. The first one it breaks is the answer. */
function overLimit(liability:number,profile:ShippingProfileResponse):string|null {
  const cap=pilot().permissions?.max_liability;
  const {single_package_liability_limit:single,remaining_aggregate_liability:left,liability_unlimited}=profile.capacity;
  if(cap!==undefined&&liability>cap)return `liability ${liability} over permissions.max_liability ${cap}`;
  if(liability_unlimited)return null;
  if(single!==undefined&&liability>single)return `liability ${liability} over the ${profile.profile.tier} per-package limit ${single}`;
  if(left!==undefined&&liability>left)return `liability ${liability} over the remaining aggregate allowance ${left}`;
  return null;
}

/** The shipping board at this base (`shipping/list`), your profile and your active
 * contracts. Each listing carries a route quote so you can see fuel against
 * `contract.base_reward`; listings your tier, your liability allowance or
 * `permissions.max_liability` refuse are dropped, and what is left is sorted by net reward
 * per fuel unit. Reads only. `next` names the best three.
 *
 * `reachable` is fuel only — whether the quoted route fits inside the mood's fuel reserve.
 * The lib gives a deadline in ticks and a route in jumps with no published tick cost per
 * jump, so a deadline is not checked here; read `deadline_ticks` yourself. */
export function freightBoard(opts:{destination?:string;limit?:number}={}):Promise<Outcome<Board>> {
  return job<Board>('freightBoard',[opts.destination,opts.limit?`≤${opts.limit}`:''].filter(Boolean).join(' '),async()=>{
    const empty=():Board=>({listings:[],profile:{} as ShippingProfileResponse,active:[]});
    const docked=acct().state.location?.docked_at;
    if(!docked)return {status:'refused',did:'read no board',why:'not docked; the shipping board is a station counter',detail:empty()};
    const profile=await readProfile();
    const active=await readActive();
    const reply=details(await command('spacemolt_shipping/list',
      {sort:'reward',...opts.destination?{filter_destination:opts.destination}:{}})) as ShippingListResponse;
    const offered=(reply.shipments??[]).filter(row=>row.eligible&&!overLimit(liabilityOf(row.contract),profile));
    const fuelPrice=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);
    const ship=acct().state.ship,reserve=resolveFuelReserve(pilot().mood??'Cautious');
    const free=freeCargo();
    // ponytail: one find_route per listing, so only the top `limit` by reward are quoted.
    const rows:Board['listings']=[];
    for(const row of offered.slice(0,opts.limit??10)) {
      checkStop();
      let fuel=Infinity;
      try {fuel=Number((await route(row.contract.destination_base_id)).estimated_fuel??0);} catch {/* unroutable: left at Infinity */}
      rows.push({...row,fuel,reachable:Number.isFinite(fuel)&&fuel+reserve<=(ship?.fuel??0),
        fits:PACKAGE_CARGO<=free,liability:liabilityOf(row.contract),
        net:row.contract.base_reward-(Number.isFinite(fuel)?fuel*fuelPrice:0)});
    }
    rows.sort((a,b)=>(b.net/(b.fuel||1))-(a.net/(a.fuel||1)));
    const {capacity,profile:carrier}=profile;
    const detail:Board={listings:rows,profile,active};
    return {status:'done',
      did:`read the shipping board at ${docked}: ${reply.total??(reply.shipments??[]).length} posted, ${rows.length} you may take; `+
        `tier ${carrier.tier}, ${capacity.liability_unlimited?'unlimited':`${capacity.remaining_aggregate_liability??0} of ${capacity.aggregate_liability_limit??0}`} liability left, `+
        `${active.length} active, hold ${free} free`,
      detail,
      next:rows.filter(row=>row.fits&&row.reachable).slice(0,3)
        .map(row=>`haul('${row.contract.id}') — ${row.contract.base_reward} cr to ${row.contract.destination_base_id}, ${row.fuel} fuel, net ${Math.round(row.net)}`)
        .concat(rows.length&&!rows.some(row=>row.fits)?[`no package fits: ${PACKAGE_CARGO} cargo needed, ${free} free`]:[])
        .slice(0,3)};
  });
}

export interface Hauled {
  contract:ShippingActiveContract['contract'];
  settlement?:ShippingSettlementResponse;
  profile_after:CarrierProfile;
  /** Which leg the function ended on. */
  leg:'accepted'|'loaded'|'delivered';
}

/** One package, board to delivery: `shipping/get`, `shipping/accept`, `storage/withdraw
 * package:<id>` (an accepted package sits in your store at the origin; it is not aboard
 * until withdrawn), `goTo(destination_base_id)`, `shipping/deliver`.
 *
 * Idempotent per leg, re-entered from the live world: an active contract skips the accept,
 * a package already aboard skips the withdraw, standing at the destination skips the flight.
 *
 * Refused when `profile.debt_blocks_acceptance`, when the contract's liability exceeds
 * `permissions.max_liability` or the tier's limits, or when the package will not fit — each
 * with the numbers, and nothing sent past the check. Never accepts a contract it cannot
 * complete: failure is a debt and a tier demotion.
 *
 * Costs fuel; pays `carrier_payout` plus speed bonus, measured into `gained.credits`.
 * Tired mid-haul: the leg in flight finishes, the package stays where it is, and the
 * function returns `partial` with the contract still active; `service()` then `haul` again
 * with the same id resumes. */
export function haul(shipmentId:string):Promise<Outcome<Hauled>> {
  return job<Hauled>('haul',shipmentId,async()=>{
    const id=bare(shipmentId);
    const none=(contract?:ShipmentContract,profile?:CarrierProfile):Hauled=>
      ({contract:(contract??{}) as ShipmentContract,profile_after:(profile??{}) as CarrierProfile,leg:'accepted'});
    const blocked=admit('haul');
    if(blocked)return {status:'refused',did:`did not haul ${id}`,why:blocked,detail:none()};

    let mine=(await readActive()).find(row=>row.contract.id===id);
    let contract=mine?.contract;
    if(!contract) {
      // The board goes stale: the contract is re-read before anything is sent.
      try {contract=(details(await command('spacemolt_shipping/get',{shipment_id:id})) as ShippingContractResponse).contract;}
      catch(error){return {status:'refused',did:`did not haul ${id}`,why:(error as Error).message,detail:none()};}
      const free=freeCargo();
      if(PACKAGE_CARGO>free)return {status:'refused',did:`did not accept ${id}`,
        why:`the package needs ${PACKAGE_CARGO} cargo; the hold has ${free} free of ${acct().state.ship?.cargo_capacity??0}`,
        detail:none(contract),next:['stow(rows) or sell(rows) first, or a hull with a bigger hold']};
      const profile=await readProfile();
      if(profile.debt_blocks_acceptance)return {status:'refused',did:`did not accept ${id}`,
        why:profile.debt_block_reason??`freight debt blocks acceptance: ${profile.profile.outstanding_debt} cr outstanding`,
        detail:none(contract,profile.profile),next:['account().commands.spacemolt_shipping.pay_debt()']};
      const over=overLimit(liabilityOf(contract),profile);
      if(over)return {status:'refused',did:`did not accept ${id}`,why:over,detail:none(contract,profile.profile)};
      step(`accept ${id}: ${contract.base_reward} cr to ${contract.destination_base_id}, liability ${liabilityOf(contract)}`);
      contract=(details(await command('spacemolt_shipping/accept',{shipment_id:id,carrier:'player'})) as ShippingContractResponse).contract??contract;
      mine=(await readActive()).find(row=>row.contract.id===id);
    } else step(`${id} is already active: ${mine?.next_step??'in transit'}`);

    const destination=contract.destination_base_id;
    const packageId=contract.package_id;
    const detail=(leg:Hauled['leg'],profile?:CarrierProfile,settlement?:ShippingSettlementResponse):Hauled=>
      ({contract,profile_after:(profile??{}) as CarrierProfile,leg,...settlement?{settlement}:{}});
    const tired=async(leg:Hauled['leg'],did:string)=>({status:'partial' as const,did,why:'Tired: the leg finished, the contract is still active',
      detail:detail(leg,(await readProfile()).profile),
      next:[`service() at a base, then haul('${id}') again: it re-enters at the leg the live world implies`]});

    // Leg 2: the package aboard. An accepted package is in the store at the origin.
    if(!aboard(packageId)) {
      if(acct().state.location?.docked_at!==contract.origin_base_id) {
        step(`goTo ${contract.origin_base_id} for the package`);
        const back=await goTo(contract.origin_base_id);
        if(back.status!=='done')return {status:back.status==='partial'?'partial':'refused',
          did:`accepted ${id} but did not reach the package`,why:back.why,detail:detail('accepted'),
          next:[`haul('${id}') again from a base that can reach ${contract.origin_base_id}`]};
      }
      const took=await withdraw([{item_id:stored(packageId),quantity:1}]);
      if(!aboard(packageId))return {status:'failed',did:`accepted ${id}; the package did not come aboard`,
        why:took.why??`${stored(packageId)} is not in the hold after the withdraw`,detail:detail('accepted'),
        next:[`storage('${contract.origin_base_id}') to see where the package is`]};
      step(`package ${stored(packageId)} aboard, hold ${acct().state.ship?.cargo_used}/${acct().state.ship?.cargo_capacity}`);
    }
    if(pilot().mood==='Tired')return tired('loaded',`accepted ${id} and loaded the package at ${contract.origin_base_id}`);

    // Leg 3: the flight. `goTo` is itself idempotent, so standing at the destination sends nothing.
    const trip=await goTo(destination);
    if(trip.status!=='done')return {status:trip.status==='partial'?'partial':'refused',
      did:`carried ${id} as far as ${trip.now.location?.poi_id??'?'}`,why:trip.why,detail:detail('loaded'),
      next:[`service(), then haul('${id}') again to finish the flight to ${destination}`]};
    if(pilot().mood==='Tired')return tired('loaded',`carried ${id} to ${destination}`);

    // Leg 4: the delivery, and the settlement as the server measured it.
    checkStop();
    const settlement=details(await command('spacemolt_shipping/deliver',{shipment_id:id})) as ShippingSettlementResponse;
    const after=(await readProfile()).profile;
    const payout=settlement.carrier_payout??0;
    return {status:'done',
      did:`delivered ${id} to ${destination} for ${payout} cr${settlement.late?' (late)':''}; `+
        `${after.successful_deliveries} deliveries, tier ${after.tier}`,
      detail:detail('delivered',after,settlement),
      next:[`freightBoard() at ${destination}: the return leg is a trip you are making anyway`]};
  });
}
