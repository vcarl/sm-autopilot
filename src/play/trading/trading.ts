/** Buy low here, sell high there. Trading xp scales with credit volume, so this is also the
 * fastest skill to raise once you have capital. Markets move between look and act.
 *
 * The one thing the game will not tell you: what another station pays. `view_market` and
 * `analyze_market` both answer "here", `view_orders` answers "your own orders", and the only
 * cross-station price feed in the lib is a faction's trade ledger
 * (`spacemolt_intel/query_trade_intel`), which needs a faction with a trade-intel facility
 * and answers with other pilots' submitted observations, not live books. So `spreads()`
 * reads the ledger when there is one and otherwise remembers: every `book()` read is written
 * to this runtime's market memory, and the second visit knows what the first one saw.
 */
import type {EstimatePurchaseResponse,FactionQueryTradeIntelResponse,FindRouteResponse,MarketListingItem,OrderLevel,SellResponse} from '@spacemolt/lib';
import {miningInventory} from '../../mining-inventory.ts';
import {walkBook} from '../../order-book.ts';
import {details} from '../../response-details.ts';
import {book,buy,knownBooks,marketTick,sell,ticksOld} from '../market.ts';
import {acct,admit,checkStop,command,job,step} from '../runtime.ts';
import {withdraw} from '../storage.ts';
import {goTo,route} from '../travel.ts';
import type {Outcome} from '../types.ts';

/** One item and the best buyer known for it, with the trip to that buyer priced. */
export interface Spread {
  item_id:string;
  /** Hold plus this base's store: what a sale there would actually be worth. */
  held:number;
  /** The base that pays `best_buy`. `here` when it is this counter. */
  base_id:string;
  best_buy:number;best_buy_qty:number;
  /** How the price was learned: a live local book, a faction ledger entry another pilot
   * filed, or a book this pilot read on an earlier visit. */
  source:'here'|'faction ledger'|'remembered';
  /** How stale it is: `live`, or an age in ticks against the tick this call read. An entry
   * written before books carried a tick reads as `LEGACY_AGE` ticks old. */
  seen:string;
  /** The route quote to that base: fuel units and jumps. Zero for `here`. */
  fuel:number;jumps:number;
  /** `best_buy × min(best_buy_qty, held)` less the fuel bill at this base's all-in price. */
  net:number;
}

/** What each item in the hold is worth at the best buyer this pilot knows of, anywhere, and
 * what the trip there costs. Default items: everything in the hold and in this base's store.
 * Reads only.
 *
 * Three sources, best price per item wins: this base's live book; the faction trade ledger
 * (`query_trade_intel`) when the pilot has a faction that runs one; and the books this pilot
 * has read at other bases, remembered by `book()` in the runtime dir. Only the last is
 * guaranteed, so `did` always says which sources answered. A price that is not live is a
 * memory, and the far book may have moved — `tradeRun` re-reads before it sells.
 *
 * Refused when not docked: without a local book there is nothing to compare against. */
