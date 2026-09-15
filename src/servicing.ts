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
  let owed=due();
  if(!owed.fuel&&!owed.hull)return satisfied([],0);
  const unitFuel=base.fuel_price_all_in,perHull=base.base?.repair_price_per_hull;
  const blockers:string[]=[];
  // The pinned get_base contract posts no default ship-repair price. Never guess one.
  if(owed.fuel&&!finite(unitFuel))blockers.push('no all-in fuel quote at this station');
  if(owed.hull&&!(finite(perHull)&&perHull>0))blockers.push('no all-in repair quote at this station');
  const services=[
    {action:'spacemolt/refuel',need:owed.fuel,quote:owed.fuel*(unitFuel as number),
      reached:()=>ship().fuel>=ship().max_fuel},
    {action:'spacemolt/repair',need:owed.hull,quote:owed.hull*(perHull as number),
      reached:()=>ship().hull>=ship().max_hull},
  ].filter(service=>service.need>0);
  if(!blockers.length) {
    const quoted=services.reduce((sum,service)=>sum+service.quote,0),credits=account.state.player!.credits;
    if(quoted>margin)blockers.push(`quoted ${quoted} credits exceeds the ${options.mood} service spend margin ${margin}`);
    if(credits-quoted<reserve)blockers.push(`credits ${credits} less reserve ${reserve} cannot cover the quoted ${quoted} credits`);
  }
  if(blockers.length)throw new ServiceBlocked([...blockers,...gaps()]);

  const issued:string[]=[];
  let spent=0;
  for(const service of services) {
    verify();
    const reply=details(await command(service.action,{}));
    issued.push(service.action);
    await account.refresh();
    verify();
    // Station services have no atomic server-side price cap: the quote is a preflight
    // estimate and the canonical charge is checked before anything else is bought.
    const cost=reply.cost;
    if(!finite(cost))throw new ServiceBlocked([`unpriced accepted ${service.action}: an authoritative cost is required before further spending`,...gaps()]);
    if(cost>service.quote)throw new ServiceBlocked([`${service.action} charged ${cost} against a ${service.quote} credit quote`,...gaps()]);
    spent+=cost;
    if(!service.reached())throw new ServiceBlocked([`${service.action} did not reach the serviced-dock target`,...gaps()]);
  }
  await account.refresh();
  verify();
  const remaining=gaps();
  if(remaining.length)throw new ServiceBlocked(['servicing did not hold the serviced-dock targets',...remaining]);
  return satisfied(issued,spent);
}
