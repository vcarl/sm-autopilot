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
import type {EstimatePurchaseResponse,FactionQueryTradeIntelResponse,MapSystemInfo,MarketListingItem,OrderLevel,SellResponse} from '@spacemolt/lib';
import {miningInventory} from '../../mining-inventory.ts';
import {walkBook} from '../../order-book.ts';
import {details} from '../../response-details.ts';
import {book,buy,knownBooks,marketTick,sell,ticksOld} from '../market.ts';
import {acct,admit,checkStop,command,job,step} from '../runtime.ts';
import {withdraw} from '../storage.ts';
import {goTo,route} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';

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
    const far=await farBooks(here,now);
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
        :`${runCall([{at:row.base_id}])} — ${row.best_buy} each (${row.source}, ${row.seen}), ${row.fuel} fuel, ${row.net} cr net`),
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

/** ponytail: the ledger is read whole, a page of `LEDGER_PAGE` stations at a time, at most
 * `LEDGER_PAGES` pages (the galaxy has 79 stations) — a bounded call count per read, re-read at
 * every `farBooks`. Cache it per tick if the calls ever show against the rate limit. */
const LEDGER_PAGE=20,LEDGER_PAGES=4;
/** The faction trade ledger, whole books by station, when the pilot has one. Never filtered by
 * `item_id`: live, that filter answers nothing even for a filed item. Every failure — no faction,
 * no trade-intel facility, no such command — is the same answer: no more of the cross-station feed. */
async function ledger():Promise<FactionQueryTradeIntelResponse['entries']> {
  const entries:FactionQueryTradeIntelResponse['entries']=[];
  for(let page=0;page<LEDGER_PAGES;page++) {
    checkStop();
    try {
      const reply=details(await command('spacemolt_intel/query_trade_intel',{limit:LEDGER_PAGE,offset:page*LEDGER_PAGE})) as FactionQueryTradeIntelResponse;
      entries.push(...reply.entries??[]);
      if(!reply.entries?.length||entries.length>=Number(reply.total??0))break;
    } catch {break;}
  }
  return entries;
}

/** A book row as far as a source can say: a ledger entry has the top of book and volumes, no levels. */
type Listing=Pick<MarketListingItem,'item_id'|'best_buy'|'best_buy_qty'|'best_sell'|'best_sell_qty'>
  &Partial<Pick<MarketListingItem,'buy_orders'|'sell_orders'>>;
/** A book at another base, with its age in ticks against `now`, and its system when the memory kept it. */
interface FarBook {base_id:string;source:'faction ledger'|'remembered';age:number;system_id?:string;items:Listing[]}

/** Every far book this pilot may know: the faction ledger's whole books, then the books
 * remembered at other bases. What `spreads()`, `routes()` and `tradeRun` all read. A ledger entry
 * comes back with an empty `system_id`; the memory's system for that base stands in, else none. */
async function farBooks(here:string,now:number):Promise<FarBook[]> {
  const memory=knownBooks();
  const systemOf=new Map(memory.filter(known=>known.system_id).map(known=>[known.base_id,known.system_id!]));
  const filed=(await ledger()).filter(entry=>entry.base_id!==here).map(entry=>{
    const system_id=entry.system_id||systemOf.get(entry.base_id);
    return {base_id:entry.base_id,source:'faction ledger' as const,age:ticksOld(entry.submitted_at_tick,now),
      ...system_id?{system_id}:{},
      items:(entry.items??[]).map(item=>({item_id:item.item_id,best_buy:item.best_buy,best_buy_qty:item.buy_volume,
        best_sell:item.best_sell,best_sell_qty:item.sell_volume}))};
  });
  const remembered=memory.filter(known=>known.base_id!==here).map(known=>({base_id:known.base_id,
    source:'remembered' as const,age:ticksOld(known.tick,now),...known.system_id?{system_id:known.system_id}:{},items:known.items}));
  return [...filed,...remembered];
}

/** Ticks for a far end's trust to halve: an hour at ten seconds a tick. NPC books move rarely,
 * so an hour-old price still counts half. */
export const HALF_LIFE=360;
const trust=(age:number)=>0.5**(age/HALF_LIFE);

/** A stop's book as the planner reads it. No `items`: nothing is known of that base's book. */
export interface Book {base_id:string;source:Spread['source'];age:number;items?:Map<string,Listing>}
/** Units sold at one stop and what they fetch there, level by level. */
export interface Sale {item_id:string;quantity:number;revenue:number}
/** What the plan does at one stop. */
export interface Leg {
  at:string;
  /** Where this stop's book came from and its age in ticks, as `Spread.source`; `here`/0 when live. */
  source:Spread['source'];age:number;
  /** Held goods sold here: each whose trusted bid here is at least its best trusted bid later on
   * the route, and at least half the best trusted bid at any base known off it. */
  sold:Sale[];
  /** The item taken here, units, and what they cost at the asks (0 from the store). */
  buy?:string;bought:number;cost:number;
  /** Tax on that buy; null when no rate is known. Only the docked base's rate is readable, so
   * `routes()` prices a far stop's buy at it, and says so in the row's `why`. */
  sales_tax:number|null;
}
/** A held row left aboard, and `why`: the better bid known off the route, when there is one. */
export type Unsold=Row&{why?:string};
/** A whole route from the hold you have. `net` = `revenue − cost − sales_tax` (known taxes only). */
export interface Plan {legs:Leg[];
  /** What is still aboard after the last stop: no stop on the route bids for it as well as a base
   * off the route does (named in `why`), or nobody known bids at all. Not in the net. */
  unsold:Unsold[];
  revenue:number;cost:number;sales_tax:number|null;net:number}
