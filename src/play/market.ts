/** The market counter at the base you are docked at. Prices are read live at the moment of
 * the act, never from a plan. */
import type {BuyResponse,EstimatePurchaseResponse,MarketListingItem,SellResponse,ViewMarketResponse,ViewStorageResponse} from '@spacemolt/lib';
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {miningInventory} from '../mining-inventory.ts';
import {details} from '../response-details.ts';
import {bench,moduleSpec,room,whyNotFit} from './hangar.ts';
import {acct,admit,checkStop,command,job,pilot,runtimeDir,step,wanted} from './runtime.ts';
import {withdraw} from './storage.ts';
import type {Outcome,Row,Want} from './types.ts';

/** The lib's per-item book (`best_buy`, `best_buy_qty`, `best_sell`, `best_sell_qty`,
 * `spread`) plus your own position, which the market does not know. */
export type Quote=MarketListingItem&{held:number;stored:number};

const CAP=40;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** A book this pilot has stood in front of, kept so the next base knows what the last one
 * paid. The game publishes no cross-station prices — `view_market` and `analyze_market` are
 * both "here" — so memory is the only far price a factionless pilot can have. */
export interface RememberedBook {base_id:string;at:string;items:MarketListingItem[]}
const MEMORY='markets.json',BASES=12;

/** Every book read in this runtime dir, newest base first. Empty without a runtime. */
export function knownBooks():RememberedBook[] {
  const dir=runtimeDir();
  if(!dir)return [];
  try {
    const stored=JSON.parse(readFileSync(join(dir,MEMORY),'utf8')) as RememberedBook[];
    return Array.isArray(stored)?stored.filter(row=>row?.base_id&&Array.isArray(row.items)):[];
  } catch {return [];}
}

/** Temp file then rename, as `writeRun` does: a torn write would price a trip on a lie.
 * ponytail: the last 12 bases, whole books. A pilot that walks a wider circuit than that
 * wants the oldest entry aged out by tick, not by count. */
function remember(base_id:string,items:MarketListingItem[]):void {
  const dir=runtimeDir();
  if(!dir||!base_id)return;
  const kept=[{base_id,at:new Date().toISOString(),items},...knownBooks().filter(row=>row.base_id!==base_id)].slice(0,BASES);
  try {
    mkdirSync(dir,{recursive:true});
    const path=join(dir,MEMORY),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,JSON.stringify(kept),{mode:0o600});
    renameSync(temp,path);
  } catch {/* a market this pilot cannot remember is still a market it can trade at */}
}

/** The book here, whole, read once and filtered in memory: one 190 KB reply beats twenty
 * filtered ones against the rate limit, and the pilot never sees it. Every read is also
 * written to this runtime's market memory, which is what `spreads()` reads. */
export async function book():Promise<Map<string,MarketListingItem>> {
  const reply=details(await command('spacemolt_market/view_market',{})) as ViewMarketResponse;
  const items=reply.items??[];
  remember(acct().state.location?.docked_at??'',items);
  return new Map(items.map(item=>[item.item_id,item]));
}

/** What things are worth here. Default: every item in the hold and in this base's store.
 * Pass item ids for others. Capped at 40 rows. Over `view_market` it adds: the filter to
 * what you hold, your held/stored counts beside each book, and the cap. Reads only. `next`
 * names the best thing to sell here by `best_buy × min(best_buy_qty, held)`. */
