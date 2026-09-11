import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePassengers} from './passenger-fit.ts';
import {executionFixture} from './execution-fixture.ts';
import {resolveContext} from './execution-policy.ts';

function fixture(t:any,source:'buy'|'storage'|'cargo'='buy',noInstall=false) {
  const f=executionFixture(t);
  f.execution.context=resolveContext({stance:'Logistics',mood:'Focused',objective:'Prepare passenger cabin'},f.execution.context);
  Object.assign(f.state.ship,{cpu_used:4,cpu_capacity:20,power_used:4,power_capacity:20,utility_slots:2});
  f.state.modules=[{module_id:'laser',type_id:'mining_laser_i',slot:'utility',size:5,cpu_usage:2,power_usage:2},{module_id:'scanner',type_id:'survey_scanner_i',slot:'utility',size:5,cpu_usage:2,power_usage:2}];
  const cabin='economy_passenger_cabin';
  if(source==='cargo'){f.state.cargo.push({item_id:cabin,quantity:1,size:10});f.state.ship.cargo_used+=10;}
  let stored=source==='storage'?1:0;
  const send=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params:any={}):Promise<any>=>{
    const reply=await send(tool,action,params);
    let result:any;
    if(action==='inspect')result={catalog:{items:[{id:cabin,slot:'utility',size:10,cpu_usage:3,power_usage:4,passenger_economy_berths:12,required_skills:{}}]}};
    if(tool==='spacemolt_storage'&&action==='view')result={items:[{item_id:cabin,quantity:stored,size:10}]};
    if(action==='estimate_purchase')result={quantity_requested:1,available:1,unfilled:0,total_cost:80,subtotal:75,sales_tax:5,fills:[{quantity:1,price_each:75}]};
    if(action==='buy'||tool==='spacemolt_storage'&&action==='withdraw') {
      f.state.cargo.push({item_id:cabin,quantity:1,size:10});f.state.ship.cargo_used+=10;
      if(action==='buy'){f.state.player.credits+=100-80;result={item_id:cabin,quantity:1,total_cost:80,delivered_to_cargo:1};}else{stored--;result={};}
    }
    if(action==='uninstall_mod') {
      f.state.modules=f.state.modules.filter((row:any)=>row.module_id!==params.id);
      f.state.cargo.push({item_id:'mining_laser_i',quantity:1,size:5});f.state.ship.cargo_used+=5;f.state.ship.cpu_used-=2;f.state.ship.power_used-=2;
    }
    if(action==='install_mod'&&!noInstall) {
      f.state.modules.push({module_id:'cabin-installed',type_id:cabin,slot:'utility',size:10,cpu_usage:3,power_usage:4});
      f.state.cargo=f.state.cargo.filter((row:any)=>row.item_id!==cabin);f.state.ship.cargo_used-=10;f.state.ship.cpu_used+=3;f.state.ship.power_used+=4;
    }
    if(action==='list_passengers')result={count:0,passengers:[],...(f.state.modules.some((row:any)=>row.type_id===cabin)?{berths:{economy:{total:12,free:12},business:{total:0,free:0},first:{total:0,free:0}}}:{})};
    return result===undefined?reply:{structuredContent:result};
  };
  return f;
}

test('passenger preparation quotes without mutation then shared execution fits exact cabin preserving the mining laser',async t=>{
  for(const source of ['buy','storage','cargo'] as const) {
    const f=fixture(t,source);
    const assessed:any=await f.execution.dispatch('assess',{kind:'passenger_fit'});
    assert.equal(assessed.status,'quoted');assert.equal(assessed.estimated_spend,source==='buy'?80:0);
    assert.equal(f.calls.some(call=>['spacemolt/buy','spacemolt/uninstall_mod','spacemolt/install_mod','spacemolt_storage/withdraw'].includes(call.key)),false);
    await f.choose();
    const job:any=await f.execution.dispatch('prepare',{kind:'passengers'});
    assert.equal(job.status,'completed');
    assert.equal(job.spending.gross_spend,source==='buy'?80:0);
    assert.ok(f.state.modules.some((row:any)=>row.module_id==='cabin-installed'));
    assert.ok(f.state.modules.some((row:any)=>row.module_id==='scanner'));
    assert.ok(f.state.cargo.some((row:any)=>row.item_id==='mining_laser_i'&&row.quantity===1));
    assert.ok(f.state.cargo.some((row:any)=>row.item_id==='original'&&row.quantity===1));
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/uninstall_mod').every(call=>call.params.id==='laser'),true);
  }
});

test('fit blockers prevent purchases and a nominal successful install without canonical effect cannot complete',async t=>{
  const blocked=fixture(t);
  blocked.state.modules[0].type_id='valuable_utility';
  const result=await preparePassengers({execute:true,max_spend:100,credit_reserve:0},blocked.account,async(action,params)=>{
    const [tool,name]=action.split('/');return blocked.account.send(tool!,name!,params!);
  });
  assert.equal(result.status,'blocked');assert.ok(result.blockers.some(reason=>reason.includes('Mining Laser')));
  assert.equal(blocked.calls.some(call=>call.key==='spacemolt/buy'||call.key==='spacemolt/uninstall_mod'),false);
  const noEffect=fixture(t,'buy',true);await noEffect.choose();
  const failed:any=await noEffect.execution.dispatch('prepare',{kind:'passengers'});
  assert.notEqual(failed.status,'completed');assert.match(failed.error,/installation/);
  assert.equal(noEffect.calls.filter(call=>call.key==='spacemolt/install_mod').length,1);
  assert.ok(noEffect.state.cargo.some((row:any)=>row.item_id==='economy_passenger_cabin'));
});