/** One stop handed to `plan`: its book, what to take there, and the tax on taking it. */
export interface PlanStop {book:Book;buy?:string;
  /** A cap on `buy`. */
  quantity?:number;
  /** Where `buy` comes from when not the market's asks: the store, as one level at price 0. */
  asks?:OrderLevel[];
  /** Sales tax on `buy`; null when not known, which sizes it untaxed. */
  rate:number|null}

type Sides=Map<string,{bids:OrderLevel[];asks:OrderLevel[]}>;
/** One side of a row, best first: asks are `sell_orders`, bids `buy_orders`. A source that
 * carries no levels (the faction ledger) is one level at the top of book. */
function levels(row:Listing,side:'asks'|'bids'):OrderLevel[] {
  const [orders,price_each,quantity]=side==='asks'?[row.sell_orders,row.best_sell,row.best_sell_qty]
    :[row.buy_orders,row.best_buy,row.best_buy_qty];
  return orders?.length?orders:price_each>0&&quantity>0?[{price_each,quantity}]:[];
}
/** The price of the `n`th unit down a side (from 1); 0 past its end. */
function unit(side:readonly OrderLevel[],n:number):number {
  for(const level of side){if(n<=level.quantity)return level.price_each;n-=level.quantity;}
  return 0;
}
/** A side with its first `n` units gone. */
function drop(side:readonly OrderLevel[],n:number):OrderLevel[] {
  return side.flatMap(level=>{const take=Math.min(n,level.quantity);n-=take;return level.quantity>take?[{...level,quantity:level.quantity-take}]:[];});
}

/** ponytail: a unit is not sold for under 1/DUMP of the best trusted bid a base off the route
 * posts. Off-route bids are not weighed by the trip there, so a flat ratio stands in for it: a
 * bid a jump away a little over this one still sells here, and `routes()` ranks the trip. Tunable. */
export const DUMP=2;
/** The best trusted bid for the `n`th unit of `item_id` in `books`, as `decide` weighs a far book. */
const farBid=(book:Book,item_id:string,n:number)=>{const row=book.items?.get(item_id);return row?trust(book.age)*unit(levels(row,'bids'),n):0;};
/** Where the best trusted top bid for `item_id` among `books` is, and what it is. */
function bestBid(item_id:string,books:readonly Book[]):{base_id:string;price:number}|undefined {
  const top=books.map(book=>({book,worth:farBid(book,item_id,1)})).filter(row=>row.worth>0).sort((a,b)=>b.worth-a.worth)[0];
  return top&&{base_id:top.book.base_id,price:top.book.items!.get(item_id)!.best_buy};
}
/** Unsold rows with the better bid known off the route named. */
const unsoldWhy=(rows:Row[],elsewhere:readonly Book[]):Unsold[]=>rows.map(row=>{
  const far=bestBid(row.item_id,elsewhere);
  return far?{...row,why:`${far.base_id} bids ${far.price}, off this route`}:row;
});

/** One stop's decision, and the only one: `routes()` folds it over a whole route, `tradeRun` runs
 * it at each stop against the live book. First, sell each held unit whose trusted bid here is at
 * least its best trusted bid at any later stop, and at least 1/DUMP of the best trusted bid at any
 * base known off the route (`elsewhere`): a unit is never dumped here for a fraction of what a book
 * this pilot knows would pay. A later stop with
 * no known book may bid for anything, so goods are kept for it. Then take `buy` into the room that frees, one unit at a
 * time, while the unit's best later bid beats its ask plus tax. Both walks are level by level.
 * ponytail: each held item is weighed against one later book at a time, as if the whole carry went
 * there; a split across two later bases is not planned. */
