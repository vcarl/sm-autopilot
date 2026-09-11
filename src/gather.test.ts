import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {gatherFixture} from './gather-fixture.ts';
import {ExecutionStore} from './execution-store.ts';
import {executionCatalog} from './execution.ts';
import {resolveContext,moods} from './execution-policy.ts';
import {miningInventory} from './mining-inventory.ts';

test('Industry shared jobs assess real local candidates, preserve mixed yield and starting assets, and report bounded unsuccessful or partial work',async t=>{
  const f=gatherFixture(t);await f.choose();
  f.state.modules=f.state.modules.filter((module:any)=>module.module_id!=='miner');
  f.state.modules.push({module_id:'scanner',type_id:'survey_scanner_i',slot:'utility',size:1});
  f.state.cargo.push({item_id:'mining_laser_i',quantity:1,size:1});
  const fit=f.account.send.bind(f.account);
  f.account.send=async(tool,action,params)=>{
    const response=await fit(tool,action,params);
    if(action==='uninstall_mod') {
      f.state.modules=f.state.modules.filter((module:any)=>module.module_id!==params?.id);
      f.state.cargo.push({item_id:'survey_scanner_i',quantity:1,size:1});
    }
    if(action==='install_mod') {
      f.state.cargo=f.state.cargo.filter((item:any)=>item.item_id!=='mining_laser_i');
      f.state.modules.push({module_id:'miner',type_id:'mining_laser_i',slot:'utility',stats:{mining_power:5}});
    }
    return response;
  };
  const preparation:any=await f.execution.dispatch('prepare');
  assert.equal(preparation.status,'completed');
  assert.ok(f.state.modules.some((module:any)=>module.stats?.mining_power>0));
  assert.equal(miningInventory(f.state).survey_scanner_i,1);
  const observation:any=await f.execution.dispatch('observe');
  const target=observation.gathering.candidates[0].poi_id;
  const assessment:any=await f.execution.dispatch('assess',{poi_id:target});
  assert.equal(assessment.status,'ready_to_verify_resources');
  assert.equal(f.calls.some(c=>c.key==='spacemolt/mine'),false);
  const before=miningInventory(f.state);
  const job:any=await f.execution.dispatch('gather',{poi_id:target,cycles:2});
  assert.equal(job.status,'completed');
  assert.deepEqual(job.result.gather.yields,{ore:2,carbon:1});
  assert.deepEqual(job.result.gather.retained_cargo,job.result.gather.yields);
  for(const [item,quantity] of Object.entries(miningInventory(f.state)))assert.equal(quantity-(before[item]??0),job.result.gather.yields[item]??0);
  assert.equal(job.result.gather.skill_progress[0].verified_xp_gain,10);
  assert.equal(job.cash_delta,-12);
  assert.equal(job.after.location.docked_at,f.store.data.home!.base_id);
  assert.equal(job.after.ship.fuel,job.after.ship.max_fuel);
  assert.ok(!f.calls.some(c=>['spacemolt/sell','spacemolt_storage/deposit','spacemolt/hunt'].includes(c.key)));
  assert.deepEqual((new ExecutionStore(f.directory,'pilot').data.jobs.at(-1)?.result as any).gather,job.result.gather);
  const partial=gatherFixture(t);await partial.choose();
  const send=partial.account.send.bind(partial.account);let cycles=0;
  partial.account.send=async(tool,action,params)=>{
    if(action==='mine'&&cycles++>0)throw new SpacemoltError('resource_depleted','exhausted');
    return send(tool,action,params);
  };
  const depleted:any=await partial.execution.dispatch('gather',{poi_id:'belt',cycles:3});
  assert.equal(depleted.status,'completed');
  assert.equal(depleted.result.gather.stop_reason,'resource_depleted');
  assert.equal(depleted.result.gather.cycles_completed,1);
  assert.deepEqual(depleted.result.gather.retained_cargo,{ore:2});
  for(const mode of ['missing_resources','no_yield','passengers','other_system','filtered','replaced','mismatch']) {
    const blocked=gatherFixture(t);await blocked.choose();
    const original=blocked.account.send.bind(blocked.account);
    blocked.account.send=async(tool,action,params):Promise<any>=>{
      if(mode==='no_yield'&&action==='mine')return {structuredContent:{}};
      if(mode==='filtered'&&action==='mine') {
        blocked.state.cargo.push({item_id:'unrelated_reward',quantity:3,size:1});
        return {structuredContent:{kind:'filtered',filtered:true}};
      }
      if(mode==='passengers'&&action==='list_passengers')return {structuredContent:{count:1,passengers:[{id:'passenger',destination_base_id:'other'}]}};
      if(mode==='missing_resources'&&action==='get_poi')return {structuredContent:{poi:{id:'belt',system_id:'system'}}};
      const result:any=await original(tool,action,params);
      if(mode==='replaced'&&action==='mine')blocked.state.ship.id='replacement';
      if(mode==='mismatch'&&action==='mine'&&result.structuredContent.resource_id==='carbon')result.structuredContent.quantity++;
      return result;
    };
    if(mode==='other_system')Object.assign(blocked.execution.context.home!,{base_id:'remote_base',poi_id:'remote_station',system_id:'remote'});
    const result:any=await blocked.execution.dispatch('gather',{poi_id:'belt',cycles:2});
    assert.equal(result.status,'blocked',mode);
    assert.equal(blocked.calls.filter(c=>c.key==='spacemolt/mine').length,mode==='replaced'?1:mode==='mismatch'?2:0,mode);
    if(mode==='no_yield')assert.equal(result.result.gather.cycles_completed,1);
    if(mode==='filtered') {
      assert.deepEqual(result.result.gather.yields,{});
      assert.deepEqual(result.result.gather.unattributed_cargo_gains,{unrelated_reward:3});
    }
    if(mode==='replaced')assert.deepEqual(result.result.partial.gather.yields,{});
    if(mode==='mismatch') {
      assert.deepEqual(result.result.gather.yields,{ore:2});
      assert.equal(result.result.gather.status,'blocked');
      assert.equal(result.result.gather.stop_reason,'yield_unverified');
    }
  }
});

