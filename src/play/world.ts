/** What this pilot knows of the world beyond the ship: `world.db` in the runtime dir, one SQLite file the
 * bridge opens once and is the only writer of (freighters in its process share the handle). Two kinds of
 * fact, each kept by the reads and acts that already happen:
 *
 * - `markets` + `books`: every base's market book as last read here, top `LEVELS` levels a side, each
 *   level stamped `since`, the first tick it was seen at that price unbroken. Kept by count (`BASES`),
 *   never by age: a consumer discounts by age itself.
 * - `stores`: what the account's station storage holds, per base and item, as the game last said:
 *   a `storage/view` replaces a base, a deposit/withdraw/buy-to-storage reply sets an item.
 * - `facilities`: the public facilities seen at each base, one row per facility type, with its fee per run
 *   when a `facility/list` there said it; a `no_facility` refusal adds the one it names, fee unknown.
 *
 * Every read is a pure function over these tables. The journal stays the telemetry record: a book read
 * is still a `book` line in `books.jsonl`, a store change a `store` line. */
import type {MarketListingItem,OrderLevel} from '@spacemolt/lib';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {journalRun} from '../run-record.ts';
import {listing} from '../servicing.ts';
import {field} from './game.ts';
import type {RememberedBook} from './market.ts';
import {readNames} from './places.ts';

const FILE='world.db';
/** Levels kept a side: what `books.jsonl` journals too. A row's `buy_quantity`/`sell_quantity` keep the whole depth. */
export const LEVELS=10;
/** ponytail: a size ceiling only, never an evictor in practice: the galaxy has ~80 stations. */
const BASES=500;
/** A level as kept: the game's, plus the first tick it was seen at this price, unbroken across reads. */
export type Level=OrderLevel&{since?:number};
/** A level's `since`, when it carries one. */
export const sinceOf=(level:OrderLevel):number|undefined=>{const value=field(level,'since');return typeof value==='number'?value:undefined;};

const SCHEMA=[
  `CREATE TABLE markets(base_id TEXT PRIMARY KEY,system_id TEXT,tick INTEGER,at TEXT NOT NULL)`,
  `CREATE TABLE books(base_id TEXT NOT NULL,item_id TEXT NOT NULL,row TEXT NOT NULL,PRIMARY KEY(base_id,item_id)) WITHOUT ROWID`,
  `CREATE TABLE stores(base_id TEXT NOT NULL,item_id TEXT NOT NULL,quantity INTEGER NOT NULL,tick INTEGER,at TEXT NOT NULL,PRIMARY KEY(base_id,item_id)) WITHOUT ROWID`,
];

const open=new Map<string,DatabaseSync>();
/** The runtime dir's db, opened (and migrated) on first use; undefined without a dir, or when it cannot be opened.
 * A file deleted under an open handle is reopened, so a fresh dir at the same path starts fresh. */
export function worldDb(dir:string|undefined):DatabaseSync|undefined {
  if(!dir)return undefined;
  const path=join(dir,FILE),had=open.get(dir);
  if(had&&existsSync(path))return had;
  had?.close();
  try {
    mkdirSync(dir,{recursive:true});
    const db=new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000');
    migrate(db,dir);
    open.set(dir,db);
    return db;
  } catch {open.delete(dir);return undefined;} // edge: memory is a convenience; a pilot with none still trades
}
/** Every dir with an open db, for the test that proves each is a throwaway. */
export const openDirs=()=>[...open.keys()];

const tx=<T>(db:DatabaseSync,body:()=>T):T=>{
  db.exec('BEGIN IMMEDIATE');
  try {const out=body();db.exec('COMMIT');return out;}
  catch(error){db.exec('ROLLBACK');throw error;}
};

/** Schema version 1, and the import of what the files before it kept: `markets.json`, then the latest `book` line per
 * base in `books.jsonl` when it is newer (the journal covers bases the memory evicted), with each level's `since` from
 * the journal's run of reads. Once, in one transaction: a torn import is none. The old files are left where they are. */
