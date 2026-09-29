import assert from 'node:assert/strict';
import test from 'node:test';
import type {GameState} from '@spacemolt/lib';
import type {ReadinessAccount,ReadinessCommand} from '../../readiness.ts';
import {FakeLibGoalAccount,type FakeCommandHandlers} from '../../test-support/fake-lib-account.ts';
import {bind,unbind,type Pilot} from '../runtime.ts';
import {buildFacility,facilities} from './facilities/facilities.ts';

/** A pilot docked at `sol_base` with nothing owned and no facility commands registered beyond
 * what a test hands in — `Unregistered command` is the loud failure a missing handler gets. */
function world(handlers:FakeCommandHandlers,pilot:Pilot={mood:'Focused'},credits=1_000) {
  const game=new FakeLibGoalAccount<GameState>({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false} as GameState['location'],
    player:{credits} as GameState['player'],
    ship:{} as GameState['ship'],cargo:[],modules:[],skills:{},
  },handlers);
  const command:ReadinessCommand=(action,params)=>{
    const [tool,name]=action.split('/');
    return game.send(tool!,name!,params);
  };
  const lines:string[]=[];
  bind({account:game as unknown as ReadinessAccount,command,pilot:()=>pilot,emit:text=>lines.push(text)});
  return {game,lines};
}

const OWNED=(facilities_:unknown[],grace=260)=>()=>({structuredContent:{action:'owned',facilities:facilities_,
  rent:{facilities:facilities_.length,est_rent_per_day:0,grace_cycles:grace,
    total_rent_per_cycle:(facilities_ as {rent_per_cycle:number}[]).reduce((n,row)=>n+row.rent_per_cycle,0)}}});

test('facilities() sums runway across every owned facility, not one at a time',async()=>{
  const owned=[{facility_id:'f1',base_id:'sol_base',base_name:'Sol Base',name:'Smelter',type:'smelter',rent_per_cycle:50},
    {facility_id:'f2',base_id:'range_base',base_name:'Deep Range Base',name:'Bunk',type:'crew_bunk',rent_per_cycle:30}];
  const {game}=world({spacemolt_facility:{owned:OWNED(owned)}});
  try {
    const out=await facilities();
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.owned.length,2);
    // 1,000 cr over 80 cr/cycle total (50+30): the wallet, not one facility's share of it.
    assert.equal(out.detail.owned[0]!.runway_cycles,12);
    assert.equal(out.detail.owned[1]!.runway_cycles,12);
    assert.match(out.next[0]!,/runway 12 cycles is under the 260-cycle grace/);
  } finally {unbind();game;}
});

test('facilities() excludes station facilities with no fee and no public access',async()=>{
  const list=()=>({structuredContent:{action:'list',base_id:'sol_base',
    station_facilities:[{facility_id:'repair1',type:'repair_bay',name:'Repair Bay',category:'infrastructure',
      description:'',level:1}],
    player_facilities:[],faction_facilities:[],
    public_facilities:[{facility_id:'pub1',type:'smelter',name:'Public Smelter',category:'production',
      description:'',level:1,recipe_id:'smelt_ore',labor_per_cycle:5,
      production:{public:true,rental_fee_per_run:20}}]}});
  const types=()=>({structuredContent:{action:'types',kind:'list',page:1,per_page:50,total:0,total_pages:1,types:[]}});
  const {} =world({spacemolt_facility:{owned:OWNED([]),list,types}});
  try {
    const out=await facilities();
    assert.equal(out.status,'done',out.why);
    assert.deepEqual(out.detail.here.map(row=>row.id),['pub1']);
  } finally {unbind();}
});

test('buildFacility is idempotent: already owned here sends no build command',async()=>{
  const owned=[{facility_id:'f1',base_id:'sol_base',base_name:'Sol Base',name:'Bunk',type:'crew_bunk',rent_per_cycle:10}];
  const {game}=world({spacemolt_facility:{owned:OWNED(owned)}});
  try {
    const out=await buildFacility('crew_bunk');
    assert.equal(out.status,'done',out.why);
    assert.equal(out.detail.facility_id,'f1');
    assert.equal(game.calls.filter(call=>call.action!=='owned').length,0,'nothing but the read was sent');
  } finally {unbind();}
});

test('buildFacility refuses when a material is in the hold, not this station\'s storage',async()=>{
  const typed=()=>({structuredContent:{action:'types',kind:'detail',type_id:'smelter',name:'Smelter',
    category:'production',level:1,description:'',buildable:true,build_cost:1_000,build_time:100,
    labor_cost:0,rent_per_cycle:50,build_materials:[{item_id:'steel_plate',quantity:10}]}});
  const storage=()=>({structuredContent:{items:[]}}); // the plate is aboard, not in the store
  const {game}=world({spacemolt_facility:{owned:OWNED([]),types:typed},spacemolt_storage:{view:storage}});
  try {
    const out=await buildFacility('smelter');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/steel_plate 0 of 10/);
    assert.equal(game.calls.some(call=>call.action==='build'),false,'nothing was committed');
  } finally {unbind();}
});

test('buildFacility refuses a build that would breach the credit reserve',async()=>{
  const typed=()=>({structuredContent:{action:'types',kind:'detail',type_id:'smelter',name:'Smelter',
    category:'production',level:1,description:'',buildable:true,build_cost:1_000,build_time:100,
    labor_cost:0,rent_per_cycle:50,build_materials:[]}});
  const {game}=world({spacemolt_facility:{owned:OWNED([]),types:typed},
    spacemolt_storage:{view:()=>({structuredContent:{items:[]}})}},
    {mood:'Focused',permissions:{credit_reserve:500}},1_000);
  try {
    const out=await buildFacility('smelter');
    assert.equal(out.status,'refused');
    assert.match(out.why!,/costs 1000 cr; 1000 less the 500 credit reserve cannot cover it/);
    assert.equal(game.calls.some(call=>call.action==='build'),false,'nothing was committed');
  } finally {unbind();}
});
