import assert from 'node:assert/strict';
import test from 'node:test';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {goTo} from './play/travel.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';

// Report 02, fix 1: on the live server a base's id is the same as its POI's id, so the old
// `target_poi !== named` heuristic never counted anything as a base, and a Tired pilot's only
// admitted move (goTo a base) was refused every time. The fixtures elsewhere in this repo
// give bases ids that differ from their POI ids (`sol_base` at POI `station`), which is
// exactly the shape that heuristic gets right, so this is the one fixture that would have
// caught it: a base whose id equals its own POI's id.
test('a Tired pilot can goTo a base whose id equals its own POI id',async()=>{
  const initial={location:{system_id:'edge',poi_id:'open_space',docked_at:null as string|null,in_transit:false},
    ship:{id:'ship',fuel:50,max_fuel:100,cargo_used:0}};
  const handlers:FakeCommandHandlers={spacemolt:{
    find_route:()=>({found:true,target_system:'edge',target_poi:'unknown_edge_waystation',
      total_jumps:0,estimated_fuel:0,fuel_per_jump:0,fuel_available:server.ship.fuel,cargo_used:0,
      route:[{system_id:'edge',jumps:0}]}),
    get_system:()=>({system:{connections:['edge'],pois:[
      {id:'open_space',name:'Open Space',type:'poi'},
      // The base id is the POI's own id — the shape the live server actually uses.
      {id:'unknown_edge_waystation',name:'Unknown Edge Waystation',type:'station',
        base_id:'unknown_edge_waystation',base_name:'Unknown Edge Waystation'},
    ]}}),
    travel:(params={})=>{server.location.poi_id=String(params.id);return {};},
    dock:()=>{server.location.docked_at='unknown_edge_waystation';return {};},
  }};
  const account=new FakeLibGoalAccount(initial,handlers);
  const server=account.server;
  const command:ReadinessCommand=(name,payload)=>{
    const [tool,action]=name.split('/');
    return account.send(tool,action,payload);
  };
  const pilot:Pilot={mood:'Tired'};
  bind({account:account as unknown as ReadinessAccount,command,
    pilot:()=>pilot,setPilot:()=>{assert.fail('Tired is not cleared by this trip')},emit:()=>{}});
  try {
    const trip=await goTo('unknown_edge_waystation');
    assert.equal(trip.status,'done',trip.why);
    assert.equal(trip.detail.docked,true);
    assert.equal(server.location.docked_at,'unknown_edge_waystation');
  } finally {unbind();}
});
