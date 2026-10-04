import type {GameState,MarketListingItem,OrderLevel} from '@spacemolt/lib';
import {Data,Effect,Result} from 'effect';
import {Game,attempt,field,type GameError} from './play/game.ts';
import type {ReadinessAccount} from './readiness.ts';
import {replyBody,rows} from './storage.ts';
import {resolveServiceSpend,type Mood} from './mood-policy.ts';
import {FUEL_CELL,cellReserve} from './mining-inventory.ts';
import {knownBooks,rememberBook} from './play/market.ts';
import {quoteNext} from './run-record.ts';

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
  /** False keeps this fill's prices off the pilot's next `trade` line: the quote is one per
   * bridge, and a freighter serviced in it is not the pilot (its trades carry no quote). */
  quotes?:boolean;
}
/** The fuel-cell top-up that follows a fill: cells aboard against the reserve, what was bought
 * for what, and `skipped` saying why nothing was when the reserve was due. */
export interface CellTopUp {held:number;target:number;bought:number;spent:number;skipped?:string}
export interface ServiceOutcome {satisfied:true;issued:string[];spent:number;fuel:number;hull:number;cells?:CellTopUp;
  /** Present when the wallet (or the margin) covered only part of the bill: what was not bought, and why. */
  short?:string[]}

/** Carries the units still missing, so a caller can never mistake it for readiness. `message` is
 * what the pilot is told; `gather-job.ts` and the freighter read it and check `instanceof`. */
export class ServiceBlocked extends Data.TaggedError('ServiceBlocked')<{readonly blockers:readonly string[];readonly message:string}> {}
const blocked=(blockers:readonly string[])=>new ServiceBlocked({blockers:[...blockers],message:`service_blocked: ${blockers.join('; ')}`});
/** The ship, wallet or dock was not what servicing needs, or changed under it: nothing more is spent. */
export class ServiceUnsafe extends Data.TaggedError('ServiceUnsafe')<{readonly message:string}> {}

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const shortfall=(name:string,have:number,need:number,unit:string)=>
  `${name} have ${have}, need ${need}; shortfall ${need-have} ${unit}`;
const num=(value:unknown,otherwise=0)=>typeof value==='number'?value:otherwise;
const text=(value:unknown)=>typeof value==='string'?value:'';

type Ship=NonNullable<GameState['ship']>;
/** What servicing reads off a refreshed account, proved present: the ship, the wallet, the dock and
 * what the hold and the fit held. */
const custody=(state:GameState)=>{
  const {ship,location,player,cargo,modules}=state;
  if(!ship||!location||!player||!Array.isArray(cargo)||!Array.isArray(modules))
    return Effect.fail(new ServiceUnsafe({message:'Dock with authoritative ship, wallet and custody state before servicing'}));
  if(!location.docked_at||location.in_transit)return Effect.fail(new ServiceUnsafe({message:'Servicing requires a verified dock'}));
  if(![ship.fuel,ship.max_fuel,ship.hull,ship.max_hull,player.credits].every(finite))
    return Effect.fail(new ServiceUnsafe({message:'Authoritative fuel, hull and wallet numbers required before servicing'}));
  return Effect.succeed({ship,credits:player.credits,shipId:ship.id,dock:location.docked_at,system:location.system_id,poi:location.poi_id,
    cargo:structuredClone(cargo),modules:structuredClone(modules)});
};

/** Servicing is script-owned: the mood resolves the spend margin and D3 resolves the
 * targets. The margin meters the repair only: fuel is resupply, and a mood never strands a ship,
 * so a refuel is bounded by the wallet and `creditReserve` alone. A serviced dock restores the full tank and full hull; the mood's retreat
 * fraction is the away-from-dock line, not a service target. The post-state is read
 * authoritatively and decides.
 *
 * Where the bill does not fit whole, it buys what fits: the refuel first (resupply), then the
 * repair if what is left above the reserve still covers it. What was not bought comes back in
 * `short`; only a counter where nothing fits fails with `ServiceBlocked`.
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
 *
 * A lost reply on the refuel or the repair is never re-sent: it fails with the tag, and the
 * caller's own re-read says what landed. */