test('gather honors resolved cycle bounds, stops or defends after persisted yield, and never replays an unknown mine',async t=>{
  for(const mood of moods) {
    const context=resolveContext({stance:'Industry',mood,objective:'Bounded gathering'});
    assert.throws(()=>resolveContext({stance:'Industry',mood,objective:'Bounded gathering',limits:{max_gather_cycles:context.limits.max_gather_cycles+1}}),/bound/);
    if(mood==='Tired')assert.equal('gather' in executionCatalog(context),false);
  }
  for(const event of ['stop','attack','uncertain']) {
    const f=gatherFixture(t);await f.choose();
    await assert.rejects(f.execution.dispatch('gather',{poi_id:'belt',cycles:f.execution.context.limits.max_gather_cycles+1}),/policy/);
    const send=f.account.send.bind(f.account);let mines=0;
    f.account.send=async(tool,action,params)=>{
      const result=await send(tool,action,params);
      if(action==='mine') {
        mines++;
        if(event==='stop')f.execution.signal('Tired');
        if(event==='attack'){f.attack();f.execution.requestDefense();}
        if(event==='uncertain')throw new Error('Connection lost after mine may have been accepted');
      }
      return result;
    };
    const job:any=await f.execution.dispatch('gather',{poi_id:'belt',cycles:3});
    assert.equal(mines,1,event);
    const persisted=new ExecutionStore(f.directory,'pilot').data.jobs.at(-1)!;
    assert.equal(persisted.id,job.id);
    if(event==='uncertain') {
      assert.equal(job.status,'needs_reconciliation');
      assert.equal(job.actions.at(-1).action,'spacemolt/mine');
      const recovered:any=await f.execution.reconcile();
      assert.equal(recovered.status,'needs_reconciliation');
      assert.equal(mines,1);
      assert.ok(!f.calls.some(c=>c.key==='spacemolt/refuel'));
    } else {
      assert.equal(job.status,'returned_to_base',event);
      assert.deepEqual(job.result.partial.gather.yields,{ore:2});
      assert.deepEqual(job.result.partial.gather.retained_cargo,{ore:2});
      assert.equal(job.after.location.docked_at,'base');
      assert.equal(job.after.ship.fuel,job.after.ship.max_fuel);
      assert.equal(job.obligation_verification.status,'observed');
      if(event==='attack')assert.equal(job.defense[0].result.retreated,true);
      await assert.rejects(f.execution.dispatch('gather',{poi_id:'belt'}),/admission closed/);
    }
    assert.ok(!f.calls.some(c=>c.key==='spacemolt/hunt'));
  }
  const lost=gatherFixture(t);await lost.choose();
  const send=lost.account.send.bind(lost.account);let mines=0,failed=false;
  lost.account.send=async(tool,action,params)=>{
    const result=await send(tool,action,params);
    if(action==='mine')mines++;
    return result;
  };
  lost.account.refresh=async()=>{
    if(mines===2&&!failed){failed=true;throw new Error('Refresh failed after accepted second mine');}
    return lost.state;
  };
  const unfinished:any=await lost.execution.dispatch('gather',{poi_id:'belt',cycles:2});
  assert.equal(unfinished.status,'needs_reconciliation');
  lost.state.cargo=lost.state.cargo.filter((item:any)=>item.item_id!=='ore');
  const recovered:any=await lost.execution.reconcile();
  assert.equal(recovered.status,'blocked');
  assert.equal(mines,2);
  let progress=recovered.result;
  while(progress.partial)progress=progress.partial;
  assert.deepEqual(progress.gather.yields,{ore:2});
  assert.deepEqual(progress.gather.retained_cargo,{ore:0});
  assert.equal(progress.gather.status,'blocked');
  assert.match(progress.gather.inventory_verification,/missing/);
  assert.equal(recovered.obligation_verification.status,'observed');
  assert.equal(recovered.after.location.docked_at,'base');
  assert.deepEqual((new ExecutionStore(lost.directory,'pilot').data.jobs.at(-1)?.result as any).partial.gather,progress.gather);
});
