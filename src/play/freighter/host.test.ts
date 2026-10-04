// The host's own reads, in a process of their own: `inFaction` says "no faction" once per process, and the first
// test here is the one that hears it.
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ReadinessCommand} from '../../readiness.ts';
import {readJournal} from '../../run-record.ts';
import {TICK} from '../../test-support/bridge-world.ts';
import {market,readFleet,recallLoop,writeFleet} from './host.ts';

const MEMORY={base_id:'range_base',at:'',tick:TICK,system_id:'deep_range',
  items:[{item_id:'gem',best_buy:150,best_buy_qty:50,best_sell:0,best_sell_qty:0,buy_orders:[],sell_orders:[]}]};
const runtimeWith=()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-book-'));
  writeFileSync(join(runtime,'markets.json'),JSON.stringify([MEMORY]));
  return runtime;
};

test("a book fetched for a freighter with no faction says so under that freighter's name, and the memory stands",async()=>{
  const runtime=runtimeWith();
  try {
    const command:ReadinessCommand=async()=>{throw new Error('the ledger is not asked of a factionless account');};
    const book=await market(runtime,'hauler',{state:{player:{}}},command).book('range_base');
    assert.equal(book?.tick,TICK);
    const said=readJournal(runtime).filter(line=>line.event==='faction_skipped');
    assert.deepEqual(said.map(line=>line.freighter),['hauler']);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a ledger the server refuses leaves the memory standing, journals the refusal with its code and the freighter, and writes no defect line',async()=>{
  const runtime=runtimeWith();
  try {
    const command:ReadinessCommand=async()=>{throw new SpacemoltError('no_trade_intel','no trade intel facility');};
    const book=await market(runtime,'hauler',{state:{player:{faction_id:'guild'}}},command).book('range_base');
    assert.equal(book?.tick,TICK);
    const lines=readJournal(runtime);
    assert.deepEqual(lines.filter(line=>line.event==='defect'),[]);
    const unread=lines.filter(line=>line.ledger_unread!==undefined);
    assert.equal(unread.length,1);
    assert.match(String(unread[0]?.ledger_unread),/no_trade_intel/);
    assert.equal(unread[0]?.freighter,'hauler');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a bug in the ledger read goes up to the loop that asked, not swallowed as a missing ledger',async()=>{
  const runtime=runtimeWith();
  try {
    const bug=new TypeError('not a game error');
    const command:ReadinessCommand=async()=>{throw bug;};
    await assert.rejects(market(runtime,'hauler',{state:{player:{faction_id:'guild'}}},command).book('range_base'),error=>error===bug);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test("one freighter's failed ledger fetch is its own: another freighter asking the same base within BOOK_TTL_MS reads its own",async()=>{
  const runtime=runtimeWith();
  try {
    const taken=new Error('session_replaced or disconnected: kicked');
    const gone:ReadinessCommand=async()=>{throw taken;};
    const fine:ReadinessCommand=async()=>({structuredContent:{entries:[{base_id:'range_base',submitted_at_tick:TICK+1,
      items:[{item_id:'gem',best_buy:160,buy_volume:5,best_sell:0,sell_volume:0}]}]}});
    const faction={state:{player:{faction_id:'guild'}}};
    await assert.rejects(market(runtime,'a',faction,gone).book('range_base'),error=>error===taken);
    const book=await market(runtime,'b',faction,fine).book('range_base');
    assert.equal(book?.tick,TICK+1,'b read the ledger on its own connection');
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a ledger entry that does not decode is said under the freighter, and the memory stands',async()=>{
  const runtime=runtimeWith();
  try {
    const command:ReadinessCommand=async()=>({structuredContent:{entries:[{base_id:'range_base',submitted_at_tick:TICK+1,items:[{item_id:'gem'}]}]}});
    const book=await market(runtime,'hauler',{state:{player:{faction_id:'guild'}}},command).book('range_base');
    assert.equal(book?.tick,TICK);
    assert.ok(readJournal(runtime).some(line=>line.freighter==='hauler'&&line.base_id==='range_base'&&line.ledger_unread!==undefined));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a fleet row the host cannot read is kept on disk as it was through every rewrite, and said once under its name',()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-fleet-'));
  try {
    const broken={state:'flying',circuit:{hold:'?'},float:9_000,owner:'B',holding:{gem:{quantity:40,cost:4_800}}};
    writeFileSync(join(runtime,'freighters.json'),JSON.stringify({broken,
      hauler:{state:'running',circuit:{closed:true,hold:'gem',lap_jumps:2,lap_net:100,stops:[]},float:5_000,owner:'B',lap:0,returned:0,at:''}}));
    assert.deepEqual(Object.keys(readFleet(runtime)),['hauler']);
    recallLoop(runtime,'hauler','lap');
    recallLoop(runtime,'hauler');
    const disk=JSON.parse(readFileSync(join(runtime,'freighters.json'),'utf8'));
    assert.deepEqual(disk.broken,broken,'the row it cannot read is not erased');
    assert.equal(disk.hauler.state,'parked');
    assert.equal(readJournal(runtime).filter(line=>line.freighter==='broken'&&line.fleet_row_unread!==undefined).length,1);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('a fleet file that is not a JSON object is set aside, not overwritten, before the next write',()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-fleet-'));
  try {
    writeFileSync(join(runtime,'freighters.json'),'[not json');
    writeFleet(runtime,{});
    const aside=readdirSync(runtime).filter(file=>file.startsWith('freighters.json.unreadable-'));
    assert.equal(aside.length,1);
    assert.equal(readFileSync(join(runtime,aside[0]!),'utf8'),'[not json');
    assert.ok(readJournal(runtime).some(line=>line.event==='fleet_unreadable'));
  } finally {rmSync(runtime,{recursive:true,force:true});}
});