function migrate(db:DatabaseSync,dir:string):void {
  const version=Number(db.prepare('PRAGMA user_version').get()?.user_version??0);
  if(version<1)importFiles(db,dir);
  if(version<2)tx(db,()=>{db.exec(FACILITIES);db.exec('PRAGMA user_version=2');});
}
/** Version 2: the facility book. */
const FACILITIES=`CREATE TABLE facilities(base_id TEXT NOT NULL,type TEXT NOT NULL,row TEXT NOT NULL,PRIMARY KEY(base_id,type)) WITHOUT ROWID`;
function importFiles(db:DatabaseSync,dir:string):void {
  tx(db,()=>{
    for(const sql of SCHEMA)db.exec(sql);
    const books=new Map<string,RememberedBook>();
    try {
      const kept:unknown=JSON.parse(readFileSync(join(dir,'markets.json'),'utf8'));
      for(const raw of Array.isArray(kept)?kept:[]) {
        const base_id=field(raw,'base_id'),items=field(raw,'items'),at=field(raw,'at'),tick=field(raw,'tick'),system=field(raw,'system_id');
        if(typeof base_id==='string'&&base_id&&Array.isArray(items)&&!books.has(base_id))books.set(base_id,{base_id,at:typeof at==='string'?at:'',
          ...typeof tick==='number'?{tick}:{},...typeof system==='string'?{system_id:system}:{},items:items.flatMap(listing)});
      }
    } catch {} // edge: no markets.json, or a torn one, is nothing to import
    const since=new Map<string,number>();
    for(const line of journalled(dir)) {
      const base_id=field(line,'base_id'),tick=field(line,'book_tick'),items=field(line,'items'),at=field(line,'at');
      if(typeof base_id!=='string'||typeof tick!=='number'||!Array.isArray(items))continue;
      // A level seen in this read keeps the tick it was first seen at, if the read before had it too.
      const seen=new Map<string,number>();
      const levels=(item:string,side:string,list:unknown)=>(Array.isArray(list)?list:[]).flatMap((pair:unknown):Level[]=>{
        if(!Array.isArray(pair)||typeof pair[0]!=='number'||typeof pair[1]!=='number')return [];
        const key=`${base_id}\0${item}\0${side}\0${pair[0]}`,first=since.get(key)??tick;
        seen.set(key,first);
        return [{price_each:pair[0],quantity:pair[1],since:first}];
      });
      const rows=items.flatMap((row:unknown):MarketListingItem[]=>{
        const item_id=field(row,'item_id');
        if(typeof item_id!=='string')return [];
        const bids=levels(item_id,'bids',field(row,'bids')),asks=levels(item_id,'asks',field(row,'asks'));
        return listing({item_id,best_buy:bids[0]?.price_each??0,best_buy_qty:bids[0]?.quantity??0,best_sell:asks[0]?.price_each??0,
          best_sell_qty:asks[0]?.quantity??0,buy_quantity:field(row,'bid_depth'),sell_quantity:field(row,'ask_depth'),buy_orders:bids,sell_orders:asks});
      });
      for(const key of [...since.keys()])if(key.startsWith(`${base_id}\0`)&&!seen.has(key))since.delete(key);
      for(const [key,first] of seen)since.set(key,first);
      const had=books.get(base_id);
      if(!had||(had.tick??-1)<tick)books.set(base_id,{base_id,at:typeof at==='string'?at:'',tick,...had?.system_id?{system_id:had.system_id}:{},items:rows});
    }
    // Oldest first, so the newest read is the last row written: ties keep the file's newest-first order.
    for(const book of [...books.values()].reverse().sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:0)) {
      // A level the journal saw at the same tick carries the journal's `since`; markets.json's own levels have none.
      const stamped=book.items.map(row=>({...row,buy_orders:row.buy_orders.map(level=>({...level,
        since:sinceOf(level)??since.get(`${book.base_id}\0${row.item_id}\0bids\0${level.price_each}`)})),
        sell_orders:row.sell_orders.map(level=>({...level,since:sinceOf(level)??since.get(`${book.base_id}\0${row.item_id}\0asks\0${level.price_each}`)}))}));
      put(db,{...book,items:stamped});
    }
    db.exec('PRAGMA user_version=1');
  });
}
/** `books.jsonl`'s lines in order, parsed; a line that does not parse is skipped. */
function journalled(dir:string):unknown[] {
  let text='';
  try {text=readFileSync(join(dir,'books.jsonl'),'utf8');} catch {return [];} // edge: no journal of books yet
  return text.split('\n').flatMap(line=>{try {const parsed:unknown=line?JSON.parse(line):undefined;return parsed===undefined?[]:[parsed];} catch {return [];}}); // edge: a torn last line
}

