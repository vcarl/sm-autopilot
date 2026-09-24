import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {goTo} from './play/travel.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';

// S2: `imposeTired()` moves the mood between any two commands, and a `goTo` already in the
// air used to fly the whole route on the mood it departed under — the stop only bit at the
// next job gate, one leg too late. A route of two jumps to a POI, with hull lost on the way,
// is the shape that shows it: the crossing is imposed after the first jump, and the second
// must not be flown. The trip is `partial` where it stopped, and the pilot is left able to
// fly to a base, which is what the Tired stop is for.
const SYSTEMS=['a','b','c'];
const SYSTEM_OF:Record<string,string>={a:'a',b:'b',c:'c',ore_belt:'c',b_station:'b'};
const POI_OF:Record<string,string|undefined>={ore_belt:'ore_belt',b_station:'b_dock'};
const POIS:Record<string,{id:string;name?:string;base_id?:string;base_name?:string}[]>={
  a:[{id:'gate',name:'A Gate'}],
  b:[{id:'gate',name:'B Gate'},{id:'b_dock',name:'B Dock',base_id:'b_station',base_name:'B Station'}],
  c:[{id:'gate',name:'C Gate'},{id:'ore_belt',name:'Ore Belt'}],
};
const JUMP=10;

function fixture() {
  const initial={location:{system_id:'a',poi_id:'gate',docked_at:null as string|null,in_transit:false},
    ship:{id:'ship',fuel:100,max_fuel:120,hull:100,max_hull:100,cargo_used:0},
    player:{credits:1_000}};
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:({id}={})=>{
      const target=SYSTEM_OF[String(id)];
      assert.ok(target,`fixture knows no place named ${id}`);
      const from=SYSTEMS.indexOf(server.location.system_id),to=SYSTEMS.indexOf(target!);
      const path=from<=to?SYSTEMS.slice(from,to+1):SYSTEMS.slice(to,from+1).reverse();
      return {found:true,target_system:target,...POI_OF[String(id)]?{target_poi:POI_OF[String(id)]}:{},
        total_jumps:path.length-1,estimated_fuel:(path.length-1)*JUMP,fuel_per_jump:JUMP,
        fuel_available:server.ship.fuel,cargo_used:server.ship.cargo_used,
        route:path.map((system_id,jumps)=>({system_id,jumps}))};
    },
    get_system:()=>{
      const here=SYSTEMS.indexOf(server.location.system_id);
      return {system:{connections:[SYSTEMS[here-1],SYSTEMS[here+1]].filter(Boolean),
        pois:POIS[server.location.system_id]}};
    },
    jump:({id}={})=>{
      server.ship.fuel-=JUMP;
      server.location.system_id=String(id);server.location.poi_id='gate';
      // A knock taken on the first hop: hull under the Cautious walk-away line is a crossing,
      // and the runtime imposes Tired on the next command's return.
      if(String(id)==='b')server.ship.hull=90;
      return {};
    },
    travel:({id}={})=>{server.location.poi_id=String(id);return {};},
    dock:()=>{server.location.docked_at='b_station';return {};},
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  let who:Pilot={mood:'Cautious'};
  bind({account:account as unknown as ReadinessAccount,command,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  return {account,server,command,pilot:()=>who,
    jumps:()=>account.calls.filter(call=>call.action==='jump').length};
}

test('a crossing mid-route stops the leg in flight, and a base is still reachable',async()=>{
  const f=fixture();
  try {
    const trip=await goTo('ore_belt');
    // One jump flown, the crossing imposed, the second jump never sent.
    assert.equal(f.pilot().mood,'Tired');
    assert.equal(f.jumps(),1);
    assert.equal(f.server.location.system_id,'b');
    assert.equal(trip.status,'partial',`${trip.did}: ${trip.why}`);
    assert.match(trip.why??'',/Tired/);
    assert.equal(trip.detail.jumps,1);

    // The stop is not a strand: the pilot is sitting in a system, out of transit, and the
    // one move a Tired pilot is admitted for still goes through.
    const rescue=await goTo('b_station');
    assert.equal(rescue.status,'done',`${rescue.did}: ${rescue.why}`);
    assert.equal(rescue.detail.docked,true);
    assert.equal(f.server.location.docked_at,'b_station');
    assert.equal(f.pilot().mood,'Tired','the hull is still down, so the stop still stands');
  } finally {unbind();}
});
