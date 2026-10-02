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
import type {EstimatePurchaseResponse,FactionQueryTradeIntelResponse,FindRouteResponse,MapSystemInfo,MarketListingItem,OrderLevel,SellResponse} from '@spacemolt/lib';
import {miningInventory} from '../../mining-inventory.ts';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {walkBook} from '../../order-book.ts';
import {details} from '../../response-details.ts';
import {journalRun} from '../../run-record.ts';
import {inFaction} from '../../trade-intel.ts';
import {book,buy,knownBooks,marketTick,sell,slipped,ticksOld} from '../market.ts';
import {readDrained,ring} from '../freighter/drained.ts';
import {markPlace,readMobile,readPlaces} from '../places.ts';
import {acct,admit,checkStop,command,job,runtimeDir,step,type Said} from '../runtime.ts';
import {counter} from '../counter.ts';
import {withdraw} from '../storage.ts';
import {goTo} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';

/** Whose connection and files a search reads through: the pilot's for `routes()`, or a freighter's
 * own when its host re-plans it, so a host loop never touches the play runtime. */
/** `inFaction` for a seat, the skip journalled to the seat's runtime. */
export const seatInFaction=(seat:Seat)=>inFaction(seat.account,text=>{if(seat.runtime)journalRun(seat.runtime,{text},'faction_skipped');});
export interface Seat {account:ReadinessAccount;command:ReadinessCommand;runtime:string|undefined;
  /** The live book where the ship is docked, and the tick it was read on. */
  book():Promise<{items:Map<string,MarketListingItem>;tick:number}>;
  /** Throws to end a search early. */
  stop():void}
/** The pilot's seat: the play runtime, and `book()` remembering and filing what it reads. */
export const pilotSeat=():Seat=>({account:acct(),command,runtime:runtimeDir(),book:async()=>({items:await book(),tick:marketTick()}),stop:checkStop});

/** One item and one buyer known for it, with the trip to that buyer priced and ranked. */
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
  /** `0.5 ^ (age / HALF_LIFE)`: 1 for a live book. */
  confidence:number;
  /** What rows rank by, as `routes()` rows do: `max(confidence, 1/64) × net / max(1, jumps)`. */
  score:number;
}
/** Buyers listed per item, best score first. */
export const BUYERS=3;

/** What each item in the hold is worth at the best buyers this pilot knows of, anywhere, and
 * what the trip there costs: up to `BUYERS` rows an item, ranked as `routes()` ranks a one-stop
 * route, by trust-weighted net per jump. Default items: everything in the hold and in this base's
 * store. Reads only.
 *
 * Three sources, every buyer in them weighed: this base's live book; the faction trade ledger
 * (`query_trade_intel`) when the pilot has a faction that runs one; and the books this pilot
 * has read at other bases, remembered by `book()` in the runtime dir. Only the last is
 * guaranteed, so `did` always says which sources answered. A price that is not live is a
 * memory, and the far book may have moved — `tradeRun` re-reads before it sells.
 *
 * Refused when not docked: without a local book there is nothing to compare against. */
export function spreads(items?:string[]):Promise<Outcome<{spreads:Spread[];sources:string[]}>> {
  return job<{spreads:Spread[];sources:string[]}>('spreads',(items??[]).join(' '),async()=>{
    const none={spreads:[] as Spread[],sources:[] as string[]};
    const at=await counter();
    if('refused' in at)return {status:'refused',did:'read no spreads',why:at.refused,detail:none,
      next:['goTo a base, then spreads()']};
    const here=at.docked;

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
    // Every buyer known for a wanted item: the live book here, then each far book. A higher bid
    // does not hide a lower one — a stale bid 15 jumps out must not hide a fresh one a jump away.
    type Offer=Omit<Spread,'held'|'fuel'|'jumps'|'net'|'confidence'|'score'>&{age:number};
    const offers:Offer[]=[];
    for(const id of wanted) {
      const row=listed.get(id);
      if(row&&row.best_buy>0)offers.push({item_id:id,base_id:here,best_buy:row.best_buy,best_buy_qty:row.best_buy_qty,source:'here',seen:'live',age:0});
    }
    const seat=pilotSeat(),far=await farBooks(here,now,seat);
    sources.push(...(['faction ledger','remembered'] as const).filter(source=>far.some(known=>known.source===source)));
    for(const known of far)
      for(const row of known.items)
        if(wanted.includes(row.item_id)&&row.best_buy>0)
          offers.push({item_id:row.item_id,base_id:known.base_id,best_buy:row.best_buy,best_buy_qty:row.best_buy_qty,
            source:known.source,seen:`${known.age} ticks old`,age:known.age});

    // Trips priced as routes() prices them: jumps over the map, fuel per jump from one quote.
    const {hop,perJump,lost}=await chart(here,[...new Set(offers.map(row=>row.base_id))],far,seat);
    const fuelPrice=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);
    const priced=offers.flatMap(({age,...row})=>{
      const jumps=hop(here,row.base_id);
      if(jumps===null)return [];
      const held=stock[row.item_id]??0,fuel=jumps*perJump,confidence=trust(age);
      const net=Math.round(row.best_buy*Math.min(row.best_buy_qty,held)-fuel*fuelPrice);
      return [{...row,held,fuel,jumps,net,confidence,score:rank(confidence,net,jumps)}];
    }).sort((a,b)=>b.score-a.score);
    const listedFor=new Map<string,number>();
    const rows=priced.filter(row=>{const n=listedFor.get(row.item_id)??0;listedFor.set(row.item_id,n+1);return n<BUYERS;});

    const best=wanted.flatMap(id=>rows.find(row=>row.item_id===id)??[]),away=best.filter(row=>row.base_id!==here);
    const unsellable=wanted.filter(id=>!offers.some(row=>row.item_id===id));
    const unplaced=[...new Set(offers.map(row=>row.base_id))].filter(base=>lost.has(base));
    return {status:'done',
      did:`priced ${best.length} of ${wanted.length} held item${wanted.length===1?'':'s'} at ${rows.length} buyer${rows.length===1?'':'s'} against ${sources.join(' + ')}`
        +(away.length?`; the best buyer for ${away.length} of them is not ${here}`:'')
        +(unsellable.length?`; no buyer known anywhere for ${unsellable.slice(0,5).join(', ')}`:'')
        +(unplaced.length?`; ${unplaced.length} buyer base(s) not placed, so not priced: ${unplaced.slice(0,5).join(', ')}`:''),
      detail:{spreads:rows,sources},
      next:[...rows.slice(0,2).map(row=>row.base_id===here
        ?`sell([{item_id:'${row.item_id}'}]) here — ${row.best_buy} × ${Math.min(row.best_buy_qty,row.held)} ≈ ${row.net} cr net`
        :`${runCall([{at:row.base_id}])} — ${row.best_buy} each (${row.source}, ${row.seen}), ${row.fuel} fuel, ${row.net} cr net`),
      ...unsellable.length?['no price is known for the rest; goTo another base and prices() there to learn one']:[]].slice(0,3)};
  });
}

