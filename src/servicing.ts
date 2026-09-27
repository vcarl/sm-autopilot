import type {GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {resolveServiceSpend,type Mood} from './mood-policy.ts';
import {FUEL_CELL,cellReserve} from './mining-inventory.ts';
import {knownBooks,rememberBook} from './play/market.ts';
import {quoteNext} from './run-record.ts';

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
  /** A standing permission (D11), independent of the mood. */
  creditReserve?:number;
  /** The runtime whose market memory the fuel-cell price is checked against and written to. */
  runtime?:string;
  /** False skips the fuel-cell top-up: a freighter's hold is its circuit's to plan. */
  cells?:boolean;
}
/** The fuel-cell top-up that follows a fill: cells aboard against the reserve, what was bought
 * for what, and `skipped` saying why nothing was when the reserve was due. */
export interface CellTopUp {held:number;target:number;bought:number;spent:number;skipped?:string}
export interface ServiceOutcome {satisfied:true;issued:string[];spent:number;fuel:number;hull:number;cells?:CellTopUp;
  /** Present when the wallet (or the margin) covered only part of the bill: what was not bought, and why. */
  short?:string[]}

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
 * targets. The margin meters the repair only: fuel is resupply, and a mood never strands a ship,
 * so a refuel is bounded by the wallet and `creditReserve` alone. A serviced dock restores the full tank and full hull; the mood's retreat
 * fraction is the away-from-dock line, not a service target. The post-state is read
 * authoritatively and decides.
 *
 * Where the bill does not fit whole, it buys what fits: the refuel first (resupply), then the
 * repair if what is left above the reserve still covers it. What was not bought comes back in
 * `short`; only a counter where nothing fits throws `ServiceBlocked`.
 *
 * A docked counter bills on credits and reports the charge afterwards, so a posted price is an
 * estimate and never a precondition: `fuel_price_all_in` and `repair_price_per_hull` are
 * owner-set on player stations ("Owner-set per-hull-point repair price (player station)",
 * `@spacemolt/lib` types.gen.d.ts), so an ordinary NPC counter posts nothing for the hull and
 * repairs to full anyway (proved live 2026-09-24: 59 → 80 hull for 105 credits at
 * sirius_observatory_station, whose `get_base` carries no `repair_price_per_hull`). Requiring
 * that field is what wedged a pilot in Tired for six hours.
 *
 * `creditReserve` is the standing bound and is never widened. It cannot be quoted exactly
 * before an unpriced service, so it is enforced twice: the posted estimate must leave it intact
 * beforehand, and the canonical charge is measured against it after each call — a breach stops
 * anything further being bought and names the reserve.
 */
export async function serviceShip(account:ReadinessAccount,command:ReadinessCommand,options:ServiceOptions):Promise<ServiceOutcome> {
  const done=await fill(account,command,options);
  return options.cells===false?done:{...done,cells:await topUpCells(account,command,options)};
}

/** A live cell price over this multiple of the remembered median is not paid. */
export const CELL_PRICE_BOUND=1.5;
const median=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;
  return sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2;
};

/** Fuel cells are resupply, bought with the fill: up to `CELL_TARGET` of the hold once they fall
 * under `CELL_FLOOR`. Bounded as the refuel is — by `creditReserve` alone, never the mood's
 * margin, so Tired's "service only" covers them. The live ask here is checked against the asks
 * this runtime remembers (`markets.json`): over `CELL_PRICE_BOUND`× their median it is skipped,
 * and with none remembered it is paid and remembered. Never throws: a counter without cells is
 * still a serviced ship, and `skipped` says why nothing was bought. */
