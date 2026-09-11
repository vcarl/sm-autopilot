import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveStationDestinations,industryLocations} from './locations.ts';
import {passengerFixture} from './passenger-fixture.ts';
import {Execution} from './execution.ts';
import {ExecutionStore} from './execution-store.ts';

const station=(id:string,base_id:string,system_id='system')=>({id,base_id,poi_id:base_id,system_id,name:base_id,system_name:system_id,services:[],wrecked:false});

test('directory matching uses exact typed identities and rejects ambiguity, wrecks and distant destinations',async()=>{
  const directory=[station('public-id','other'),station('distant','far','far-system'),{...station('wreck','wreck-base'),wrecked:true}];
  const distances=new Map([['system',0],['far-system',3]]);
  const results=resolveStationDestinations(directory as any,distances,['public-id','other','distant','wreck','unknown'],2);
  assert.equal(results[0]?.station?.base_id,'other');
  assert.equal(results[0]?.status,'resolved');assert.equal(results[1]?.status,'resolved');
  assert.equal(results[2]?.status,'outside_route_limit');assert.equal(results[3]?.status,'wrecked');assert.equal(results[4]?.status,'missing');
  assert.equal(resolveStationDestinations([...directory,station('public-id','another')] as any,distances,['public-id'],2)[0]?.status,'ambiguous');
  await assert.rejects(industryLocations('system',{observed_destination_ids:Array(7).fill('id')}),/at most six/);
});

test('shared passenger jobs resolve offer IDs for routing and retain identity across Tired resume without duplicate boarding',async t=>{
  for(const interrupted of [false,true]) {
    const f=passengerFixture(t,{destination:'public-id'});
    const locations=f.execution.deps.locations!;
    f.execution.deps.locations=async(system,params)=>({...await locations(system,params),
      destination_matches:resolveStationDestinations([station('public-id','other')] as any,new Map([['system',0]]),params.observed_destination_ids as string[]??[],2)});
    await f.choose();
    const assessment:any=await f.execution.dispatch('assess',{kind:'passengers'});
    assert.equal(assessment.candidates[0].destination,'public-id');
    assert.equal(assessment.candidates[0].destination_base_id,'other');
    assert.deepEqual(assessment.candidates[0].blockers,[]);
    if(interrupted)f.onBoard(()=>f.execution.signal('Tired'));
    let job:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'public-id'});
    if(interrupted) {
      assert.equal(job.status,'blocked');assert.equal(f.passengers().length,1);
      const store=new ExecutionStore(f.directory,'pilot');await store.startNewRun(f.account);
      const execution=new Execution(f.account,store,f.execution.context,f.execution.deps);
      job=await execution.dispatch('transport',{resume_job_id:job.id});
    }
    assert.equal(job.status,'completed',JSON.stringify(job.result));
    assert.equal(job.result.transport.destination,'public-id');assert.equal(job.result.transport.destination_base_id,'other');
    assert.equal(job.result.transport.fare_collected,7);
    assert.equal(f.calls.filter(call=>call.key==='spacemolt/load_passenger').length,1);
    assert.equal(f.calls.find(call=>call.key==='spacemolt/load_passenger')?.params.id,'other');
    assert.ok(f.calls.some(call=>call.key==='spacemolt/travel'&&call.params.id==='other'));
    assert.equal(f.state.location.docked_at,'base');assert.equal(f.passengers().length,0);
  }
  const f=passengerFixture(t,{destination:'unresolved'});await f.choose();
  const blocked:any=await f.execution.dispatch('transport',{kind:'passengers',destination:'unresolved'});
  assert.equal(blocked.status,'blocked');
  assert.equal(f.calls.some(call=>call.key==='spacemolt/load_passenger'),false);
});