/** One row as kept: `LEVELS` levels a side, the rest summed in `buy_quantity`/`sell_quantity` as the game sent them. */
const trim=(row:MarketListingItem):MarketListingItem=>({...row,buy_orders:row.buy_orders.slice(0,LEVELS),sell_orders:row.sell_orders.slice(0,LEVELS)});
function put(db:DatabaseSync,book:RememberedBook):void {
  db.prepare('INSERT OR REPLACE INTO markets VALUES(?,?,?,?)').run(book.base_id,book.system_id??null,book.tick??null,book.at);
  db.prepare('DELETE FROM books WHERE base_id=?').run(book.base_id);
  const insert=db.prepare('INSERT INTO books VALUES(?,?,?)');
  for(const row of book.items)insert.run(book.base_id,row.item_id,JSON.stringify(trim(row)));
}

/** Every base's book, newest read first. */
export function readBooks(dir:string|undefined):RememberedBook[] {
  const db=worldDb(dir);
  if(!db)return [];
  const items=new Map<string,MarketListingItem[]>();
  for(const {base_id,row} of db.prepare('SELECT base_id,row FROM books').all())
    items.set(String(base_id),[...items.get(String(base_id))??[],...listing(JSON.parse(String(row)))]);
  return db.prepare('SELECT * FROM markets ORDER BY at DESC,rowid DESC').all().map(row=>({base_id:String(row.base_id),at:String(row.at),
    ...row.tick===null?{}:{tick:Number(row.tick)},...row.system_id===null?{}:{system_id:String(row.system_id)},items:items.get(String(row.base_id))??[]}));
}
/** A fresh read of `book.base_id`, replacing what was kept: each level the last read had at the same price keeps its `since`. */
export function keepBook(dir:string|undefined,book:RememberedBook):void {
  const db=worldDb(dir);
  if(!db)return;
  const before=new Map(db.prepare('SELECT item_id,row FROM books WHERE base_id=?').all(book.base_id).flatMap(raw=>listing(JSON.parse(String(raw.row)))).map(row=>[row.item_id,row]));
  const was=db.prepare('SELECT tick FROM markets WHERE base_id=?').get(book.base_id)?.tick;
  const first=(old:Level[]|undefined,price:number)=>{const had=old?.find(level=>level.price_each===price);return had?had.since??(typeof was==='number'?was:book.tick):book.tick;};
  // Rebuilt through `listing`, so a row handed in without its order lists keeps as one with them empty.
  const items=book.items.flatMap(listing).map(row=>{const old=before.get(row.item_id);
    return {...row,buy_orders:row.buy_orders.map(level=>({...level,since:first(old?.buy_orders,level.price_each)})),
      sell_orders:row.sell_orders.map(level=>({...level,since:first(old?.sell_orders,level.price_each)}))};});
  tx(db,()=>{
    put(db,{...book,items});
    db.prepare(`DELETE FROM markets WHERE base_id NOT IN (SELECT base_id FROM markets ORDER BY at DESC LIMIT ${BASES})`).run();
    db.prepare('DELETE FROM books WHERE base_id NOT IN (SELECT base_id FROM markets)').run();
  });
}
/** One kept row, rewritten in place (a fill taken off it); a row not kept stays not kept. */
export function keepRow(dir:string|undefined,base_id:string,row:MarketListingItem):void {
  worldDb(dir)?.prepare('UPDATE books SET row=? WHERE base_id=? AND item_id=?').run(JSON.stringify(trim(row)),base_id,row.item_id);
}

/** What one base's store holds, as last said, with when. */
export interface Stored {base_id:string;item_id:string;quantity:number;tick:number|null;at:string}
/** Every stored row, every base, by base then item. */
export function readStores(dir:string|undefined):Stored[] {
  return (worldDb(dir)?.prepare('SELECT * FROM stores ORDER BY base_id,item_id').all()??[]).map(row=>({base_id:String(row.base_id),
    item_id:String(row.item_id),quantity:Number(row.quantity),tick:row.tick===null?null:Number(row.tick),at:String(row.at)}));
}
/** One base's stored rows. */
export const storedAt=(dir:string|undefined,base_id:string):Stored[]=>readStores(dir).filter(row=>row.base_id===base_id);
/** Units of each item stored anywhere. */
export function storedTotals(dir:string|undefined):Record<string,number> {
  const totals:Record<string,number>={};
  for(const row of readStores(dir))totals[row.item_id]=(totals[row.item_id]??0)+row.quantity;
  return totals;
}
/** Set `items` at `base_id` (`whole`: they are the base's whole store, the rest gone), journalling a `store` line
 * of what changed: `{base_id, via, items:{item_id: quantity now}}`. */