export function spreads(items?:string[]):Promise<Outcome<{spreads:Spread[];sources:string[]}>> {
  return job<{spreads:Spread[];sources:string[]}>('spreads',(items??[]).join(' '),async()=>{
    const none={spreads:[] as Spread[],sources:[] as string[]};
    const here=acct().state.location?.docked_at;
    if(!here)return {status:'refused',did:'read no spreads',why:'not docked; a market is a station counter',detail:none,
      next:['goTo a base, then spreads()']};

    // What a sale is worth is what you can put on the counter: hold plus the store here.
    const stock:Record<string,number>={...miningInventory(acct().state)};
    for(const row of await storeRows())stock[row.item_id]=(stock[row.item_id]??0)+row.quantity;
    const listed=await book();
    // The tick that same reply came back on: every age below is measured against it.
    const now=marketTick();
    const wanted=items?.length?items:[...new Set([...Object.keys(stock),...listed.keys()].filter(id=>stock[id]))];
    if(!wanted.length)return {status:'done',did:`nothing aboard or stored at ${here} to price`,detail:{spreads:[],sources:['here']},
      // `{poi}` was shorthand for an undefined identifier — it does not compile — and named no
      // POI and no base; `buy()` was missing both of its required arguments. `spreads` only
      // reaches this line docked, so the base the take settles at is in hand.
      next:[`gatherUntil({poi:'<belt poi id>',base:'${here}'}) or buy('<item_id>', <quantity>) something first`]};

    const sources=['here'];
    // Best known buyer per item, seeded from the live local book.
    const best=new Map<string,Spread>();
    const offer=(row:Omit<Spread,'held'|'fuel'|'jumps'|'net'>)=>{
      if(!(row.best_buy>0))return;
      const held=stock[row.item_id]??0;
      const standing=best.get(row.item_id);
      // Per unit, because the trip is priced later: the deepest book still has to be flown to.
      if(standing&&standing.best_buy>=row.best_buy)return;
      best.set(row.item_id,{...row,held,fuel:0,jumps:0,net:0});
    };
    for(const id of wanted) {
      const row=listed.get(id);
      if(row)offer({item_id:id,base_id:here,best_buy:row.best_buy,best_buy_qty:row.best_buy_qty,source:'here',seen:'live'});
    }
    const far=await farBooks(wanted,here,now);
    sources.push(...(['faction ledger','remembered'] as const).filter(source=>far.some(known=>known.source===source)));
    for(const known of far)
      for(const row of known.items)
        if(wanted.includes(row.item_id))
          offer({item_id:row.item_id,base_id:known.base_id,best_buy:row.best_buy,best_buy_qty:row.best_buy_qty,
            source:known.source,seen:`${known.age} ticks old`});

    // One find_route per far base, not per item: the trip is the same for everything sold there.
    const fuelPrice=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);
    const trip=new Map<string,{fuel:number;jumps:number}>([[here,{fuel:0,jumps:0}]]);
    for(const base of new Set([...best.values()].map(row=>row.base_id))) {
      checkStop();
      if(trip.has(base))continue;
      try {const quote=await route(base);trip.set(base,{fuel:Number(quote.estimated_fuel??0),jumps:Number(quote.total_jumps??0)});}
      catch {trip.set(base,{fuel:Infinity,jumps:Infinity});}
    }
    const rows=[...best.values()].map(row=>{
      const {fuel,jumps}=trip.get(row.base_id)!;
      const gross=row.best_buy*Math.min(row.best_buy_qty,row.held);
      return {...row,fuel,jumps,net:Math.round(gross-(Number.isFinite(fuel)?fuel*fuelPrice:0))};
    }).filter(row=>Number.isFinite(row.fuel)).sort((a,b)=>b.net-a.net);

    const away=rows.filter(row=>row.base_id!==here);
    const unsellable=wanted.filter(id=>!best.has(id));
    return {status:'done',
      did:`priced ${rows.length} of ${wanted.length} held item${wanted.length===1?'':'s'} against ${sources.join(' + ')}`
        +(away.length?`; the best buyer for ${away.length} of them is not ${here}`:'')
        +(unsellable.length?`; no buyer known anywhere for ${unsellable.slice(0,5).join(', ')}`:''),
      detail:{spreads:rows,sources},
      next:[...rows.slice(0,2).map(row=>row.base_id===here
        ?`sell([{item_id:'${row.item_id}'}]) here — ${row.best_buy} × ${Math.min(row.best_buy_qty,row.held)} ≈ ${row.net} cr net`
        :`goTo('${row.base_id}') then sell([{item_id:'${row.item_id}'}]) — ${row.best_buy} each (${row.source}, ${row.seen}), ${row.fuel} fuel, ${row.net} cr net`),
      ...unsellable.length?['no price is known for the rest; goTo another base and prices() there to learn one']:[]].slice(0,3)};
  });
}

/** This base's store, item rows only. Absent storage is an empty store, not a failure. */
async function storeRows():Promise<{item_id:string;quantity:number}[]> {
  try {
    const reply=details(await command('spacemolt_storage/view',{})) as {items?:{item_id:string;quantity:number}[]};
    return (reply.items??[]).map(row=>({item_id:row.item_id,quantity:row.quantity}));
  } catch {return [];}
}

/** The faction trade ledger, per item, when the pilot has one. Every failure — no faction, no
 * trade-intel facility, no such command — is the same answer: no cross-station feed. */
