/** Buy low here, sell high there. Trading xp scales with credit volume, so this is also the
 * fastest skill to raise once you have capital. Markets move between look and act. */
import type {EstimatePurchaseResponse,MarketInsight,MarketListingItem,SellResponse} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

export interface Spread {
  item_id:string;
  buy_at:{base_id:string;book:MarketListingItem};
  sell_at:{base_id:string;book:MarketListingItem};
  /** `sell_at.best_buy − buy_at.best_sell`, per unit, and the depth on both ends. */
  margin_each:number;depth:number;
  /** Fuel for the round trip, quoted. */
  fuel:number;
  /** Margin × depth minus fuel at this base's all-in price. */
  net:number;
}

/** Spreads between this market and `stations` (default: bases one jump out, read via
 * `view_orders({station_id})`), for `items` (default: this base's `analyze_market` insights).
 * Uses live order books with volume, never snapshots. Reads only. `next` names the best net
 * spread as a `tradeRun` call. */
export function findSpread(opts?:{stations?:string[];items?:string[]}):Promise<Outcome<{spreads:Spread[];insights:MarketInsight[]}>> {throw new Error('unimplemented');}

export interface Traded {
  item_id:string;
  estimate:EstimatePurchaseResponse;
  bought:number;
  sold:SellResponse[];
  /** Realised: sales minus purchase minus fuel, from the wallet. */
  net:number;
  leg:'bought'|'flown'|'sold';
}

/** One round: `buy` `quantity` of `item` here (re-estimated at the moment of purchase),
 * `goTo(sellAt)`, `sell` it there, and report the realised net. Quantity defaults to what
 * the hold fits and `permissions.max_spend` allows. Refused when the re-read spread has
 * gone, when the buy would breach `credit_reserve`, or when `sellAt` is no-go. `partial`
 * at `leg:'flown'` when the far book has thinned: the goods stay aboard and `next` says
 * where else they sell. Trains trading, navigation. Tired: refused before the buy; after it,
 * the goods ride home with the pilot. */
export function tradeRun(opts:{item:string;sellAt:string;quantity?:number}):Promise<Outcome<Traded>> {throw new Error('unimplemented');}
