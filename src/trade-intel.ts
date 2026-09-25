/** Files a station's book to the faction's trade ledger (`submit_trade_intel`), so every pilot and
 * freighter in the faction reads it back as a far book through `query_trade_intel`. The pilot's
 * `book()` and a freighter's stop both call it on every market read; nobody calls it by hand. */
import type {MarketListingItem} from '@spacemolt/lib';
import type {ReadinessCommand} from './readiness.ts';

/** Per account: the tick each base was last filed at. A book is filed once per tick. */
const filed=new WeakMap<object,Map<string,number>>();
/** ponytail: an account whose first filing failed (no faction, no Trade Ledger) is not asked again
 * this process, so a pilot who joins a faction mid-process files from the next process on. A
 * dropped connection on that first filing counts as "no ledger" too. */
const off=new WeakSet<object>();

/** File `items` as `base_id`'s book at `tick`, once. Never throws; `say` hears once per account
 * per process why filing is off. ponytail: the whole priced book goes in one station report (the
 * live proof filed 23 rows); cut it to held and traded items if the ledger ever refuses the size. */
export async function fileIntel(account:object,command:ReadinessCommand,base_id:string,items:readonly MarketListingItem[],
  tick:number,say:(text:string)=>void=()=>{}):Promise<void> {
  if(!base_id||off.has(account))return;
  const seen=filed.get(account)??new Map<string,number>();
  filed.set(account,seen);
  if(seen.get(base_id)===tick)return;
  seen.set(base_id,tick);
  const rows=items.filter(row=>row.best_buy>0||row.best_sell>0).map(row=>({item_id:row.item_id,
    best_buy:row.best_buy,best_sell:row.best_sell,buy_volume:row.best_buy_qty,sell_volume:row.best_sell_qty}));
  if(!rows.length)return;
  try {await command('spacemolt_intel/submit_trade_intel',{stations:[{base_id,items:rows}]});}
  catch(error) {
    off.add(account);
    say(`trade intel not filed, and not tried again this process: ${error instanceof Error?error.message:String(error)}`);
  }
}