function setStore(dir:string,base_id:string,items:Record<string,number>,via:string,tick:number|null,whole:boolean):void {
  const db=worldDb(dir);
  if(!db||!base_id)return;
  const before=Object.fromEntries(db.prepare('SELECT item_id,quantity FROM stores WHERE base_id=?').all(base_id).map(row=>[String(row.item_id),Number(row.quantity)]));
  const next=whole?items:{...before,...items};
  const changed=Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(next)])]
    .flatMap(item=>(before[item]??0)===(next[item]??0)?[]:[[item,next[item]??0]]));
  const at=new Date().toISOString();
  tx(db,()=>{
    if(whole)db.prepare('DELETE FROM stores WHERE base_id=?').run(base_id);
    const write=db.prepare('INSERT OR REPLACE INTO stores VALUES(?,?,?,?,?)'),drop=db.prepare('DELETE FROM stores WHERE base_id=? AND item_id=?');
    for(const [item,quantity] of Object.entries(whole?next:items))if(quantity>0)write.run(base_id,item,quantity,tick,at);else drop.run(base_id,item);
  });
  // A store change the journal cannot take is still kept: the line is analysis, the table the memory.
  if(Object.keys(changed).length)try {journalRun(dir,{base_id,via,...tick===null?{}:{tick},items:changed},'store');} catch {} // edge: an unwritable journal
}

const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
/** A reply's body: the structured content, a state delta's details, or the reply itself. */
const bodyOf=(reply:unknown):unknown=>field(reply,'structuredContent')??field(field(reply,'delta'),'details')??reply;

/** What one landed command says of the account's stores, kept: a `storage/view` replaces its base, and a view's
 * `locations` whose `item_count` disagrees with what is kept (or a base kept that it does not list) has that base
 * re-read with `view(station_id)` — read-only, from anywhere — or emptied; a deposit sets the item to the reply's
 * `storage_total`, a withdraw to its `storage_remaining`, a buy delivered to storage adds `delivered_to_storage`.
 * `docked` is where the ship is, for the replies that do not name a base. Never throws. */
export async function noteStore(dir:string|undefined,docked:string|undefined,action:string,params:Record<string,unknown>|undefined,reply:unknown,
  view?:(station:string)=>Promise<unknown>):Promise<void> {
  if(!dir)return;
  try {
    const body=bodyOf(reply),tick=count(field(body,'tick'))??null,item=field(body,'item_id')??params?.item_id??params?.id;
    if(action==='spacemolt_storage/view') {
      const base=field(body,'base_id')||params?.station_id,rows=field(body,'items');
      if(typeof base!=='string'||!base||!Array.isArray(rows))return;
      const items:Record<string,number>={};
      for(const row of rows){const id=field(row,'item_id'),n=count(field(row,'quantity'));if(typeof id==='string'&&n!==undefined)items[id]=(items[id]??0)+n;}
      setStore(dir,base,items,'view',tick,true);
      const listed=field(body,'locations');
      if(!view||params?.station_id||!Array.isArray(listed))return;
      const kept=new Map<string,number>();
      for(const row of readStores(dir))kept.set(row.base_id,(kept.get(row.base_id)??0)+row.quantity);
      const counts=new Map(listed.flatMap(row=>{const id=field(row,'base_id'),n=count(field(row,'item_count'));return typeof id==='string'&&n!==undefined?[[id,n] as const]:[];}));
      // One base that will not answer is left as kept; the others are still read.
      for(const [at,n] of counts)if(at!==base&&n!==(kept.get(at)??0))
        try {await noteStore(dir,docked,action,{station_id:at},await view(at));} catch {} // edge: a far read refused or lost; the next view tries again
      for(const at of kept.keys())if(at!==base&&!counts.has(at))setStore(dir,at,{},'view',tick,true);
      return;
    }
    if(typeof item!=='string'||!docked)return;
    const verb=action.split('/')[1];
    const total=action==='spacemolt_storage/deposit'?count(field(body,'storage_total')):action==='spacemolt_storage/withdraw'?count(field(body,'storage_remaining')):undefined;
    if(total!==undefined)return setStore(dir,docked,{[item]:total},verb??'',tick,false);
    const delivered=action==='spacemolt/buy'?count(field(body,'delivered_to_storage')):undefined;
    if(delivered)setStore(dir,docked,{[item]:(readStores(dir).find(row=>row.base_id===docked&&row.item_id===item)?.quantity??0)+delivered},'buy',tick,false);
  } catch {} // edge: a store this memory could not keep is still the game's; the next view keeps it
}

