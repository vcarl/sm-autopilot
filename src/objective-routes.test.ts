import test from 'node:test';
import assert from 'node:assert/strict';
import {industryLocations} from './locations.ts';
import {validateTransportReturn} from './execution-logistics.ts';
import {planTransportFuel} from './transport-itinerary.ts';
import {resolveContext} from './execution-policy.ts';

const home=(id:string,hops=0)=>({base_id:id,system_id:id,poi_id:id,hops,rationale:'Observed station',observed_at:'now'});

test('objective destinations resolve across the finite directed map while explicit route budgets remain effective',async t=>{
  const ids=Array.from({length:11},(_,i)=>`system-${i}`);
  t.mock.method(globalThis,'fetch',async(input:any)=>{
    if(new URL(String(input)).pathname==='/api/map')return Response.json({systems:ids.map((id,i)=>({id,connections:i+1<ids.length?[ids[i+1]]:[]})),empires:{}});
    return Response.json({stations:ids.map(id=>({id,base_id:id,poi_id:id,system_id:id,name:id,system_name:id,services:['refuel'],wrecked:false})),empires:[]});
  });
  const params={observed_destination_ids:[ids.at(-1)!],refresh_map:true,limit:2};
  const capped=await industryLocations(ids[0],{...params,max_jumps:2});
  assert.equal(capped.destination_matches?.[0]?.status,'outside_route_limit');
  const connected=await industryLocations(ids[0],{...params,max_jumps:null});
  assert.equal(connected.destination_matches?.[0]?.status,'resolved');
  assert.equal(connected.destination_matches?.[0]?.station?.hops,ids.length-1);
  assert.equal(connected.stations?.length,2,'Display limit does not exclude an explicitly requested destination');
  const context={...resolveContext({stance:'Logistics',stop_condition:'objective',objective:'Complete delivery and return'}),home:home(ids.at(-1)!)};
  assert.equal((await validateTransportReturn(home(ids[0]!),context)).status,'reachable');
  assert.equal((await validateTransportReturn(home(ids.at(-1)!),{...context,home:home(ids[0]!)})).status,'blocked','Forward edges do not prove a reverse return route');
});

test('long objective routes use actual fuel and reserve evidence instead of a mood jump cap',async()=>{
  const context={...resolveContext({stance:'Logistics',mood:'Focused',stop_condition:'objective',objective:'Complete delivery and return'}),home:home('home',10)};
  const account:any={ship:{id:'ship',fuel:120,max_fuel:120,cargo_used:10,cargo_capacity:120},location:{system_id:'origin',docked_at:'origin-base'},refresh:async()=>{}};
  const command=async()=>({found:true,target_system:'destination',total_jumps:10,estimated_fuel:20,fuel_per_jump:2,fuel_available:account.ship.fuel,cargo_used:10,
    route:Array.from({length:11},(_,jumps)=>({system_id:jumps===0?'origin':jumps===10?'destination':`via-${jumps}`,jumps}))});
  const ready=await planTransportFuel(account,command,home('destination'),home('home',10),context);
  assert.equal(ready.status,'ready',ready.blockers.join('; '));
  assert.equal(ready.required_fuel,57);
  account.ship.fuel=56;
  const insufficient=await planTransportFuel(account,command,home('destination'),home('home',10),context);
  assert.equal(insufficient.status,'blocked');
  assert.match(insufficient.blockers.join('; '),/fuel/);
  assert.equal(insufficient.required_fuel,ready.required_fuel);
});