async function ledger(items:string[]):Promise<FactionQueryTradeIntelResponse['entries']> {
  const seen=new Map<string,FactionQueryTradeIntelResponse['entries'][number]>();
  for(const item_id of items.slice(0,10)) {
    checkStop();
    try {
      const reply=details(await command('spacemolt_intel/query_trade_intel',{item_id})) as FactionQueryTradeIntelResponse;
      for(const entry of reply.entries??[])seen.set(`${entry.base_id}:${entry.submitted_at_tick}`,entry);
    } catch {return [...seen.values()];}
  }
  return [...seen.values()];
}

/** A book row as far as a source can say: a ledger entry has the top of book and volumes, no levels. */
type Listing=Pick<MarketListingItem,'item_id'|'best_buy'|'best_buy_qty'|'best_sell'|'best_sell_qty'>
  &Partial<Pick<MarketListingItem,'buy_orders'|'sell_orders'>>;
/** A book at another base, with its age in ticks against `now`. */
interface FarBook {base_id:string;source:'faction ledger'|'remembered';age:number;items:Listing[]}

/** Every far book this pilot may know: the faction ledger's entries for `items`, then the books
 * remembered at other bases. What `spreads()` and `routes()` both read. */
async function farBooks(items:string[],here:string,now:number):Promise<FarBook[]> {
  const filed=(await ledger(items)).map(entry=>({base_id:entry.base_id,source:'faction ledger' as const,
    age:ticksOld(entry.submitted_at_tick,now),
    items:(entry.items??[]).map(item=>({item_id:item.item_id,best_buy:item.best_buy,best_buy_qty:item.buy_volume,
      best_sell:item.best_sell,best_sell_qty:item.sell_volume}))}));
  const remembered=knownBooks().filter(known=>known.base_id!==here).map(known=>({base_id:known.base_id,
    source:'remembered' as const,age:ticksOld(known.tick,now),items:known.items}));
  return [...filed,...remembered];
}

export interface Traded {
  item_id:string;
  /** The buy preview; empty when nothing was bought because the goods were already aboard. */
  estimate:EstimatePurchaseResponse;
  bought:number;
  /** Carried rather than bought: what was aboard, plus what `from:'store'` withdrew. */
  carried:number;
  sold:SellResponse[];
  /** Realised: sales minus purchase minus what the flight took out of the wallet. */
  net:number;
  leg:'bought'|'flown'|'sold';
}

/** One round toward "`item` sold at `sellAt`", composed from the functions that already do the
 * work. Goods already aboard are delivered instead of buying more; `from:'store'` first
 * withdraws what the hold fits of `item` from the store here. Only when none is aboard (and
 * `from` is not `'store'`) does it `buy` `quantity` here. Then `goTo(sellAt)` and `sell` it
 * there. Each leg keeps its own rules — `buy` refuses under `credit_reserve`, `goTo` refuses a
 * POI while Tired, `sell` re-reads the far book and leaves a row with no buyer aboard — so this
 * adds only the sequence and the realised net. Quantity defaults to what the hold fits.
 *
 * `partial` at `leg:'bought'` when the flight did not finish and at `leg:'flown'` when the
 * far book would not take the goods: either way they are aboard, and `next` says so. Trains
 * trading and navigation. */
