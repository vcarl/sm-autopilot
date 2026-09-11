import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {GameState} from '@spacemolt/lib';
import {ensureReadiness, inspectReadiness} from './readiness.ts';

function fixture(): GameState {
  return {
    player:{credits:10000}, location:{docked_at:'station'},
    ship:{id:'ship',cpu_used:4,cpu_capacity:20,power_used:4,power_capacity:20,cargo_capacity:125,cargo_used:20,fuel:100,max_fuel:120,hull:80,max_hull:80,shield:0,max_shield:0,utility_slots:2,incapacitated:false},
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
  for(const failure of ['unconsumed_laser','lost_cargo','lost_module']) {
    const damaged={state:fixture(),async refresh(){}};
    await assert.rejects(ensureReadiness(damaged,async action=>{
      if(action==='spacemolt/uninstall_mod') {
        damaged.state.modules=damaged.state.modules!.filter(module=>module.module_id!=='scanner');
        damaged.state.cargo!.push({item_id:'survey_scanner_i',item_name:'Survey Scanner I',quantity:1,size:10});
        damaged.state.ship!.cargo_used+=10;
      } else {
        damaged.state.modules!.push({module_id:'laser',type_id:'mining_laser_i',name:'Mining Laser I',type:'mining',cpu_usage:2,power_usage:5,slot:'utility',size:10,stats:{mining_power:10}});
        if(failure!=='unconsumed_laser') {
          damaged.state.cargo=damaged.state.cargo!.filter(row=>row.item_id!=='mining_laser_i');
          damaged.state.ship!.cargo_used-=10;
        }
        if(failure==='lost_cargo')damaged.state.cargo=[];
        if(failure==='lost_module')damaged.state.modules=damaged.state.modules!.filter(module=>module.module_id!=='expander');
      }
    },{requireMining:true},true),/consumption|custody/);
  }
});

test('canonical readiness rejects unknown or impossible resources and custody before work and after service',async()=>{
  const corruptions:Array<(state:any)=>void>=[
    ...['cpu_capacity','power_capacity','cargo_capacity','max_fuel','max_hull','max_shield'].map(field=>(state:any)=>{delete state.ship[field];}),
    ...[['cpu_used','cpu_capacity'],['power_used','power_capacity'],['cargo_used','cargo_capacity'],['fuel','max_fuel'],['hull','max_hull'],['shield','max_shield']].map(([used,max])=>(state:any)=>{state.ship[used!]=state.ship[max!]+1;}),
    (state:any)=>{state.ship.cpu_used=NaN;},
    (state:any)=>{state.ship.power_capacity=Infinity;},
    (state:any)=>{state.ship.utility_slots=1.5;},
    (state:any)=>{state.ship.cargo_used=-1;},
    (state:any)=>{state.player.credits=NaN;},
    (state:any)=>{state.modules[0].module_id='';},
    (state:any)=>{state.modules[0].module_id=state.modules[1].module_id;},
    (state:any)=>{state.cargo[0].quantity='unknown';},
    (state:any)=>{state.cargo[0].quantity=-1;},
    (state:any)=>{state.cargo[0].size=NaN;},
  ];
  for(const corrupt of corruptions) {
    const account={state:fixture(),async refresh(){}};
    corrupt(account.state);
    let sends=0;
    const result=await ensureReadiness(account,async()=>{sends++;},{},true);
    assert.equal(result.verification.ready,false);assert.ok(result.verification.blockers.length>0);assert.equal(sends,0);
  }
  for(const corrupt of [...corruptions,(state:any)=>{state.ship.id='replacement';},(state:any)=>{state.location.docked_at='other';}]) {
    const account={state:fixture(),async refresh(){}};
    let sends=0;
    await assert.rejects(ensureReadiness(account,async()=>{
      sends++;account.state.ship!.fuel=120;account.state.player!.credits-=10;corrupt(account.state);
      return {cost:10};
    },{minFuel:120,maxServiceSpend:10,serviceQuotes:{refuel:10}},true),/Canonical|capacities|custody|Ship|ship|dock/);
    assert.equal(sends,1);
  }
  assert.equal(inspectReadiness(fixture()).ready,true);
});

test('readiness safety options reject invalid types and numbers before planning or sending',async()=>{
  const invalid:any[]=[{minFuel:'0'},null,[],{requireMining:'false'},{serviceQuotes:[]},{serviceQuotes:null}];
  for(const key of ['minFreeCargo','minFuel','minHull','creditReserve','maxServiceSpend'])for(const value of ['0',null,NaN,Infinity,-1])invalid.push({[key]:value});
  for(const key of ['refuel','repair'])for(const value of ['0',null,NaN,Infinity,-1])invalid.push({serviceQuotes:{[key]:value}});
  for(const options of invalid) {
    let sends=0;
    await assert.rejects(ensureReadiness({state:fixture(),async refresh(){}},async()=>{sends++;},options,true),/Invalid readiness/);
    assert.equal(sends,0);
  }
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