export function prices(items?:string[]):Promise<Outcome<{quotes:Quote[]}>> {
  return job<{quotes:Quote[]}>('prices',(items??[]).join(' '),async()=>{
    if(!acct().state.location?.docked_at)return {status:'refused',did:'read no prices',why:'not docked; a market is a station counter',detail:{quotes:[]}};
    const held=miningInventory(acct().state);
    let stored:Record<string,number>={};
    try {
      const store=details(await command('spacemolt_storage/view',{})) as ViewStorageResponse;
      for(const row of store.items??[])stored[row.item_id]=(stored[row.item_id]??0)+row.quantity;
    } catch {stored={};}
    const wanted=items?.length?items:[...new Set([...Object.keys(held),...Object.keys(stored)])];
    const listed=await book();
    const quotes:Quote[]=wanted.filter(id=>listed.has(id)).slice(0,CAP)
      .map(id=>({...listed.get(id)!,held:held[id]??0,stored:stored[id]??0}));
    const missing=wanted.filter(id=>!listed.has(id));
    const best=quotes.map(q=>({q,value:q.best_buy*Math.min(q.best_buy_qty,q.held+q.stored)})).sort((a,b)=>b.value-a.value)[0];
    return {status:'done',did:`${quotes.length} of ${wanted.length} items are quoted here${missing.length?`; no book for ${missing.slice(0,5).join(', ')}`:''}`,
      detail:{quotes},next:best&&best.value>0?[`${best.q.item_id}: best buy ${best.q.best_buy} × ${Math.min(best.q.best_buy_qty,best.q.held+best.q.stored)} ≈ ${Math.round(best.value)} cr`]:[]};
  });
}

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
export function sell(items:Want[],opts:{from?:'hold'|'store';floor?:Record<string,number>}={}):Promise<Outcome<Sold>> {
  return job<Sold>('sell',items.map(row=>`${row.quantity??'all'} ${row.item_id}`).join(', ')+(opts.from==='store'?' from store':''),async()=>{
    const docked=acct().state.location?.docked_at??'';
    const empty=():Sold=>({base_id:docked,fills:[],short:[],total:0});
    if(!items.length)return {status:'refused',did:'sold nothing',why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    if(!docked)return {status:'refused',did:'sold nothing',why:'not docked; a market is a station counter',detail:empty()};
    const want=wanted(items);
    if('refused' in want)return {status:'refused',did:'sold nothing',why:want.refused,detail:empty()};
    const asked=want.rows;
    if(!asked.length)return {status:'refused',did:'sold nothing',why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    const listed=await book();
    const fills:SellResponse[]=[],short:Sold['short']=[];
    let total=0;
    /** One row out of the hold, bounded by what is aboard; returns what the book took. */
    const sellRow=async(row:Row):Promise<number>=>{
      checkStop();
      const held=miningInventory(acct().state)[row.item_id]??0;
      const quantity=Math.min(row.quantity,held);
      const quote=listed.get(row.item_id);
      const floor=opts.floor?.[row.item_id];
      if(quantity<=0){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'not held'});return 0;}
      if(!quote||!(quote.best_buy>0)){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'no buyer'});return 0;}
      if(floor!==undefined&&quote.best_buy<floor){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:`under floor: best buy ${quote.best_buy} < ${floor}`});return 0;}
      try {
        const fill=details(await command('spacemolt/sell',{id:row.item_id,quantity})) as SellResponse;
        const took=Number(fill.quantity_sold??quantity);
        fills.push(fill);total+=Number(fill.total_earned??0);
        step(`sell ${took} ${row.item_id} +${fill.total_earned??'?'} cr`);
        if(took<quantity)short.push({item_id:row.item_id,requested:row.quantity,sold:took,why:`book took ${took}`});
        return took;
      } catch(error){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:message(error)});return 0;}
    };
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
        checkStop();
        const took=await withdraw([...left].map(([item_id,quantity])=>
          Number.isFinite(quantity)?{item_id,quantity}:{item_id}));
        if(!loads&&took.status==='refused'&&!took.detail.moved.length)
          return {status:'refused',did:'sold nothing',why:`withdraw first: ${took.why}`,detail:empty()};
        if(!took.detail.moved.length)break;
        // A row the store came up short on is exhausted: sell what came out, then stop asking.
        const emptied=took.detail.short.filter(row=>row.why==='not in store').map(row=>row.item_id);
        for(const row of took.detail.moved) {
          const sold=await sellRow(row);
          const rest=(left.get(row.item_id)??0)-sold;
          if(sold<row.quantity||rest<=0)left.delete(row.item_id);
          else left.set(row.item_id,rest);
        }
        for(const item of emptied)left.delete(item);
        loads++;
      }
    } else for(const row of asked)await sellRow(row);
    const detail:Sold={base_id:docked,fills,short,total};
    // Nothing named was held: the end state already holds, so it is said, not refused.
    const already=short.filter(row=>row.why==='not held');
    const blocked=short.filter(row=>!already.includes(row));
    const kept=opts.from==='store'?blocked.filter(row=>row.why==='no buyer'||row.why.startsWith('under floor')):[];
    const said=[...kept.length?[`left in the store: ${kept.map(row=>`${row.item_id} ${row.why}`).join(', ')}`]:[],
      ...already.length?[`nothing to sell: ${already.map(row=>`${row.item_id} not held`).join(', ')}`]:[]].join('; ');
    const why=blocked.map(row=>`${row.item_id}: ${row.why}`).join('; ');
    const sold=fills.length?`sold ${fills.map(f=>`${f.quantity_sold} ${f.item_id}`).join(', ')} at ${docked} for ${total} cr`
      :blocked.length?`sold nothing at ${docked}`:`nothing to sell at ${docked}`;
    return {status:blocked.length?(fills.length?'partial':'refused'):'done',
      did:said?`${sold}; ${said}`:sold,...why?{why}:{},detail};
  });
}