async function topUpCells(account:ReadinessAccount,command:ReadinessCommand,options:ServiceOptions):Promise<CellTopUp> {
  const reserve=cellReserve(account.state);
  const out:CellTopUp={held:reserve.held,target:reserve.target,bought:0,spent:0};
  if(!reserve.due)return out;
  const skip=(why:string)=>({...out,skipped:`fuel cells: ${why}`});
  try {
    const ship=account.state.ship!,room=Math.floor((ship.cargo_capacity-ship.cargo_used)/reserve.size);
    const want=Math.min(reserve.target-reserve.held,room);
    if(want<=0)return skip('no room in the hold');
    const market=details(await command('spacemolt_market/view_market',{}));
    const items=Array.isArray(market.items)?market.items:[];
    const ask=items.find((row:{item_id:string})=>row.item_id===FUEL_CELL)?.best_sell;
    const seen=knownBooks(options.runtime??'').flatMap(book=>book.items)
      .filter(row=>row.item_id===FUEL_CELL&&row.best_sell>0).map(row=>row.best_sell);
    const base=account.state.location?.docked_at??'';
    rememberBook(options.runtime??'',base,account.state.location?.system_id,items,Number(market.current_tick??0));
    if(!(ask>0))return skip(`${base} sells none`);
    if(seen.length&&ask>CELL_PRICE_BOUND*median(seen))
      return skip(`${ask} cr is over ${CELL_PRICE_BOUND}x the remembered median ${median(seen)}`);
    const quote=details(await command('spacemolt_market/estimate_purchase',{item_id:FUEL_CELL,quantity:want}));
    const credits=account.state.player!.credits,cost=Number(quote.total_cost),floor=options.creditReserve??0;
    const n=Math.min(want,Number(quote.available??want));
    if(!(n>0))return skip(`${base} has none available`);
    if(!Number.isFinite(cost)||credits-cost<floor)return skip(`${n} cost ${cost}; credits ${credits} would fall under the reserve ${floor}`);
    quoteNext('spacemolt/buy',FUEL_CELL,{ask,estimate_total:cost,estimate_available:quote.available??null});
    await command('spacemolt/buy',{id:FUEL_CELL,quantity:n});
    await account.refresh();
    const after=cellReserve(account.state);
    return {...out,held:after.held,bought:after.held-reserve.held,spent:credits-account.state.player!.credits};
  } catch(error) {return skip((error as Error).message);}
}

async function fill(account:ReadinessAccount,command:ReadinessCommand,options:ServiceOptions):Promise<ServiceOutcome> {
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
  const opening=account.state.player!.credits;
  let budget=opening-reserve;
  // In order, fuel first: each service is bought if what is left above the reserve covers it.
  const admitted=services.filter(service=>{
    const {estimate}=service,name=service.action.split('/')[1];
    if(service.action==='spacemolt/repair'&&(estimate??0)>margin) {
      blockers.push(`quoted ${estimate} credits of repair exceeds the ${options.mood} service spend margin ${margin}`);
      return false;
    }
    // An unpriced service needs room above the reserve to spend at all; a priced one may fit exactly.
    if(estimate===undefined?budget<=0:budget<estimate) {
      blockers.push(estimate===undefined
        ?`credits ${opening} leave nothing above the reserve ${reserve}, and this counter posts no ${name} price to quote against`
        :`credits ${opening} less reserve ${reserve} cannot cover the quoted ${estimate} credits of ${name}`);
      return false;
    }
    budget-=estimate??0;
    return true;
  });
  if(!admitted.length)throw new ServiceBlocked([...blockers,...gaps()]);

  const issued:string[]=[];
  let spent=0;
  for(const service of admitted) {
    verify();
    quoteNext(service.action,undefined,{posted_unit:service.action==='spacemolt/refuel'?unitFuel??null:perHull??null,
      need:service.need,estimate:service.estimate??null});
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
    if(service.action==='spacemolt/repair'&&cost>margin)
      throw new ServiceBlocked([`${service.action} charged ${cost}, over the ${options.mood} service spend margin ${margin}`,...gaps()]);
    if(!service.reached())throw new ServiceBlocked([`${service.action} did not reach the serviced-dock target`,...gaps()]);
  }
  await account.refresh();
  verify();
  const remaining=gaps();
  if(blockers.length)return {...satisfied(issued,spent),short:[...blockers,...remaining]};
  if(remaining.length)throw new ServiceBlocked(['servicing did not hold the serviced-dock targets',...remaining]);
  return satisfied(issued,spent);
}
