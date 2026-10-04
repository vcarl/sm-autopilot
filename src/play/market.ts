/** The market counter at the base you are docked at. Prices are read live at the moment of
 * the act, never from a plan. */
import type {BuyResponse,EstimatePurchaseResponse,MarketListingItem,SellResponse,ViewMarketResponse,ViewStorageResponse} from '@spacemolt/lib';
import {Effect,Result} from 'effect';
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {disposable,miningInventory} from '../mining-inventory.ts';
import {markPlace} from './places.ts';
import {fileIntelEffect} from '../trade-intel.ts';
import {quoteNext} from '../run-record.ts';
import {listing,words} from '../servicing.ts';
import {replyBody,rows} from '../storage.ts';
import {counterEffect} from './counter.ts';
import {Game,attempt,field,message} from './game.ts';
import {bench,moduleSpec,room,whyNotFit} from './hangar.ts';
import {Stopped,acct,admit,edge,jobEffect,pilot,reached,runtimeDir,step,stopped,wanted} from './runtime.ts';
import {withdraw} from './storage.ts';
import {num} from './rows.ts';
import type {Outcome,Row,Want} from './types.ts';

/** The lib's per-item book (`best_buy`, `best_buy_qty`, `best_sell`, `best_sell_qty`,
 * `spread`) plus your own position, which the market does not know. */
export type Quote=MarketListingItem&{held:number;stored:number};

const CAP=40;
/** The counter, or why the job broke: a dock that was blocked is the job's failure, as a throw always was. */
const atCounter=()=>counterEffect().pipe(Effect.catchTag('DockBlocked',blocked=>Effect.succeed({broke:blocked.message})));

// The frozen surface promises the lib's reply types; the live body is not decoded whole, because the server omits spec fields.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asEstimate=(body:unknown)=>body as EstimatePurchaseResponse; // cast: frozen surface (EstimatePurchaseResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asBuy=(body:unknown)=>body as BuyResponse; // cast: frozen surface (BuyResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asSell=(body:unknown)=>body as SellResponse; // cast: frozen surface (SellResponse)

/** A book this pilot has stood in front of, kept so the next base knows what the last one
 * paid. The game publishes no cross-station prices — `view_market` and `analyze_market` are
 * both "here" — so memory is the only far price a factionless pilot can have. */
export interface RememberedBook {base_id:string;at:string;tick?:number;
  /** The system the base is in, as the ship stood there: what lets `routes()` count jumps between
   * two far bases from the map alone. Absent on entries written before it was kept. */
  system_id?:string;items:MarketListingItem[]}
const MEMORY='markets.json';
/** A book older than this many ticks (a day at ten seconds a tick) is dropped at the next
 * write. NPC books move rarely, so a day-old price is still a lead; a week-old one is not. */
const MEMORY_TICKS=8640;
/** ponytail: 40 whole books is ~8 MB of JSON read on every `knownBooks()`; the count is only a
 * size ceiling now that age is the evictor. Store top levels only if the read ever shows up. */
const BASES=40;
/** How old an entry written before books carried a tick is taken to be. An assumption for
 * pre-ageing files, not a measurement: old enough for the pilot to distrust, not old enough
 * to be worth dropping a price nothing else can supply. */
export const LEGACY_AGE=20;
/** Age in ticks, computed at read and never stored. An untagged entry reads as `LEGACY_AGE`.
 * A tick that ran backwards — server restart, season rollover — would read as a negative age,
 * which is nonsense to hand a pilot, so it clamps to 0: "as fresh as this call". */
export const ticksOld=(tick:number|undefined,now:number):number=>
  tick===undefined?LEGACY_AGE:Math.max(0,now-tick);

/** The best remembered bid for an item at a base other than `here`, with its age — the query
 * `sell`'s did and the menu's sell rows both ran per item against a fresh `knownBooks()` read
 * (an 8 MB parse each). Callers read `knownBooks()` once and pass the result in. */
export interface FarBid {base_id:string;best_buy:number;best_buy_qty:number;age:number}
export function bestFarBid(books:RememberedBook[],item_id:string,here:string|null|undefined,tick:number):FarBid|undefined {
  return books.filter(row=>row.base_id!==here)
    .flatMap(row=>row.items.filter(i=>i.item_id===item_id&&i.best_buy>0&&i.best_buy_qty>0)
      .map(i=>({base_id:row.base_id,best_buy:i.best_buy,best_buy_qty:i.best_buy_qty,age:ticksOld(row.tick,tick)})))
    .sort((a,b)=>b.best_buy-a.best_buy)[0];
}