// ---- Derived views: pure over the tables, no call ------------------------------------------

/** A side's top level: the first kept, else the row's own best price and quantity (a book read without its levels). */
const topOf=(row:MarketListingItem,side:'buy_orders'|'sell_orders'):OrderLevel|undefined=>{
  const [price_each,quantity]=side==='buy_orders'?[row.best_buy,row.best_buy_qty]:[row.best_sell,row.best_sell_qty];
  return row[side][0]??(price_each>0&&quantity>0?{price_each,quantity}:undefined);
};

/** One side's top at one base: price, units at that price, the book's age in ticks against `now` (null untagged),
 * and since when that price has stood (null for a level kept before stamps). */
export interface Quoted {base_id:string;price:number;quantity:number;age:number|null;since:number|null}
/** Everything known of one item: aboard, stored by base, and each base's best bid and ask, best first. */
export interface ItemView {item_id:string;aboard:number;stored:{base_id:string;quantity:number;at:string}[];bids:Quoted[];asks:Quoted[]}
export function itemView(dir:string|undefined,item_id:string,aboard:number,now:number):ItemView {
  const books=readBooks(dir).flatMap(book=>book.items.filter(row=>row.item_id===item_id).map(row=>({book,row})));
  const top=(side:'buy_orders'|'sell_orders')=>books.flatMap(({book,row}):Quoted[]=>{const level=topOf(row,side);
    return level?[{base_id:book.base_id,price:level.price_each,quantity:level.quantity,age:book.tick===undefined?null:Math.max(0,now-book.tick),since:level?sinceOf(level)??null:null}]:[];});
  return {item_id,aboard,stored:readStores(dir).filter(row=>row.item_id===item_id).map(({base_id,quantity,at})=>({base_id,quantity,at})),
    bids:top('buy_orders').sort((a,b)=>b.price-a.price),asks:top('sell_orders').sort((a,b)=>a.price-b.price)};
}
/** Where `need` units of an input come from, cheapest first: the hold, then the store at `here`, then other stores
 * (free, but a trip), then the cheapest known ask. What a recipe's inputs are sourced by. */
export function inputSources(view:ItemView,need:number,here:string|undefined):{from:string;quantity:number;price:number}[] {
  const out:{from:string;quantity:number;price:number}[]=[];
  const take=(from:string,quantity:number,price:number)=>{const n=Math.min(need,quantity);if(n>0){out.push({from,quantity:n,price});need-=n;}};
  take('hold',view.aboard,0);
  for(const row of [...view.stored].sort((a,b)=>Number(b.base_id===here)-Number(a.base_id===here)))take(`store:${row.base_id}`,row.quantity,0);
  for(const ask of view.asks)take(`ask:${ask.base_id}`,ask.quantity,ask.price);
  return out;
}
/** Every base's stores with the best known bid for each item there (anywhere), largest stored value first. */
export function holdings(dir:string|undefined,now:number):{base_id:string;item_id:string;quantity:number;bid:Quoted|null}[] {
  const bids=new Map<string,Quoted>();
  for(const book of readBooks(dir))for(const row of book.items){const level=topOf(row,'buy_orders');
    if(level&&level.price_each>(bids.get(row.item_id)?.price??0))bids.set(row.item_id,{base_id:book.base_id,price:level.price_each,quantity:level.quantity,
      age:book.tick===undefined?null:Math.max(0,now-book.tick),since:sinceOf(level)??null});}
  return readStores(dir).map(row=>({base_id:row.base_id,item_id:row.item_id,quantity:row.quantity,bid:bids.get(row.item_id)??null}))
    .sort((a,b)=>(b.bid?.price??0)*Math.min(b.quantity,b.bid?.quantity??0)-(a.bid?.price??0)*Math.min(a.quantity,a.bid?.quantity??0));
}

// ---- The facility book ---------------------------------------------------------------------

/** A public facility seen at a base. `type` is the facility definition id; a row learnt from a `no_facility`
 * refusal has only the name the server gave, as both `type` and `name`, and no fee. `tick` is when it was seen. */