export interface Bought {
  /** The preview the spend was checked against (`total_cost`, `sales_tax`, `unfilled`). */
  estimate:EstimatePurchaseResponse;
  /** The fill, when one happened. */
  bought?:BuyResponse;
}

/** Buy at market price, here, after an `estimate_purchase` preview. Over `spacemolt/buy` it
 * adds: the estimate read first and refused when `total_cost` would take the wallet under
 * `permissions.credit_reserve`, over `permissions.max_spend` or over `maxEach × quantity`;
 * the refusal names the numbers. A **module** is checked against the ship's grid first —
 * free slot of its kind, CPU and power — and refused when it could not be fitted, with
 * `next` saying what to remove; `{force:true}` skips that check for a pilot buying a spare.
 * Trains trading. Tired or Relaxed: refused. */
export function buy(itemId:string,quantity:number,opts:{deliverTo?:'cargo'|'storage';maxEach?:number;force?:boolean}={}):Promise<Outcome<Bought>> {
  return job<Bought>('buy',`${quantity} ${itemId}`,async()=>{
    const none={estimate:{} as EstimatePurchaseResponse};
    const stop=admit('buy');
    if(stop)return {status:'refused',did:`did not buy ${itemId}`,why:stop,detail:none};
    if(!acct().state.location?.docked_at)return {status:'refused',did:`did not buy ${itemId}`,why:'not docked',detail:none};
    // A module that cannot be fitted is a dead 2,080 cr: the grid is checked before the buy.
    if(!opts.force) {
      const spec=await moduleSpec(itemId).catch(()=>null);
      const why=spec&&whyNotFit(spec,bench());
      if(why)return {status:'refused',did:`did not buy ${itemId}`,why,detail:none,
        next:[`refit({remove:[…]}) first, then buy`,`buy('${itemId}', ${quantity}, {force:true}) to hold it as a spare`,
          room(acct().state.ship as never)]};
    }
    const estimate=details(await command('spacemolt_market/estimate_purchase',{item_id:itemId,quantity})) as EstimatePurchaseResponse;
    const who=pilot(),credits=acct().state.player?.credits??0;
    const reserve=who.permissions?.credit_reserve??0,cap=who.permissions?.max_spend;
    const cost=Number(estimate.total_cost??0);
    if(!(estimate.available>0))return {status:'refused',did:`did not buy ${itemId}`,why:`not on this market: ${estimate.message??'0 available'}`,detail:{estimate}};
    if(credits-cost<reserve)return {status:'refused',did:`did not buy ${itemId}`,why:`costs ${cost}; credits ${credits} less reserve ${reserve} leaves ${credits-reserve}`,detail:{estimate}};
    if(cap!==undefined&&cost>cap)return {status:'refused',did:`did not buy ${itemId}`,why:`costs ${cost}, over permissions.max_spend ${cap}`,detail:{estimate}};
    if(opts.maxEach!==undefined&&cost>opts.maxEach*quantity)return {status:'refused',did:`did not buy ${itemId}`,why:`costs ${cost}, over maxEach ${opts.maxEach} × ${quantity}`,detail:{estimate}};
    const bought=details(await command('spacemolt/buy',{id:itemId,quantity:Math.min(quantity,estimate.available),
      ...opts.deliverTo?{deliver_to:opts.deliverTo}:{}})) as BuyResponse;
    return {status:(bought.unfilled??0)>0?'partial':'done',
      did:`bought ${bought.quantity??quantity} ${itemId} for ${bought.total_cost??cost} cr`,
      ...(bought.unfilled??0)>0?{why:`${bought.unfilled} unfilled`}:{},detail:{estimate,bought}};
  });
}