/** The global tick from the last `view_market` reply this process read.
 * ponytail: process-local, and only sound read straight after a `book()` in the same job —
 * which is every consumer. Widen `book()`'s return if that stops being true. */
let lastTick=0;
export const marketTick=():number=>lastTick;

/** Every book read in this runtime dir, newest base first. Empty without a runtime. The
 * directory is an argument so a caller outside a bound run (the juncture's `factsNow`) can
 * read the same memory. */
export function knownBooks(dir=runtimeDir()):RememberedBook[] {
  if(!dir)return [];
  try {
    const stored:unknown=JSON.parse(readFileSync(join(dir,MEMORY),'utf8'));
    return rows(stored).flatMap(remembered);
  } catch {return [];} // edge: no memory yet, or a torn file, is no remembered book
}
/** One remembered book as the file has it, rebuilt from the fields read: a row with no base or no item list is dropped. */
const remembered=(raw:unknown):RememberedBook[]=>{
  const base_id=field(raw,'base_id'),items=field(raw,'items'),at=field(raw,'at'),tick=num(raw,'tick'),system=field(raw,'system_id');
  return typeof base_id==='string'&&base_id&&Array.isArray(items)
    ?[{base_id,at:typeof at==='string'?at:'',...tick===undefined?{}:{tick},...typeof system==='string'?{system_id:system}:{},items:items.flatMap(listing)}]:[];
};

/** Temp file then rename, as `writeRun` does: a torn write would price a trip on a lie.
 * Evicted by age (`MEMORY_TICKS`), newest first, capped at `BASES`. */
const remember=(base_id:string,items:MarketListingItem[],tick:number)=>
  rememberBook(runtimeDir(),base_id,acct().state.location?.system_id,items,tick);
/** Keep `base_id`'s book, read at `tick` in `system_id`, in `dir`'s market memory, and its place.
 * What `book()` does for the pilot, and a freighter's host for a book it scouted. */
export function rememberBook(dir:string|undefined,base_id:string,system_id:string|undefined,items:MarketListingItem[],tick:number):void {
  if(!dir||!base_id)return;
  markPlace(dir,base_id,system_id??'');
  const kept=[{base_id,at:new Date().toISOString(),tick,system_id,items},
    ...knownBooks(dir).filter(row=>row.base_id!==base_id&&ticksOld(row.tick,tick)<=MEMORY_TICKS)].slice(0,BASES);
  try {
    mkdirSync(dir,{recursive:true});
    const path=join(dir,MEMORY),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(kept),{mode:0o600});
    renameSync(temp,path);
  } catch {/* a market this pilot cannot remember is still a market it can trade at */} // edge: memory is a convenience; the file may be unwritable
}

/** The book here, whole, read once and filtered in memory: one 190 KB reply beats twenty
 * filtered ones against the rate limit, and the pilot never sees it. Every read is also
 * written to this runtime's market memory, which is what `spreads()` reads, and filed to the
 * faction's trade ledger once per tick when there is one. */
export const bookEffect=()=>Effect.gen(function*() {
  const reply=replyBody(yield* (yield* Game).command('spacemolt_market/view_market',{}));
  const items=rows(field(reply,'items')).flatMap(listing);
  lastTick=num(reply,'current_tick')??lastTick;
  const base=acct().state.location?.docked_at??'';
  remember(base,items,lastTick);
  yield* fileIntelEffect(acct(),base,items,lastTick,step);
  return new Map(items.map(item=>[item.item_id,item]));
});

/** What things are worth here. Default: every item in the hold and in this base's store.
 * Pass item ids for others. Capped at 40 rows. Over `view_market` it adds: the filter to
 * what you hold, your held/stored counts beside each book, and the cap. Reads only. `next`
 * names the best thing to sell here by `best_buy × min(best_buy_qty, held)`. */
