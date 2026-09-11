import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {miningInventory,measureMineYield} from './mining-inventory.ts';
import {gatherFixture} from './gather-fixture.ts';

test('recorded live mine delta verifies only site-resource gains retained from its correlated response',()=>{
  const {replay}=JSON.parse(readFileSync(new URL('../evidence/shared-live-gather-delta.json',import.meta.url),'utf8'));
  const before=miningInventory(replay.before),after=miningInventory(replay.accepted_mine.delta);
  const site={ship_id:replay.before.ship.id,system_id:replay.before.location.system_id,poi_id:replay.before.location.poi_id};
  const resources=new Set<string>(replay.resources.map((r:any)=>r.resource_id));
  const measured=measureMineYield(before,after,replay.accepted_mine,site,resources);
  assert.deepEqual(measured.yields,{carbon_ore:3});
  assert.equal(measured.source,'command_state_delta');
  assert.match(measured.note,/simultaneous same-resource gains cannot be separated/);
  const increased={...after,carbon_ore:after.carbon_ore!+100};
  assert.deepEqual(measureMineYield(before,increased,replay.accepted_mine,site,resources).yields,measured.yields);
  const unchangedIdentity=structuredClone(replay.accepted_mine);
  delete unchangedIdentity.delta.ship;delete unchangedIdentity.delta.location;
  assert.deepEqual(measureMineYield(before,after,unchangedIdentity,site,resources).yields,measured.yields);
  for(const change of [
    (r:any)=>{r.command='trade';},
    (r:any)=>{r.delta.ship.id='other_ship';},
    (r:any)=>{r.delta.location.poi_id='other_site';},
    (r:any)=>{r.delta.details={kind:'filtered'};},
    (r:any)=>{delete r.delta.cargo;},
  ]) {
    const invalid=structuredClone(replay.accepted_mine);change(invalid);
    assert.deepEqual(measureMineYield(before,after,invalid,site,resources).yields,{});
  }
  assert.deepEqual(measureMineYield(before,before,replay.accepted_mine,site,resources).yields,{});
});

test('gather completes bounded extraction from command deltas, preserves unrelated gains separately and records provenance',async t=>{
  const f=gatherFixture(t);await f.choose();
  const send=f.account.send.bind(f.account);let tick=0;
  f.account.send=async(tool,action,params)=>{
    const reply=await send(tool,action,params);
    if(action!=='mine')return reply;
    f.state.cargo.push({item_id:'unrelated_reward',quantity:1,size:1});f.state.ship.cargo_used++;
    return {command:'mine',tick:++tick,delta:structuredClone({ship:f.state.ship,cargo:f.state.cargo,location:f.state.location})} as any;
  };
  const job:any=await f.execution.dispatch('gather',{poi_id:'belt',cycles:2});
  assert.equal(job.status,'completed');
  const work=job.result.gather;
  assert.equal(work.cycles_completed,work.cycles_requested);
  assert.deepEqual(work.yields,{ore:2,carbon:1});
  assert.deepEqual(work.retained_cargo,work.yields);
  assert.deepEqual(work.unattributed_cargo_gains,{unrelated_reward:2});
  assert.ok(work.yield_measurements.every((m:any)=>m.source==='command_state_delta'));
  assert.equal(job.after.ship.fuel,job.after.ship.max_fuel);
});