/** One bid known for an item: where, how much, how deep, how old, and how far. */
export interface Buyer {item_id:string;base_id:string;best_buy:number;best_buy_qty:number;source:Spread['source'];
  /** Ticks since the book was read; 0 for this counter's live book. */
  age:number;
  /** Jumps from where you are, on the map; null when the base could not be placed. */
  jumps:number|null}

/** Who buys `items`: the highest bids known for each, anywhere — this counter's live book when
 * docked, the faction ledger, the books remembered — up to `BUYERS` an item, with each book's age and
 * the jumps there. Held or not, docked or not. Reads only.
 * Live 2026-09-30 (kvothe): hours flown system to system, `prices(['aluminum_ore'])` at each, hunting
 * a buyer the market memory already held. */
export function buyers(items:string|readonly string[]):Promise<Outcome<{buyers:Buyer[]}>> {
  const wanted=[...new Set(typeof items==='string'?[items]:items)];
  return job<{buyers:Buyer[]}>('buyers',wanted.join(' '),async()=>{
    if(!wanted.length)return {status:'refused',did:'named no item',why:"pass an item id or a list: buyers('aluminum_ore')",detail:{buyers:[]}};
    const here=acct().state.location?.docked_at??'',live=here?await book():undefined;
    const now=live?marketTick():tickNow();
    const seat=pilotSeat(),far=await farBooks(here,now,seat);
    const bids=[...live?wanted.flatMap(id=>{const row=live.get(id);return row?[{...row,base_id:here,source:'here' as const,age:0}]:[];}):[],
      ...far.flatMap(known=>known.items.filter(row=>wanted.includes(row.item_id)).map(row=>({...row,base_id:known.base_id,source:known.source,age:known.age})))]
      .filter(row=>row.best_buy>0&&row.best_buy_qty>0).sort((a,b)=>b.best_buy-a.best_buy);
    const top=wanted.flatMap(id=>bids.filter(row=>row.item_id===id).slice(0,BUYERS));
    const {hop}=await chart(here,[...new Set(top.map(row=>row.base_id))],far,seat);
    const rows:Buyer[]=top.map(row=>({item_id:row.item_id,base_id:row.base_id,best_buy:row.best_buy,best_buy_qty:row.best_buy_qty,
      source:row.source,age:row.age,jumps:hop(here,row.base_id)}));
    const said=wanted.map(id=>{
      const mine=rows.filter(row=>row.item_id===id);
      return `${id}: ${mine.map(row=>`${row.base_id} bids ${row.best_buy} for ${row.best_buy_qty} (${row.source==='here'?'live':`${row.source}, ${row.age} ticks old`}, ${row.jumps??'?'} jumps)`).join('; ')||'no buyer known'}`;
    });
    const held=miningInventory(acct().state);
    return {status:'done',did:said.join(' | '),detail:{buyers:rows},
      next:wanted.flatMap(id=>{const best=rows.find(row=>row.item_id===id);return best&&held[id]
        ?[best.base_id===here?`sell([{item_id:'${id}'}])`:runCall([{at:best.base_id}])]:[];}).slice(0,3)};
  });
}
/** ponytail: undocked there is no live tick to age a book against; the newest book known, advanced
 * at ten seconds a tick since it was read, stands in. A docked call measures it from the live book. */
