import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {GameState} from '@spacemolt/lib';
import {ensureReadiness, inspectReadiness} from './readiness.ts';

function fixture(): GameState {
  return {
    player:{credits:10000}, location:{docked_at:'station'},
    ship:{cargo_capacity:125,cargo_used:20,fuel:100,max_fuel:120,hull:80,max_hull:80,utility_slots:2,incapacitated:false},
    cargo:[{item_id:'mining_laser_i',quantity:1,size:10},{item_id:'titanium_alloy',quantity:10,size:1}],
    modules:[
      {module_id:'scanner',type_id:'survey_scanner_i',slot:'utility',size:10,stats:{survey_power:30}},
      {module_id:'expander',type_id:'cargo_expander_ii',slot:'utility',size:10,stats:{cargo_bonus:50}},
    ],
  } as unknown as GameState;
}

test('a full utility fit recovers mining capability and preserves scanner, expander and other cargo', async () => {
  const account = {state:fixture(),async refresh(){}};
  const calls:string[] = [];
  const result = await ensureReadiness(account,async action => {
    calls.push(action);
    if (action === 'spacemolt/uninstall_mod') {
      account.state.modules = account.state.modules!.filter(m => m.module_id !== 'scanner');
      account.state.cargo!.push({item_id:'survey_scanner_i',item_name:'Survey Scanner I',quantity:1,size:10});
      account.state.ship!.cargo_used += 10;
    } else {
      account.state.cargo = account.state.cargo!.filter(c => c.item_id !== 'mining_laser_i');
      account.state.modules!.push({module_id:'laser',type_id:'mining_laser_i',name:'Mining Laser I',type:'mining',cpu_usage:2,power_usage:5,slot:'utility',size:10,stats:{mining_power:10}});
      account.state.ship!.cargo_used -= 10;
    }
  },{requireMining:true,minFreeCargo:50},true);
  assert.deepEqual(calls,['spacemolt/uninstall_mod','spacemolt/install_mod']);
  assert.ok(result.verification.ready);
  assert.equal(account.state.cargo!.find(c=>c.item_id==='survey_scanner_i')?.quantity,1);
  assert.equal(account.state.cargo!.find(c=>c.item_id==='titanium_alloy')?.quantity,10);
  assert.ok(account.state.modules!.some(m=>m.module_id==='expander'));
  // A successful command receipt without a canonical fit must not pass.
  const stale = {state:fixture(),async refresh(){}};
  await assert.rejects(ensureReadiness(stale,async()=>{}, {requireMining:true},true),/preserved/);
});

test('undocked refits, inadequate cargo and unbudgeted station services cannot issue actions', async () => {
  const account={state:fixture(),async refresh(){}};
  let sends=0;
  account.state.location!.docked_at=null;
  let result=await ensureReadiness(account,async()=>{sends++;},{requireMining:true},true);
  assert.ok(result.verification.blockers.some(s=>s.includes('Dock')));
  account.state.location!.docked_at='station';
  account.state.ship!.cargo_used=124;
  result=await ensureReadiness(account,async()=>{sends++;},{requireMining:true},true);
  assert.ok(result.verification.blockers.some(s=>s.includes('preserve')));
  account.state.ship!.cargo_used=20;
  result=await ensureReadiness(account,async()=>{sends++;},{minFuel:120,maxServiceSpend:20,serviceQuotes:{refuel:40}},true);
  assert.ok(result.verification.blockers.some(s=>s.includes('budget')));
  assert.equal(sends,0);
  assert.ok(inspectReadiness(account.state,{minFuel:120}).blockers.some(s=>s.includes('quote')));
});
