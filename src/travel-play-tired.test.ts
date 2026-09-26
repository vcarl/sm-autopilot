import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {goTo} from './play/travel.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';

// The live juncture (2026-09-24): Tired, docked at `a_station` — a counter that posts no all-in
// repair quote — with every base that could mend the hull in another system. On the live server
// a base id IS its POI id, which the fixture below mirrors, so `find_route` resolving a base to
// "the same id" says nothing about whether it is one, and the system's own POI rows can only be
// read for the system the ship is in. A Tired pilot that may not fly to a base cannot stop being
// Tired, so Tired admits the flight: the mood widens what a script may force, never blocks it.
const SYSTEMS=['a','b','c'];
const SYSTEM_OF:Record<string,string>={a:'a',b:'b',c:'c',ore_belt:'c',b_station:'b',a_station:'a'};
const POI_OF:Record<string,string|undefined>={ore_belt:'ore_belt',b_station:'b_station',a_station:'a_station'};
const POIS:Record<string,{id:string;name?:string;base_id?:string;base_name?:string}[]>={
  a:[{id:'gate',name:'A Gate'},{id:'a_station',name:'A Station',base_id:'a_station',base_name:'A Station'}],
  b:[{id:'gate',name:'B Gate'},{id:'b_station',name:'B Station',base_id:'b_station',base_name:'B Station'}],
  c:[{id:'gate',name:'C Gate'},{id:'ore_belt',name:'Ore Belt'}],
};
const JUMP=10;

function fixture() {
  const initial={location:{system_id:'a',poi_id:'a_station',docked_at:'a_station' as string|null,in_transit:false},
    ship:{id:'ship',fuel:73,max_fuel:120,hull:59,max_hull:80,cargo_used:0},
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
    // `a_station` posts a fuel price and no repair price: the hull cannot be bought here.
    get_base:()=>({services:['refuel'],base:{poi_id:'a_station'},fuel_price_all_in:5}),
    undock:()=>{server.location.docked_at=null;return {};},
    jump:({id}={})=>{
      server.ship.fuel-=JUMP;
      server.location.system_id=String(id);server.location.poi_id='gate';
      return {};
    },
    travel:({id}={})=>{server.location.poi_id=String(id);return {};},
    dock:()=>{server.location.docked_at=server.location.poi_id;return {};},
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  let who:Pilot={mood:'Tired'};
  bind({account:account as unknown as ReadinessAccount,command,
    pilot:()=>who,emit:()=>{}});
  return {account,server,command,pilot:()=>who,
    jumps:()=>account.calls.filter(call=>call.action==='jump').length};
}

test('Tired flies to a base in another system, the one move that can end the shift',async()=>{
  const f=fixture();
  try {
    const trip=await goTo('b_station');
    assert.equal(trip.status,'done',`${trip.did}: ${trip.why}`);
    assert.equal(f.jumps(),1);
    assert.equal(trip.detail.docked,true);
    assert.equal(f.server.location.docked_at,'b_station');
    assert.equal(f.pilot().mood,'Tired','the hull is still down, so the mood of record stands');
  } finally {unbind();}
});
