/** Sealed-package freight: accept a contract, carry the package, deliver it. Builds the
 * carrier tier (probationary → licensed at 5 deliveries → trusted → prime), which is the
 * only thing that raises the liability you may carry. */
import type {CarrierProfile,ShipmentContract,ShippingActiveContract,ShippingContractResponse,ShippingListing,ShippingProfileResponse,ShippingSettlementResponse} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {replyBody} from '../../storage.ts';
import {TravelBlocked} from '../../travel.ts';
import * as Wire from '../../wire.gen.ts';
import {Game,attempt,field} from '../game.ts';
import {folded,withdrawEffect} from '../storage.ts';
import {Stopped,acct,admit,edge,jobEffect,pilot,step,stopped} from '../runtime.ts';
import {goToEffect,routeEffect} from '../travel.ts';
import type {Outcome} from '../types.ts';
import {kept,num,offSpec,told} from '../rows.ts';

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
const aboard=(packageId:string)=>(acct().state.cargo??[]).some(row=>row.item_id===stored(packageId));

// The frozen surface promises the lib's types; a live reply is decoded only for the fields read below, because the server omits spec fields.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asProfile=(body:unknown)=>body as ShippingProfileResponse; // cast: frozen surface (ShippingProfileResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asCarrier=(body:unknown)=>body as CarrierProfile; // cast: frozen surface (CarrierProfile)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asContract=(body:unknown)=>body as ShipmentContract; // cast: frozen surface (ShipmentContract)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asActive=(row:unknown)=>row as ShippingActiveContract; // cast: frozen surface (ShippingActiveContract)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asListing=(row:unknown)=>row as ShippingListing; // cast: frozen surface (ShippingListing)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asSettlement=(body:unknown)=>body as ShippingSettlementResponse; // cast: frozen surface (ShippingSettlementResponse)

const contractFields=['id','package_id','origin_base_id','destination_base_id','base_reward','reserved_exposure','appraised_value'] as const;
const decodeProfile=Schema.decodeUnknownEffect(Wire.ShippingProfileResponse.mapFields(fields=>({
  capacity:fields.capacity.mapFields(Struct.pick(['single_package_liability_limit','remaining_aggregate_liability','liability_unlimited','aggregate_liability_limit'])),
  debt_block_reason:fields.debt_block_reason,debt_blocks_acceptance:Schema.optionalKey(fields.debt_blocks_acceptance),
  profile:fields.profile.mapFields(Struct.pick(['tier','outstanding_debt','successful_deliveries']))})));
const decodeActive=Schema.decodeUnknownOption(Wire.ShippingActiveContract.mapFields(fields=>({
  contract:fields.contract.mapFields(Struct.pick(contractFields)),role:fields.role,next_step:Schema.optionalKey(fields.next_step)})));
const decodeListing=Schema.decodeUnknownOption(Wire.ShippingListing.mapFields(fields=>({
  contract:fields.contract.mapFields(Struct.pick(contractFields)),eligible:fields.eligible})));
const decodeContract=Schema.decodeUnknownEffect(Wire.ShippingContractResponse.mapFields(fields=>({contract:fields.contract.mapFields(Struct.pick(contractFields))})));
const decodeAccepted=Schema.decodeUnknownOption(Wire.ShippingContractResponse.mapFields(fields=>({contract:fields.contract.mapFields(Struct.pick(contractFields))})));
const decodeSettlement=Schema.decodeUnknownOption(Wire.ShippingSettlementResponse.mapFields(fields=>({
  carrier_payout:fields.carrier_payout,late:fields.late})));

/** The carrier record. A reply that does not read is `failed`, saying so: nothing is sent past an allowance that was never read. */
const readProfile=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt_shipping/profile',{}));
  yield* decodeProfile(body).pipe(Effect.mapError(offSpec('spacemolt_shipping/profile')));
  return asProfile(body);
});
/** The contracts this account carries, as the game lists them: a row that does not read is left out and said. */
const readActive=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt_shipping/active',{}));
  return kept('spacemolt_shipping/active','shipments',field(body,'shipments'),decodeActive,row=>field(field(row,'contract'),'id')).map(asActive)
    .filter(row=>row.role==='carrier'||row.role==='invited_carrier');
});

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

const emptyBoard=():Board=>({listings:[],profile:asProfile({}),active:[]});