export const serviceShipEffect=(account:ReadinessAccount,options:ServiceOptions):Effect.Effect<ServiceOutcome,GameError|ServiceBlocked|ServiceUnsafe,Game>=>
  Effect.gen(function*() {
    const done=yield* fill(account,options);
    return options.cells===false?done:{...done,cells:yield* topUpCellsEffect(account,options)};
  });

/** A live cell price over this multiple of the remembered median is not paid. */
export const CELL_PRICE_BOUND=1.5;
const median=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;
  return sorted.length%2?(sorted[mid]??0):((sorted[mid-1]??0)+(sorted[mid]??0))/2;
};

const level=(raw:unknown):OrderLevel[]=>{
  const price=field(raw,'price_each'),quantity=field(raw,'quantity'),mine=field(raw,'my_quantity'),source=field(raw,'source');
  return typeof price==='number'&&typeof quantity==='number'
    ?[{price_each:price,quantity,...typeof mine==='number'?{my_quantity:mine}:{},...typeof source==='string'?{source}:{}}]:[];
};
/** One `view_market` row as the book memory keeps it. The live server omits spec fields, so a row is
 * built from what it carries (a missing number is 0, a missing list empty), never decoded whole. */
export const listing=(raw:unknown):MarketListingItem[]=>{
  const id=field(raw,'item_id'),spread=field(raw,'spread');
  return typeof id!=='string'?[]:[{item_id:id,item_name:text(field(raw,'item_name')),category:text(field(raw,'category')),
    best_buy:num(field(raw,'best_buy')),best_buy_qty:num(field(raw,'best_buy_qty')),
    best_sell:num(field(raw,'best_sell')),best_sell_qty:num(field(raw,'best_sell_qty')),
    buy_price:num(field(raw,'buy_price')),buy_quantity:num(field(raw,'buy_quantity')),
    sell_price:num(field(raw,'sell_price')),sell_quantity:num(field(raw,'sell_quantity')),
    buy_orders:rows(field(raw,'buy_orders')).flatMap(level),sell_orders:rows(field(raw,'sell_orders')).flatMap(level),
    ...typeof spread==='number'?{spread}:{}}];
};

