import type {GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {resolveServiceSpend,type Mood} from './mood-policy.ts';

/** `decided` carried the deleted rules engine's Decision; it is typed loose here only
 * so the first-attempt consumers (industry, recovery) keep compiling unchanged.
 * ponytail: shim for a dead engine, delete with those files' rewrite. */
export interface ServiceClock {decided?:(decision:any,phase?:any)=>void;now?:()=>number;sleep?:(ms:number)=>Promise<void>}
export interface ServiceFuelQuote {
  observed_at:string;base_id:string;system_id:string;poi_id:string;ship_id:string;
  max_fuel:number;unit_price:number|null;
}
export interface ServiceOptions {
  mood:Mood;
  /** Operator-owned permission (D11), independent of the mood. */
  creditReserve?:number;
}
export interface ServiceOutcome {satisfied:true;issued:string[];spent:number;fuel:number;hull:number}

/** Carries the units still missing, so a caller can never mistake it for readiness. */
export class ServiceBlocked extends Error {
  readonly blockers:string[];
  constructor(blockers:string[]) {
    super(`service_blocked: ${blockers.join('; ')}`);
    this.blockers=[...blockers];
  }
}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const shortfall=(name:string,have:number,need:number,unit:string)=>
  `${name} have ${have}, need ${need}; shortfall ${need-have} ${unit}`;

/** Servicing is script-owned: the mood resolves the spend margin and D3 resolves the
 * targets. A serviced dock restores the full tank and full hull; the mood's retreat
 * fraction is the away-from-dock line, not a service target. A partial fill is never
 * success — the post-state is read authoritatively and decides.
 *
 * A docked counter bills on credits and reports the charge afterwards, so a posted price is an
 * estimate and never a precondition: `fuel_price_all_in` and `repair_price_per_hull` are
 * owner-set on player stations ("Owner-set per-hull-point repair price (player station)",
 * `@spacemolt/lib` types.gen.d.ts), so an ordinary NPC counter posts nothing for the hull and
 * repairs to full anyway (proved live 2026-09-24: 59 → 80 hull for 105 credits at
 * sirius_observatory_station, whose `get_base` carries no `repair_price_per_hull`). Requiring
 * that field is what wedged a pilot in Tired for six hours.
 *
 * `creditReserve` is the operator's bound and is never widened. It cannot be quoted exactly
 * before an unpriced service, so it is enforced twice: the posted estimate must leave it intact
 * beforehand, and the canonical charge is measured against it after each call — a breach stops
 * anything further being bought and names the reserve.
 */
export async function serviceShip(account:ReadinessAccount,command:ReadinessCommand,options:ServiceOptions):Promise<ServiceOutcome> {
  const margin=resolveServiceSpend(options.mood),reserve=options.creditReserve??0;
  if(!finite(reserve))throw new Error('Service credit reserve must be a finite non-negative number');
  const custody=(state:GameState)=>{
    const {ship,location,player,cargo,modules}=state??{};
    if(!ship||!location||!player||!Array.isArray(cargo)||!Array.isArray(modules))
      throw new Error('Dock with authoritative ship, wallet and custody state before servicing');
    if(!location.docked_at||location.in_transit)throw new Error('Servicing requires a verified dock');
    if(![ship.fuel,ship.max_fuel,ship.hull,ship.max_hull,player.credits].every(finite))
      throw new Error('Authoritative fuel, hull and wallet numbers required before servicing');
    return {shipId:ship.id,dock:location.docked_at,system:location.system_id,poi:location.poi_id,
      cargo:structuredClone(cargo),modules:structuredClone(modules)};
  };
  await account.refresh();
  const before=custody(account.state);
  const held=(rows:typeof before.cargo,id:string)=>rows.filter(row=>row.item_id===id).reduce((sum,row)=>sum+row.quantity,0);
  const verify=()=>{
    const now=custody(account.state);
    if(now.shipId!==before.shipId||now.dock!==before.dock||now.system!==before.system||now.poi!==before.poi)
      throw new Error('Ship or docking changed during servicing');
    if(before.cargo.some(row=>held(now.cargo,row.item_id)<held(before.cargo,row.item_id))||
      before.modules.some(row=>!now.modules.some(current=>current.module_id===row.module_id&&current.type_id===row.type_id)))
      throw new Error('Starting cargo or fitted equipment lost during servicing');
  };
  const ship=()=>account.state.ship!;
  const due=()=>{
    const {fuel,max_fuel,hull,max_hull}=ship();
    return {fuel:Math.max(0,max_fuel-fuel),hull:Math.max(0,max_hull-hull)};
  };
  const gaps=()=>{
    const {fuel,max_fuel,hull,max_hull}=ship(),out:string[]=[];
    if(fuel<max_fuel)out.push(shortfall('fuel',fuel,max_fuel,'fuel units'));
    if(hull<max_hull)out.push(shortfall('hull',hull,max_hull,'hull points'));
    return out;
  };
  const satisfied=(issued:string[],spent:number):ServiceOutcome=>
    ({satisfied:true,issued,spent,fuel:ship().fuel,hull:ship().hull});
  if(!due().fuel&&!due().hull)return satisfied([],0);

  // The price belongs to the authenticated dock; a remote directory is not a quote.
  const base=details(await command('spacemolt/get_base',{}));
  await account.refresh();
  verify();
  const owed=due();
  if(!owed.fuel&&!owed.hull)return satisfied([],0);
  const unitFuel=base.fuel_price_all_in,perHull=base.base?.repair_price_per_hull;
  // `estimate` is what a posted price says this will cost, and undefined where nothing is
  // posted. It bounds the spend before the call; the charge bounds it after.
  const services=[
    {action:'spacemolt/refuel',need:owed.fuel,estimate:finite(unitFuel)?owed.fuel*unitFuel:undefined,
      reached:()=>ship().fuel>=ship().max_fuel},
    {action:'spacemolt/repair',need:owed.hull,estimate:finite(perHull)&&perHull>0?owed.hull*perHull:undefined,
      reached:()=>ship().hull>=ship().max_hull},
  ].filter(service=>service.need>0);
  const blockers:string[]=[];
  const estimated=services.reduce((sum,service)=>sum+(service.estimate??0),0);
  const opening=account.state.player!.credits;
  if(estimated>margin)blockers.push(`quoted ${estimated} credits exceeds the ${options.mood} service spend margin ${margin}`);
  // An unpriced service needs room above the reserve to spend at all; a priced one may fit exactly.
  const spendable=opening-estimated-reserve;
  if(spendable<0||(!estimated&&!spendable))blockers.push(estimated
    ?`credits ${opening} less reserve ${reserve} cannot cover the quoted ${estimated} credits`
    :`credits ${opening} leave nothing above the reserve ${reserve}, and this counter posts no price to quote against`);
  if(blockers.length)throw new ServiceBlocked([...blockers,...gaps()]);

  const issued:string[]=[];
  let spent=0;
  for(const service of services) {
    verify();
    const reply=details(await command(service.action,{}));
    issued.push(service.action);
    await account.refresh();
    verify();
    // Station services have no atomic server-side price cap and an unposted one cannot be
    // quoted at all: the canonical charge is the only bound, checked before anything else is
    // bought. `quantity` is no help — on `repair` it counts repair kits, and a docked repair
    // service spends credits to full regardless (lib: SpacemoltRepairData.quantity).
    const cost=reply.cost;
    if(!finite(cost))throw new ServiceBlocked([`unpriced accepted ${service.action}: an authoritative cost is required before further spending`,...gaps()]);
    spent+=cost;
    if(service.estimate!==undefined&&cost>service.estimate)
      throw new ServiceBlocked([`${service.action} charged ${cost} against a ${service.estimate} credit quote`,...gaps()]);
    if(account.state.player!.credits<reserve)
      throw new ServiceBlocked([`${service.action} charged ${cost}, leaving credits ${account.state.player!.credits} under the reserve ${reserve}`,...gaps()]);
    if(spent>margin)
      throw new ServiceBlocked([`${service.action} charged ${cost}: ${spent} credits spent exceeds the ${options.mood} service spend margin ${margin}`,...gaps()]);
    if(!service.reached())throw new ServiceBlocked([`${service.action} did not reach the serviced-dock target`,...gaps()]);
  }
  await account.refresh();
  verify();
  const remaining=gaps();
  if(remaining.length)throw new ServiceBlocked(['servicing did not hold the serviced-dock targets',...remaining]);
  return satisfied(issued,spent);
}