function decide(aboard:Record<string,number>,free:number,here:Sides|undefined,trusted:number,
  later:{trust:number;sides:Sides|undefined}[],stop:PlanStop,elsewhere:readonly Book[]):{sold:Sale[];bought:number;cost:number} {
  // The unit a later stop, or a base off the route, would pay for the `n`th carried unit; the same
  // base as here has had `off` sold into it.
  const kept=(item_id:string,n:number,off:number)=>Math.max(0,...later.map(next=>!next.sides?Infinity
    :next.trust*unit(next.sides.get(item_id)?.bids??[],n+(next.sides===here?off:0))));
  // What a base off the route would pay for the `n`th carried unit, trusted.
  const away=(item_id:string,n:number)=>Math.max(0,...elsewhere.map(book=>farBid(book,item_id,n)));
  const sold:Sale[]=[];
  for(const [item_id,held] of Object.entries(aboard)) {
    const bids=here?.get(item_id)?.bids??[];
    let n=0;
    while(n<held&&unit(bids,n+1)>0&&trusted*unit(bids,n+1)>=kept(item_id,held-n,n)&&DUMP*unit(bids,n+1)>=away(item_id,held-n))n++;
    if(n)sold.push({item_id,quantity:n,revenue:walkBook(bids,n).gross});
  }
  if(!stop.buy)return {sold,bought:0,cost:0};
  const item=stop.buy,asks=stop.asks??here?.get(item)?.asks??[];
  const carried=(aboard[item]??0)-(sold.find(row=>row.item_id===item)?.quantity??0);
  const room=Math.min(free+sold.reduce((sum,row)=>sum+row.quantity,0),stop.quantity??Infinity);
  const bid=(n:number)=>Math.max(0,...later.map(next=>unit(next.sides?.get(item)?.bids??[],carried+n)));
  let bought=0;
  while(bought<room&&!walkBook(asks,bought+1).unfilled&&bid(bought+1)>unit(asks,bought+1)*(1+(stop.rate??0)))bought++;
  return {sold,bought,cost:walkBook(asks,bought).gross};
}

/** The route from the hold you have and `free` room: `decide` at each stop, then the hold and the
 * books move by what it did — a base visited twice is one book, so what the first visit took is
 * gone for the second. `elsewhere` is every other book known, off the route: a held good is not
 * sold on the route for less than one of them bids. Pure. */
export function plan(hold:Record<string,number>,free:number,stops:PlanStop[],elsewhere:readonly Book[]=[]):Plan {
  const aboard={...hold};
  const sides=new Map<string,Sides|undefined>();
  for(const {book} of stops)if(!sides.has(book.base_id))sides.set(book.base_id,book.items&&new Map([...book.items]
    .map(([id,row])=>[id,{bids:levels(row,'bids'),asks:levels(row,'asks')}])));
  const legs=stops.map((stop,i):Leg=>{
    const here=sides.get(stop.book.base_id);
    const later=stops.slice(i+1).map(next=>({trust:trust(next.book.age),sides:sides.get(next.book.base_id)}));
    const {sold,bought,cost}=decide(aboard,free,here,trust(stop.book.age),later,stop,elsewhere);
    for(const sale of sold) {
      aboard[sale.item_id]=aboard[sale.item_id]!-sale.quantity;free+=sale.quantity;
      const row=here!.get(sale.item_id)!;row.bids=drop(row.bids,sale.quantity);
    }
    if(bought) {
      aboard[stop.buy!]=(aboard[stop.buy!]??0)+bought;free-=bought;
      const row=here?.get(stop.buy!);if(row&&!stop.asks)row.asks=drop(row.asks,bought);
    }
    return {at:stop.book.base_id,source:stop.book.source,age:stop.book.age,sold,...stop.buy?{buy:stop.buy}:{},bought,cost,
      sales_tax:!bought||stop.asks?0:stop.rate===null?null:Math.floor(cost*stop.rate)};
  });
  const revenue=legs.reduce((sum,leg)=>sum+leg.sold.reduce((part,sale)=>part+sale.revenue,0),0);
  const cost=legs.reduce((sum,leg)=>sum+leg.cost,0),tax=legs.reduce((sum,leg)=>sum+(leg.sales_tax??0),0);
  return {legs,unsold:unsoldWhy(Object.entries(aboard).filter(([,quantity])=>quantity>0).map(([item_id,quantity])=>({item_id,quantity})),elsewhere),
    revenue,cost,sales_tax:legs.some(leg=>leg.sales_tax===null)?null:tax,net:Math.round(revenue-cost-tax)};
}

/** One stop of a `tradeRun`: the base, and optionally what to take there. */
export interface RunStop {at:string;buy?:string;
  /** A cap on `buy`; the plan sizes it otherwise. */
  quantity?:number;
  /** `'store'`: `buy` comes out of this base's store, at no cost, instead of off the market. */
  from?:'store'}
/** A value as a pilot writes it: single quotes, bare keys. */
const literal=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');
/** The call that runs `stops`, as a pilot pastes it. */
export const runCall=(stops:RunStop[])=>`tradeRun(${literal({stops})})`;

/** The docked base's sales tax on `item_id`: `estimate_purchase` is the only read of it. */
async function taxRate(item_id:string):Promise<number|null> {
  try {
    const bps=Number((details(await command('spacemolt_market/estimate_purchase',{item_id,quantity:1})) as EstimatePurchaseResponse).sales_tax_rate_bps);
    return Number.isFinite(bps)?bps/10_000:null;
  } catch {return null;}
}
/** Every book known by base, the most trusted reading of each; `here`'s is the live one. */
function byBase(here:Book,far:FarBook[]):Map<string,Book&{system_id?:string}> {
  const known=new Map<string,Book&{system_id?:string}>([[here.base_id,here]]);
  for(const row of far)if(!known.has(row.base_id)||known.get(row.base_id)!.age>row.age)
    known.set(row.base_id,{...row,items:new Map(row.items.map(item=>[item.item_id,item]))});
  return known;
}
const cargo=()=>{const ship=acct().state.ship;return Math.max(0,(ship?.cargo_capacity??0)-(ship?.cargo_used??0));};

