import test from 'node:test';
import assert from 'node:assert/strict';
import {planTransportFuel} from './transport-itinerary.ts';
import {resolveContext} from './execution-policy.ts';

const station=(base_id:string,system_id:string,hops=0)=>({base_id,system_id,poi_id:base_id,hops,rationale:'fixture',observed_at:'fixture'});
const context=()=>({...resolveContext({stance:'Logistics',mood:'Focused',objective:'Deliver and return'}),home:station('home','home-system')});
function fixture(fuel:number,cargo:number) {
  const account:any={ship:{id:'ship',fuel,max_fuel:120,cargo_used:cargo,cargo_capacity:120},location:{system_id:'origin',docked_at:'origin-base'},refresh:async()=>{}};
  const calls:string[]=[];
  const command=async(_action:string,params:any={})=>{
    calls.push(params.id);return {found:true,target_system:params.id,total_jumps:1,estimated_fuel:10+cargo,fuel_per_jump:10+cargo,
      fuel_available:fuel,cargo_used:cargo,route:[{system_id:'origin',jumps:0},{system_id:params.id,jumps:1}]};
  };
  return {account,command,calls};
}

test('itinerary fuel covers current load, asymmetric return hops and operating reserve without claiming a reverse quote',async()=>{
  for(const [cargo,fuel,expected] of [[0,47,'ready'],[5,47,'blocked'],[5,62,'ready']] as const) {
    const f=fixture(fuel,cargo),result=await planTransportFuel(f.account,f.command,station('destination','target'),station('home','home-system',2),context());
    assert.equal(result.status,expected);assert.equal(result.required_fuel,(10+cargo)*3+17);
    assert.equal(result.return.kind,'loaded_cargo_hop_projection');assert.equal(result.return.jumps,2);
    assert.deepEqual(f.calls,['target']);assert.equal(result.outbound.quote.cargo_used,cargo);
  }
  const local=fixture(40,0);
  const actual=await planTransportFuel(local.account,local.command,station('destination','origin'),station('home','home-system',1),context());
  assert.equal(actual.status,'ready');assert.equal(actual.outbound.fuel,0);assert.equal(actual.return.kind,'actual_route_quote');
  assert.deepEqual(local.calls,['home-system']);assert.equal(actual.required_fuel,27);
  for(const [total,rate] of [[30,1],[1,30]]) {
    const f=fixture(80,0);
    const command=async(action:string,params:any)=>({...await f.command(action,params),estimated_fuel:total,fuel_per_jump:rate});
    const planned=await planTransportFuel(f.account,command,station('destination','target'),station('home','home-system',2),context());
    assert.equal(planned.return.fuel,60,'Neither conflicting quote component can understate the return projection');
    assert.equal(planned.required_fuel,total!+60+17);
    assert.equal(planned.return.quoted_fuel_per_jump,rate);assert.equal(planned.return.quoted_average_fuel_per_jump,total);
    assert.equal(planned.status,total===30?'blocked':'ready');
  }
});

test('unknown, inconsistent and racing fuel evidence blocks commitment and preserves received quotes',async()=>{
  for(const issue of ['missing_fuel','missing_load','different_load','different_fuel','wormhole','mood_cap','race']) {
    const f=fixture(120,0),original=f.command;
    const command=async(action:string,params:any)=>{
      const result:any=await original(action,params);
      if(issue==='missing_fuel')delete result.estimated_fuel;
      if(issue==='missing_load')delete result.cargo_used;
      if(issue==='different_load')result.cargo_used=1;
      if(issue==='different_fuel')result.fuel_available=119;
      if(issue==='wormhole')result.route[1].via_wormhole=true;
      if(issue==='race')f.account.ship.fuel=119;
      return result;
    };
    const policy=context();if(issue==='mood_cap')policy.mood='Tired';
    const result=await planTransportFuel(f.account,command,station('destination','target'),station('home','home-system',2),policy);
    assert.equal(result.status,'blocked',issue);assert.ok(result.blockers.length);assert.equal(result.route_quotes.length,1);
  }
  const unknown=fixture(120,0);delete unknown.account.ship.fuel;
  const blocked=await planTransportFuel(unknown.account,unknown.command,station('destination','target'),station('home','home-system',2),context());
  assert.equal(blocked.status,'blocked');assert.deepEqual(unknown.calls,[]);
});