export const pricesEffect=(items?:string[])=>jobEffect<{quotes:Quote[]},Game>('prices',(items??[]).join(' '),Effect.gen(function*() {
  const at=yield* atCounter();
  if('broke' in at)return {status:'failed',did:'prices broke',why:at.broke,detail:{quotes:[]}};
  if('refused' in at)return {status:'refused',did:'read no prices',why:at.refused,detail:{quotes:[]}};
  const held=miningInventory(acct().state);
  const stored:Record<string,number>={};
  // No store view is no stored count, said, not a failed read: the book is still worth quoting.
  const viewed=yield* Effect.result((yield* Game).command('spacemolt_storage/view',{}));
  if(Result.isFailure(viewed))step(`storage view failed, quoting stored as 0: ${words(viewed.failure)}`);
  else {
    let dropped=0;
    for(const row of rows(field(replyBody(viewed.success),'items'))) {
      const id=field(row,'item_id'),quantity=num(row,'quantity');
      if(typeof id==='string'&&quantity!==undefined)stored[id]=(stored[id]??0)+quantity;else dropped++;
    }
    if(dropped)step(`storage view: ${dropped} row(s) had no item_id and quantity; left out of the stored counts`);
  }
  const wanted=items?.length?items:[...new Set([...Object.keys(held),...Object.keys(stored)])];
  const listed=yield* bookEffect();
  const quotes:Quote[]=wanted.flatMap(id=>{const row=listed.get(id);return row?[{...row,held:held[id]??0,stored:stored[id]??0}]:[];}).slice(0,CAP);
  const missing=wanted.filter(id=>!listed.has(id));
  const best=quotes.map(q=>({q,value:q.best_buy*Math.min(q.best_buy_qty,q.held+q.stored)})).sort((a,b)=>b.value-a.value)[0];
  return {status:'done',did:`${quotes.length} of ${wanted.length} items are quoted here${missing.length?`; no book for ${missing.slice(0,5).join(', ')}`:''}`,
    detail:{quotes},next:best&&best.value>0?[`${best.q.item_id}: best buy ${best.q.best_buy} × ${Math.min(best.q.best_buy_qty,best.q.held+best.q.stored)} ≈ ${Math.round(best.value)} cr`]:[]};
}));
export function prices(items?:string[]):Promise<Outcome<{quotes:Quote[]}>> {return edge(pricesEffect(items));}

export interface Sold {
  base_id:string;
  /** One `SellResponse` per row that sold: `total_earned`, `quantity_sold`, `xp_gained`. */
  fills:SellResponse[];
  /** Not sold and why: `no buyer`, `under floor`, `not held`, or the game's refusal. */
  short:{item_id:string;requested:number;sold:number;why:string}[];
  total:number;
}

/** Sell the named rows at market price, here. The pilot names what it sells; nothing is
 * sold by default. Over `spacemolt/sell` it adds: the book read before anything moves so a
 * row with no buyer is never touched, `from:'store'` (withdraw and sell in hold-sized batches
 * until the named rows are gone), a per-item `floor` on `best_buy`, and the wallet measured
 * for `gained.credits`.
 *
 * - `items`: rows to sell; omit a row's `quantity` to mean all of it.
 * - `from:'store'`: take the rows out of the store here and sell them, one hold-load at a
 *   time, however many loads it takes. Rows with no buyer (or under `floor`) stay in the
 *   store, unwithdrawn, and `did` says so. Default `'hold'`.
 * - `floor`: per-item minimum `best_buy`; below it the row is skipped, not dumped.
 *
 * Trains trading (xp scales with credit volume). Not docked or no market here: `refused`. */
