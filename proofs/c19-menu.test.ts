import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReadinessAccount,ReadinessCommand} from '../src/readiness.ts';
import type {Mood} from '../src/mood-policy.ts';
import {travelTo,TravelBlocked} from '../src/travel.ts';
import {ServiceBlocked,serviceShip} from '../src/servicing.ts';
import {STANCES,type Facts,type StanceName} from '../src/rules-table.ts';
import {buildMenu} from '../src/menu.ts';

// The D2 margins are the operator's table, asserted here rather than read back from
// the resolver, so the menu and the scripts are pinned to the same numbers.
const reserves={Relaxed:30,Cautious:30,Focused:24,Opportunistic:20,Aggressive:12,Tired:0} as const;
const spends={Relaxed:500,Cautious:500,Focused:1000,Opportunistic:1000,Aggressive:2000} as const;
const walkAway={Relaxed:.90,Cautious:.95,Focused:.90,Opportunistic:.90,Aggressive:.80,Tired:.95} as const;

const base=():Facts['place']=>({kind:'base',base_id:'base',is_home:false,
  counters:['Market','Services','Comms / news','Progression desk','Home desk','Boards — missions','Distress'],
  service_prices:{fuel:5,hull:5},sites:[],board:{contracts:[],passengers:0}});
const at=(over:Partial<Facts>={}):Facts=>({
  mood:'Focused',place:base(),
  holdings:{fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:100_000},
  obligations:{},permissions:{},observed:{},...over});
/** Every stance's preconditions met at once, so one fixture answers all six. */
const rich=(stance:StanceName,mood:Mood='Focused'):Facts=>at({stance,mood,
  place:{...base(),workshop:true,
    sites:[{poi_id:'belt',quoted_fuel:10,resource:'ore'},{poi_id:'far-station',quoted_fuel:10,serviced_base:true},
      {poi_id:'near-station',quoted_fuel:5,serviced_base:true}],
    board:{contracts:[{id:'c1',cargo:10,liability:100}],passengers:3}},
  holdings:{fuel:120,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:100_000,inputs:['polymer']},
  permissions:{max_liability:2_000},
  observed:{targets:['creature-7'],spread:{item_id:'ore',margin:40}}});
const jobs=(menu:{options:{job:string}[]})=>menu.options.map(option=>option.job).filter(job=>/^J\d/.test(job));

test('C19: danger is evaluated first and a dangerous place offers nothing but safety',async()=>{
  for(const place of [base(),{kind:'space'} as Facts['place']]) {
    const menu=buildMenu(at({stance:'Hunter',place,observed:{threats:['pirate frigate Vexil']}}));
    assert.ok(menu.options.length>=3,'a threatened pilot still has somewhere to go');
    // Nothing inadmissible is even computed: the menu is the safety set, not a filter of work.
    assert.deepEqual(menu.unavailable,[]);
    for(const option of menu.options) {
      assert.match(option.reason,/pirate frigate Vexil/,option.job);
      assert.match(option.job,/^(Retreat|Dock|Hold position)/,option.job);
      assert.equal(option.bounds.walkAway,walkAway.Focused,option.job);
    }
    assert.ok(menu.options.some(option=>/^Retreat/.test(option.job)));
    assert.ok(menu.options.some(option=>/^Dock/.test(option.job)));
    assert.ok(menu.options.some(option=>/^Hold position/.test(option.job)));
  }
});

test('C19: at a base the menu is never empty and every option carries a reason and bounds',async()=>{
  // Empty board, no sites, no workshop, no inputs, nothing owed: the stance contributes
  // no work at all, and the shared options still stand.
  for(const stance of [undefined,'Industrialist' as const])for(const mood of Object.keys(spends) as (keyof typeof spends)[]) {
    const menu=buildMenu(at({stance,mood,holdings:{fuel:60,max_fuel:120,hull:80,max_hull:100,cargo_free:50,credits:100_000}}));
    assert.ok(menu.options.length>0,`${stance}/${mood}: the menu is never empty`);
    assert.deepEqual(jobs(menu),['J12 Home, serviced'],`${stance}/${mood}: only the universal job is admissible`);
    assert.ok(menu.options.some(option=>option.job.startsWith('Counter: ')),'a counter needs no stocked board');
    for(const option of menu.options) {
      assert.ok(option.reason.length>0,option.job);
      assert.equal(option.admissible,true,option.job);
      assert.deepEqual(option.bounds,{spend:spends[mood],fuelReserve:reserves[mood],walkAway:walkAway[mood]},option.job);
    }
    // An off-menu attempt is told what would make it admissible.
    assert.ok(menu.unavailable.length>0);
    for(const refusal of menu.unavailable)assert.ok(refusal.reason.length>0,refusal.job);
    // Place changes the menu: the counters and the service are the base's, not the belt's,
    // and the menu at a POI is still not empty.
    const belt=buildMenu(at({stance,mood,place:{kind:'poi',poi_id:'belt'} as Facts['place']}));
    assert.ok(belt.options.length>0,'a pilot away from a base still has options');
    assert.deepEqual(belt.options.filter(option=>option.job.startsWith('Counter: ')),[]);
    assert.deepEqual(jobs(belt),[]);
    assert.ok(belt.unavailable.some(refusal=>refusal.job==='J12 Home, serviced'&&/dock at a base/.test(refusal.reason)));
  }
});