/** What one stop of a run did. */
export interface Visit {at:string;
  /** The lib's `SellResponse` per row sold here. */
  sold:SellResponse[];
  /** Units of the stop's `buy` taken aboard, and the credits that cost: what left the wallet, tax included. */
  bought:number;spent:number;
  /** What fell short here, or why nothing was taken. */
  why?:string}
export interface Traded {
  /** One per stop reached, in order. */
  stops:Visit[];
  /** What was aboard when the run ended. After the last stop: what no stop bought, or what a base
   * off the route bids more for (named in the row's `why`). */
  unsold:Unsold[];
  /** Fuel units burned on the flights: the tank's measured drop across each `goTo`. */
  fuel:number;
  /** Sales, less what the buys took out of the wallet (tax included), less `fuel` at the
   * `fuel_price_all_in` of the first base the run was docked at — counted the way `Route.net`
   * counts it, so the two compare directly. */
  net:number;
}

/** Fly `stops` in order, and at each one sell and buy what the plan says, from the hold you have.
 * At each stop the live book is read and the rest of the route re-planned against it — the later
 * stops at their best known books — by the same rule `routes()` ranks with; so a full hold, an
 * empty one or a mixed one needs no other call. Each leg keeps its own rules (`buy` refuses under
 * `credit_reserve`, `goTo` refuses a POI while Tired). Never throws: a flight that does not arrive
 * is `partial` with the stops done so far, and `next` is the rest of the route. Re-running the
 * same call starts again at the first stop and re-plans from the hold you have. Trains trading and
 * navigation. */
export function tradeRun(opts:{stops:RunStop[]}):Promise<Outcome<Traded>> {
  const route=opts.stops??[];
  return job<Traded>('tradeRun',route.map(stop=>stop.buy?`${stop.at} (${stop.buy})`:stop.at).join(' → '),async()=>{
    const stops:Visit[]=[];
    let earned=0,spent=0,fuel=0,fuelPrice:number|undefined;
    const priced=async()=>{try {fuelPrice??=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);} catch {/* read at the next stop */}};
    // Every book known off the rest of the route, as of the last stop read.
    let elsewhere:Book[]=[];
    const detail=():Traded=>({stops,unsold:unsoldWhy(Object.entries(miningInventory(acct().state)).filter(([,quantity])=>quantity>0)
      .map(([item_id,quantity])=>({item_id,quantity})),elsewhere),fuel,net:Math.round(earned-spent-fuel*(fuelPrice??0))});
    const blocked=admit('tradeRun');
    if(blocked)return {status:'refused',did:'ran no trade',why:blocked,detail:detail()};
    if(!route.length)return {status:'refused',did:'ran no trade',why:'no stops: pass {stops:[{at, buy?}, …]}',detail:detail()};
    const said=()=>stops.map(visit=>`${visit.at}: ${[...visit.sold.map(fill=>`sold ${fill.quantity_sold} ${fill.item_id}`),
      ...visit.bought?[`took ${visit.bought}`]:[]].join(', ')||'nothing'}`).join(' → ');
    const short:string[]=[];
    if(acct().state.location?.docked_at)await priced();
    for(const [i,stop] of route.entries()) {
      checkStop();
      if(acct().state.location?.docked_at!==stop.at) {
        const trip=await goTo(stop.at);
        // ponytail: the tank's drop; a refuel inside goTo hides the burn it covered.
        fuel+=trip.cost.fuel;
        if(trip.status!=='done'||!acct().state.location?.docked_at)
          return {status:i?'partial':trip.status==='refused'?'refused':'failed',did:`${said()||'nothing done'}; did not reach ${stop.at}`,
            why:[...short,`${stop.at}: ${trip.why??trip.did}`].join('; '),detail:detail(),next:[runCall(route.slice(i))]};
      }
      const here=acct().state.location!.docked_at!;
      await priced();
      const visit:Visit={at:here,sold:[],bought:0,spent:0};
      stops.push(visit);
      const notes:string[]=[];
      let listed:Map<string,MarketListingItem>;
      try {listed=await book();}
      catch(error) {short.push(`${here}: no market (${error instanceof Error?error.message:String(error)})`);visit.why=short.at(-1);continue;}
      const later=route.slice(i+1).map(next=>next.at);
      const hold=miningInventory(acct().state);
      const known=byBase({base_id:here,source:'here',age:0,items:listed},
        await farBooks(here,marketTick()));
      elsewhere=[...known.values()].filter(book=>book.base_id!==here&&!later.includes(book.base_id));
      const stored=stop.buy&&stop.from==='store'?(await storeRows()).filter(row=>row.item_id===stop.buy).reduce((sum,row)=>sum+row.quantity,0):0;
      const [leg]=plan(hold,cargo(),[
        {book:known.get(here)!,...stop.buy?{buy:stop.buy}:{},...stop.quantity===undefined?{}:{quantity:stop.quantity},
          ...stop.from==='store'?{asks:stored?[{price_each:0,quantity:stored}]:[]}:{},
          rate:stop.buy&&stop.from!=='store'?await taxRate(stop.buy):0},
        ...later.map(base=>({book:known.get(base)??{base_id:base,source:'remembered' as const,age:0},rate:null}))],elsewhere).legs;
      if(leg!.sold.length) {
        const sold=await sell(leg!.sold.map(({item_id,quantity})=>({item_id,quantity})));
        visit.sold=sold.detail?.fills??[];earned+=sold.detail?.total??0;
        if(sold.status!=='done')short.push(`${here}: ${sold.why??sold.did}`);
      }
      if(stop.buy) {
        const want=Math.min(leg!.bought,cargo());
        if(!want)notes.push(`took no ${stop.buy}: ${leg!.bought?'no room left after the sales'
          :`nothing ${stop.from==='store'?'in the store':'on the asks'} here beats the best known bid later on the route`}`);
        else if(stop.from==='store') {
          const took=await withdraw([{item_id:stop.buy,quantity:want}]);
          visit.bought=took.detail?.moved.reduce((sum,row)=>sum+row.quantity,0)??0;
          if(!visit.bought)short.push(`${here}: withdrew no ${stop.buy}: ${took.why??took.did}`);
        } else {
          const got=await buy(stop.buy,want);
          // The wallet, not `total_cost`: the reply's cost is the subtotal, and the tax is on top.
          visit.bought=Number(got.detail?.bought?.quantity??0);visit.spent=got.cost.credits;spent+=visit.spent;
          if(got.status!=='done')short.push(`${here}: ${got.why??got.did}`);
        }
      }
      const why=[...short.filter(line=>line.startsWith(`${here}:`)),...notes].join('; ');
      if(why)visit.why=why;
    }
    const end=detail();
    const did=`${said()} — net ${end.net} cr after ${fuel} fuel at ${fuelPrice??0} cr`
      +(end.unsold.length?`; unsold: ${end.unsold.map(row=>`${row.quantity} ${row.item_id}${row.why?` (${row.why})`:''}`).join(', ')}`:'');
    if(short.length)return {status:'partial',did,why:short.join('; '),detail:end,next:[runCall(route)]};
    // Pasteable calls only. A route that bought something may pay again while the spread holds; a
    // route that only sold the hold has nothing left to do, so the next move is a new search.
    const again=end.net>0&&route.some(stop=>stop.buy&&stop.from!=='store');
    return {status:'done',did,detail:end,next:again?[runCall(route),'routes()']:['routes()']};
  });
}

