import test from 'node:test';
import assert from 'node:assert/strict';
import {executionFixture} from './execution-fixture.ts';

test('accepted travel waits for a forced live arrival read despite fresh unrelated pushes, and Tired returns after settling',async t=>{
  for(const mode of ['arrival','tired','timeout','danger']) {
    const tired=mode==='tired';
    const f=executionFixture(t);await f.choose();
    let now=0,pending:string|undefined,refreshes=0;
    f.execution.deps.combat!.now=()=>now;
    const sleep=f.execution.deps.combat!.sleep!;let danger=false;
    f.execution.deps.combat!.sleep=async(ms)=>{now+=ms;await sleep(ms);if(tired)f.execution.signal();if(mode==='danger'&&!danger){danger=true;f.attack();f.execution.requestDefense();}};
    const send=f.account.send.bind(f.account);
    f.account.send=async(tool,action,params)=>{
      const result=await send(tool,action,params);
      if(action==='travel'&&params?.id==='other') {
        pending='other';f.state.location.poi_id='station';f.state.location.in_transit=true;
      }
      if(action==='summary'&&mode==='danger'){f.state.location={system_id:'system',poi_id:'belt',docked_at:null,in_transit:false};pending=undefined;}
      if(action==='dock')assert.equal(f.state.location.in_transit,false);
      return result;
    };
    f.account.refresh=async()=>{
      refreshes++;
      // Cargo updates keep the global freshness clock looking current throughout.
      Object.assign(f.account,{isStateStale:false});
      if(pending&&now>=30000&&mode!=='timeout'){f.state.location.poi_id=pending;f.state.location.in_transit=false;pending=undefined;}
      return f.state;
    };
    const job:any=await f.execution.dispatch('travel',{base_id:'other'});
    const returning=tired||mode==='danger';
    assert.equal(job.status,mode==='timeout'?'needs_reconciliation':returning?'returned_to_base':'completed',JSON.stringify(job));
    if(mode==='timeout'){assert.equal(f.store.unresolved()?.id,job.id);assert.ok(!f.calls.some(c=>c.key==='spacemolt/dock'));}
    else assert.equal(job.after.location.docked_at,returning?'base':'other');
    if(mode==='danger')assert.equal(job.defense[0].result.retreated,true);
    assert.equal(f.calls.filter(c=>c.key==='spacemolt/travel'&&c.params.id==='other').length,1);
    assert.ok(now>=30000&&now<=(mode==='timeout'?600000:90000));assert.ok(refreshes>1);
    assert.ok(job.actions.every((a:any)=>a.status==='confirmed'));
    if(mode==='arrival')assert.ok(f.calls.filter(c=>c.key==='spacemolt_battle/status').length<=3);
  }
  for(const affordable of [true,false]) {
    const f=executionFixture(t);await f.choose();f.state.ship.fuel=16;
    f.execution.context.limits.max_spend=affordable?400:10;
    const job:any=await f.execution.dispatch('travel',{base_id:'other'});
    assert.equal(job.status,affordable?'completed':'blocked',JSON.stringify(job));
    const refuels=job.actions.filter((a:any)=>a.action==='spacemolt/refuel');
    if(affordable) {
      assert.equal(refuels.length,2);assert.equal(refuels[0].before.location.docked_at,'base');
      assert.equal(refuels[0].result.structuredContent.cost,(120-16)*3);
      assert.equal(job.spending.gross_spend,(120-16+1)*3);
    } else {
      assert.equal(refuels.length,0);assert.equal(f.state.location.docked_at,'base');
      assert.ok(!f.calls.some(c=>c.key==='spacemolt/undock'));
    }
  }
});