export const sellEffect=(items:Want[],opts:{from?:'hold'|'store';floor?:Record<string,number>}={})=>
  jobEffect<Sold,Game>('sell',items.map(row=>`${row.quantity??'all'} ${row.item_id}`).join(', ')+(opts.from==='store'?' from store':''),Effect.gen(function*() {
    const game=yield* Game;
    let docked=acct().state.location?.docked_at??'';
    const empty=():Sold=>({base_id:docked,fills:[],short:[],total:0});
    if(!items.length)return {status:'refused',did:'sold nothing',why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    const at=yield* atCounter();
    if('broke' in at)return {status:'failed',did:'sell broke',why:at.broke,detail:empty()};
    if('refused' in at)return {status:'refused',did:'sold nothing',why:at.refused,detail:empty()};
    docked=at.docked;
    const want=wanted(items);
    if('refused' in want)return {status:'refused',did:'sold nothing',why:want.refused,detail:empty()};
    const asked=want.rows;
    if(!asked.length)return {status:'refused',did:'sold nothing',why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    const listed=yield* bookEffect(),read_at=Date.now(),read_tick=marketTick();
    const fills:SellResponse[]=[],short:Sold['short']=[];
    // What each fill earned, by the row it sold: the reply's own item_id is not read.
    // `earned` is absent when the wallet could not say (a reply with no `total_earned`, a re-read that failed): no number is guessed.
    const landed:{item_id:string;quantity:number;earned?:number}[]=[];
    let total=0;
    // What the account held before the next sell, carried locally: the cached state is not advanced by a sale, so a re-read after a
    // lost reply is measured against this and not against a read made before an earlier row sold. Unknown credits stay unknown until re-anchored.
    const carried:{held:Record<string,number>;credits:number|undefined}={held:{},credits:undefined};
    const anchor=()=>{carried.held={...disposable(acct().state)};carried.credits=acct().state.player?.credits;};
    anchor();
    /** One row out of the hold, bounded by what is aboard; returns what the book took. */
    const sellRow=(row:Row)=>Effect.gen(function*() {
      if(stopped())return yield* Effect.fail(new Stopped());
      const held=carried.held[row.item_id]??0;
      const quantity=Math.min(row.quantity,held);
      const quote=listed.get(row.item_id);
      const floor=opts.floor?.[row.item_id];
      if(quantity<=0){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'not held'});return 0;}
      if(!quote||!(quote.best_buy>0)){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'no buyer'});return 0;}
      if(floor!==undefined&&quote.best_buy<floor){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:`under floor: best buy ${quote.best_buy} < ${floor}`});return 0;}
      quoteNext('spacemolt/sell',row.item_id,{bid:quote.best_buy,ask:quote.best_sell,book_tick:read_tick,
        age_s:Math.round((Date.now()-read_at)/100)/10});
      const sent=yield* Effect.result(game.command('spacemolt/sell',{id:row.item_id,quantity}));
      if(Result.isFailure(sent)) {
        const error=sent.failure;
        if(error._tag!=='ReplyLost'){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:words(error)});return 0;}
        // The sell may have landed: never re-sent. The hold and the wallet are re-read; a failed re-read is a gap said, not a failed job.
        const read=yield* Effect.result(game.refresh);
        if(Result.isFailure(read)) {
          const gap=`hold not re-read: ${message(read.failure.cause)}`;
          step(`sell ${row.item_id}: ${words(error)}; ${gap}; credits unknown from here`);
          carried.credits=undefined;
          short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:`${words(error)}; ${gap}`});
          return 0;
        }
        const credits=acct().state.player?.credits;
        const took=Math.max(0,held-(disposable(acct().state)[row.item_id]??0));
        const earned=carried.credits===undefined||credits===undefined?undefined:Math.max(0,credits-carried.credits);
        anchor();
        if(took>0){landed.push({item_id:row.item_id,quantity:took,...earned===undefined?{}:{earned}});total+=earned??0;
          step(`sell ${took} ${row.item_id} ${earned===undefined?'credits unknown':`+${earned} cr`} (reply lost; hold re-read)`);}
        if(took<quantity)short.push({item_id:row.item_id,requested:row.quantity,sold:took,
          why:`${words(error)}; hold re-read: ${took} sold${took>0&&earned===undefined?'; credits unknown':''}`});
        return took;
      }
      const fill=replyBody(sent.success),earned=num(fill,'total_earned'),took=num(fill,'quantity_sold')??quantity;
      fills.push(asSell(fill));total+=earned??0;landed.push({item_id:row.item_id,quantity:took,...earned===undefined?{}:{earned}});
      carried.held[row.item_id]=held-took;
      carried.credits=carried.credits===undefined||earned===undefined?undefined:carried.credits+earned;
      step(`sell ${took} ${row.item_id} +${earned??'?'} cr`);
      if(took<quantity)short.push({item_id:row.item_id,requested:row.quantity,sold:took,why:`book took ${took}`});
      return took;
    });
    if(opts.from==='store') {
      // The book decides what leaves the store at all: an unsellable row stays where it is.
      const left=new Map<string,number>();
      for(const row of asked) {
        const quote=listed.get(row.item_id),floor=opts.floor?.[row.item_id];
        if(!quote||!(quote.best_buy>0)){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'no buyer'});continue;}
        if(floor!==undefined&&quote.best_buy<floor){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:`under floor: best buy ${quote.best_buy} < ${floor}`});continue;}
        left.set(row.item_id,(left.get(row.item_id)??0)+row.quantity);
      }
      // One hold-load per pass: withdraw what fits, sell it, go back for the rest.
      let loads=0;
      while(left.size) {
        if(stopped())return yield* Effect.fail(new Stopped());
        const wanted=[...left].map(([item_id,quantity])=>Number.isFinite(quantity)?{item_id,quantity}:{item_id});
        const took=yield* attempt('withdraw',()=>withdraw(wanted)); // bridge: U13
        // A withdraw that broke or was stopped built no detail (`{}`): what it said is the sell's why.
        const out=reached(took);
        if(!loads&&(!out||took.status==='refused'&&!out.moved.length))
          return {status:out?'refused':took.status,did:'sold nothing',why:`withdraw first: ${took.why}`,detail:empty()};
        if(!out) {
          step(`withdraw ${took.status}: ${took.why??took.did}`);
          for(const [item_id,quantity] of left)short.push({item_id,requested:quantity,sold:0,why:`withdraw ${took.status}: ${took.why??took.did}`});
          break;
        }
        if(!out.moved.length)break;
        // A row the store came up short on is exhausted: sell what came out, then stop asking.
        anchor(); // the withdraw read the account afresh
        const emptied=out.short.filter(row=>row.why==='not in store').map(row=>row.item_id);
        for(const row of out.moved) {
          const sold=yield* sellRow(row);
          const rest=(left.get(row.item_id)??0)-sold;
          if(sold<row.quantity||rest<=0)left.delete(row.item_id);
          else left.set(row.item_id,rest);
        }
        for(const item of emptied)left.delete(item);
        loads++;
      }
    } else for(const row of asked)yield* sellRow(row);
    const detail:Sold={base_id:docked,fills,short,total};
    // Nothing named was held: the end state already holds, so it is said, not refused.
    const already=short.filter(row=>row.why==='not held');
    const blocked=short.filter(row=>!already.includes(row));
    const kept=opts.from==='store'?blocked.filter(row=>row.why==='no buyer'||row.why.startsWith('under floor')):[];
    const said=[...kept.length?[`left in the store: ${kept.map(row=>`${row.item_id} ${row.why}`).join(', ')}`]:[],
      ...already.length?[`nothing to sell: ${already.map(row=>`${row.item_id} not held`).join(', ')}`]:[]].join('; ');
    const why=blocked.map(row=>`${row.item_id}: ${row.why}`).join('; ');
    // A store sell yields one fill per item per hold-load, so summing by item_id before
    // joining is what keeps "sold 36 copper_ore, 8 iron_ore, 36 copper_ore, …" from repeating.
    const byItem=new Map<string,{quantity:number;earned:number;unknown:boolean}>();
    for(const fill of landed) {
      const row=byItem.get(fill.item_id)??{quantity:0,earned:0,unknown:false};
      row.quantity+=fill.quantity;row.earned+=fill.earned??0;row.unknown||=fill.earned===undefined;
      byItem.set(fill.item_id,row);
    }
    // The yardstick is a bid, not this book's ask: a sale at the bid is normally well under the
    // ask, so comparing to the ask fires on ordinary sells in any wide-spread book. A remembered
    // book elsewhere bidding materially more is the real tell.
    const MATERIAL=1.5;
    const books=knownBooks();
    const farBid=(item_id:string)=>bestFarBid(books,item_id,docked,read_tick);
    const sold=landed.length?`sold ${[...byItem].map(([item_id,{quantity,earned,unknown}])=>{
      if(unknown)return `${quantity} ${item_id} (credits unknown)`;
      const unit=quantity?Math.round(earned/quantity):0;
      const better=farBid(item_id);
      return `${quantity} ${item_id}`+(better&&better.best_buy>unit*MATERIAL
        ?` at ${unit} (${better.base_id} bid ${better.best_buy}, ${better.age} ticks ago)`:'');
    }).join(', ')} at ${docked} for ${[...byItem.values()].some(row=>row.unknown)?'at least ':''}${total} cr`
      :blocked.length?`sold nothing at ${docked}`:`nothing to sell at ${docked}`;
    return {status:blocked.length?(landed.length?'partial':'refused'):'done',
      did:said?`${sold}; ${said}`:sold,...why?{why}:{},detail};
  }));
