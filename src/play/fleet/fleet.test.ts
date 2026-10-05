import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ConnectionClosedError,SpacemoltError,type Account} from '@spacemolt/lib';
import type {ReadinessCommand} from '../../readiness.ts';
import {readJournal} from '../../run-record.ts';
import {bridgeWorld} from '../../test-support/bridge-world.ts';
import {scriptPath} from '../freighter/host.ts';
import {bind,stop,unbind} from '../runtime.ts';
import type {Circuit} from '../trading/trading.ts';
import {assign} from './fleet.ts';

const GEMS:Circuit={closed:true,hold:10,lap_jumps:2,lap_net:500,stops:[
  {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:10,max_price:110},sell:[]},
  {at:'range_base',system_id:'deep_range',sell:[{item:'gem',min_price:120}]}]};

/** `assign` over a faction-ledger world whose commands go wrong the way `raises` says; what it answered, the `defect` lines it journalled, and whether a script was written. */
async function assignOver(raises:(action:string)=>void,early:()=>void=()=>{}) {
  const runtime=mkdtempSync(join(tmpdir(),'fleet-map-'));
  const world=bridgeWorld({tradeIntel:[{base_id:'sol_base',items:[{item_id:'gem',best_buy:0,best_sell:100,sell_volume:50}]},
    {base_id:'range_base',items:[{item_id:'gem',best_buy:130,buy_volume:50}]}]});
  (world.account.server.player as {username?:string}).username='B';
  const command:ReadinessCommand=async(action,params)=>{raises(action);return world.command(action,params);};
  bind({account:world.account as unknown as Account,command,pilot:()=>({mood:'Focused'}),emit:()=>{},runtime});
  try {
    await world.account.refresh();early();
    const out=await assign('hauler',GEMS,{float:20_000});
    return {out,defects:readJournal(runtime,10_000).filter(entry=>entry.event==='defect'),installed:existsSync(scriptPath(runtime,'hauler'))};
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
}

test("assign over a map the server refuses is refused in the server's code, installs nothing, and is no defect",async()=>{
  const {out,defects,installed}=await assignOver(action=>{if(action==='spacemolt/get_map')throw new SpacemoltError('rate_limited','slow down');});
  assert.equal(out.status,'refused');
  assert.match(out.why??'',/rate_limited/);
  assert.equal(installed,false);
  assert.deepEqual(defects,[]);
});

test('assign over a map whose reply is lost is failed, installs nothing, and is no defect',async()=>{
  const {out,defects,installed}=await assignOver(action=>{if(action==='spacemolt/get_map')throw new ConnectionClosedError('socket gone');});
  assert.equal(out.status,'failed');
  assert.equal(installed,false);
  assert.deepEqual(defects,[]);
});

test('assign stopped by the pilot before it reads the books is a stop, installs nothing, and is no defect',async()=>{
  const {out,defects,installed}=await assignOver(()=>{},stop);
  assert.notEqual(out.status,'done');
  assert.match(out.why??'',/stopped on order/);
  assert.equal(installed,false);
  assert.deepEqual(defects,[]);
});
