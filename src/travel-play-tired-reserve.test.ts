import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from './test-support/fake-lib-account.ts';
import {goTo} from './play/travel.ts';
import {bind,unbind,type Pilot} from './play/runtime.ts';
import type {Mood} from './mood-policy.ts';

// The mood's fuel reserve is the trigger for resupply, not a travel margin (operator's decision,
// 2026-09-26). A leg is admitted when the tank covers its route; a leg that takes fuel under the
// reserve imposes Tired, and Tired's rules send the pilot to service. Before, travel refused any
// trip that would dip under the reserve, so fuel never crossed it and Tired never fired: a
// Focused pilot with 26 fuel was refused a 4-fuel trip ("short 2") and was never Tired either.
//
// S4, still pinned below: a Tired imposed mid-trip must not strand the resupply leg.
const SYSTEMS=['a','b','c'];
const SYSTEM_OF:Record<string,string>={a:'a',b:'b',c:'c',c_station:'c'};
const POI_OF:Record<string,string|undefined>={c_station:'c_dock'};
const POIS:Record<string,{id:string;name?:string;base_id?:string;base_name?:string}[]>={
  a:[{id:'gate',name:'A Gate'}],
  b:[{id:'gate',name:'B Gate'}],
  c:[{id:'gate',name:'C Gate'},{id:'c_dock',name:'C Dock',base_id:'c_station',base_name:'C Station'}],
};
const LEAK=5;

function fixture({fuel=52,mood='Cautious' as Mood,JUMP=10,knock=true,runtime=undefined as string|undefined}={}) {
  const initial={location:{system_id:'a',poi_id:'gate',docked_at:null as string|null,in_transit:false},
    ship:{id:'ship',fuel,max_fuel:120,hull:100,max_hull:100,cargo_used:0},
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
      if(knock&&String(id)==='b'){server.ship.hull=90;server.ship.fuel-=LEAK;}
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
  let who:Pilot={mood};
  bind({account:account as unknown as ReadinessAccount,command,runtime,
    pilot:()=>who,setPilot:next=>{who=next;},emit:()=>{}});
  return {account,server,command,pilot:()=>who,
    jumps:()=>account.calls.filter(call=>call.action==='jump').length};
}

test('the leg to a base is re-quoted on the mood in force, so Tired reaches the station',async()=>{
  const f=fixture();
  try {
    const trip=await goTo('c_station');
    // The crossing was imposed on the first jump (the hull knock); 37 fuel covers the last
    // jump's 10, and the leg to the counter is flown.
    assert.equal(f.pilot().mood,'Tired');
    assert.equal(trip.status,'done',`${trip.did}: ${trip.why}`);
    assert.equal(f.jumps(),2);
    assert.equal(trip.detail.docked,true);
    assert.equal(f.server.location.docked_at,'c_station');
  } finally {unbind();}
});

// The stranding of 2026-09-25, in miniature: Focused, 26 fuel, two jumps of 2 to the station.
test('a trip the tank covers is flown under the reserve, and the leg that crosses it imposes Tired',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'tired-reserve-'));
  const f=fixture({fuel:26,mood:'Focused',JUMP:2,knock:false,runtime});
  try {
    const trip=await goTo('c_station');
    // 26 >= the route's 4 though < 4 + Focused's 24: admitted, where the old rule said "short 2".
    assert.equal(trip.status,'done',`${trip.did}: ${trip.why}`);
    assert.equal(f.jumps(),2);
    assert.equal(f.server.location.docked_at,'c_station');
    assert.equal(f.server.ship.fuel,22);
    assert.equal(f.pilot().mood,'Tired');
    assert.equal(f.pilot().mood_before_tired,'Focused');
    const journal=readFileSync(join(runtime,'gameplay.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const tired=journal.filter(line=>line.event==='tired');
    assert.equal(tired.length,1);
    // The first jump leaves 24, on the line; the second takes the tank under it.
    assert.deepEqual({rule:tired[0].rule,mood_before:tired[0].mood_before},
      {rule:'fuel 22 under the Focused reserve 24',mood_before:'Focused'});
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('a trip the tank does not cover is still refused, with the route shortfall',async()=>{
  const f=fixture({fuel:3,mood:'Focused',JUMP:2,knock:false});
  try {
    const trip=await goTo('c_station');
    assert.equal(trip.status,'refused');
    assert.equal(trip.why,'fuel 3, the route needs 4; short 1');
    assert.equal(f.jumps(),0);
    assert.equal(f.pilot().mood,'Tired','3 is under the Focused reserve too, from the first read');
  } finally {unbind();}
});