export function tradeRun(opts:{item:string;sellAt:string;quantity?:number;from?:'hold'|'store'}):Promise<Outcome<Traded>> {
  return job<Traded>('tradeRun',`${opts.quantity??'a hold of'} ${opts.item} → ${opts.sellAt}${opts.from==='store'?' from store':''}`,async()=>{
    const none:Traded={item_id:opts.item,estimate:{} as EstimatePurchaseResponse,bought:0,carried:0,sold:[],net:0,leg:'bought'};
    const blocked=admit('tradeRun');
    if(blocked)return {status:'refused',did:`ran no trade in ${opts.item}`,why:blocked,detail:none};
    const aboard=()=>miningInventory(acct().state)[opts.item]??0;
    if(opts.from==='store') {
      const took=await withdraw([opts.quantity===undefined?{item_id:opts.item}:{item_id:opts.item,quantity:opts.quantity}]);
      if(!aboard())return {status:took.status==='refused'?'refused':'done',did:`carried no ${opts.item}: none aboard and ${took.did}`,
        ...took.why?{why:took.why}:{},detail:none};
    }
    let estimate=none.estimate,spent=0,bought=0;
    const carried=aboard();
    if(carried)step(`carrying ${carried} ${opts.item} already aboard`);
    else {
      const ship=acct().state.ship;
      const quantity=opts.quantity??Math.max(0,(ship?.cargo_capacity??0)-(ship?.cargo_used??0));
      if(!(quantity>0))return {status:'refused',did:`ran no trade in ${opts.item}`,why:`no quantity: the hold has ${quantity} free`,detail:none};
      const got=await buy(opts.item,quantity);
      estimate=got.detail?.estimate??none.estimate;
      spent=Number(got.detail?.bought?.total_cost??0);
      bought=Number(got.detail?.bought?.quantity??0);
      if(!bought)return {status:got.status==='refused'?'refused':'failed',did:`bought no ${opts.item}`,why:got.why??got.did,
        detail:{...none,estimate}};
      step(`bought ${bought} ${opts.item} for ${spent} cr`);
    }
    const load=carried?`carried ${carried} ${opts.item}`:`bought ${bought} ${opts.item} for ${spent} cr`;

    const flown=await goTo(opts.sellAt);
    if(flown.status!=='done')return {status:'partial',did:`${load}; did not reach ${opts.sellAt}`,
      why:flown.why??flown.did,detail:{...none,estimate,bought,carried,net:-spent-flown.cost.credits,leg:'bought'},
      next:[`tradeRun(${JSON.stringify({item:opts.item,sellAt:opts.sellAt}).replace(/"/g,"'")}) again delivers what is aboard`,`spreads(['${opts.item}']) for another buyer`]};

    const sold=await sell([{item_id:opts.item}]);
    const earned=sold.detail?.total??0;
    const net=Math.round(earned-spent-flown.cost.credits);
    const detail:Traded={item_id:opts.item,estimate,bought,carried,sold:sold.detail?.fills??[],net,
      leg:sold.status==='done'?'sold':'flown'};
    if(detail.leg==='flown')return {status:'partial',did:`${load} to ${opts.sellAt}; it did not sell`,
      why:sold.why??sold.did,detail,next:[`spreads(['${opts.item}']) — the book here has moved`]};
    return {status:'done',
      did:`${load}, flew to ${opts.sellAt}, sold for ${earned} cr — net ${net} cr after ${flown.cost.credits} cr of flight`,
      detail,next:net>0?[`tradeRun({item:'${opts.item}', sellAt:'${opts.sellAt}'}) again while the spread holds`]:[]};
  });
}

/** Ticks for a far end's trust to halve: an hour at ten seconds a tick. NPC books move rarely,
 * so an hour-old price still counts half. */
export const HALF_LIFE=360;
/** ponytail: only the top 5 candidates (by trust-weighted net before fuel) are priced with
 * `find_route`, one call per distinct base, so at most 10. A route that would only win once
 * fuel is counted, ranked sixth before it, is never seen. Raise it if the rate limit allows. */
const PRICED=5;

/** One buy-there-sell-there opportunity, sized against both books and the hold. */
export interface Route {
  item_id:string;
  /** Where it is bought and where it is sold. Either may be this base. */
  buyAt:string;sellAt:string;
  /** Where each end's price came from, as `Spread.source`. */
  buySource:Spread['source'];sellSource:Spread['source'];
  /** Age of each end in ticks: 0 for this base's live book. */
  buyAge:number;sellAge:number;
  /** Units worth moving: `buyAt`'s asks and `sellAt`'s bids walked level by level up to the
   * free hold, stopped at the last unit whose bid still beats its ask plus tax. */
  quantity:number;
  /** What those units cost at `buyAt` and fetch at `sellAt`, level by level. */
  cost:number;revenue:number;
  /** Tax on the buy, from `estimate_purchase`'s `sales_tax_rate_bps`. Null when not known: only
   * this base's rate is readable, so a far `buyAt` is netted untaxed and `why` says so. */
  sales_tax:number|null;
  /** Jumps for the whole trip (see `routes()`); null when a lookup failed. */
  total_jumps:number|null;
  /** Fuel units: the sum of `total_jumps × fuel_per_jump` over the legs. Null when a lookup failed. */
  fuel:number|null;
  /** `revenue − cost − sales_tax − fuel × fuel_price_all_in` here. Fuel is left out when it
   * could not be priced. */
  net:number;
  /** `0.5 ^ ((buyAge + sellAge) / HALF_LIFE)`: 1 for two live books. */
  confidence:number;
  /** What rows are ranked by: `confidence × net / max(1, total_jumps)`. 0 for an unpriced trip. */
  score:number;
  /** The call to paste. */
  next:string;
  /** What this row could not know: a failed route lookup, an unknown tax. */
  why?:string;
}