function tickNow():number {
  const newest=knownBooks().filter(row=>row.tick!==undefined).sort((a,b)=>b.tick!-a.tick!)[0];
  const since=newest?Math.floor((Date.now()-Date.parse(newest.at))/10_000):0;
  return Math.max(marketTick(),newest?newest.tick!+(Number.isFinite(since)?Math.max(0,since):0):0);
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
async function ledger(seat:Seat):Promise<FactionQueryTradeIntelResponse['entries']> {
  const entries:FactionQueryTradeIntelResponse['entries']=[];
  if(!seatInFaction(seat))return entries;
  for(let page=0;page<LEDGER_PAGES;page++) {
    seat.stop();
    try {
      const reply=details(await seat.command('spacemolt_intel/query_trade_intel',{limit:LEDGER_PAGE,offset:page*LEDGER_PAGE})) as FactionQueryTradeIntelResponse;
      entries.push(...reply.entries??[]);
      if(!reply.entries?.length||entries.length>=Number(reply.total??0))break;
    } catch {break;}
  }
  return entries;
}

/** A book row as far as a source can say: a ledger entry has the top of book and volumes, no levels. */
export type Listing=Pick<MarketListingItem,'item_id'|'best_buy'|'best_buy_qty'|'best_sell'|'best_sell_qty'>
  &Partial<Pick<MarketListingItem,'buy_orders'|'sell_orders'>>;
/** A ledger entry's rows as book rows: its top of book and volumes. */
export const ledgerItems=(entry:FactionQueryTradeIntelResponse['entries'][number]):Listing[]=>(entry.items??[]).map(item=>
  ({item_id:item.item_id,best_buy:item.best_buy,best_buy_qty:item.buy_volume,best_sell:item.best_sell,best_sell_qty:item.sell_volume}));
/** A book at another base, with its age in ticks against `now`, and its system when the memory kept it. */
interface FarBook {base_id:string;source:'faction ledger'|'remembered';age:number;system_id?:string;items:Listing[]}

/** Every far book this pilot may know: the faction ledger's whole books, then the books
 * remembered at other bases, one per base — the fresher copy when both have it. What `spreads()`,
 * `routes()`, `tradeRun` and `assign` all read. A ledger entry comes back with an empty
 * `system_id`, as does a memory written before books kept one; the memory's system for that base
 * stands in, else the kept place (`places.json`), else none. */
export async function farBooks(here:string,now:number,seat:Seat=pilotSeat()):Promise<FarBook[]> {
  const dir=seat.runtime,memory=knownBooks(dir??'');
  const systemOf=new Map([...Object.entries(dir?readPlaces(dir):{}),
    ...memory.filter(known=>known.system_id).map(known=>[known.base_id,known.system_id!] as [string,string])]);
  const filed=(await ledger(seat)).filter(entry=>entry.base_id!==here).map(entry=>{
    const system_id=entry.system_id||systemOf.get(entry.base_id);
    return {base_id:entry.base_id,source:'faction ledger' as const,age:ticksOld(entry.submitted_at_tick,now),
      ...system_id?{system_id}:{},items:ledgerItems(entry)};
  });
  const remembered=memory.filter(known=>known.base_id!==here).map(known=>({base_id:known.base_id,
    source:'remembered' as const,age:ticksOld(known.tick,now),...systemOf.has(known.base_id)?{system_id:systemOf.get(known.base_id)!}:{},items:known.items}));
  // One book per base: the fresher of the ledger's copy and the memory's, a tie to the ledger.
  const fresher=new Map<string,FarBook>();
  for(const book of [...filed,...remembered])if(!((fresher.get(book.base_id)?.age??Infinity)<=book.age))fresher.set(book.base_id,book);
  return [...fresher.values()];
}

/** Ticks for a far end's trust to halve: an hour at ten seconds a tick. NPC books move rarely,
 * so an hour-old price still counts half. */
export const HALF_LIFE=360;
const trust=(age:number)=>0.5**(age/HALF_LIFE);
/** ponytail: the least confidence a row is ranked at, six half-lives (six hours of summed book
 * age). Past it, age discounts no further and rows rank by net per jump alone — live, every
 * Sol-cluster book was ~12 hours old, confidence ~0, and a 162-net row ranked over a 920-net row
 * of the same 4 jumps. Tune it if stale rows crowd out fresh ones. */
const TRUST_FLOOR=1/64;
/** What a row ranks by: `max(confidence, TRUST_FLOOR) × net / max(1, jumps)`; 0 for an unpriced trip. */
const rank=(confidence:number,net:number,jumps:number|null)=>jumps===null?0:Math.max(confidence,TRUST_FLOOR)*net/Math.max(1,jumps);

/** A book's provenance as a pilot reads it: `live`, or `remembered, 85 ticks old`. */
const aged=(book:{source:Spread['source'];age:number})=>book.source==='here'?'live':`${book.source}, ${book.age} ticks old`;

/** A stop's book as the planner reads it. No `items`: nothing is known of that base's book. */
export interface Book {base_id:string;source:Spread['source'];age:number;items?:Map<string,Listing>}
/** Units sold at one stop and what they fetch there, level by level. */
export interface Sale {item_id:string;quantity:number;revenue:number}
/** Units taken on at one stop and what they cost at the asks (0 from the store). */
export interface Buy {item_id:string;quantity:number;cost:number}
/** What the plan does at one stop. */
export interface Leg {
  at:string;
  /** Where this stop's book came from and its age in ticks, as `Spread.source`; `here`/0 when live. */
  source:Spread['source'];age:number;
  /** Held goods sold here: each whose trusted bid here is at least its best trusted bid later on
   * the route, and at least half the best trusted bid at any base known off it. */
  sold:Sale[];
  /** Each item taken here, and the totals: units, and what they cost at the asks (0 from the store). */
  buys:Buy[];bought:number;cost:number;
  /** Tax on those buys; null when no rate is known. Only the docked base's rate is readable, so
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
/** One stop handed to `plan`: its book, the items it may take on, and the tax on taking them. */
export interface PlanStop {book:Book;buy?:readonly string[];
  /** A cap on all of `buy` together. */
  quantity?:number;
  /** Where each `buy` item comes from when not the market's asks: the store, as one level at price 0. */
  asks?:Record<string,OrderLevel[]>;
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
/** How many of `0, 1, …, hi−1` pass `ok` before the first that fails. `ok` must hold, then fail:
 * a book walked best first, against what the next unit would fetch elsewhere, is that shape. */
function count(hi:number,ok:(n:number)=>boolean):number {
  let lo=0;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ok(mid-1))lo=mid;else hi=mid-1;}
  return lo;
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
 * no known book may bid for anything, so goods are kept for it. Then fill the room that frees one
 * unit at a time, each unit of whichever `buy` item earns most on it: its best later bid less its
 * ask plus tax, while that is above 0. Every walk is level by level; a run of units that earn alike
 * is taken at once, found by bisection, so a 1200-unit hold is a few steps, not 1200.
 * ponytail: each held item is weighed against one later book at a time, as if the whole carry went
 * there; a split across two later bases is not planned. The fill is greedy per stop: room kept
 * empty here for a better buy at the next stop is not planned. */
function decide(aboard:Record<string,number>,free:number,here:Sides|undefined,trusted:number,
  later:{trust:number;sides:Sides|undefined}[],stop:PlanStop,elsewhere:readonly Book[]):{sold:Sale[];buys:Buy[]} {
  // The unit a later stop, or a base off the route, would pay for the `n`th carried unit; the same
  // base as here has had `off` sold into it.
  const kept=(item_id:string,n:number,off:number)=>Math.max(0,...later.map(next=>!next.sides?Infinity
    :next.trust*unit(next.sides.get(item_id)?.bids??[],n+(next.sides===here?off:0))));
  // What a base off the route would pay for the `n`th carried unit, trusted.
  const away=(item_id:string,n:number)=>Math.max(0,...elsewhere.map(book=>farBid(book,item_id,n)));
  const sold:Sale[]=[];
  for(const [item_id,held] of Object.entries(aboard)) {
    const bids=here?.get(item_id)?.bids??[];
    const n=count(held,k=>unit(bids,k+1)>0&&trusted*unit(bids,k+1)>=kept(item_id,held-k,k)&&DUMP*unit(bids,k+1)>=away(item_id,held-k));
    if(n)sold.push({item_id,quantity:n,revenue:walkBook(bids,n).gross});
  }
  let room=Math.min(free+sold.reduce((sum,row)=>sum+row.quantity,0),stop.quantity??Infinity);
  const rows=[...new Set(stop.buy??[])].map(item=>{
    const asks=stop.asks?.[item]??here?.get(item)?.asks??[];
    return {item,asks,depth:asks.reduce((sum,level)=>sum+level.quantity,0),n:0,
      carried:(aboard[item]??0)-(sold.find(row=>row.item_id===item)?.quantity??0)};
  });
  // What the `n+1`th unit of a row earns: its best later bid, less its ask plus tax. None past the asks.
  const earns=(row:typeof rows[number],n:number)=>n>=row.depth?-Infinity
    :Math.max(0,...later.map(next=>unit(next.sides?.get(row.item)?.bids??[],row.carried+n+1)))-unit(row.asks,n+1)*(1+(stop.rate??0));
  // A row's next unit only ever earns less, and only the row that took units moves: each is re-read once.
  let live=rows.map(row=>({row,now:earns(row,0)})).filter(pick=>pick.now>0);
  while(room>0&&live.length) {
    const [best,next]=live.sort((a,b)=>b.now-a.now) as [typeof live[number],typeof live[number]|undefined];
    // The best row takes units while each still earns more than 0 and at least what the runner-up's next does.
    const take=count(room,k=>{const now=earns(best.row,best.row.n+k);return now>0&&now>=(next?.now??0);});
    best.row.n+=take;room-=take;best.now=earns(best.row,best.row.n);
    live=live.filter(pick=>pick.now>0);
  }
  return {sold,buys:rows.filter(row=>row.n).map(row=>({item_id:row.item,quantity:row.n,cost:walkBook(row.asks,row.n).gross}))};
}

/** The game taxes each buy on its own, floored. Null when no rate is known and something was bought. */
const taxOn=(buys:readonly Buy[],rate:number|null)=>!buys.length?0:rate===null?null:buys.reduce((sum,row)=>sum+Math.floor(row.cost*rate),0);

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
    const {sold,buys}=decide(aboard,free,here,trust(stop.book.age),later,stop,elsewhere);
    for(const sale of sold) {
      aboard[sale.item_id]=aboard[sale.item_id]!-sale.quantity;free+=sale.quantity;
      const row=here!.get(sale.item_id)!;row.bids=drop(row.bids,sale.quantity);
    }
    for(const {item_id,quantity} of buys) {
      aboard[item_id]=(aboard[item_id]??0)+quantity;free-=quantity;
      const row=here?.get(item_id);if(row&&!stop.asks)row.asks=drop(row.asks,quantity);
    }
    return {at:stop.book.base_id,source:stop.book.source,age:stop.book.age,sold,buys,
      bought:buys.reduce((sum,row)=>sum+row.quantity,0),cost:buys.reduce((sum,row)=>sum+row.cost,0),sales_tax:taxOn(buys,stop.asks?0:stop.rate)};
  });
  const revenue=legs.reduce((sum,leg)=>sum+leg.sold.reduce((part,sale)=>part+sale.revenue,0),0);
  const cost=legs.reduce((sum,leg)=>sum+leg.cost,0),tax=legs.reduce((sum,leg)=>sum+(leg.sales_tax??0),0);
  return {legs,unsold:unsoldWhy(Object.entries(aboard).filter(([,quantity])=>quantity>0).map(([item_id,quantity])=>({item_id,quantity})),elsewhere),
    revenue,cost,sales_tax:legs.some(leg=>leg.sales_tax===null)?null:tax,net:Math.round(revenue-cost-tax)};
}