export function sell(items:Want[],opts:{from?:'hold'|'store';floor?:Record<string,number>}={}):Promise<Outcome<Sold>> {return edge(sellEffect(items,opts));}

export interface Bought {
  /** The preview the spend was checked against (`total_cost`, `sales_tax`, `unfilled`). */
  estimate:EstimatePurchaseResponse;
  /** The fill, when one happened. */
  bought?:BuyResponse;
}

/** Buy at market price, here, after an `estimate_purchase` preview. Over `spacemolt/buy` it
 * adds: the estimate read first and refused when `total_cost` would take the wallet under
 * `permissions.credit_reserve` or over `maxEach × quantity`; the refusal names the numbers. A **module** is checked against the ship's grid first —
 * free slot of its kind, CPU and power — and refused when it could not be fitted, with
 * `next` saying what to remove; `{force:true}` skips that check for a pilot buying a spare.
 * Trains trading. Tired or Relaxed: refused. */
export const buyEffect=(itemId:string,quantity:number,opts:{deliverTo?:'cargo'|'storage';maxEach?:number;force?:boolean}={})=>
  jobEffect<Bought,Game>('buy',`${quantity} ${itemId}`,Effect.gen(function*() {
    const game=yield* Game;
    const none={estimate:asEstimate({})};
    // bridge: U31 (admit keeps its Promise form with the module singletons it reads)
    const stop=yield* attempt('buy',()=>admit('buy'));
    if(stop)return {status:'refused',did:`did not buy ${itemId}`,why:stop,detail:none};
    const at=yield* atCounter();
    if('broke' in at)return {status:'failed',did:'buy broke',why:at.broke,detail:none};
    if('refused' in at)return {status:'refused',did:`did not buy ${itemId}`,why:at.refused,detail:none};
    // A module that cannot be fitted is a dead 2,080 cr: the grid is checked before the buy.
    if(!opts.force) {
      // No spec is no fit check, said: the buy goes on to the estimate, as it did when the read was dropped silently.
      const read=yield* Effect.result(attempt('moduleSpec',()=>moduleSpec(itemId))); // bridge: U14
      if(Result.isFailure(read))step(`no fit check for ${itemId}: ${words(read.failure)}`);
      const spec=Result.isSuccess(read)?read.success:null;
      const why=spec&&whyNotFit(spec,bench());
      if(why) {
        const ship=acct().state.ship;
        return {status:'refused',did:`did not buy ${itemId}`,why,detail:none,
          next:[`refit({remove:[…]}) first, then buy`,`buy('${itemId}', ${quantity}, {force:true}) to hold it as a spare`,
            ...ship?[room(ship)]:[]]};
      }
    }
    const quote=replyBody(yield* game.command('spacemolt_market/estimate_purchase',{item_id:itemId,quantity}));
    const estimate=asEstimate(quote),available=num(quote,'available')??0,message=field(quote,'message');
    const who=pilot(),credits=acct().state.player?.credits??0;
    const reserve=who.permissions?.credit_reserve??0;
    const cost=num(quote,'total_cost')??0;
    if(!(available>0))return {status:'refused',did:`did not buy ${itemId}`,why:`not on this market: ${typeof message==='string'?message:'0 available'}`,detail:{estimate}};
    if(credits-cost<reserve)return {status:'refused',did:`did not buy ${itemId}`,why:`costs ${cost}; credits ${credits} less reserve ${reserve} leaves ${credits-reserve}`,detail:{estimate}};
    if(opts.maxEach!==undefined&&cost>opts.maxEach*quantity)return {status:'refused',did:`did not buy ${itemId}`,why:`costs ${cost}, over maxEach ${opts.maxEach} × ${quantity}`,detail:{estimate}};
    quoteNext('spacemolt/buy',itemId,{estimate_quantity:quantity,estimate_total:cost,estimate_available:available});
    // A refusal or a lost reply goes up to the job, named; the buy is never re-sent after a lost reply.
    const filled=replyBody(yield* game.command('spacemolt/buy',{id:itemId,quantity:Math.min(quantity,available),
      ...opts.deliverTo?{deliver_to:opts.deliverTo}:{}}));
    // The reply's `total_cost` is the subtotal; the tax on it is charged on top, floored.
    const subtotal=num(filled,'total_cost')??cost,tax=Math.floor(subtotal*(num(quote,'sales_tax_rate_bps')??0)/10_000);
    const unfilled=num(filled,'unfilled')??0;
    return {status:unfilled>0?'partial':'done',
      did:`bought ${num(filled,'quantity')??quantity} ${itemId} for ${subtotal+tax} cr${tax?` (${tax} of it tax)`:''}`,
      ...unfilled>0?{why:`${unfilled} unfilled`}:{},detail:{estimate,bought:asBuy(filled)}};
  }));
export function buy(itemId:string,quantity:number,opts:{deliverTo?:'cargo'|'storage';maxEach?:number;force?:boolean}={}):Promise<Outcome<Bought>> {return edge(buyEffect(itemId,quantity,opts));}
