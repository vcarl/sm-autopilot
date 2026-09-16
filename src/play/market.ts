/** The market counter at the base you are docked at. Prices are read live at the moment of
 * the act, never from a plan. */
import type {BuyResponse,EstimatePurchaseResponse,MarketListingItem,SellResponse,ViewMarketResponse,ViewStorageResponse} from '@spacemolt/lib';
import {miningInventory} from '../mining-inventory.ts';
import {details} from '../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step} from './runtime.ts';
import {withdraw} from './storage.ts';
import type {Outcome,Row} from './types.ts';

/** The lib's per-item book (`best_buy`, `best_buy_qty`, `best_sell`, `best_sell_qty`,
 * `spread`) plus your own position, which the market does not know. */
export type Quote=MarketListingItem&{held:number;stored:number};

const CAP=40;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);

/** The book here, whole, read once and filtered in memory: one 190 KB reply beats twenty
 * filtered ones against the rate limit, and the pilot never sees it. */
async function book():Promise<Map<string,MarketListingItem>> {
  const reply=details(await command('spacemolt_market/view_market',{})) as ViewMarketResponse;
  return new Map((reply.items??[]).map(item=>[item.item_id,item]));
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
 * sold by default. Over `spacemolt/sell` it adds: the book re-read before each row so a thin
 * book never sells into nothing, `from:'store'` (withdraw first), a per-item `floor` on
 * `best_buy`, and the wallet measured for `gained.credits`.
 *
 * - `items`: rows to sell; quantity `Infinity` means all held.
 * - `from:'store'`: withdraw the rows first, then sell. Default `'hold'`.
 * - `floor`: per-item minimum `best_buy`; below it the row is skipped, not dumped.
 *
 * Trains trading (xp scales with credit volume). Not docked or no market here: `refused`. */
export function sell(items:Row[],opts:{from?:'hold'|'store';floor?:Record<string,number>}={}):Promise<Outcome<Sold>> {
  return job<Sold>('sell',items.map(row=>`${row.quantity} ${row.item_id}`).join(', ')+(opts.from==='store'?' from store':''),async()=>{
    const docked=acct().state.location?.docked_at??'';
    const empty=():Sold=>({base_id:docked,fills:[],short:[],total:0});
    if(!items.length)return {status:'refused',did:'sold nothing',why:'no rows named; pass [{item_id, quantity}]',detail:empty()};
    if(!docked)return {status:'refused',did:'sold nothing',why:'not docked; a market is a station counter',detail:empty()};
    if(opts.from==='store') {
      const took=await withdraw(items);
      if(took.status==='refused')return {status:'refused',did:'sold nothing',why:`withdraw first: ${took.why}`,detail:empty()};
    }
    const listed=await book();
    const fills:SellResponse[]=[],short:Sold['short']=[];
    let total=0;
    for(const row of items) {
      checkStop();
      const held=miningInventory(acct().state)[row.item_id]??0;
      const quantity=Math.min(row.quantity,held);
      const quote=listed.get(row.item_id);
      const floor=opts.floor?.[row.item_id];
      if(quantity<=0){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'not held'});continue;}
      if(!quote||!(quote.best_buy>0)){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:'no buyer'});continue;}
      if(floor!==undefined&&quote.best_buy<floor){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:`under floor: best buy ${quote.best_buy} < ${floor}`});continue;}
      try {
        const fill=details(await command('spacemolt/sell',{id:row.item_id,quantity})) as SellResponse;
        fills.push(fill);total+=Number(fill.total_earned??0);
        step(`sell ${fill.quantity_sold??quantity} ${row.item_id} +${fill.total_earned??'?'} cr`);
        if((fill.quantity_sold??quantity)<quantity)short.push({item_id:row.item_id,requested:row.quantity,sold:fill.quantity_sold??0,why:`book took ${fill.quantity_sold}`});
      } catch(error){short.push({item_id:row.item_id,requested:row.quantity,sold:0,why:message(error)});}
    }
    const detail:Sold={base_id:docked,fills,short,total};
    const why=short.map(row=>`${row.item_id}: ${row.why}`).join('; ');
    return {status:short.length?(fills.length?'partial':'refused'):'done',
      did:fills.length?`sold ${fills.map(f=>`${f.quantity_sold} ${f.item_id}`).join(', ')} at ${docked} for ${total} cr`:`sold nothing at ${docked}`,
      ...why?{why}:{},detail};
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
 * the refusal names the numbers. Trains trading. Tired or Relaxed: refused. */
export function buy(itemId:string,quantity:number,opts:{deliverTo?:'cargo'|'storage';maxEach?:number}={}):Promise<Outcome<Bought>> {
  return job<Bought>('buy',`${quantity} ${itemId}`,async()=>{
    const none={estimate:{} as EstimatePurchaseResponse};
    const stop=admit('buy');
    if(stop)return {status:'refused',did:`did not buy ${itemId}`,why:stop,detail:none};
    if(!acct().state.location?.docked_at)return {status:'refused',did:`did not buy ${itemId}`,why:'not docked',detail:none};
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
