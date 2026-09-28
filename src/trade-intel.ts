/** Files a station's book to the faction's trade ledger (`submit_trade_intel`), so every pilot and
 * freighter in the faction reads it back as a far book through `query_trade_intel`. The pilot's
 * `book()` and a freighter's stop both call it on every market read; nobody calls it by hand. */
import type {MarketListingItem} from '@spacemolt/lib';
import type {ReadinessCommand} from './readiness.ts';

/** Per account: the tick each base was last filed at. A book is filed once per tick. */
const filed=new WeakMap<object,Map<string,number>>();
/** Accounts already told once why a filing failed. */
const told=new WeakSet<object>();
let saidNoFaction=false;

/** Whether the account's player is in a faction, read off the state the account already holds.
 * Every faction intel call — filing a book, reading the trade ledger, reading the intel map — is
 * made only when this holds: without a faction the game refuses each one (live 2026-09-28: 152
 * refused filings in nine hours). `say` hears once per process that they are skipped. */
export function inFaction(account:object,say?:(text:string)=>void):boolean {
  if((account as {state?:{player?:{faction_id?:string}|null}}).state?.player?.faction_id)return true;
  if(say&&!saidNoFaction) {
    saidNoFaction=true;
    say('no faction: faction intel (trade ledger, intel map) is neither filed nor read');
  }
  return false;
}

/** ponytail: the rows of one station report, as JSON, are kept under this many bytes. Live, a
 * 542-row book (~55 KB) filed and a 716-row one (~73 KB) dropped the connection every time, and a
 * second filing for a base replaces the first, so the book cannot be split. The ceiling is the
 * server's, not measured closer than that; raise it if a bigger book ever files whole. */
export const FILE_BYTES=50_000;

/** The rows worth filing, most tradeable first (a bid and an ask, then by the value on the book),
 * cut to fit `FILE_BYTES`. */
export function fileRows(items:readonly MarketListingItem[]) {
  const rows=items.filter(row=>row.best_buy>0||row.best_sell>0).map(row=>({item_id:row.item_id,
    best_buy:row.best_buy,best_sell:row.best_sell,buy_volume:row.best_buy_qty,sell_volume:row.best_sell_qty}))
    .sort((a,b)=>Number(b.best_buy>0&&b.best_sell>0)-Number(a.best_buy>0&&a.best_sell>0)
      ||b.best_buy*b.buy_volume+b.best_sell*b.sell_volume-(a.best_buy*a.buy_volume+a.best_sell*a.sell_volume));
  let bytes=0;
  return rows.filter(row=>(bytes+=JSON.stringify(row).length+1)<=FILE_BYTES);
}

/** File `items` as `base_id`'s book at `tick`, once. Never throws. A failure costs that base this
 * tick only — the next base, or the next tick, files again — and `say` hears once per account per
 * process why one failed. */
export async function fileIntel(account:object,command:ReadinessCommand,base_id:string,items:readonly MarketListingItem[],
  tick:number,say:(text:string)=>void=()=>{}):Promise<void> {
  if(!base_id||!inFaction(account,say))return;
  const seen=filed.get(account)??new Map<string,number>();
  filed.set(account,seen);
  if(seen.get(base_id)===tick)return;
  seen.set(base_id,tick);
  const rows=fileRows(items);
  if(!rows.length)return;
  try {await command('spacemolt_intel/submit_trade_intel',{stations:[{base_id,items:rows}]});}
  catch(error) {
    if(told.has(account))return;
    told.add(account);
    say(`trade intel not filed at ${base_id}: ${error instanceof Error?error.message:String(error)}`);
  }
}