/** ponytail: routes of at most 3 stops, grown breadth-first keeping the best 20 at each length. A
 * route that only pays at a fourth stop, or through a prefix ranked 21st, is never seen. Raise
 * them if the search stays fast. */
const MAX_STOPS=3,BEAM=20;
/** Rows returned. */
const ROWS=5;
/** ponytail: a base whose system the memory did not keep (a ledger entry, a pre-system memory) is
 * placed with one `find_route` each, at most 5 per call; past that its routes are unpriced rows. */
const UNPLACED=5;

/** Jumps from one system to another over the map's links (`get_map` connections), breadth first;
 * null when the map does not connect them. */
export function hops(links:ReadonlyMap<string,readonly string[]>,from:string,to:string):number|null {
  let frontier=[from],n=0;
  const seen=new Set(frontier);
  while(frontier.length&&!frontier.includes(to)) {
    n++;
    frontier=frontier.flatMap(system=>links.get(system)??[]).filter(system=>!seen.has(system)&&!!seen.add(system));
  }
  return frontier.length?n:null;
}

/** A route as `routes()` ranks it: the plan from the hold you have, with the trip priced. */
export interface Route extends Plan {
  /** Jumps from here through every stop, from the map; null when a stop could not be placed. */
  total_jumps:number|null;
  /** Fuel units: `total_jumps × fuel_per_jump`. Null when the trip is unpriced. */
  fuel:number|null;
  /** `0.5 ^ (sum of the stops' book ages / HALF_LIFE)`: 1 when every book is live. */
  confidence:number;
  /** What rows are ranked by: `confidence × net / max(1, total_jumps)`. 0 for an unpriced trip. */
  score:number;
  /** The call to paste. */
  next:string;
  /** What this row could not know: an unplaced stop, an unknown tax, a far stop's tax estimated at this base's rate. */
  why?:string;
  /** Present on a `routes({circuit})` row: the lap to hand a freighter. */
  circuit?:Circuit;
}

/** A closed lap a freighter repeats: `routes({circuit:{hold}})` plans it, `assign` hands it over.
 * Each stop sells its `sell` items at bids of at least `min_price`, then buys up to `qty` of its
 * `buy` item at asks of at most `max_price`; the last stop is followed by the first. */
export interface Circuit {closed:true;
  /** The hold the lap was planned for, starting empty. */
  hold:number;
  /** Jumps round the whole lap, last stop back to the first included. */
  lap_jumps:number;
  /** The steady-state lap's revenue less cost, tax and fuel. */
  lap_net:number;
  stops:readonly {at:string;system_id:string;buy?:{item:string;qty:number;max_price:number};
    sell:readonly {item:string;min_price:number}[]}[]}
