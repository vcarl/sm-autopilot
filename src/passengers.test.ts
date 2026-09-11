import test from 'node:test';
import assert from 'node:assert/strict';
import {assessPassengers,transportPassengers,type PassengerControls,type PassengerReceipt} from './passengers.ts';

function fixture(auto=true) {
  const passenger={citizen_id:'p',destination:'destination',class:'economy',ticks_remaining:30,base_fare:8};
  const unrelated={citizen_id:'other',destination:'elsewhere',class:'economy',ticks_remaining:80,base_fare:5};
  const account:any={ship:{id:'ship'},location:{docked_at:'origin'},cargo:[{item_id:'original',quantity:3}],credits:100};
  let rows:any[]=[unrelated],stop=false;
  const calls:{action:string;params:any}[]=[],saved:PassengerReceipt[]=[];
  const controls:PassengerControls={checkpoint:async()=>{if(stop)throw new Error('Tired');},record:r=>saved.push(structuredClone(r)),validateRoute:async()=>{},travel:async(destination)=>{
    account.location.docked_at=destination;
    if(auto){rows=rows.filter(row=>row.citizen_id!=='p');account.credits+=107;}
    return {dock_receipts:[{structuredContent:{passenger_arrivals:auto?{delivered:[passenger],fare_collected:7}:{}}}]};
  }};
  const command=async(action:string,params:any={})=>{
    calls.push({action,params});
    if(action==='spacemolt/list_passengers')return {count:rows.length,passengers:structuredClone(rows),berths:{economy:{free:2,total:3},business:{free:0,total:0},first:{free:0,total:0}}};
    if(action==='spacemolt/list_station_passengers')return {count:1,waiting:[passenger]};
    if(action==='spacemolt/load_passenger'){rows.push(passenger);return {count:1,loaded:[passenger],total_fare:8};}
    if(action==='spacemolt/unload_passenger'){rows=rows.filter(row=>row.citizen_id!==params.id);account.credits+=107;return {kind:'single',delivered:true,fare_collected:7};}
    throw new Error(`Unexpected ${action}`);
  };
  return {account,command,controls,calls,saved,stop:()=>{stop=true;},resume:()=>{stop=false;},rows:()=>rows};
}

test('passenger transport verifies boarding and exact delivery fare through dock or explicit single unload',async()=>{
  for(const auto of [true,false]) {
    const f=fixture(auto);
    const assessment=await assessPassengers(f.account,f.command,{destination:'destination'},{stations:[{base_id:'destination',system_id:'system',poi_id:'poi'}] as any});
    assert.equal(assessment.status,'assessed');assert.equal(assessment.candidates[0]?.passengers[0].citizen_id,'p');
    assert.equal(f.calls.some(call=>call.action==='spacemolt/load_passenger'),false);
    const result=await transportPassengers(f.account,f.command,{destination:'destination'},f.controls);
    assert.equal(result.status,'completed');assert.equal(result.fare_collected,7);
    assert.equal(result.loaded[0]!.ticks_remaining,30);assert.equal(result.delivered[0]!.citizen_id,'p');
    assert.deepEqual(f.rows().map(row=>row.citizen_id),['other']);assert.deepEqual(f.account.cargo,[{item_id:'original',quantity:3}]);
    assert.equal(f.calls.filter(call=>call.action==='spacemolt/unload_passenger').length,auto?0:1);
    assert.ok(f.saved.some(row=>row.pending_action?.action==='spacemolt/load_passenger'));
    assert.equal(f.saved.at(-1)?.status,'completed');
  }
});

test('stops preserve boarded passengers for verified resume and uncertain boarding or arrival never replays',async()=>{
  const f=fixture();
  const command=async(action:string,params:any={})=>{const reply=await f.command(action,params);if(action==='spacemolt/load_passenger')f.stop();return reply;};
  const stopped=await transportPassengers(f.account,command,{destination:'destination'},f.controls);
  assert.equal(stopped.status,'interrupted');assert.equal(stopped.pending_action,undefined);
  assert.equal(f.account.location.docked_at,'origin');assert.equal(stopped.onboard.find(row=>row.citizen_id==='p')?.ticks_remaining,30);
  f.resume();
  const resumed=await transportPassengers(f.account,f.command,{destination:'destination',resume:stopped},f.controls);
  assert.equal(resumed.status,'completed');assert.equal(f.calls.filter(call=>call.action==='spacemolt/load_passenger').length,1);
  const expired=fixture();
  const expiredResult=await transportPassengers(expired.account,async(action,params)=>{
    const reply:any=await expired.command(action,params);
    if(action==='spacemolt/list_passengers')for(const row of reply.passengers)if(row.citizen_id==='p')row.ticks_remaining=0;
    return reply;
  },{destination:'destination'},expired.controls);
  assert.equal(expiredResult.status,'interrupted');assert.equal(expiredResult.pending_action,undefined);
  assert.equal(expiredResult.onboard.find(row=>row.citizen_id==='p')?.ticks_remaining,0);
  assert.equal(expired.account.location.docked_at,'origin');
  for(const stage of ['board','dock']) {
    const g=fixture();
    if(stage==='dock')g.controls.travel=async()=>{g.account.location.docked_at='destination';throw new Error('Dock response lost');};
    const uncertain=await transportPassengers(g.account,async(action,params)=>{const reply=await g.command(action,params);if(stage==='board'&&action==='spacemolt/load_passenger')throw new Error('Board response lost');return reply;},{destination:'destination'},g.controls);
    assert.equal(uncertain.status,'needs_reconciliation');assert.ok(uncertain.pending_action);
    const retry=await transportPassengers(g.account,async()=>{throw new Error('No replay permitted');},{destination:'destination',resume:uncertain},g.controls);
    assert.equal(retry.status,'needs_reconciliation');assert.equal(g.calls.filter(call=>call.action==='spacemolt/load_passenger').length,1);
  }
});