/** The shipping board at this base (`shipping/list`), your profile and your active
 * contracts. Each listing carries a route quote so you can see fuel against
 * `contract.base_reward`; listings your tier, your liability allowance or
 * `permissions.max_liability` refuse are dropped, and what is left is sorted by net reward
 * per fuel unit. Reads only. `next` names the best three.
 *
 * `reachable` is fuel only — whether the tank covers the quoted route.
 * The lib gives a deadline in ticks and a route in jumps with no published tick cost per
 * jump, so a deadline is not checked here; read `deadline_ticks` yourself. */
export function freightBoard(opts:{destination?:string;limit?:number}={}):Promise<Outcome<Board>> {return edge(freightBoardEffect(opts));}

/** `freightBoard` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal or a lost reply on a
 * read ends it naming the action and the code; a destination that is no place is an unroutable listing, not a failed board. */
export const freightBoardEffect=(opts:{destination?:string;limit?:number}={})=>
  jobEffect<Board,Game>('freightBoard',[opts.destination,opts.limit?`≤${opts.limit}`:''].filter(Boolean).join(' '),folded<Board>('freightBoard',emptyBoard,Effect.gen(function*() {
    const game=yield* Game;
    const docked=acct().state.location?.docked_at;
    if(!docked)return {status:'refused' as const,did:'read no board',why:'not docked; the shipping board is a station counter',detail:emptyBoard()};
    const profile=yield* readProfile();
    const active=yield* readActive();
    const reply=replyBody(yield* game.command('spacemolt_shipping/list',
      {sort:'reward',...opts.destination?{filter_destination:opts.destination}:{}}));
    const posted=kept('spacemolt_shipping/list','shipments',field(reply,'shipments'),decodeListing,row=>field(field(row,'contract'),'id')).map(asListing);
    const offered=posted.filter(row=>row.eligible&&!overLimit(liabilityOf(row.contract),profile));
    const price=field(replyBody(yield* game.command('spacemolt/get_base',{})),'fuel_price_all_in');
    const fuelPrice=typeof price==='number'?price:1;
    const ship=acct().state.ship;
    const free=freeCargo();
    // ponytail: one find_route per listing, so only the top `limit` by reward are quoted.
    const rows:Board['listings']=[];
    for(const row of offered.slice(0,opts.limit??10)) {
      if(stopped())return yield* Effect.fail(new Stopped());
      // `routeEffect` fails `NotAPlace` (a `TravelBlocked`) for "not a place"; anything else (a dropped socket, a
      // real server error) is a failed board read, not a listing to quietly mark unroutable.
      const quoted=yield* Effect.result(routeEffect(row.contract.destination_base_id));
      if(Result.isFailure(quoted)&&!(quoted.failure instanceof TravelBlocked))return yield* quoted.failure;
      const fuel=Result.isSuccess(quoted)?Number(quoted.success.estimated_fuel??0):Infinity; // unroutable: left at Infinity
      rows.push({...row,fuel,reachable:Number.isFinite(fuel)&&fuel<=(ship?.fuel??0),
        fits:PACKAGE_CARGO<=free,liability:liabilityOf(row.contract),
        net:row.contract.base_reward-(Number.isFinite(fuel)?fuel*fuelPrice:0)});
    }
    rows.sort((a,b)=>(b.net/(b.fuel||1))-(a.net/(a.fuel||1)));
    const {capacity,profile:carrier}=profile;
    const detail:Board={listings:rows,profile,active};
    return {status:'done' as const,
      did:`read the shipping board at ${docked}: ${num(reply,'total')??posted.length} posted, ${rows.length} you may take; `+
        `tier ${carrier.tier}, ${capacity.liability_unlimited?'unlimited':`${capacity.remaining_aggregate_liability??0} of ${capacity.aggregate_liability_limit??0}`} liability left, `+
        `${active.length} active, hold ${free} free`,
      detail,
      next:rows.filter(row=>row.fits&&row.reachable).slice(0,3)
        .map(row=>`haul('${row.contract.id}') — ${row.contract.base_reward} cr to ${row.contract.destination_base_id}, ${row.fuel} fuel, net ${Math.round(row.net)}`)
        .concat(rows.length&&!rows.some(row=>row.fits)?[`no package fits: ${PACKAGE_CARGO} cargo needed, ${free} free`]:[])
        .slice(0,3)};
  })));

export interface Hauled {
  contract:ShippingActiveContract['contract'];
  settlement?:ShippingSettlementResponse;
  profile_after:CarrierProfile;
  /** Which leg the function ended on. */
  leg:'accepted'|'loaded'|'delivered';
}