test('C19: the menu agrees with travelTo and serviceShip on the same table',async()=>{
  for(const [mood,reserve] of Object.entries(reserves) as [Mood,number][]) {
    for(const deficit of [1,0]) {
      const cost=10,fuel=cost+reserve-deficit;
      const menu=buildMenu(at({mood,place:{...base(),sites:[{poi_id:'relay',quoted_fuel:cost,serviced_base:true}]},
        holdings:{fuel,max_fuel:120,hull:100,max_hull:100,cargo_free:50,credits:100_000}}));
      const offered=menu.options.some(option=>option.job.includes('relay'));
      const refused=menu.unavailable.find(refusal=>refusal.job.includes('relay'));
      const departure=travelFixture(fuel,cost);
      const trip=travelTo(departure.account,departure.command,{system_id:'a',poi_id:'relay'},{mood});
      if(deficit) {
        assert.equal(offered,false,`${mood}: a trip the script refuses is not on the menu`);
        assert.match(refused!.reason,/shortfall 1 fuel units/,mood);
        await assert.rejects(trip,error=>error instanceof TravelBlocked&&
          error.message.includes('shortfall 1 fuel units'),mood);
      } else {
        assert.equal(offered,true,`${mood}: the script accepts exactly what the menu offered`);
        assert.equal(refused,undefined,mood);
        await trip;
      }
    }
  }
  for(const [mood,margin] of Object.entries(spends) as [Mood,number][])for(const over of [1,0]) {
    // Ten fuel units and ten hull points short, priced at half the margin each.
    const price=margin/20,quoted=margin+over*20;
    const menu=buildMenu(at({mood,place:{...base(),service_prices:{fuel:price+over,hull:price+over}},
      holdings:{fuel:110,max_fuel:120,hull:90,max_hull:100,cargo_free:50,credits:100_000}}));
    const service=menu.options.find(option=>option.job.startsWith('J12'));
    const refused=menu.unavailable.find(refusal=>refusal.job.startsWith('J12'));
    const f=serviceFixture(price+over);
    const run=serviceShip(f.account,f.command,{mood});
    if(over) {
      assert.equal(service,undefined,`${mood}: a service the script refuses is not on the menu`);
      assert.match(refused!.reason,new RegExp(`exceeds the ${mood} service spend margin ${margin}`),mood);
      await assert.rejects(run,error=>error instanceof ServiceBlocked&&
        error.message.includes(`exceeds the ${mood} service spend margin ${margin}`),mood);
    } else {
      assert.ok(service,`${mood}: the margin admits the full service`);
      assert.match(service.reason,new RegExp(`${quoted} credits`),mood);
      assert.equal((await run).spent,margin,mood);
    }
  }
});

test('C19: Tired offers resupply and safety and nothing else',async()=>{
  const facts=rich('Hunter','Tired');
  const menu=buildMenu({...facts,holdings:{...facts.holdings,fuel:40,hull:60}});
  assert.ok(menu.options.length>0);
  assert.deepEqual(jobs(menu),['J12 Home, serviced'],'Tired starts nothing new');
  for(const option of menu.options)
    assert.match(option.job,/^(J12 Home, serviced|Travel to (far|near)-station|Counter: (Services|Distress)|Hold position and watch)$/,option.job);
  // The same facts at a job mood carry the stance's work, so the restriction is Tired's.
  assert.ok(jobs(buildMenu({...facts,mood:'Focused',holdings:{...facts.holdings,fuel:40,hull:60}})).length>1);
});

