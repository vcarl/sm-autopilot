import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Account} from '@spacemolt/lib';
import {readJournal} from '../run-record.ts';
import {bridgeWorld,type WorldOptions} from '../test-support/bridge-world.ts';
import {buy,knownBooks,rememberBook} from './market.ts';
import {bind,stateSnapshot,unbind} from './runtime.ts';
import {storage,stow,withdraw} from './storage.ts';
import {holdings,inputSources,itemView,keepBook,openDirs,readBooks,readStores,worldDb,type Level} from './world.ts';

const fresh=()=>mkdtempSync(join(tmpdir(),'spacemolt-world-'));
const row=(item_id:string,bids:[number,number][],asks:[number,number][]=[])=>({item_id,item_name:'',category:'',
  best_buy:bids[0]?.[0]??0,best_buy_qty:bids[0]?.[1]??0,best_sell:asks[0]?.[0]??0,best_sell_qty:asks[0]?.[1]??0,buy_price:0,buy_quantity:0,
  sell_price:0,sell_quantity:0,buy_orders:bids.map(([price_each,quantity])=>({price_each,quantity})),sell_orders:asks.map(([price_each,quantity])=>({price_each,quantity}))});

test('first open imports markets.json and, where newer or missing, the latest book line per base from books.jsonl; once, leaving the files',()=>{
  const dir=fresh();
  try {
    writeFileSync(join(dir,'markets.json'),JSON.stringify([{base_id:'sol_base',at:'2026-10-04T10:00:00Z',tick:500,system_id:'sol',items:[row('ore',[[8,50]])]},
      {base_id:'range_base',at:'2026-10-04T09:00:00Z',tick:400,items:[row('gem',[[90,5]])]}]));
    // unknown_edge was evicted from markets.json and lives only in the journal; range_base's journal is newer than the file.
    // Live 2026-10-03 (kvothe): unknown_edge's aluminum_ore bid of 81 × 4,974 was dropped by the day-old eviction.
    const line=(base_id:string,book_tick:number,bids:[number,number][])=>JSON.stringify({at:'2026-10-04T08:00:00Z',event:'book',base_id,book_tick,
      items:[{item_id:'aluminum_ore',bid_depth:bids.reduce((n,[,q])=>n+q,0),ask_depth:0,bids,asks:[]}]});
    writeFileSync(join(dir,'books.jsonl'),[line('unknown_edge',100,[[81,4974]]),line('unknown_edge',300,[[81,4974],[70,10]]),
      line('range_base',450,[[50,9]]),'{torn'].join('\n'));
    const books=readBooks(dir);
    assert.deepEqual(books.map(book=>[book.base_id,book.tick]).sort(),[['range_base',450],['sol_base',500],['unknown_edge',300]]);
    const edge=books.find(book=>book.base_id==='unknown_edge')!.items[0]!;
    assert.equal(edge.best_buy,81);assert.equal(edge.buy_quantity,4984);
    // The 81 bid was on both reads: seen since tick 100. The 70 bid only on the last.
    assert.deepEqual((edge.buy_orders as Level[]).map(level=>[level.price_each,level.since]),[[81,100],[70,300]]);
    assert.equal(books.find(book=>book.base_id==='sol_base')!.system_id,'sol');
    assert.ok(existsSync(join(dir,'markets.json'))&&existsSync(join(dir,'books.jsonl')),'never deletes the old files');
    // Idempotent: a changed file is not imported again.
    writeFileSync(join(dir,'markets.json'),'[]');
    assert.equal(readBooks(dir).length,3);
    assert.equal(Number(worldDb(dir)!.prepare('PRAGMA user_version').get()!.user_version),2);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a level seen at the same price across reads keeps the tick it was first seen; a new price is stamped with this read',()=>{
  const dir=fresh();
  try {
    keepBook(dir,{base_id:'sol_base',at:'a',tick:100,items:[row('ore',[[8,50],[7,10]],[[10,5]])]});
    keepBook(dir,{base_id:'sol_base',at:'b',tick:200,items:[row('ore',[[9,4],[8,40]],[[10,1]])]});
    const ore=readBooks(dir)[0]!.items[0]!;
    assert.deepEqual((ore.buy_orders as Level[]).map(level=>[level.price_each,level.since]),[[9,200],[8,100]]);
    assert.deepEqual((ore.sell_orders as Level[]).map(level=>[level.price_each,level.since]),[[10,100]]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('every base is kept whatever its age, and levels past ten a side are trimmed',()=>{
  const dir=fresh();
  try {
    rememberBook(dir,'old_base','sol',[row('ore',[[5,1]])],1);
    rememberBook(dir,'sol_base','sol',[row('ore',Array.from({length:15},(_,i):[number,number]=>[100-i,1]))],1_000_000);
    assert.deepEqual(knownBooks(dir).map(book=>book.base_id).sort(),['old_base','sol_base']);
    assert.equal(knownBooks(dir).find(book=>book.base_id==='sol_base')!.items[0]!.buy_orders.length,10);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the views: an item seen whole, inputs sourced hold then store then ask, holdings valued at the best known bid',()=>{
  const dir=fresh();
  try {
    keepBook(dir,{base_id:'sol_base',at:'a',tick:100,items:[row('ore',[[8,50]],[[10,5]])]});
    keepBook(dir,{base_id:'range_base',at:'b',tick:150,items:[row('ore',[[15,4]],[[9,100]])]});
    worldDb(dir)!.prepare("INSERT INTO stores VALUES('range_base','ore',6,NULL,'x'),('sol_base','ore',3,NULL,'x')").run();
    const view=itemView(dir,'ore',2,200);
    assert.deepEqual(view.bids.map(bid=>[bid.base_id,bid.price,bid.age,bid.since]),[['range_base',15,50,150],['sol_base',8,100,100]]);
    assert.deepEqual(view.asks.map(ask=>[ask.base_id,ask.price]),[['range_base',9],['sol_base',10]]);
    assert.deepEqual(inputSources(view,20,'sol_base'),[{from:'hold',quantity:2,price:0},{from:'store:sol_base',quantity:3,price:0},
      {from:'store:range_base',quantity:6,price:0},{from:'ask:range_base',quantity:9,price:9}]);
    assert.deepEqual(holdings(dir,200).map(row=>[row.base_id,row.quantity,row.bid?.base_id]),[['range_base',6,'range_base'],['sol_base',3,'range_base']]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function world(options:WorldOptions={}) {
  const game=bridgeWorld({services:['refuel','repair','storage'],cargo:[{item_id:'ore',quantity:7}],cargoUsed:7,cargoCapacity:50,
    store:[{item_id:'scrap',quantity:2}],...options});
  const runtime=fresh();
  bind({account:game.account as unknown as Account,command:game.command,pilot:()=>({mood:'Focused'}),runtime,emit:()=>{}});
  return {...game,runtime,close:()=>{unbind();rmSync(runtime,{recursive:true,force:true});}};
}
const kept=(runtime:string)=>readStores(runtime).map(row=>[row.base_id,row.item_id,row.quantity]);

test('the stores table is kept by every view and move: a view sets the base, a deposit and a withdraw the item, each a store line',async()=>{
  const f=world();
  try {
    assert.equal((await storage()).status,'done');
    assert.deepEqual(kept(f.runtime),[['sol_base','scrap',2]]);
    assert.equal((await stow([{item_id:'ore',quantity:5}])).status,'done');
    assert.deepEqual(kept(f.runtime),[['sol_base','ore',5],['sol_base','scrap',2]]);
    assert.equal((await withdraw([{item_id:'ore',quantity:3}])).status,'done');
    assert.deepEqual(kept(f.runtime),[['sol_base','ore',2],['sol_base','scrap',2]]);
    const lines=readJournal(f.runtime).filter(line=>line.event==='store').map(line=>[line.via,line.items]);
    assert.deepEqual(lines,[['view',{scrap:2}],['deposit',{ore:5}],['withdraw',{ore:2}]],'a re-view that changes nothing writes no line');
    assert.deepEqual((stateSnapshot().stores as Record<string,unknown>),{sol_base:{ore:2,scrap:2}});
  } finally {f.close();}
});

test('a view whose locations disagree with what is kept re-reads that base from afar, and forgets a base no longer listed',async()=>{
  const f=world();
  const reads:unknown[]=[];
  const view=f.command;
  unbind();
  bind({account:f.account as unknown as Account,pilot:()=>({mood:'Focused'}),runtime:f.runtime,emit:()=>{},command:async(action,params)=>{
    if(action!=='spacemolt_storage/view')return view(action,params);
    reads.push(params?.station_id??'here');
    return params?.station_id==='far_base'
      ?{structuredContent:{base_id:'far_base',items:[{item_id:'gem',quantity:4}],locations:[]}}
      :{structuredContent:{base_id:'sol_base',items:[],locations:[{base_id:'far_base',item_count:4}]}};
  }});
  try {
    worldDb(f.runtime)!.prepare("INSERT INTO stores VALUES('gone_base','ore',9,NULL,'x')").run();
    await storage();
    assert.deepEqual(reads,['here','far_base']);
    assert.deepEqual(kept(f.runtime),[['far_base','gem',4]]);
    await storage();
    assert.deepEqual(reads,['here','far_base','here'],'a store that agrees is not re-read');
  } finally {f.close();}
});

test('goods bought into the store are gained, and stowing is neither gain nor loss (live: gatherUntil stowed 344 units, "nothing gained")',async()=>{
  const f=world({markets:{sol_base:[{item_id:'ore',best_buy:8,best_buy_qty:50,best_sell:10,best_sell_qty:50}]}});
  try {
    await storage();
    const bought=await buy('ore',5,{deliverTo:'storage'});
    assert.equal(bought.status,'done',bought.why);
    assert.deepEqual(bought.gained.items,[{item_id:'ore',quantity:5}]);
    assert.deepEqual(kept(f.runtime),[['sol_base','ore',5],['sol_base','scrap',2]]);
    const stowed=await stow([{item_id:'ore'}]);
    assert.deepEqual(stowed.gained.items,[]);
  } finally {f.close();}
});

// Last in the file: every db this file's tests opened lives under its throwaway dir. The bridge world's exit hook
// asserts the same for every test file that builds one.
test('every db a test opened is under the system temp dir',()=>{
  assert.ok(openDirs().length>0);
  for(const dir of openDirs())assert.ok(dir.startsWith(tmpdir()),dir);
});