/** One side of a row, best first: asks are `sell_orders`, bids `buy_orders`. A source that
 * carries no levels (the faction ledger) is one level at the top of book. */
function levels(row:Listing,side:'asks'|'bids'):OrderLevel[] {
  const [orders,price_each,quantity]=side==='asks'?[row.sell_orders,row.best_sell,row.best_sell_qty]
    :[row.buy_orders,row.best_buy,row.best_buy_qty];
  return orders?.length?orders:price_each>0&&quantity>0?[{price_each,quantity}]:[];
}

/** Units worth moving from `asks` to `bids`, at most `hold`: the last unit whose bid still beats
 * its ask taxed at `rate`. Both books only get worse unit by unit, so the first loser ends it. */
export function depth(asks:readonly OrderLevel[],bids:readonly OrderLevel[],hold:number,rate:number):number {
  const unit=(side:readonly OrderLevel[],n:number)=>walkBook(side,n).gross-walkBook(side,n-1).gross;
  let quantity=0;
  while(quantity<hold) {
    const n=quantity+1;
    if(walkBook(asks,n).unfilled||walkBook(bids,n).unfilled||unit(bids,n)<=unit(asks,n)*(1+rate))break;
    quantity=n;
  }
  return quantity;
}

/** Buy-at-A, sell-at-B trades over everything this pilot knows — the live book here, the faction
 * ledger, the remembered books — ranked by trust-weighted net per jump. Reads only: it computes,
 * the pilot chooses. `items` narrows it; default is every item on any known book.
 *
 * Each candidate is sized by walking A's asks and B's bids up to the free hold, so the
 * top-of-book spread is not assumed to hold for the whole load. The top 5 are priced with
 * `find_route`, which answers only from where the ship is: the trip here→A→B is quoted as
 * here→A, A→here, here→B — an upper bound, exact when A or B is here. Each row's `next` is the
 * call to paste. A failed lookup is a row with a `why` and the Outcome `partial`, never a throw.
 * Refused when not docked or the hold is full. */