/** ponytail: a lap's prices carry 10% of slack against the planned average — a buy up to 10%
 * over it, a sale down to 10% under it — so a book that moves a little does not stop the lap. Tunable. */
const SLACK=0.1;

/** Every route worth flying over what this pilot knows — the live book here, the faction ledger,
 * the remembered books — from the hold you have, ranked by trust-weighted net per jump. A route is
 * 1 to 3 stops, each maybe taking an item on; every stop is planned by the rule `tradeRun` runs,
 * so what ranks is what runs. `items` narrows what is taken on; goods aboard are always weighed.
 * Reads only. Jumps come from `get_map` and each base's system, which the market memory keeps;
 * fuel per jump from one `find_route`. A stop that could not be placed is a row with a `why` and
 * the Outcome `partial`, never a throw. Refused when not docked.
 *
 * ponytail: goods in this base's store are not weighed; `tradeRun` takes them with `from:'store'`. */
export function routes(opts:{items?:string[];circuit?:{hold:number}}={}):Promise<Outcome<{routes:Route[];sources:string[]}>> {
  return job<{routes:Route[];sources:string[]}>('routes',(opts.items??[]).join(' '),async()=>{
    const none={routes:[] as Route[],sources:[] as string[]};
    const here=acct().state.location?.docked_at,circuit=opts.circuit;
    if(!here)return {status:'refused',did:'ranked no routes',why:'not docked; a market is a station counter',
      detail:none,next:['goTo a base, then routes()']};
    if(circuit&&!(circuit.hold>0&&Number.isFinite(circuit.hold)))return {status:'refused',did:'ranked no routes',
      why:`circuit.hold ${circuit.hold} is not a positive number of units`,detail:none};
    const origin=acct().state.location?.system_id??'',free=cargo(),aboard=miningInventory(acct().state);
    const listed=await book();
    const far=await farBooks(here,marketTick());
    const known=byBase({base_id:here,source:'here',age:0,items:listed},far);
    const sources=[...new Set([...known.values()].map(row=>row.source))];
    const probe=[...listed.values()].find(row=>row.best_sell>0);
    const rate=probe?await taxRate(probe.item_id):null;

    // Where each base is: the memory's system, else one find_route (which also prices a jump).
    const systems=new Map<string,string>([[here,origin]]);
    for(const row of far)if(row.system_id)systems.set(row.base_id,row.system_id);
    const lost=new Map<string,string>();
    let perJump:number|undefined;
    const place=async(base:string)=>{
      checkStop();
      try {const quote=await route(base);systems.set(base,quote.target_system);perJump??=Number(quote.fuel_per_jump??0);}
      catch(error) {lost.set(base,error instanceof Error?error.message:String(error));}
    };
    const unplaced=[...known.keys()].filter(base=>!systems.has(base));
    for(const base of unplaced.slice(0,UNPLACED))await place(base);
    for(const base of unplaced.slice(UNPLACED))lost.set(base,`not placed: past the ${UNPLACED} find_route lookups one call makes`);
    const away=[...known.keys()].filter(base=>systems.has(base)&&base!==here);
    if(perJump===undefined&&away.length)await place(away[0]!);
    const links=new Map<string,string[]>();
    if(away.length)try {
      for(const row of (details(await command('spacemolt/get_map',{})) as {systems?:MapSystemInfo[]}).systems??[])
        links.set(row.system_id,row.connections??[]);
    } catch {/* no map: every far stop is unpriced, and says so */}
    const counted=new Map<string,number|null>();
    const jumps=(from:string,to:string):number|null=>{
      const key=`${from}>${to}`;
      if(!counted.has(key))counted.set(key,hops(links,from,to));
      return counted.get(key)!;
    };
    const fuelPrice=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);

    const taxWhy=(planned:Pick<Plan,'legs'|'sales_tax'>)=>planned.sales_tax===null?['sales tax not known; net is untaxed']
      :planned.legs.filter(leg=>leg.bought&&leg.at!==here).map(leg=>`tax at ${leg.at} estimated at ${here}'s ${Math.round(rate!*10_000)} bps`);
    const confidence=(stops:RunStop[])=>trust([...new Set(stops.map(stop=>stop.at))].reduce((sum,base)=>sum+known.get(base)!.age,0));
    const evaluate=(stops:RunStop[]):Route=>{
      // Only the docked base's rate is readable; it stands in for every far stop's.
      const planned=plan(aboard,free,stops.map(stop=>({book:known.get(stop.at)!,...stop.buy?{buy:stop.buy}:{},rate})),
        [...known.values()].filter(book=>!stops.some(stop=>stop.at===book.base_id)));
      const why:string[]=[];
      let total:number|null=0,from=origin;
      for(const stop of stops) {
        const system=systems.get(stop.at),n=system===undefined?null:jumps(from,system);
        if(n===null){why.push(`no route to ${stop.at}${lost.has(stop.at)?`: ${lost.get(stop.at)}`:' on the map'}; fuel not priced`);total=null;break;}
        total+=n;from=system!;
      }
      why.push(...taxWhy(planned));
      const fuel=total===null?null:total*(perJump??0);
      const net=Math.round(planned.net-(fuel??0)*fuelPrice);
      const trusted=confidence(stops);
      return {...planned,total_jumps:total,fuel,net,confidence:trusted,score:total===null?0:trusted*net/Math.max(1,total),
        next:runCall(stops),...why.length?{why:why.join('; ')}:{}};
    };
    // A closed lap for an empty `circuit.hold`, whatever is aboard now: three laps planned, the middle
    // one read — the first starts empty, the last has no next lap to carry for. One plan() shares each
    // base's book between the laps, so the middle lap trades on books one lap has already eaten into.
    // The lap starts at its first buy: started at a sale, lap one sells nothing, and the middle lap
    // would sell into the untouched book (live: 965 for 50 steel where the repeat pays 950) — so a
    // ring read from each end would rank by whichever end flattered it.
    // ponytail: a ring whose hold is never empty (x bought at A sold at C, y bought at B sold at A)
    // still reads one item off a book lap one did not touch; plan a fourth lap if that ring ever ranks.
    // A lap repeats only what it buys and sells, so each item counts only min(sold, bought) units:
    // sales kept at the dearest legs first, buys at the cheapest (live: sold 50 steel, bought 21, net
    // 521 where the lap flown nets -30; and 2 targeting computers sold that no stop bought, 16,681).
    // ponytail: a kept unit is priced at its leg's average; walk the levels if a balanced lap's
    // prediction drifts from the realised net.
    const middleOf=(stops:RunStop[])=>plan({},circuit!.hold,[...stops,...stops,...stops].map(stop=>({book:known.get(stop.at)!,...stop.buy?{buy:stop.buy}:{},rate})),
      [...known.values()].filter(book=>!stops.some(stop=>stop.at===book.base_id))).legs.slice(stops.length,2*stops.length);
    const lapOf=(given:RunStop[]):Route=>{
      // Where the lap first buys is only known once planned: a stop named to buy may take nothing.
      const first=Math.max(0,middleOf(given).findIndex(leg=>leg.bought)),stops=[...given.slice(first),...given.slice(0,first)];
      const n=stops.length,hold=circuit!.hold,middle=middleOf(stops),sales=middle.flatMap(leg=>leg.sold),buys=middle.filter(leg=>leg.bought);
      const count=(rows:{item:string;quantity:number}[],item:string)=>rows.filter(row=>row.item===item).reduce((sum,row)=>sum+row.quantity,0);
      const sold=sales.map(sale=>({item:sale.item_id,quantity:sale.quantity})),bought=buys.map(leg=>({item:leg.buy!,quantity:leg.bought}));
      const both=new Map([...sold,...bought].map(row=>[row.item,Math.min(count(sold,row.item),count(bought,row.item))]));
      const allot=<T,>(rows:T[],item:(row:T)=>string,quantity:(row:T)=>number,each:(row:T)=>number)=>{
        const left=new Map(both);
        return new Map(rows.toSorted((a,b)=>each(a)-each(b)).map(row=>{
          const take=Math.min(quantity(row),left.get(item(row))!);left.set(item(row),left.get(item(row))!-take);return [row,take];}));
      };
      const keptSales=allot(sales,sale=>sale.item_id,sale=>sale.quantity,sale=>-sale.revenue/sale.quantity);
      const keptBuys=allot(buys,leg=>leg.buy!,leg=>leg.bought,leg=>leg.cost/leg.bought);
      const legs=middle.map((leg):Leg=>{
        const took=keptBuys.get(leg)??0,cost=took?leg.cost*took/leg.bought:0;
        return {...leg,sold:leg.sold.map(sale=>{const quantity=keptSales.get(sale)!;return {...sale,quantity,revenue:sale.revenue*quantity/sale.quantity};})
          .filter(sale=>sale.quantity>0),bought:took,cost,sales_tax:leg.sales_tax===null?null:Math.floor(cost*(rate??0))};
      });
      let lap:number|null=0;
      for(const [i,stop] of stops.entries()) {
        const from=systems.get(stop.at),to=systems.get(stops[(i+1)%n]!.at),hop=from===undefined||to===undefined?null:jumps(from,to);
        if(hop===null){lap=null;break;}
        lap+=hop;
      }
      const sum=(part:(leg:Leg)=>number)=>legs.reduce((total,leg)=>total+part(leg),0);
      const revenue=sum(leg=>leg.sold.reduce((total,sale)=>total+sale.revenue,0)),cost=sum(leg=>leg.cost),tax=sum(leg=>leg.sales_tax??0);
      const sales_tax=legs.some(leg=>leg.sales_tax===null)?null:tax,fuel=lap===null?null:lap*(perJump??0);
      const lap_net=Math.round(revenue-cost-tax-(fuel??0)*fuelPrice),trusted=confidence(stops),why=taxWhy({legs,sales_tax});
      const closed:Circuit={closed:true,hold,lap_jumps:lap??0,lap_net,stops:stops.map((stop,i)=>{
        const leg=legs[i]!;
        return {at:stop.at,system_id:systems.get(stop.at)??'',
          ...leg.bought?{buy:{item:leg.buy!,qty:leg.bought,max_price:Math.ceil((1+SLACK)*leg.cost/leg.bought-1e-9)}}:{},
          sell:leg.sold.map(sale=>({item:sale.item_id,min_price:Math.floor((1-SLACK)*sale.revenue/sale.quantity+1e-9)}))};
      })};
      return {legs,unsold:[],revenue,cost,sales_tax,net:lap_net,total_jumps:lap,fuel,confidence:trusted,
        score:lap===null?0:trusted*lap_net/Math.max(1,lap),next:`assign('freighter', ${literal(closed)}, {float:20000})`,
        ...why.length?{why:why.join('; ')}:{},circuit:closed};
    };

    // Breadth-first over stop lists: each route grows by one stop, the last stop taking on nothing
    // or any item whose ask there the new stop outbids.
    const wanted=(item:string)=>!opts.items?.length||opts.items.includes(item);
    const found=new Map<string,Route>();
    // A route pays, and every stop on it does something: a stop that neither sells nor buys is only fuel.
    // A circuit pays once round a whole lap, fuel and all. One ring of bases is one circuit: its
    // rotations, and the other buys that ring could make, rank as the best of them alone.
    const keep=(stops:RunStop[])=>{
      const row=circuit?lapOf(stops):evaluate(stops),trades=row.legs.every(leg=>leg.sold.length||leg.bought);
      const pays=trades&&(circuit?row.total_jumps!==null&&row.net>0:row.revenue>row.cost);
      const key=circuit?stops.map(stop=>stop.at).map((_,i,keys)=>[...keys.slice(i),...keys.slice(0,i)].join(' ')).sort()[0]!:row.next;
      if(pays&&!((found.get(key)?.score??-Infinity)>=row.score))found.set(key,row);
      return pays&&row;
    };
    let beam:RunStop[][]=[...known.keys()].map(at=>[{at}]);
    // A circuit is 2 or 3 distinct bases, so one stop alone is only a seed.
    if(!circuit)beam.forEach(keep);
    for(let length=2;length<=MAX_STOPS;length++) {
      checkStop();
      const grown:{stops:RunStop[];score:number}[]=[];
      for(const stops of beam) {
        const last=stops.at(-1)!.at,asks=known.get(last)!.items!;
        for(const [at,next] of known) {
          if(at===last||circuit&&stops.some(stop=>stop.at===at))continue;
          const buys=[undefined,...[...asks.values()].filter(row=>row.best_sell>0&&wanted(row.item_id)
            &&(next.items!.get(row.item_id)?.best_buy??0)>row.best_sell).map(row=>row.item_id)];
          for(const buy of buys) {
            const longer=[...stops.slice(0,-1),{at:last,...buy?{buy}:{}},{at}];
            const row=keep(longer);
            if(row||circuit)grown.push({stops:longer,score:row?row.score:-Infinity});
            // Round a circuit, the last stop may take on what the first stop outbids it for.
            if(circuit)for(const item of next.items!.values())
              if(item.best_sell>0&&wanted(item.item_id)&&(known.get(longer[0]!.at)!.items!.get(item.item_id)?.best_buy??0)>item.best_sell)
                keep([...longer.slice(0,-1),{at,buy:item.item_id}]);
          }
        }
      }
      beam=grown.sort((a,b)=>b.score-a.score).slice(0,BEAM).map(row=>row.stops);
    }

    const rows=[...found.values()].sort((a,b)=>Number(a.total_jumps===null)-Number(b.total_jumps===null)||b.score-a.score).slice(0,ROWS);
    if(!rows.length)return {status:'done',did:`no route pays across ${known.size} book(s) (${sources.join(' + ')}) from this hold`,
      detail:{routes:[],sources},next:['goTo another base and prices() there to learn its book']};
    const failed=rows.filter(row=>row.total_jumps===null);
    // Short: a hold of ten kinds is `sell 499 of 10 kinds`; the legs in `detail` carry the rest.
    const says=(row:Route)=>row.legs.map(leg=>[leg.at,
      ...leg.sold.length>2?[`sell ${leg.sold.reduce((sum,sale)=>sum+sale.quantity,0)} of ${leg.sold.length} kinds`]
        :leg.sold.map(sale=>`sell ${sale.quantity} ${sale.item_id}`),
      ...leg.bought?[`buy ${leg.bought} ${leg.buy}`]:[]].join(' ')).join(' → ');
    return {status:failed.length?'partial':'done',
      did:`ranked ${rows.length} route(s) over ${known.size} book(s) (${sources.join(' + ')}); best: ${says(rows[0]!)}, net ${rows[0]!.net} cr`,
      ...failed.length?{why:failed.map(row=>`${says(row)}: ${row.why}`).join('; ')}:{},
      detail:{routes:rows,sources},next:rows.slice(0,3).map(row=>row.next)};
  });
}