/** One stop of a `tradeRun`: the base, and optionally what to take there: one item, or several
 * that the plan fills the hold from, unit by unit, whichever earns most. */
export interface RunStop {at:string;buy?:string|readonly string[];
  /** A cap on all of `buy` together; the plan sizes it otherwise. */
  quantity?:number;
  /** `'store'`: `buy` comes out of this base's store, at no cost, instead of off the market. */
  from?:'store'}
/** A stop's `buy` as a list. */
const items=(stop:RunStop)=>stop.buy===undefined?[]:typeof stop.buy==='string'?[stop.buy]:[...stop.buy];
/** A value as a pilot writes it: single quotes, bare keys. */
const literal=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');
/** The call that runs `stops`, as a pilot pastes it. */
export const runCall=(stops:RunStop[])=>`tradeRun(${literal({stops})})`;

/** The docked base's sales tax on `item_id`: `estimate_purchase` is the only read of it. */
async function taxRate(item_id:string,send:ReadinessCommand=command):Promise<number|null> {
  try {
    const bps=Number((details(await send('spacemolt_market/estimate_purchase',{item_id,quantity:1})) as EstimatePurchaseResponse).sales_tax_rate_bps);
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
const cargo=(account=acct())=>{const ship=account.state.ship;return Math.max(0,(ship?.cargo_capacity??0)-(ship?.cargo_used??0));};

/** What one stop of a run did. */
export interface Visit {at:string;
  /** The lib's `SellResponse` per row sold here. */
  sold:SellResponse[];
  /** Units of the stop's `buy` items taken aboard, all told, and the credits that cost: what left the wallet, tax included. */
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

/** What a stop took, and the later bid each item was taken for with that book's age:
 * `took 2 dark_matter_residue for sirius_observatory_station's 1020 bid (remembered, 85 ticks old)`.
 * Grouped by the later base; past two kinds a group is `N of K kinds`. A later stop with no known
 * book names no bid. */
function carried(took:readonly {item_id:string;quantity:number}[],later:readonly (Book|undefined)[]):string[] {
  const groups=new Map<Book|undefined,{item_id:string;quantity:number}[]>();
  for(const row of took) {
    const bid=(book:Book|undefined)=>book?.items?.get(row.item_id)?.best_buy??0;
    const target=later.filter(book=>bid(book)>0).sort((a,b)=>bid(b)-bid(a))[0];
    groups.set(target,[...groups.get(target)??[],row]);
  }
  return [...groups].map(([book,rows])=>`took ${rows.length>2?`${rows.reduce((sum,row)=>sum+row.quantity,0)} of ${rows.length} kinds`
    :rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ')}${!book?'':rows.length===1
    ?` for ${book.base_id}'s ${book.items!.get(rows[0]!.item_id)!.best_buy} bid (${aged(book)})`:` for ${book.base_id}'s bids (${aged(book)})`}`);
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
  return job<Traded>('tradeRun',route.map(stop=>items(stop).length?`${stop.at} (${items(stop).join(', ')})`:stop.at).join(' → '),async()=>{
    const stops:Visit[]=[];
    let earned=0,spent=0,fuel=0,fuelPrice:number|undefined;
    const priced=async()=>{try {fuelPrice??=Number(details(await command('spacemolt/get_base',{})).fuel_price_all_in??1);} catch {/* read at the next stop */}};
    // Every book known off the rest of the route, as of the last stop read.
    let elsewhere:Book[]=[];
    const detail=():Traded=>({stops,unsold:unsoldWhy(Object.entries(miningInventory(acct().state)).filter(([,quantity])=>quantity>0)
      .map(([item_id,quantity])=>({item_id,quantity})),elsewhere),fuel,net:Math.round(earned-spent-fuel*(fuelPrice??0))});
    const blocked=await admit('tradeRun');
    if(blocked)return {status:'refused',did:'ran no trade',why:blocked,detail:detail()};
    if(!route.length)return {status:'refused',did:'ran no trade',why:'no stops: pass {stops:[{at, buy?}, …]}',detail:detail()};
    // What each stop reached did, as the did says it: rendered at the stop, against the book read there.
    const told:string[]=[];
    const said=()=>told.join(' → ');
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
      catch(error) {short.push(`${here}: no market (${error instanceof Error?error.message:String(error)})`);visit.why=short.at(-1);told.push(`${here}: nothing`);continue;}
      const later=route.slice(i+1).map(next=>next.at);
      const hold=miningInventory(acct().state);
      const known=byBase({base_id:here,source:'here',age:0,items:listed},
        await farBooks(here,marketTick()));
      elsewhere=[...known.values()].filter(book=>book.base_id!==here&&!later.includes(book.base_id));
      const wanted=items(stop),store=stop.from==='store'?await storeRows():[];
      const stored=(item:string)=>store.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);
      // ponytail: one tax read for the stop, on its first item: every rate read live is the station's.
      const [leg]=plan(hold,cargo(),[
        {book:known.get(here)!,buy:wanted,...stop.quantity===undefined?{}:{quantity:stop.quantity},
          ...stop.from==='store'?{asks:Object.fromEntries(wanted.map(item=>[item,stored(item)?[{price_each:0,quantity:stored(item)}]:[]]))}:{},
          rate:wanted.length&&stop.from!=='store'?await taxRate(wanted[0]!):0},
        ...later.map(base=>({book:known.get(base)??{base_id:base,source:'remembered' as const,age:0},rate:null}))],elsewhere).legs;
      if(leg!.sold.length) {
        const sold=await sell(leg!.sold.map(({item_id,quantity})=>({item_id,quantity})));
        visit.sold=sold.detail?.fills??[];earned+=sold.detail?.total??0;
        if(sold.status!=='done')short.push(`${here}: ${sold.why??sold.did}`);
      }
      if(wanted.length&&!leg!.buys.length)notes.push(`took no ${wanted.join(', ')}: nothing ${stop.from==='store'?'in the store':'on the asks'} here beats the best known bid later on the route`);
      const loaded:{item_id:string;quantity:number}[]=[];
      for(const {item_id,quantity} of leg!.buys) {
        const want=Math.min(quantity,cargo());
        if(!want)notes.push(`took no ${item_id}: no room left after the sales`);
        else if(stop.from==='store') {
          const took=await withdraw([{item_id,quantity:want}]);
          const moved=took.detail?.moved.reduce((sum,row)=>sum+row.quantity,0)??0;
          visit.bought+=moved;if(moved)loaded.push({item_id,quantity:moved});
          if(!moved)short.push(`${here}: withdrew no ${item_id}: ${took.why??took.did}`);
        } else {
          const got=await buy(item_id,want);
          // The wallet, not `total_cost`: the reply's cost is the subtotal, and the tax is on top.
          const n=Number(got.detail?.bought?.quantity??0);
          visit.bought+=n;visit.spent+=got.cost.credits;spent+=got.cost.credits;if(n)loaded.push({item_id,quantity:n});
          if(got.status!=='done')short.push(`${here}: ${got.why??got.did}`);
        }
      }
      const why=[...short.filter(line=>line.startsWith(`${here}:`)),...notes].join('; ');
      if(why)visit.why=why;
      told.push(`${here}: ${[...visit.sold.map(fill=>`sold ${fill.quantity_sold} ${fill.item_id}${slipped(listed.get(fill.item_id),Number(fill.quantity_sold),Number(fill.total_earned))}`),
        ...carried(loaded,later.map(base=>known.get(base)))].join(', ')||'nothing'}`);
    }
    const end=detail();
    const did=`${said()} — net ${end.net} cr after ${fuel} fuel at ${fuelPrice??0} cr`
      +(end.unsold.length?`; unsold: ${end.unsold.map(row=>`${row.quantity} ${row.item_id}${row.why?` (${row.why})`:''}`).join(', ')}`:'');
    if(short.length)return {status:'partial',did,why:short.join('; '),detail:end,next:[runCall(route)]};
    // Pasteable calls only. A route that bought something may pay again while the spread holds; a
    // route that only sold the hold has nothing left to do, so the next move is a new search.
    const again=end.net>0&&route.some(stop=>items(stop).length&&stop.from!=='store');
    return {status:'done',did,detail:end,next:again?[runCall(route),'routes()']:['routes()']};
  });
}

/** How far `routes()` looks unless told: `STOPS` stops, each leg at most `LEG_JUMPS` jumps, no cap
 * on the whole. A local cycle; a galaxy tour is the same call with larger numbers, up to `MAX_STOPS`. */
export const STOPS=4,LEG_JUMPS=3,MAX_STOPS=10;
/** ponytail: the search grows routes one stop at a time, keeping the best BEAM at each length, and
 * branches on bases only (the plan picks the items), so it plans about `maxStops × BEAM × bases`
 * routes, a circuit's three laps each. All CPU: distances are the one `get_map` read. Measured on 40
 * books of 50 items, every one tradeable: a 3-lap plan is ~0.7 ms at 4 stops and ~1.4 ms at 10, so
 * ~4 s for a default circuit search and ~20 s for a 10-stop tour, at worst. A route that pays only
 * through a prefix ranked past BEAM is never seen; raise it if a tour search stays fast. The search
 * yields to the event loop every SLICE_MS, so the bridge's freighters and commands stall at most a
 * slice, not the whole search; move it to a worker thread if the total time ever matters. */
const BEAM=20;
/** Longest synchronous stretch of the route search, in ms, before it lets the event loop run. */
const SLICE_MS=15;
/** Rows returned. */
const ROWS=5;
/** ponytail: a base whose system neither the memory nor `places.json` kept (a ledger entry, a
 * pre-system memory) is placed with one `find_route` each, at most 5 per call, and the place is
 * kept; past that its routes are unpriced rows until a later call places it. */
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

/** Where `bases` are and how many jumps apart: each one's system from its far book, else from one
 * `find_route` (at most `UNPLACED` a call, each kept in `places.json`), jumps over the `get_map`
 * links, and the fuel a jump burns from one quote. `hop` is null where a base is unplaced or the map
 * does not join the two; `lost` says why. What `routes()` and `spreads()` both price a trip by. */
async function chart(here:string,bases:readonly string[],far:readonly FarBook[],seat:Seat) {
  // Where each base is: the memory's system, else one find_route (which also prices a jump).
  const systems=new Map<string,string>([[here,seat.account.state.location?.system_id??'']]);
  // A mobile base (one a freighter found moved) is never placed from memory: find_route says where it is now.
  const mobile=seat.runtime?readMobile(seat.runtime):new Set<string>();
  for(const row of far)if(row.system_id&&!mobile.has(row.base_id))systems.set(row.base_id,row.system_id);
  const lost=new Map<string,string>();
  let perJump:number|undefined;
  const place=async(base:string)=>{
    seat.stop();
    try {
      const quote=details(await seat.command('spacemolt/find_route',{id:base})) as FindRouteResponse,dir=seat.runtime;
      if(!quote.found||!quote.target_system)throw new Error(`no system, POI or base is named ${base}`);
      systems.set(base,quote.target_system);perJump??=Number(quote.fuel_per_jump??0);
      if(dir)markPlace(dir,base,quote.target_system);
    }
    catch(error) {lost.set(base,error instanceof Error?error.message:String(error));}
  };
  const unplaced=bases.filter(base=>!systems.has(base));
  for(const base of unplaced.slice(0,UNPLACED))await place(base);
  const later=unplaced.slice(UNPLACED);
  for(const base of later)lost.set(base,`not placed yet: past the ${UNPLACED} find_route lookups one call makes`);
  const away=bases.filter(base=>systems.has(base)&&base!==here);
  if(perJump===undefined&&away.length)await place(away[0]!);
  const links=new Map<string,string[]>();
  if(away.length)try {
    for(const row of (details(await seat.command('spacemolt/get_map',{})) as {systems?:MapSystemInfo[]}).systems??[])
      links.set(row.system_id,row.connections??[]);
  } catch {/* no map: every far stop is unpriced, and says so */}
  const counted=new Map<string,number|null>();
  const jumps=(from:string,to:string):number|null=>{
    const key=`${from}>${to}`;
    if(!counted.has(key))counted.set(key,hops(links,from,to));
    return counted.get(key)!;
  };
  /** Jumps between two bases; null when either is unplaced or the map does not join them. */
  const hop=(a:string,b:string)=>{const from=systems.get(a),to=systems.get(b);return from===undefined||to===undefined?null:jumps(from,to);};
  return {hop,perJump:perJump??0,lost,later,systems};
}

/** A route as `routes()` ranks it: the plan from the hold you have, with the trip priced. */
export interface Route extends Plan {
  /** Jumps from here through every stop, from the map; null when a stop could not be placed. */
  total_jumps:number|null;
  /** Fuel units: `total_jumps × fuel_per_jump`. Null when the trip is unpriced. */
  fuel:number|null;
  /** `0.5 ^ (sum of the stops' book ages / HALF_LIFE)`: 1 when every book is live. */
  confidence:number;
  /** What rows are ranked by: `max(confidence, 1/64) × net / max(1, total_jumps)`. 0 for an unpriced trip. */
  score:number;
  /** The call to paste. */
  next:string;
  /** What this row could not know: an unplaced stop, an unknown tax, a far stop's tax estimated at this base's rate. */
  why?:string;
  /** Present on a `routes({circuit})` row: the lap to hand a freighter. */
  circuit?:Circuit;
}

/** One item a circuit stop takes on: up to `qty` aboard, at asks of at most `max_price`. */
export interface CircuitBuy {item:string;qty:number;max_price:number}
/** A closed lap a freighter repeats: `routes({circuit:{hold}})` plans it, `assign` hands it over.
 * Each stop sells its `sell` items at bids of at least `min_price`, then buys each of its `buys`
 * up to its `qty` at asks of at most its `max_price`; the last stop is followed by the first. */
export interface Circuit {closed:true;
  /** The hold the lap was planned for, starting empty. */
  hold:number;
  /** Jumps round the whole lap, last stop back to the first included. */
  lap_jumps:number;
  /** The steady-state lap's revenue less cost, tax and fuel. */
  lap_net:number;
  stops:readonly {at:string;system_id:string;buys?:readonly CircuitBuy[];
    /** The one-item form a circuit had before `buys`: an entry or script written then still flies, read as `buys:[buy]`. */
    buy?:CircuitBuy;
    sell:readonly {item:string;min_price:number}[]}[];
  /** The scope `routes()` planned it within, so `reassign` plans the next one alike. */
  scope?:Scope}
/** What a circuit stop takes on, whichever form it was written in. */
export const buysOf=(stop:Circuit['stops'][number]):readonly CircuitBuy[]=>stop.buys??(stop.buy?[stop.buy]:[]);
/** How far `routes()` searches: stops per route or lap, jumps per leg, jumps all told. */
export interface Scope {maxStops?:number;maxLegJumps?:number;maxJumps?:number}
/** ponytail: ticks a ring rests after a freighter parked on it drained (no trade, or losing laps),
 * before `routes({circuit})` plans it again: an hour at ten seconds a tick. Unmeasured: tune it
 * once a drained ring's books are watched refilling live. */
export const REST_TICKS=360;
/** ponytail: a lap's prices carry 10% of slack against the planned average — a buy up to 10%
 * over it, a sale down to 10% under it — so a book that moves a little does not stop the lap. Tunable. */
const SLACK=0.1;

/** Every route worth flying over what this pilot knows — the live book here, the faction ledger,
 * the remembered books — from the hold you have, ranked by trust-weighted net per jump. The search
 * picks only the bases, in order: at every stop the plan sells and fills the hold by the rule
 * `tradeRun` runs, so what ranks is what runs. `items` narrows what is taken on; goods aboard are
 * always weighed. `maxStops` (default `STOPS`, at most `MAX_STOPS`), `maxLegJumps` (default
 * `LEG_JUMPS`) and `maxJumps` (default none; round the lap for a circuit) set how far it looks: a
 * short cycle by default, a galaxy tour with larger numbers.
 * Reads only. Jumps come from `get_map` and each base's system, which the market memory keeps;
 * fuel per jump from one `find_route`. A stop that could not be placed is a row with a `why` and
 * the Outcome `partial`, never a throw. Refused when not docked.
 *
 * ponytail: goods in this base's store are not weighed; `tradeRun` takes them with `from:'store'`. */
export function routes(opts:RouteOpts={}):Promise<Outcome<{routes:Route[];sources:string[]}>> {
  return job<{routes:Route[];sources:string[]}>('routes',(opts.items??[]).join(' '),()=>search(pilotSeat(),opts));
}
export type RouteOpts={items?:string[];circuit?:{hold:number}}&Scope;

/** `routes()` itself, read through `seat`: the one planner, whether the pilot or a freighter's host asks. */
export async function search(seat:Seat,opts:RouteOpts={}):Promise<Said<{routes:Route[];sources:string[]}>> {
  const none={routes:[] as Route[],sources:[] as string[]};
  const here=seat.account.state.location?.docked_at,circuit=opts.circuit;
  if(!here)return {status:'refused',did:'ranked no routes',why:'not docked; a market is a station counter',
    detail:none,next:['goTo a base, then routes()']};
  if(circuit&&!(circuit.hold>0&&Number.isFinite(circuit.hold)))return {status:'refused',did:'ranked no routes',
    why:`circuit.hold ${circuit.hold} is not a positive number of units`,detail:none};
  const most=opts.maxStops??STOPS,legCap=opts.maxLegJumps??LEG_JUMPS,cap=opts.maxJumps??Infinity;
  if(!(Number.isInteger(most)&&most>=(circuit?2:1)&&most<=MAX_STOPS)||!(legCap>=0)||!(cap>=0))return {status:'refused',did:'ranked no routes',
    why:`maxStops ${most}, maxLegJumps ${legCap}, maxJumps ${cap}: maxStops is a whole number from ${circuit?2:1} to ${MAX_STOPS}, and jumps are 0 or more`,detail:none};
  const scope:Scope={maxStops:most,maxLegJumps:legCap,...Number.isFinite(cap)?{maxJumps:cap}:{}};
  const free=cargo(seat.account),aboard=miningInventory(seat.account.state);
  const {items:listed,tick:now}=await seat.book();
  const far=await farBooks(here,now,seat);
  const known=byBase({base_id:here,source:'here',age:0,items:listed},far);
  const sources=[...new Set([...known.values()].map(row=>row.source))];
  const probe=[...listed.values()].find(row=>row.best_sell>0);
  const rate=probe?await taxRate(probe.item_id,seat.command):null;

  const {hop,perJump,lost,later,systems}=await chart(here,[...known.keys()],far,seat);
  const fuelPrice=Number(details(await seat.command('spacemolt/get_base',{})).fuel_price_all_in??1);

  // What each base may sell you: an asked item, `items` allowing, that some known book bids more for than its ask plus tax.
  const wanted=(item:string)=>!opts.items?.length||opts.items.includes(item);
  const bid=new Map<string,number>();
  for(const book of known.values())for(const row of book.items!.values())bid.set(row.item_id,Math.max(bid.get(row.item_id)??0,row.best_buy));
  const offers=new Map([...known].map(([at,book])=>[at,[...book.items!.values()].filter(row=>wanted(row.item_id)
    &&levels(row,'asks').length&&(bid.get(row.item_id)??0)>unit(levels(row,'asks'),1)*(1+(rate??0))).map(row=>row.item_id)]));
  const stopAt=(at:string):PlanStop=>({book:known.get(at)!,buy:offers.get(at)!,rate});
  const offRoute=(ats:readonly string[])=>[...known.values()].filter(book=>!ats.includes(book.base_id));

  const taxWhy=(planned:Pick<Plan,'legs'|'sales_tax'>)=>planned.sales_tax===null?['sales tax not known; net is untaxed']
    :planned.legs.filter(leg=>leg.bought&&leg.at!==here).map(leg=>`tax at ${leg.at} estimated at ${here}'s ${Math.round(rate!*10_000)} bps`);
  const confidence=(ats:readonly string[])=>trust([...new Set(ats)].reduce((sum,base)=>sum+known.get(base)!.age,0));
  /** A leg's buys as a stop of the call to paste. */
  const runStop=(leg:Leg):RunStop=>({at:leg.at,...leg.buys.length===1?{buy:leg.buys[0]!.item_id}:leg.buys.length?{buy:leg.buys.map(row=>row.item_id)}:{}});
  const evaluate=(ats:string[]):Route=>{
    // Only the docked base's rate is readable; it stands in for every far stop's.
    const planned=plan(aboard,free,ats.map(stopAt),offRoute(ats));
    const why:string[]=[];
    let total:number|null=0,from=here;
    for(const at of ats) {
      const n=hop(from,at);
      if(n===null){why.push(`no route to ${at}${lost.has(at)?`: ${lost.get(at)}`:' on the map'}; fuel not priced`);total=null;break;}
      total+=n;from=at;
    }
    why.push(...taxWhy(planned));
    const fuel=total===null?null:total*perJump;
    const net=Math.round(planned.net-(fuel??0)*fuelPrice);
    const trusted=confidence(ats);
    return {...planned,total_jumps:total,fuel,net,confidence:trusted,score:rank(trusted,net,total),
      next:runCall(planned.legs.map(runStop)),...why.length?{why:why.join('; ')}:{}};
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
  const middleOf=(ats:string[])=>plan({},circuit!.hold,[...ats,...ats,...ats].map(stopAt),offRoute(ats)).legs.slice(ats.length,2*ats.length);
  const lapOf=(given:string[]):Route=>{
    // Where the lap first buys is only known once planned: a stop the plan gives no buy may be first.
    const tried=middleOf(given),first=Math.max(0,tried.findIndex(leg=>leg.bought)),ats=[...given.slice(first),...given.slice(0,first)];
    const n=ats.length,hold=circuit!.hold,middle=first?middleOf(ats):tried,sales=middle.flatMap(leg=>leg.sold),buys=middle.flatMap(leg=>leg.buys);
    const count=(rows:readonly {item_id:string;quantity:number}[],item:string)=>rows.filter(row=>row.item_id===item).reduce((sum,row)=>sum+row.quantity,0);
    const both=new Map([...sales,...buys].map(row=>[row.item_id,Math.min(count(sales,row.item_id),count(buys,row.item_id))]));
    const allot=<T extends {item_id:string;quantity:number},>(rows:T[],each:(row:T)=>number)=>{
      const left=new Map(both);
      return new Map(rows.toSorted((a,b)=>each(a)-each(b)).map(row=>{
        const take=Math.min(row.quantity,left.get(row.item_id)!);left.set(row.item_id,left.get(row.item_id)!-take);return [row,take];}));
    };
    const keptSales=allot(sales,sale=>-sale.revenue/sale.quantity),keptBuys=allot(buys,buy=>buy.cost/buy.quantity);
    const legs=middle.map((leg):Leg=>{
      const took=leg.buys.map(buy=>{const quantity=keptBuys.get(buy)!;return {...buy,quantity,cost:buy.cost*quantity/buy.quantity};}).filter(buy=>buy.quantity>0);
      return {...leg,sold:leg.sold.map(sale=>{const quantity=keptSales.get(sale)!;return {...sale,quantity,revenue:sale.revenue*quantity/sale.quantity};})
        .filter(sale=>sale.quantity>0),buys:took,bought:took.reduce((sum,buy)=>sum+buy.quantity,0),
        cost:took.reduce((sum,buy)=>sum+buy.cost,0),sales_tax:leg.sales_tax===null?null:taxOn(took,rate??0)};
    });
    let lap:number|null=0;
    for(const [i,at] of ats.entries()) {
      const next=hop(at,ats[(i+1)%n]!);
      if(next===null){lap=null;break;}
      lap+=next;
    }
    const sum=(part:(leg:Leg)=>number)=>legs.reduce((total,leg)=>total+part(leg),0);
    const revenue=sum(leg=>leg.sold.reduce((total,sale)=>total+sale.revenue,0)),cost=sum(leg=>leg.cost),tax=sum(leg=>leg.sales_tax??0);
    const sales_tax=legs.some(leg=>leg.sales_tax===null)?null:tax,fuel=lap===null?null:lap*perJump;
    const lap_net=Math.round(revenue-cost-tax-(fuel??0)*fuelPrice),trusted=confidence(ats),why=taxWhy({legs,sales_tax});
    const closed:Circuit={closed:true,hold,lap_jumps:lap??0,lap_net,stops:ats.map((at,i)=>{
      const leg=legs[i]!;
      return {at,system_id:systems.get(at)??'',
        buys:leg.buys.map(buy=>({item:buy.item_id,qty:buy.quantity,max_price:Math.ceil((1+SLACK)*buy.cost/buy.quantity-1e-9)})),
        sell:leg.sold.map(sale=>({item:sale.item_id,min_price:Math.floor((1-SLACK)*sale.revenue/sale.quantity+1e-9)}))};
    }),scope};
    return {legs,unsold:[],revenue,cost,sales_tax,net:lap_net,total_jumps:lap,fuel,confidence:trusted,
      score:rank(trusted,lap_net,lap),next:`assign('freighter', ${literal(closed)}, {float:20000})`,
      ...why.length?{why:why.join('; ')}:{},circuit:closed};
  };

  const found=new Map<string,Route>();
  // A ring a freighter drained within REST_TICKS is not planned: its books are still refilling.
  const dir=seat.runtime,drained=circuit&&dir?readDrained(dir):{},skipped=new Set<string>();
  const resting=(key:string)=>drained[key]!==undefined&&ticksOld(drained[key],now)<REST_TICKS;
  const stopsOf=(ats:readonly string[])=>ats.map(at=>({at}));
  // A route pays, and every stop on it does something: a stop that neither sells nor buys is only fuel.
  // A circuit pays once round a whole lap, fuel and all, the hop home and the lap within scope. One
  // ring of bases is one circuit: its rotations rank as the best of them alone.
  const keep=(ats:string[]):Route|undefined=>{
    if(circuit&&resting(ring(stopsOf(ats)))){skipped.add(ring(stopsOf(ats)));return undefined;}
    const row=circuit?lapOf(ats):evaluate(ats),trades=row.legs.every(leg=>leg.sold.length||leg.bought);
    const home=circuit?hop(ats.at(-1)!,ats[0]!):0;
    const pays=trades&&(circuit?row.total_jumps!==null&&row.net>0&&row.total_jumps<=cap&&home!==null&&home<=legCap:row.revenue>row.cost);
    const key=circuit?ring(stopsOf(ats)):row.next;
    if(pays&&!((found.get(key)?.score??-Infinity)>=row.score))found.set(key,row);
    return row;
  };
  // Breadth-first over base lists: each grows by one base within a leg's and the whole trip's jumps.
  // An open route counts its jumps from here; a lap only between its stops. An unplaced hop cannot
  // be counted, so it is not capped: its row says so, and a lap through it is never kept.
  type Grown={ats:string[];jumps:number|null};
  const within=(from:Grown|undefined,at:string):Grown|undefined=>{
    const n=from?hop(from.ats.at(-1)!,at):circuit?0:hop(here,at);
    if(n!==null&&n>legCap)return undefined;
    const total=from?.jumps===null||n===null?null:(from?.jumps??0)+n;
    return total!==null&&total>cap?undefined:{ats:[...from?.ats??[],at],jumps:total};
  };
  // Every plan is CPU: past a slice, let the bridge's other work run, then go on (or stop, if told).
  let sliced=performance.now();
  const breathe=async()=>{
    if(performance.now()-sliced<SLICE_MS)return;
    await new Promise(done=>setImmediate(done));
    seat.stop();sliced=performance.now();
  };
  let beam=[...known.keys()].flatMap(at=>within(undefined,at)??[]);
  // A circuit is 2 or more distinct bases, so one stop alone is only a seed.
  if(!circuit)for(const seed of beam){await breathe();keep(seed.ats);}
  for(let length=2;length<=most;length++) {
    seat.stop();
    const grown:{route:Grown;score:number}[]=[];
    for(const from of beam)for(const at of known.keys()) {
      if(at===from.ats.at(-1)||circuit&&from.ats.includes(at))continue;
      const route=within(from,at);
      if(!route)continue;
      await breathe();
      const row=keep(route.ats);
      // A lap that does not pay yet may round into one that does; an open route grows only from one that pays.
      if(circuit||row&&row.revenue>row.cost)grown.push({route,score:row?.score??-Infinity});
    }
    beam=grown.sort((a,b)=>b.score-a.score).slice(0,BEAM).map(row=>row.route);
  }

  const rested=skipped.size?`; skipped ${skipped.size} ring(s) a freighter drained within ${REST_TICKS} ticks: ${[...skipped].join('; ')}`:'';
  const missed=[...lost.keys()];
  const unknown=missed.length?`; ${missed.length} base(s) could not be placed, so no priced route goes there: ${missed.slice(0,5).join(', ')}${missed.length>5?', …':''}`
    +(later.length?` (${later.length} past this call's ${UNPLACED} lookups; each place found is kept, so routes() again places the next ${UNPLACED})`:''):'';
  const rows=[...found.values()].sort((a,b)=>Number(a.total_jumps===null)-Number(b.total_jumps===null)||b.score-a.score).slice(0,ROWS);
  if(!rows.length)return {status:'done',did:`no route pays across ${known.size} book(s) (${sources.join(' + ')}) from this hold within ${most} stops, ${legCap} jumps a leg${Number.isFinite(cap)?` and ${cap} in all`:''}${rested}${unknown}`,
    detail:{routes:[],sources},next:['goTo another base and prices() there to learn its book']};
  const failed=rows.filter(row=>row.total_jumps===null);
  // Short: a hold of ten kinds is `sell 499 of 10 kinds`; the legs in `detail` carry the rest.
  const kinds=(verb:string,rows:readonly {item_id:string;quantity:number}[])=>rows.length>2
    ?[`${verb} ${rows.reduce((sum,row)=>sum+row.quantity,0)} of ${rows.length} kinds`]:rows.map(row=>`${verb} ${row.quantity} ${row.item_id}`);
  // Each far stop's book age, in the words: a route planned on a book that has since moved is
  // bought on a memory (live 2026-10-01, kvothe 16:10Z: 2 dark_matter_residue at 690 for a bid gone by arrival).
  const says=(row:Route)=>row.legs.map(leg=>[leg.source==='here'?leg.at:`${leg.at} (${aged(leg)})`,...kinds('sell',leg.sold),...kinds('buy',leg.buys)].join(' ')).join(' → ');
  return {status:failed.length?'partial':'done',
    did:`ranked ${rows.length} route(s) over ${known.size} book(s) (${sources.join(' + ')}); best: ${says(rows[0]!)}, net ${rows[0]!.net} cr${rested}${unknown}`,
    ...failed.length?{why:failed.map(row=>`${says(row)}: ${row.why}`).join('; ')}:{},
    detail:{routes:rows,sources},next:rows.slice(0,3).map(row=>row.next)};
}