const none=(contract?:ShipmentContract,profile?:CarrierProfile):Hauled=>
  ({contract:contract??asContract({}),profile_after:profile??asCarrier({}),leg:'accepted'});

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
 * with the same id resumes. A reply lost on the accept or the delivery is never re-sent:
 * the active list is read to see whether it landed, and a delivery that may have is `partial`. */
export function haul(shipmentId:string):Promise<Outcome<Hauled>> {return edge(haulEffect(shipmentId));}

/** `haul` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal ends it naming the action and
 * the code; a lost reply on the accept or the deliver is never re-sent, and the active list is re-read. */
export const haulEffect=(shipmentId:string)=>
  jobEffect<Hauled,Game>('haul',shipmentId,folded<Hauled>('haul',none,Effect.gen(function*() {
    const game=yield* Game;
    const id=bare(shipmentId);
    // bridge: U31 (admit keeps its Promise form with the module singletons it reads)
    const blocked=yield* attempt('haul',()=>admit('haul'));
    if(blocked)return {status:'refused' as const,did:`did not haul ${id}`,why:blocked,detail:none()};

    const live=(yield* readActive()).find(row=>row.contract.id===id);
    let contract=live?.contract;
    if(!contract) {
      // The board goes stale: the contract is re-read before anything is sent.
      const got=yield* Effect.result(game.command('spacemolt_shipping/get',{shipment_id:id}));
      if(Result.isFailure(got)) {
        if(got.failure._tag==='ReplyLost')return yield* got.failure;
        return {status:'refused' as const,did:`did not haul ${id}`,why:told(got.failure),detail:none()};
      }
      const read=replyBody(got.success);
      yield* decodeContract(read).pipe(Effect.mapError(offSpec('spacemolt_shipping/get')));
      contract=asContract(field(read,'contract'));
      const free=freeCargo();
      if(PACKAGE_CARGO>free)return {status:'refused' as const,did:`did not accept ${id}`,
        why:`the package needs ${PACKAGE_CARGO} cargo; the hold has ${free} free of ${acct().state.ship?.cargo_capacity??0}`,
        detail:none(contract),next:['stow(rows) or sell(rows) first, or a hull with a bigger hold']};
      const profile=yield* readProfile();
      if(profile.debt_blocks_acceptance)return {status:'refused' as const,did:`did not accept ${id}`,
        why:profile.debt_block_reason??`freight debt blocks acceptance: ${profile.profile.outstanding_debt} cr outstanding`,
        detail:none(contract,profile.profile),next:['account().commands.spacemolt_shipping.pay_debt()']};
      const over=overLimit(liabilityOf(contract),profile);
      if(over)return {status:'refused' as const,did:`did not accept ${id}`,why:over,detail:none(contract,profile.profile)};
      step(`accept ${id}: ${contract.base_reward} cr to ${contract.destination_base_id}, liability ${liabilityOf(contract)}`);
      const sent=yield* Effect.result(game.command('spacemolt_shipping/accept',{shipment_id:id,carrier:'player'}));
      if(Result.isSuccess(sent)) {
        const accepted=decodeAccepted(replyBody(sent.success));
        if(Option.isNone(accepted))step(`spacemolt_shipping/accept: the reply had no contract; the one read before it stands`);
        else contract=asContract(field(replyBody(sent.success),'contract'));
      } else {
        // A refusal ends the haul with its code. A lost reply is never re-sent: the active list says whether it landed.
        if(sent.failure._tag!=='ReplyLost')return yield* sent.failure;
        const landed=(yield* readActive()).find(row=>row.contract.id===id);
        if(!landed)return yield* sent.failure;
        step(`accept ${id}: reply lost on ${sent.failure.action}, but the active list has it; it landed`);
        contract=landed.contract;
      }
    } else step(`${id} is already active: ${live?.next_step??'in transit'}`);

    const destination=contract.destination_base_id;
    const packageId=contract.package_id;
    const there=contract;
    const detail=(leg:Hauled['leg'],profile?:CarrierProfile,settlement?:ShippingSettlementResponse):Hauled=>
      ({contract:there,profile_after:profile??asCarrier({}),leg,...settlement?{settlement}:{}});
    const tired=(leg:Hauled['leg'],did:string)=>Effect.gen(function*() {
      return {status:'partial' as const,did,why:'Tired: the leg finished, the contract is still active',
        detail:detail(leg,(yield* readProfile()).profile),
        next:[`service() at a base, then haul('${id}') again: it re-enters at the leg the live world implies`]};
    });

    // Leg 2: the package aboard. An accepted package is in the store at the origin.
    if(!aboard(packageId)) {
      if(acct().state.location?.docked_at!==contract.origin_base_id) {
        step(`goTo ${contract.origin_base_id} for the package`);
        const back=yield* goToEffect(contract.origin_base_id);
        if(back.status!=='done')return {status:back.status==='partial'?'partial' as const:'refused' as const,
          did:`accepted ${id} but did not reach the package`,...back.why===undefined?{}:{why:back.why},detail:detail('accepted'),
          next:[`haul('${id}') again from a base that can reach ${contract.origin_base_id}`]};
      }
      // The withdraw re-reads the hold after a lost reply and is never re-sent; the hold below is the evidence.
      const took=yield* withdrawEffect([{item_id:stored(packageId),quantity:1}]);
      if(!aboard(packageId))return {status:'failed' as const,did:`accepted ${id}; the package did not come aboard`,
        why:took.why??`${stored(packageId)} is not in the hold after the withdraw`,detail:detail('accepted'),
        next:[`storage('${contract.origin_base_id}') to see where the package is`]};
      step(`package ${stored(packageId)} aboard, hold ${acct().state.ship?.cargo_used}/${acct().state.ship?.cargo_capacity}`);
    }
    if(pilot().mood==='Tired')return yield* tired('loaded',`accepted ${id} and loaded the package at ${contract.origin_base_id}`);

    // Leg 3: the flight. `goTo` is itself idempotent, so standing at the destination sends nothing.
    const trip=yield* goToEffect(destination);
    if(trip.status!=='done')return {status:trip.status==='partial'?'partial' as const:'refused' as const,
      did:`carried ${id} as far as ${trip.now.location?.poi_id??'?'}`,...trip.why===undefined?{}:{why:trip.why},detail:detail('loaded'),
      next:[`service(), then haul('${id}') again to finish the flight to ${destination}`]};
    if(pilot().mood==='Tired')return yield* tired('loaded',`carried ${id} to ${destination}`);

    // Leg 4: the delivery, and the settlement as the server measured it.
    if(stopped())return yield* Effect.fail(new Stopped());
    const delivered=yield* Effect.result(game.command('spacemolt_shipping/deliver',{shipment_id:id}));
    if(Result.isFailure(delivered)) {
      if(delivered.failure._tag!=='ReplyLost')return yield* delivered.failure;
      // Never re-sent: it may have settled. The active list is the evidence, and what it cannot say is said as unknown.
      const seen=yield* Effect.result(readActive());
      const state=Result.isFailure(seen)?'the active list could not be re-read'
        :seen.success.some(row=>row.contract.id===id)?'the contract is still active, so it may not have settled'
          :'the contract is no longer active, so it may have settled';
      return {status:'partial' as const,did:`carried ${id} to ${destination}; the delivery's reply was lost`,
        why:`reply lost on ${delivered.failure.action}; ${state}`,detail:detail('loaded'),
        next:[`freightBoard() lists the active contracts; haul('${id}') again only if it is still listed`]};
    }
    const settled=decodeSettlement(replyBody(delivered.success));
    if(Option.isNone(settled))step('spacemolt_shipping/deliver: the settlement did not read; counted as 0 cr');
    // A settlement that did not read is not passed on as one.
    const settlement=Option.isSome(settled)?asSettlement(replyBody(delivered.success)):undefined;
    const payout=Option.isSome(settled)?settled.value.carrier_payout??0:0;
    // The delivery has landed: a profile that cannot be re-read now is said, not a failed haul.
    const read=yield* Effect.result(readProfile());
    if(Result.isFailure(read))step(`the carrier record was not re-read after the delivery (${read.failure._tag})`);
    const after=Result.isSuccess(read)?read.success.profile:undefined;
    return {status:'done' as const,
      did:`delivered ${id} to ${destination} for ${payout} cr${Option.isSome(settled)&&settled.value.late?' (late)':''}`
        +(after?`; ${after.successful_deliveries} deliveries, tier ${after.tier}`:''),
      detail:detail('delivered',after,settlement),
      next:[`freightBoard() at ${destination}: the return leg is a trip you are making anyway`]};
  })));