export interface FacilitySeen {base_id:string;type:string;name:string;system_id?:string;recipe_id?:string;
  fee_per_run?:number;output_per_run?:number;queued_runs?:number;backlog_ticks?:number;tick?:number;at:string}
/** Every facility row kept, every base. */
export function readFacilities(dir:string|undefined):FacilitySeen[] {
  return (worldDb(dir)?.prepare('SELECT row FROM facilities').all()??[]).flatMap(raw=>{
    // oxlint-disable-next-line typescript/consistent-type-assertions
    try {const row:unknown=JSON.parse(String(raw.row));return typeof field(row,'base_id')==='string'?[row as FacilitySeen]:[];} catch {return [];} // cast: a row only putFacilities wrote; edge: a torn row
  });
}
function putFacilities(dir:string|undefined,base_id:string,rows:FacilitySeen[],whole:boolean):void {
  const db=worldDb(dir);
  if(!db||!base_id)return;
  tx(db,()=>{
    if(whole)db.prepare('DELETE FROM facilities WHERE base_id=?').run(base_id);
    const write=db.prepare(`INSERT OR ${whole?'REPLACE':'IGNORE'} INTO facilities VALUES(?,?,?)`);
    for(const row of rows)write.run(base_id,row.type,JSON.stringify(row));
  });
}
/** A `facility/list` reply, kept as `base_id`'s whole facility book: each public facility type there at its lowest fee
 * per run. The reply's own `base_id` wins over the one passed. Never throws. */
export function rememberFacilities(dir:string|undefined,base_id:string,system_id:string|undefined,reply:unknown,tick:number|undefined):void {
  try {
    const body=bodyOf(reply),base=field(body,'base_id');
    const at=typeof base==='string'&&base?base:base_id,now=new Date().toISOString(),kept=new Map<string,FacilitySeen>();
    for(const key of ['public_facilities','station_facilities','faction_facilities','player_facilities']) {
      const listed=field(body,key);
      for(const entry of Array.isArray(listed)?listed:[]) {
        const type=field(entry,'type'),name=field(entry,'name'),production=field(entry,'production'),recipe=field(entry,'recipe_id');
        if(typeof type!=='string'||field(production,'public')!==true)continue;
        const fee=count(field(production,'rental_fee_per_run')),output=count(field(production,'output_per_run'));
        const queued=count(field(production,'queued_runs')),backlog=count(field(production,'backlog_ticks'));
        const row:FacilitySeen={base_id:at,type,name:typeof name==='string'?name:type,...system_id?{system_id}:{},
          ...typeof recipe==='string'?{recipe_id:recipe}:{},...fee===undefined?{}:{fee_per_run:fee},...output===undefined?{}:{output_per_run:output},
          ...queued===undefined?{}:{queued_runs:queued},...backlog===undefined?{}:{backlog_ticks:backlog},...tick===undefined?{}:{tick},at:now};
        const had=kept.get(type);
        if(!had||(fee??Infinity)<(had.fee_per_run??Infinity))kept.set(type,row);
      }
    }
    putFacilities(dir,at,[...kept.values()],true);
  } catch {} // edge: a book this memory could not keep is still the game's; the next read keeps it
}
/** A `no_facility` refusal for `recipe_id`, which names the nearest public facility that makes it ("… is made in a Alloy
 * Foundry … Nearest public one: Crimson War Citadel in Krynn (1 jump(s) away) …"), kept as that station having it, fee
 * unknown. A row already kept there is left alone; a text that does not read keeps nothing. Never throws. */
export function rememberNoFacility(dir:string|undefined,recipe_id:string,text:string,tick:number|undefined):void {
  try {
    const hit=/is made in an? (.+?),.*?Nearest public one: (.+?) in (.+?) \(/s.exec(text);
    if(!hit)return;
    const [,name='',station='',system='']=hit;
    const base_id=Object.entries(readNames(dir)).find(([,known])=>known===station)?.[0]??station;
    if(readFacilities(dir).some(row=>row.base_id===base_id&&(row.name===name||row.recipe_id===recipe_id)))return;
    putFacilities(dir,base_id,[{base_id,type:name,name,system_id:system,recipe_id,...tick===undefined?{}:{tick},at:new Date().toISOString()}],false);
  } catch {} // edge: a hint this memory could not keep; the next refusal says it again
}
