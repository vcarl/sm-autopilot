/** The recipes read, through the bridge action a tool reaches: what the pilot holds anywhere
 * decides what it can make here, and the entry says which base the inputs are at. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {Catalog,CatalogRecipe} from '@spacemolt/lib';
import {serve,type ServeOptions} from './bridge.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';

function recipe(id:string,output:string,inputs:Array<[string,number]>,
  extra:Partial<CatalogRecipe>={}):CatalogRecipe {
  return {id,name:id,description:'',category:'Components',crafting_time:1,
    outputs:[{item_id:output,quantity:1}],
    inputs:inputs.map(([item_id,quantity])=>({item_id,quantity})),...extra};
}

const CATALOG={
  version:'v1.2.3',
  recipes:[
    // Covered only once the far base's titanium is counted with the hold's iron.
    recipe('alloy_frame','alloy_frame',[['iron_ore',2],['titanium_alloy',1]]),
    // One input short: the ore is nowhere.
    recipe('null_core','null_core',[['iron_ore',1],['null_matter',3]]),
    // Fully covered, but the bench cannot run it.
    recipe('capital_spar','capital_spar',[['iron_ore',1]],{facility_only:true}),
    recipe('refine_steel','steel_plate',[['iron_ore',2]],{category:'Refining'}),
    recipe('exotic_lens','exotic_lens',[['exotic_dust',4]]),
  ],
  items:[{id:'iron_ore',name:'Iron Ore',description:'',category:'ore',base_value:1,size:1,
    stackable:true,tradeable:true,extracted_by:'mining'},
    {id:'null_matter',name:'Null Matter',description:'',category:'ore',base_value:9,size:2,
      stackable:true,tradeable:true,extracted_by:'mining'}],
  ships:[],skills:[],facilities:[],achievements:[],faction_achievements:[],
  hidden_achievement_count:0,hidden_faction_achievement_count:0,
} as unknown as Catalog;

function fixture(options:ServeOptions={}) {
  const account={
    state:{location:{system_id:'sol',poi_id:'station',docked_at:'sol_base',in_transit:false},
      ship:{fuel:100,max_fuel:120,hull:80,max_hull:80,cargo_used:4,cargo_capacity:50},
      player:{credits:1000},
      cargo:[{item_id:'iron_ore',quantity:2}]},
    refresh:async()=>{},
  } as unknown as ReadinessAccount;
  const sent:string[]=[];
  const command:ReadinessCommand=async(action,params)=>{
    sent.push(action);
    if(action==='spacemolt/get_base')return {structuredContent:{services:['storage','crafting']}};
    if(action==='spacemolt_storage/view') {
      const station=params.station_id;
      const locations=[{base_id:'sol_base',base_name:'Sol Base',system_name:'Sol',item_count:0,ship_count:0},
        {base_id:'far_base',base_name:'Far Base',system_name:'Deep Range',item_count:1,ship_count:0},
        {base_id:'empty_base',base_name:'Empty Base',system_name:'Sol',item_count:0,ship_count:0}];
      if(station==='far_base')
        return {structuredContent:{base_id:'far_base',items:[{item_id:'titanium_alloy',quantity:5}],
          ships:[],locations}};
      return {structuredContent:{base_id:'sol_base',items:[],ships:[],locations}};
    }
    throw new Error(`unexpected ${action}`);
  };
  return {dispatch:serve(account,command,{catalog:async()=>CATALOG,...options}),sent};
}

const find=(rows:any[],id:string)=>rows.find(row=>row.recipe_id===id);

test('a recipe covered by the hold and a far base is craftable now, with the far base named',async()=>{
  const {dispatch,sent}=fixture();
  const report=await dispatch('recipes',{}) as any;
  assert.equal(report.base_id,'sol_base');
  assert.equal(report.workshop,true);
  assert.equal(report.catalog_version,'v1.2.3');
  const frame=find(report.craftable_now,'alloy_frame');
  assert.ok(frame,'alloy_frame is fully covered by hold iron plus far-base titanium');
  assert.equal(frame.covered,1);
  const titanium=frame.inputs.find((row:any)=>row.item_id==='titanium_alloy');
  assert.deepEqual(titanium.at,[{base_id:'far_base',quantity:5}]);
  assert.equal(titanium.held,5);
  const iron=frame.inputs.find((row:any)=>row.item_id==='iron_ore');
  assert.deepEqual(iron.at,[{base_id:'hold',quantity:2}]);
  // The locations index says which bases hold anything, so the empty one costs no read.
  assert.equal(sent.filter(action=>action==='spacemolt_storage/view').length,2);
});

test('a recipe short one input lands in nearly, and the missing input is named',async()=>{
  const {dispatch}=fixture();
  const report=await dispatch('recipes',{}) as any;
  const core=find(report.nearly,'null_core');
  assert.ok(core,'null_core has the iron but none of the null matter');
  assert.deepEqual(core.missing,[{item_id:'null_matter',quantity:3,source:'mining'}]);
  assert.ok(core.covered>0&&core.covered<1);
  assert.ok(!find(report.craftable_now,'null_core'));
  // Nothing on hand for it at all: it is not a near miss, it is not started.
  assert.ok(!find(report.nearly,'exotic_lens'));
});

test('a fully covered recipe the bench cannot run is reported apart',async()=>{
  const {dispatch}=fixture();
  const report=await dispatch('recipes',{}) as any;
  assert.ok(find(report.facility_only,'capital_spar'));
  assert.ok(!find(report.craftable_now,'capital_spar'));
  assert.ok(!find(report.nearly,'capital_spar'));
});

test('search narrows the ranking to what it names',async()=>{
  const {dispatch}=fixture();
  const byCategory=await dispatch('recipes',{search:'refining'}) as any;
  assert.deepEqual(byCategory.craftable_now.map((row:any)=>row.recipe_id),['refine_steel']);
  assert.deepEqual(byCategory.nearly,[]);
  const byOutput=await dispatch('recipes',{search:'steel_plate'}) as any;
  assert.deepEqual(byOutput.craftable_now.map((row:any)=>row.recipe_id),['refine_steel']);
});

test('a rich inventory is bounded, and counts say how much was left out',async()=>{
  // 200 recipes over ores the pilot holds: every list would run long, and a juncture reads
  // the whole thing.
  const many=[...Array(200)].map((_,i)=>recipe(`fabricate_component_variant_${i}`,`part_${i}`,
    i%2?[['iron_ore',1],[`ore_${i%20}`,2]]:[['iron_ore',1]],{...i%9===0?{facility_only:true}:{}}));
  const wide={...CATALOG,recipes:[...CATALOG.recipes,...many],
    items:[...CATALOG.items,...[...Array(20)].map((_,i)=>({id:`ore_${i}`,name:`Ore ${i}`,
      description:'',category:'ore',base_value:1,size:1,stackable:true,tradeable:true,
      extracted_by:'mining'}))]} as unknown as Catalog;
  const {dispatch}=fixture({catalog:async()=>wide});
  const report=await dispatch('recipes',{}) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(report))<6200,'the whole result stays readable');
  // Every bucket survives the trim, and the counts are the totals, not the shown lengths.
  assert.ok(report.craftable_now.length>0&&report.facility_only.length>0);
  assert.ok(report.counts.craftable_now>report.craftable_now.length);
});

test('a catalog that cannot be fetched is reported, not thrown',async()=>{
  const {dispatch}=fixture({catalog:async()=>{throw new Error('502 from the catalog host');}});
  const report=await dispatch('recipes',{}) as any;
  assert.match(String(report.error),/catalog unavailable.*502/);
  assert.equal(report.base_id,'sol_base');
  assert.equal(report.craftable_now,undefined);
});
