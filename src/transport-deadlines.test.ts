import test from 'node:test';
import assert from 'node:assert/strict';
import {observeTransportDeadlines} from './transport-deadlines.ts';

test('passenger movement requires selected current identities and positive fresh deadlines, without interpreting waiting offers',async()=>{
  const passenger={citizen_id:'selected',destination:'destination',ticks_remaining:10};
  const receipt={kind:'passengers',ship_id:'ship',destination:'destination',loaded:[passenger],delivered:[]};
  const account:any={currentTick:1,ship:{id:'ship'},refresh:async()=>{}};
  for(const issue of ['ready','expired','missing','duplicate','changed','unknown','count','ship']) {
    account.ship.id=issue==='ship'?'replacement':'ship';
    const row={...passenger};if(issue==='expired')row.ticks_remaining=0;if(issue==='unknown')row.ticks_remaining=NaN;if(issue==='changed')row.destination='elsewhere';
    const passengers=issue==='missing'?[]:issue==='duplicate'?[row,row]:[row];
    const result=await observeTransportDeadlines(account,async(action)=>action==='spacemolt_shipping/active'?{action:'active',tick:100,shipments:[]}:{count:issue==='count'?99:passengers.length,passengers},receipt);
    assert.equal(result.status,issue==='ready'?'ready':'blocked',issue);assert.equal(result.observed_tick,100);
    if(issue==='ready')assert.deepEqual(result.selected,[passenger]);else assert.ok(result.blockers.length);
  }
  const queried:string[]=[];
  account.ship.id='ship';
  const command=async(action:string)=>{queried.push(action);return {action:'active',tick:100,shipments:[]};};
  assert.equal((await observeTransportDeadlines(account,command,{...receipt,loaded:[]})).status,'not_applicable');
  assert.equal((await observeTransportDeadlines(account,command,{...receipt,delivered:[passenger]})).status,'not_applicable');
  assert.deepEqual(queried,['spacemolt_shipping/active','spacemolt_shipping/active']);
});

test('freight movement requires current personal contract, package custody, fresh server tick and a live deadline',async()=>{
  const receipt={kind:'freight',ship_id:'ship',shipment_id:'contract',package_id:'box',destination:{base_id:'destination'},custody:{source:'cargo'}};
  for(const issue of ['ready','expired','missing','foreign','package','destination','late','ship']) {
    const account:any={currentTick:1,ship:{id:issue==='ship'?'replacement':'ship'},state:{player:{id:'pilot'}},cargo:issue==='package'?[]:[{item_id:'package:box',quantity:1}],refresh:async()=>{}};
    const row={role:'carrier',package_in_your_cargo:true,late:issue==='late',ticks_to_deadline:issue==='expired'?0:20,
      contract:{id:'contract',package_id:'box',status:'in_transit',contractor:{kind:'player',id:issue==='foreign'?'other':'pilot'},destination_base_id:issue==='destination'?'elsewhere':'destination'}};
    const result=await observeTransportDeadlines(account,async()=>({action:'active',tick:100,shipments:issue==='missing'?[]:[row]}),receipt);
    assert.equal(result.status,issue==='ready'?'ready':'blocked',issue);assert.equal(result.observed_tick,100);
    if(issue==='ready')assert.equal(result.selected[0].ticks_to_deadline,20);else assert.ok(result.blockers.length);
  }
  for(const clock of [undefined,0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    const result=await observeTransportDeadlines({refresh:async()=>{},currentTick:100} as any,async()=>({action:'active',tick:clock,shipments:[]}),undefined);
    assert.equal(result.status,'blocked');assert.equal(result.observed_tick,null);
  }
  for(const response of [{action:'other',tick:100,shipments:[]},{action:'active',tick:100}]) {
    const result=await observeTransportDeadlines({refresh:async()=>{}} as any,async()=>response,undefined);
    assert.equal(result.status,'blocked');
  }
  let queries=0;
  const result=await observeTransportDeadlines({refresh:async()=>{}} as any,async()=>{queries++;return {action:'active',tick:101,shipments:[]};},{...receipt,custody:undefined});
  assert.equal(result.status,'not_applicable');assert.equal(result.observed_tick,101);assert.equal(queries,1);
});