/** A refusal or lost reply in the words `skipped` and `why` carry. */
export const words=(error:GameError)=>error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`;

/** Fuel cells are resupply, bought with the fill: up to `CELL_TARGET` of the hold once they fall
 * under `CELL_FLOOR`. Bounded as the refuel is — by `creditReserve` alone, never the mood's
 * margin, so Tired's "service only" covers them. The live ask here is checked against the asks
 * this runtime remembers at other bases (`markets.json`): over `CELL_PRICE_BOUND`× their median
 * it is skipped, and with none remembered one cell is bought at it. Never fails: a counter without cells is
 * still a serviced ship, and `skipped` says why nothing was bought (the game's refusal, or the
 * lost reply, by name). A lost reply on the buy is not re-sent; the hold is re-read and what it
 * shows is what was bought. A defect is a bug and goes up. */
const topUpCellsEffect=(account:ReadinessAccount,options:ServiceOptions)=>Effect.gen(function*() {
  const game=yield* Game;
  const reserve=cellReserve(account.state);
  const out:CellTopUp={held:reserve.held,target:reserve.target,bought:0,spent:0};
  if(!reserve.due)return out;
  const skip=(reason:string)=>({...out,skipped:`fuel cells: ${reason}`});
  const flow=Effect.gen(function*() {
    const {ship,player}=account.state;
    if(!ship||!player)return skip('no ship or wallet state to buy against');
    const room=Math.floor((ship.cargo_capacity-ship.cargo_used)/reserve.size);
    if(Math.min(reserve.target-reserve.held,room)<=0)return skip('no room in the hold');
    const market=replyBody(yield* game.command('spacemolt_market/view_market',{}));
    const items=rows(field(market,'items')).flatMap(listing);
    const ask=items.find(row=>row.item_id===FUEL_CELL)?.best_sell??0;
    const base=account.state.location?.docked_at??'';
    // Live 2026-09-30 (kvothe 19:29Z): service() bought 9 cells at 3,000 each, 27,000 cr (300 each at
    // 16:57Z), checked against a median that held this base's own earlier 3,000 ask. Only other
    // bases' asks are a reference; with none, one cell is bought, not the whole target.
    const seen=knownBooks(options.runtime??'').filter(book=>book.base_id!==base).flatMap(book=>book.items)
      .filter(row=>row.item_id===FUEL_CELL&&row.best_sell>0).map(row=>row.best_sell);
    const reference=seen.length?median(seen):null;
    rememberBook(options.runtime??'',base,account.state.location?.system_id,items,Number(field(market,'current_tick')??0));
    if(!(ask>0))return skip(`${base} sells none`);
    if(reference!==null&&ask>CELL_PRICE_BOUND*reference)
      return skip(`${ask} cr is over ${CELL_PRICE_BOUND}x the median ${reference} other bases ask`);
    const want=reference===null?1:Math.min(reserve.target-reserve.held,room);
    const quote=replyBody(yield* game.command('spacemolt_market/estimate_purchase',{item_id:FUEL_CELL,quantity:want}));
    const credits=player.credits,cost=Number(field(quote,'total_cost')),floor=options.creditReserve??0;
    const n=Math.min(want,Number(field(quote,'available')??want));
    if(!(n>0))return skip(`${base} has none available`);
    if(!Number.isFinite(cost)||credits-cost<floor)return skip(`${n} cost ${cost}; credits ${credits} would fall under the reserve ${floor}`);
    if(options.quotes!==false)quoteNext('spacemolt/buy',FUEL_CELL,{ask,estimate_total:cost,estimate_available:field(quote,'available')??null,
      reference,reference_asks:seen.length,want,target:reserve.target,held:reserve.held});
    const bought=yield* Effect.result(game.command('spacemolt/buy',{id:FUEL_CELL,quantity:n}));
    // Only a lost reply keeps going: the buy may have landed, so the hold is re-read, never the buy re-sent.
    if(Result.isFailure(bought)&&bought.failure._tag!=='ReplyLost')return yield* bought.failure;
    yield* attempt('refresh',()=>account.refresh());
    const after=cellReserve(account.state);
    const result={...out,held:after.held,bought:after.held-reserve.held,spent:credits-(account.state.player?.credits??credits)};
    return Result.isFailure(bought)?{...result,skipped:`fuel cells: ${words(bought.failure)}`}:result;
  });
  const tried=yield* Effect.result(flow);
  return Result.isSuccess(tried)?tried.success:skip(words(tried.failure));
});

const fill=(account:ReadinessAccount,options:ServiceOptions)=>Effect.gen(function*() {
  const game=yield* Game;
  const refresh=attempt('refresh',()=>account.refresh());
  const margin=resolveServiceSpend(options.mood),reserve=options.creditReserve??0;
  if(!finite(reserve))return yield* new ServiceUnsafe({message:'Service credit reserve must be a finite non-negative number'});
  yield* refresh;
  const before=yield* custody(account.state);
  const held=(rowsHeld:NonNullable<GameState['cargo']>,id:string)=>rowsHeld.filter(row=>row.item_id===id).reduce((sum,row)=>sum+row.quantity,0);
  /** The state as it stands now, proved to be the same ship at the same dock with nothing lost. */
  const verify=Effect.gen(function*() {
    const now=yield* custody(account.state);
    if(now.shipId!==before.shipId||now.dock!==before.dock||now.system!==before.system||now.poi!==before.poi)
      return yield* new ServiceUnsafe({message:'Ship or docking changed during servicing'});
    if(before.cargo.some(row=>held(now.cargo,row.item_id)<held(before.cargo,row.item_id))||
      before.modules.some(row=>!now.modules.some(current=>current.module_id===row.module_id&&current.type_id===row.type_id)))
      return yield* new ServiceUnsafe({message:'Starting cargo or fitted equipment lost during servicing'});
    return now;
  });
  const due=({fuel,max_fuel,hull,max_hull}:Ship)=>({fuel:Math.max(0,max_fuel-fuel),hull:Math.max(0,max_hull-hull)});
  const gaps=({fuel,max_fuel,hull,max_hull}:Ship)=>{
    const out:string[]=[];
    if(fuel<max_fuel)out.push(shortfall('fuel',fuel,max_fuel,'fuel units'));
    if(hull<max_hull)out.push(shortfall('hull',hull,max_hull,'hull points'));
    return out;
  };
  const satisfied=(issued:string[],spent:number,ship:Ship):ServiceOutcome=>({satisfied:true,issued,spent,fuel:ship.fuel,hull:ship.hull});
  if(!due(before.ship).fuel&&!due(before.ship).hull)return satisfied([],0,before.ship);

  // The price belongs to the authenticated dock; a remote directory is not a quote.
  const base=replyBody(yield* game.command('spacemolt/get_base',{}));
  yield* refresh;
  const opened=yield* verify;
  const owed=due(opened.ship);
  if(!owed.fuel&&!owed.hull)return satisfied([],0,opened.ship);
  const unitFuel=field(base,'fuel_price_all_in'),perHull=field(field(base,'base'),'repair_price_per_hull');
  // `estimate` is what a posted price says this will cost, and undefined where nothing is
  // posted. It bounds the spend before the call; the charge bounds it after.
  const services=[
    {action:'spacemolt/refuel',need:owed.fuel,estimate:finite(unitFuel)?owed.fuel*unitFuel:undefined,
      reached:(ship:Ship)=>ship.fuel>=ship.max_fuel},
    {action:'spacemolt/repair',need:owed.hull,estimate:finite(perHull)&&perHull>0?owed.hull*perHull:undefined,
      reached:(ship:Ship)=>ship.hull>=ship.max_hull},
  ].filter(service=>service.need>0);
  const blockers:string[]=[];
  const opening=opened.credits;
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
  if(!admitted.length)return yield* blocked([...blockers,...gaps(opened.ship)]);

  const issued:string[]=[];
  let spent=0;
  for(const service of admitted) {
    yield* verify;
    if(options.quotes!==false)quoteNext(service.action,undefined,{posted_unit:service.action==='spacemolt/refuel'?unitFuel??null:perHull??null,
      need:service.need,estimate:service.estimate??null});
    const reply=replyBody(yield* game.command(service.action,{}));
    issued.push(service.action);
    yield* refresh;
    const now=yield* verify;
    // Station services have no atomic server-side price cap and an unposted one cannot be
    // quoted at all: the canonical charge is the only bound, checked before anything else is
    // bought. `quantity` is no help — on `repair` it counts repair kits, and a docked repair
    // service spends credits to full regardless (lib: SpacemoltRepairData.quantity).
    const cost=field(reply,'cost');
    if(!finite(cost))return yield* blocked([`unpriced accepted ${service.action}: an authoritative cost is required before further spending`,...gaps(now.ship)]);
    spent+=cost;
    if(service.estimate!==undefined&&cost>service.estimate)
      return yield* blocked([`${service.action} charged ${cost} against a ${service.estimate} credit quote`,...gaps(now.ship)]);
    if(now.credits<reserve)
      return yield* blocked([`${service.action} charged ${cost}, leaving credits ${now.credits} under the reserve ${reserve}`,...gaps(now.ship)]);
    if(service.action==='spacemolt/repair'&&cost>margin)
      return yield* blocked([`${service.action} charged ${cost}, over the ${options.mood} service spend margin ${margin}`,...gaps(now.ship)]);
    if(!service.reached(now.ship))return yield* blocked([`${service.action} did not reach the serviced-dock target`,...gaps(now.ship)]);
  }
  yield* refresh;
  const closed=yield* verify;
  const remaining=gaps(closed.ship);
  if(blockers.length)return {...satisfied(issued,spent,closed.ship),short:[...blockers,...remaining]};
  if(remaining.length)return yield* blocked(['servicing did not hold the serviced-dock targets',...remaining]);
  return satisfied(issued,spent,closed.ship);
});