test('C19: a stance contributes its own jobs when its preconditions hold, and names what is missing',async()=>{
  const wants:Record<StanceName,string[]>={
    Prospector:['J1 Hold full of ore'],Industrialist:['J7 Inputs at the bench'],
    Trader:['J6 Trade run closed'],Carrier:['J4 Freight delivered','J5 Passengers landed'],
    Hunter:['J8 Creature down'],Scout:['J9 Price circuit walked'],
  };
  for(const stance of Object.keys(wants) as StanceName[]) {
    const offered=jobs(buildMenu(rich(stance)));
    for(const job of wants[stance])assert.ok(offered.includes(job),`${stance} offers ${job}`);
    // No other stance's work leaks in, admissible or not.
    const menu=buildMenu(rich(stance)),named=[...menu.options,...menu.unavailable].map(option=>option.job);
    for(const [other,theirs] of Object.entries(wants))if(other!==stance)
      for(const job of theirs)assert.equal(named.includes(job),false,`${stance} must not see ${other}'s ${job}`);
  }
  // Preconditions absent: no stance job is admissible, and each says what it needs.
  for(const stance of Object.keys(wants) as StanceName[]) {
    const menu=buildMenu(at({stance,holdings:{fuel:60,max_fuel:120,hull:80,max_hull:100,cargo_free:50,credits:100_000}}));
    assert.deepEqual(jobs(menu),['J12 Home, serviced'],stance);
    for(const job of wants[stance]) {
      const refusal=menu.unavailable.find(entry=>entry.job===job);
      assert.ok(refusal&&refusal.reason.length>0,`${stance}: ${job} says what would admit it`);
    }
  }
  // The "start with these" flag stays meaningful: a flagged stance has work of its own.
  for(const stance of STANCES)if(stance.active_first)
    assert.ok(jobs(buildMenu(rich(stance.name))).some(job=>!job.startsWith('J12')),
      `${stance.name} is flagged to play first but contributes no job of its own`);
});

// Recording handler-map fixtures from the C1 and C5 proofs: server state is independent,
// exposed to production code only through refresh.
function travelFixture(fuel:number,cost:number) {
  const server={location:{system_id:'a',poi_id:'station',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',fuel,max_fuel:120,cargo_used:0}};
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/find_route':({id})=>({delta:{details:{found:true,target_system:id,total_jumps:0,
      estimated_fuel:cost,fuel_per_jump:cost,fuel_available:server.ship.fuel,
      cargo_used:server.ship.cargo_used,route:[{system_id:'a',jumps:0}]}}}),
    'spacemolt/undock':()=>{server.location.docked_at=null;return {};},
    'spacemolt/travel':({id})=>{server.location.poi_id=String(id);server.ship.fuel-=cost;return {};},
  };
  const command:ReadinessCommand=async(action,params)=>{
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params);
  };
  return {server,account,command};
}

function serviceFixture(price:number) {
  const server={location:{system_id:'a',poi_id:'dock',docked_at:'base' as string|null,in_transit:false},
    ship:{id:'ship',fuel:110,max_fuel:120,hull:90,max_hull:100,shield:10,max_shield:10,cargo_used:0,cargo_capacity:50},
    player:{credits:100_000},cargo:[{item_id:'ore',quantity:4}],
    modules:[{module_id:'m1',type_id:'mining_laser_i',slot:'utility'}]};
  const account:ReadinessAccount={state:structuredClone(server) as ReadinessAccount['state'],
    async refresh(){account.state=structuredClone(server) as ReadinessAccount['state'];}};
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_base':()=>({delta:{details:{services:['refuel','repair'],
      base:{poi_id:'dock',repair_price_per_hull:price},fuel_price_all_in:price}}}),
    'spacemolt/refuel':()=>{
      const filled=server.ship.max_fuel-server.ship.fuel;server.ship.fuel=server.ship.max_fuel;
      return {delta:{details:{action:'refuel',source:'station',fuel:server.ship.fuel,cost:filled*price}}};
    },
    'spacemolt/repair':()=>{
      const repaired=server.ship.max_hull-server.ship.hull;server.ship.hull=server.ship.max_hull;
      return {delta:{details:{action:'repair',source:'station',hull:server.ship.hull,cost:repaired*price}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action](params??{});
  };
  return {server,account,command};
}
