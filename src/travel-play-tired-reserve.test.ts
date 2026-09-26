import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {goTo} from './play/travel.ts';
import {derived} from './test-support/bridge-world.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';

// S4: the mood picks the fuel reserve a leg is quoted against, and `goTo` froze it at the top
// of the trip. The leg to a base is the one leg a Tired pilot is still flown — the whole point
// of the stop — so it is exactly the leg the stale reserve bites: quoted on the pre-Tired
// Cautious 30 rather than Tired's 0, `travelTo` raises `FuelRouteShortfall` on the resupply
// trip the crossing exists to enable, and the pilot is stranded one jump short of the station.
//
// A knock on the first jump is the shape that shows it: the route cost falls by exactly the
// jump's fuel, so a flat reserve that admitted the route at departure admits it after every
// jump too — only fuel lost beyond the jump's own cost can open the gap.
const SYSTEMS=['a','b','c'];
const SYSTEM_OF:Record<string,string>={a:'a',b:'b',c:'c',c_station:'c'};
const POI_OF:Record<string,string|undefined>={c_station:'c_dock'};
const POIS:Record<string,{id:string;name?:string;base_id?:string;base_name?:string}[]>={
  a:[{id:'gate',name:'A Gate'}],
  b:[{id:'gate',name:'B Gate'}],
  c:[{id:'gate',name:'C Gate'},{id:'c_dock',name:'C Dock',base_id:'c_station',base_name:'C Station'}],
};
const JUMP=10,LEAK=5;

function fixture() {
  // Fuel 52 against a two-jump route: 20 quoted plus the Cautious reserve 30 departs with 2
  // to spare, so the trip is admissible under the mood it starts in.
  const initial={location:{system_id:'a',poi_id:'gate',docked_at:null as string|null,in_transit:false},
    ship:{id:'ship',fuel:52,max_fuel:120,hull:100,max_hull:100,cargo_used:0},
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
      // The knock on the way into b: hull under the Cautious walk-away line, which imposes
      // Tired, and fuel bled past the jump's own cost.
      if(String(id)==='b'){server.ship.hull=90;server.ship.fuel-=LEAK;}
      return {};
    },
    travel:({id}={})=>{server.location.poi_id=String(id);return {};},
    dock:()=>{server.location.docked_at='c_station';return {};},
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  const who=derived(()=>({mood:'Cautious'}),account);
  bind({account:account as unknown as ReadinessAccount,command,
    pilot:who,emit:()=>{}});
  return {account,server,command,pilot:who,
    jumps:()=>account.calls.filter(call=>call.action==='jump').length};
}

test('the leg to a base is re-quoted on the mood in force, so Tired reaches the station',async()=>{
  const f=fixture();
  try {
    const trip=await goTo('c_station');
    // The crossing was imposed on the first jump; 37 fuel is short of the 40 the Cautious
    // reserve wanted for the last jump and well inside the 10 Tired's own reserve wants.
    assert.equal(f.pilot().mood,'Tired');
    assert.equal(trip.status,'done',`${trip.did}: ${trip.why}`);
    assert.equal(f.jumps(),2);
    assert.equal(trip.detail.docked,true);
    assert.equal(f.server.location.docked_at,'c_station');
  } finally {unbind();}
});
