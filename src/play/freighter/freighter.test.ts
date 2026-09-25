import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SpacemoltError} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {check} from '../../run.ts';
import {bridgeWorld} from '../../test-support/bridge-world.ts';
import {assign} from '../fleet/fleet.ts';
import {bind,unbind} from '../runtime.ts';
import type {Circuit} from '../trading/trading.ts';
import {gate,script,scriptPath} from './host.ts';
import {lap,type Freighter,type Lap,type Report} from './index.ts';

// Gems bought at sol for at most 110, sold at range for at least 120.
const GEMS:Circuit={closed:true,hold:10,lap_jumps:2,lap_net:500,stops:[
  {at:'sol_base',system_id:'sol',buy:{item:'gem',qty:10,max_price:110},sell:[]},
  {at:'range_base',system_id:'deep_range',sell:[{item:'gem',min_price:120}]}]};

/** A freighter over the fake world, its deposits and reports recorded. `refuse` names commands the game refuses. */
function freighter(rangeBid:number,refuse:string[]=[]) {
  const world=bridgeWorld({services:['refuel','repair','storage'],cargo:[{item_id:'ore',quantity:5}],cargoUsed:5,cargoCapacity:50,
    markets:{sol_base:[{item_id:'gem',best_buy:0,best_buy_qty:0,best_sell:100,best_sell_qty:50}],
      range_base:[{item_id:'gem',best_buy:rangeBid,best_buy_qty:50,best_sell:0,best_sell_qty:0},
        {item_id:'ore',best_buy:999,best_buy_qty:99,best_sell:0,best_sell_qty:0}]}});
  world.account.server.player.credits=50_000;
  const deposits:{credits:number;wallet:number}[]=[],reports:Report[]=[];
  const command:ReadinessCommand=async(action,params)=>{
    if(refuse.includes(action))throw new SpacemoltError('refused',`${action} refused`);
    if(action==='spacemolt_storage/deposit'&&params.credits!==undefined) {
      deposits.push({credits:Number(params.credits),wallet:world.account.server.player.credits});
      world.account.server.player.credits-=Number(params.credits);
      return {delta:{details:{action:'send_gift'}}};
    }
    return world.command(action,params);
  };
  let parked:string|undefined;
  const f:Freighter={name:'hauler',account:world.account as unknown as ReadinessAccount,command,owner:'B',float:5_000,
    recalled:()=>false,park:why=>{parked=why;return {park:why,net:0};},report:fields=>{reports.push(fields);}};
  return {world,f,deposits,reports,parked:()=>parked};
}

test('a lap sells only the listed items at their floors, buys within the cap, and sends home exactly what is above the float',async()=>{
  const {world,f,deposits,reports}=freighter(115);
  await world.account.refresh();
  const done=await lap(f,GEMS);
  assert.equal(done.park,undefined,reports.map(r=>r.why).filter(Boolean).join('; '));
  assert.equal(world.count('spacemolt/sell'),0,'gems bid 115 under the 120 floor, and the ore bid 999 is not on the list');
  assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/buy').map(c=>c.params),[{id:'gem',quantity:10}]);
  assert.equal(world.account.server.location.docked_at,'range_base');
  assert.equal(deposits.length,1,'sent home from sol; at range nothing sold and the refuel left it under the float');
  assert.equal(deposits[0]!.credits,deposits[0]!.wallet-f.float);
  assert.ok(world.account.server.player.credits<=f.float);
  assert.equal(reports.filter(r=>r.lapped!==undefined).length,1);
  assert.equal(world.count('spacemolt_intel/submit_trade_intel'),1,'no faction: filing is tried at the first stop and not again');
  assert.deepEqual(reports.filter(r=>r.why?.startsWith('trade intel')).map(r=>r.why),
    ['trade intel not filed, and not tried again this process: You are not in a faction']);
});

test('a lap sells at a bid over the floor',async()=>{
  const {world,f,deposits}=freighter(130);
  await world.account.refresh();
  await lap(f,GEMS);
  assert.deepEqual(world.sent.filter(c=>c.action==='spacemolt/sell').map(c=>c.params),[{id:'gem',quantity:10}]);
  assert.equal(deposits.length,2,'the sale at range goes home too');
  for(const {credits,wallet} of deposits)assert.equal(credits,wallet-f.float);
});

test('a refused buy is skipped, not thrown, and three stops in a row with no trade park the circuit',async()=>{
  const {world,f,reports,parked}=freighter(130,['spacemolt/buy']);
  await world.account.refresh();
  let laps=0,last:Lap;
  do {last=await lap(f,GEMS);laps++;} while(!last.park&&laps<5);
  assert.match(last.park!,/^circuit dead/);
  assert.equal(parked(),last.park);
  assert.equal(laps,2,'sol, range, then sol again');
  assert.ok(reports.some(r=>/buy 10 gem refused/.test(r.why??'')));
});

test('assign refuses an open path, and writes nothing',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-assign-'));
  const world=bridgeWorld({});
  bind({account:world.account as unknown as ReadinessAccount,command:world.command,pilot:()=>({mood:'Focused'}),
    setPilot:()=>{},emit:()=>{},runtime});
  try {
    const open={...GEMS,closed:false} as unknown as Circuit;
    const out=await assign('hauler',open,{float:20_000});
    assert.equal(out.status,'refused');
    assert.match(out.why!,/an open path would strand a freighter that repeats it; use routes\(\{circuit:\{hold\}\}\)/);
    const oneWay=await assign('hauler',{...GEMS,stops:[GEMS.stops[0]!]},{float:20_000});
    assert.match(oneWay.why!,/fewer than 2 distinct stops/);
    assert.equal(existsSync(scriptPath(runtime,'hauler')),false);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a generated freighter script passes the gate: tsc, and play/freighter as its only import',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'freighter-script-'));
  try {
    mkdirSync(join(runtime,'freighters'));
    writeFileSync(scriptPath(runtime,'hauler'),script(GEMS));
    assert.deepEqual(gate(scriptPath(runtime,'hauler')),[]);
    mkdirSync(join(runtime,'pilot'));
    writeFileSync(join(runtime,'pilot','index.ts'),script(GEMS));
    const typed=await check(runtime);
    assert.deepEqual(typed.errors,[]);
    writeFileSync(scriptPath(runtime,'hauler'),`import {lap} from 'play/freighter';\nimport {goTo} from 'play';\nexport default async function main() {}\n`);
    assert.match(gate(scriptPath(runtime,'hauler')).join(),/imports "play"; a freighter script imports only 'play\/freighter'/);
  } finally {rmSync(runtime,{recursive:true,force:true});}
});

test('three laps in a row that lose money park the freighter, the why naming the last lap against the prediction',async()=>{
  // Gems cost 100 at sol and sell for 100 at range: every lap pays out its fuel and repairs and makes nothing.
  const {world,f,parked}=freighter(100);
  await world.account.refresh();
  const flat:Circuit={...GEMS,stops:[GEMS.stops[0]!,{...GEMS.stops[1]!,sell:[{item:'gem',min_price:90}]}]};
  const laps:Lap[]=[];
  do laps.push(await lap(f,flat)); while(!laps.at(-1)!.park&&laps.length<5);
  assert.equal(laps.length,3);
  assert.ok(laps.every(one=>one.net<=0),laps.map(one=>one.net).join());
  assert.equal(parked(),`3 laps lost money: last ${laps[2]!.net} vs predicted 500`);
  assert.equal(world.account.server.location.docked_at,'range_base','parked docked at the last stop');
});