export function routes(opts:{items?:string[]}={}):Promise<Outcome<{routes:Route[];sources:string[]}>> {
  return job<{routes:Route[];sources:string[]}>('routes',(opts.items??[]).join(' '),async()=>{
    const none={routes:[] as Route[],sources:[] as string[]};
    const here=acct().state.location?.docked_at;
    if(!here)return {status:'refused',did:'ranked no routes',why:'not docked; a market is a station counter',
      detail:none,next:['goTo a base, then routes()']};
    const ship=acct().state.ship;
    const hold=Math.max(0,(ship?.cargo_capacity??0)-(ship?.cargo_used??0));
    if(!hold)return {status:'refused',did:'ranked no routes',why:'the hold is full',detail:none,
      next:['spreads() for where to sell what is aboard']};

    const listed=await book();
    const now=marketTick();
    const books:{base_id:string;source:Spread['source'];age:number;items:Listing[]}[]=
      [{base_id:here,source:'here',age:0,items:[...listed.values()]},
        ...await farBooks(opts.items?.length?opts.items:[...listed.keys()],here,now)];
    const sources=[...new Set(books.map(known=>known.source))];

    // The tax rate here, once: `estimate_purchase` is the only read of it.
    let rate:number|null=null;
    const probe=[...listed.values()].find(row=>row.best_sell>0);
    if(probe)try {
      const bps=Number((details(await command('spacemolt_market/estimate_purchase',{item_id:probe.item_id,quantity:1})) as EstimatePurchaseResponse).sales_tax_rate_bps);
      if(Number.isFinite(bps))rate=bps/10_000;
    } catch {/* unknown, and each row says so */}

    // Every (item, A, B) whose bid at B beats the ask at A, sized and netted before fuel.
    const found=new Map<string,Route>();
    for(const seller of books)for(const buyer of books) {
      if(seller.base_id===buyer.base_id)continue;
      for(const row of seller.items) {
        if(opts.items?.length&&!opts.items.includes(row.item_id))continue;
        const bid=buyer.items.find(other=>other.item_id===row.item_id);
        if(!bid||!(row.best_sell>0)||!(bid.best_buy>row.best_sell))continue;
        const taxed=seller.base_id===here?rate:null;
        const asks=levels(row,'asks'),bids=levels(bid,'bids');
        const quantity=depth(asks,bids,hold,taxed??0);
        if(!quantity)continue;
        const cost=walkBook(asks,quantity).gross,revenue=walkBook(bids,quantity).gross;
        const sales_tax=taxed===null?null:Math.round(cost*taxed);
        const confidence=0.5**((seller.age+buyer.age)/HALF_LIFE);
        const net=Math.round(revenue-cost-(sales_tax??0));
        const trade=`tradeRun({item:'${row.item_id}', sellAt:'${buyer.base_id}', quantity:${quantity}})`;
        const candidate:Route={item_id:row.item_id,buyAt:seller.base_id,sellAt:buyer.base_id,
          buySource:seller.source,sellSource:buyer.source,buyAge:seller.age,sellAge:buyer.age,
          quantity,cost,revenue,sales_tax,total_jumps:null,fuel:null,net,confidence,score:confidence*net,
          next:seller.base_id===here?trade:`goTo('${seller.base_id}') then ${trade}`,
          ...sales_tax===null?{why:`sales tax at ${seller.base_id} not known; net is untaxed`}:{}};
        // A base can be known twice (ledger and memory): the more trusted reading wins.
        const key=`${row.item_id}|${seller.base_id}|${buyer.base_id}`;
        if((found.get(key)?.score??-Infinity)<candidate.score)found.set(key,candidate);
      }
    }
    const top=[...found.values()].sort((a,b)=>b.score-a.score).slice(0,PRICED);
    if(!top.length)return {status:'done',did:`no known bid beats another base's ask across ${books.length} book(s) (${sources.join(' + ')})`,
      detail:{routes:[],sources},next:['goTo another base and prices() there to learn its book']};

    // One find_route per distinct far base; a failure is kept as its message.
    const fuelPrice=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);
    const quotes=new Map<string,FindRouteResponse|string>();
    for(const base of new Set(top.flatMap(row=>[row.buyAt,row.sellAt]))) {
      checkStop();
      if(base===here)continue;
      try {quotes.set(base,await route(base));}
      catch(error) {quotes.set(base,error instanceof Error?error.message:String(error));}
    }
    const failed:string[]=[];
    for(const row of top) {
      const legs=(row.buyAt===here?[row.sellAt]:[row.buyAt,row.buyAt,row.sellAt])
        .filter(base=>base!==here).map(base=>quotes.get(base)!);
      const miss=legs.find((leg):leg is string=>typeof leg==='string');
      if(miss!==undefined) {
        failed.push(`${row.item_id} ${row.buyAt}→${row.sellAt}`);
        row.why=[`no route: ${miss}; fuel not priced`,row.why].filter(Boolean).join('; ');
        row.score=0;
        continue;
      }
      const priced=legs as FindRouteResponse[];
      row.total_jumps=priced.reduce((sum,leg)=>sum+Number(leg.total_jumps??0),0);
      row.fuel=priced.reduce((sum,leg)=>sum+Number(leg.total_jumps??0)*Number(leg.fuel_per_jump??0),0);
      row.net=Math.round(row.net-row.fuel*fuelPrice);
      row.score=row.confidence*row.net/Math.max(1,row.total_jumps);
    }
    // Priced rows by score; a row whose trip could not be priced goes last.
    const rows=top.sort((a,b)=>Number(a.total_jumps===null)-Number(b.total_jumps===null)||b.score-a.score);
    const best=rows[0]!;
    return {status:failed.length?'partial':'done',
      did:`ranked ${rows.length} route(s) over ${books.length} book(s) (${sources.join(' + ')}); best: ${best.quantity} ${best.item_id} ${best.buyAt}→${best.sellAt}, net ${best.net} cr`,
      ...failed.length?{why:`no route for ${failed.join(', ')}`}:{},
      detail:{routes:rows,sources},next:rows.slice(0,3).map(row=>row.next)};
  });
}
