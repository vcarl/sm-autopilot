import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {Account,Catalog} from '@spacemolt/lib';
import {listing} from '../../servicing.ts';
import {bridgeWorld} from '../../test-support/bridge-world.ts';
import {bind,unbind} from '../runtime.ts';
import {keepBook,rememberFacilities,rememberNoFacility,worldDb} from '../world.ts';
import {catalog,trace,unitValue} from './catalog.ts';
import {useCatalog} from './crafting.ts';

const recipe=(id:string,inputs:[string,number][],outputs:[string,number][],more:Record<string,unknown>={})=>({id,name:id.replace(/_/g,' '),
  category:'Refining',description:'',crafting_time:2,inputs:inputs.map(([item_id,quantity])=>({item_id,quantity})),
  outputs:outputs.map(([item_id,quantity])=>({item_id,quantity})),...more});
/** Steel two ways (mined iron, or a bought nodule), a hull plate two ways (one facility-only), an armor plate over
 * both, wire two ways both mined, and a catalyst bred from itself. */
const CATALOG={version:'test',items:[{id:'iron_ore',extracted_by:'mining'},{id:'copper_ore',extracted_by:'mining'},{id:'nodule'}],recipes:[
  recipe('basic_iron_smelting',[['iron_ore',10]],[['steel_plate',1]]),
  recipe('nodule_smelting',[['nodule',3]],[['steel_plate',2]]),
  recipe('press_hull_plate',[['steel_plate',2],['copper_ore',1]],[['hull_plate',1]],{category:'Components'}),
  recipe('facility_hull_plate',[['steel_plate',1]],[['hull_plate',1]],{category:'Components',facility_only:true,produced_by_facility_ids:['hull_press']}),
  recipe('craft_armor_plate',[['hull_plate',2],['steel_plate',1]],[['armor_plate',1]],{category:'Defense'}),
  recipe('wire_from_iron',[['iron_ore',5]],[['wire',1]],{category:'Components'}),
  recipe('wire_from_copper',[['copper_ore',2]],[['wire',1]],{category:'Components'}),
  recipe('breed_catalyst',[['catalyst',1],['iron_ore',1]],[['catalyst',2]]),
  recipe('secret_alloy',[['iron_ore',1]],[['unobtainium',1]],{hidden:true})]} as unknown as Catalog;

function world(runtime?:string) {
  useCatalog(async()=>CATALOG);
  const game=bridgeWorld({services:['refuel'],cargo:[{item_id:'iron_ore',quantity:10}],cargoUsed:10});
  const lines:string[]=[];
  bind({account:game.account as unknown as Account,command:game.command,pilot:()=>({}),emit:text=>lines.push(text),...runtime?{runtime}:{}});
  return {...game,lines,printed:()=>lines.filter(text=>!/^[▶✓✗]/.test(text)).join('\n')};
}

test('catalog: makes, uses, category and search combine, print the old tool\'s layout, and send nothing',async()=>{
  const f=world();
  try {
    const made=await catalog({makes:'steel_plate'});
    assert.equal(made.status,'done',made.why);
    assert.deepEqual(made.detail.recipes.map(row=>row.id),['basic_iron_smelting','nodule_smelting']);
    assert.match(f.printed(),/^ {2}basic iron smelting {2}\(basic_iron_smelting\) {2}\[Refining\] {2}2 ticks\n {4}In: iron_ore x10\n {4}Out: steel_plate x1$/m);
    assert.match(made.did,/2 recipes match makes "steel_plate"/);
    const used=await catalog({uses:'steel_plate',category:'components'});
    assert.deepEqual(used.detail.recipes.map(row=>row.id),['press_hull_plate','facility_hull_plate']);
    assert.match(f.printed(),/\(facility_hull_plate\) {2}\[Components\] {2}2 ticks {2}facility only/);
    assert.deepEqual((await catalog({search:'WIRE'})).detail.recipes.map(row=>row.id),['wire_from_iron','wire_from_copper']);
    assert.equal((await catalog({search:'unobtainium'})).detail.total,0,'a hidden recipe is not listed');
    assert.equal(f.sent.length,0,'the catalog is not a game command');
  } finally {unbind();}
});

test('catalog caps what it prints at twenty, and says how many more and how to narrow',async()=>{
  const f=world();
  useCatalog(async()=>({...CATALOG,recipes:Array.from({length:25},(_,i)=>recipe(`r${i}`,[['iron_ore',1]],[[`out${i}`,1]]))}) as unknown as Catalog);
  try {
    const out=await catalog({uses:'iron_ore'});
    assert.equal(out.detail.total,25);
    assert.equal(out.detail.recipes.length,25,'detail keeps every row for a program');
    assert.equal((f.printed().match(/ {4}In:/g)??[]).length,20);
    assert.match(out.did,/25 recipes match uses "iron_ore"; showing 20, 5 more: narrow with search, category, makes or uses/);
  } finally {unbind();}
});

test('trace draws the tree, counts the hold and every store, prices leaves from memory, and lists the alternates',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-trace-'));
  const f=world(runtime);
  try {
    const db=worldDb(runtime)!;
    db.prepare("INSERT INTO stores VALUES('sol_base','steel_plate',1,NULL,'x')").run();
    db.prepare("INSERT INTO stores VALUES('frontier_station','iron_ore',40,NULL,'x')").run();
    keepBook(runtime,{base_id:'0123456789abcdef0123',at:new Date().toISOString(),tick:100,items:[
      {item_id:'nodule',best_buy:0,best_buy_qty:0,best_sell:7,best_sell_qty:50,buy_quantity:0,sell_quantity:50,buy_orders:[],sell_orders:[{price_each:7,quantity:50}]},
      {item_id:'copper_ore',best_buy:0,best_buy_qty:0,best_sell:2,best_sell_qty:50,buy_quantity:0,sell_quantity:50,buy_orders:[],sell_orders:[{price_each:2,quantity:50}]}].flatMap(listing)});
    writeFileSync(join(runtime,'names.json'),JSON.stringify({'0123456789abcdef0123':'Far Depot'}));
    const out=await trace('armor_plate');
    assert.equal(out.status,'done',out.why);
    // 1 armor = 2 hull (4 steel + 2 copper) + 1 steel: 5 steel, 1 stored, so 4 runs of iron smelting, 40 ore.
    assert.deepEqual(out.detail.steps,[{recipe:'basic_iron_smelting',runs:4,facility_only:false},
      {recipe:'press_hull_plate',runs:2,facility_only:false},{recipe:'craft_armor_plate',runs:1,facility_only:false}]);
    const iron=out.detail.leaves.find(row=>row.item_id==='iron_ore')!;
    assert.deepEqual([iron.need,iron.have,iron.aboard,iron.stored],[40,50,10,[{base_id:'frontier_station',quantity:40}]]);
    const text=f.printed();
    assert.match(text,/^1x armor_plate {2}\(craft_armor_plate\)$/m);
    assert.match(text,/^ {4}├── 2x hull_plate {2}\(press_hull_plate\)$/m);
    assert.match(text,/^ {4}│ {3}├── 4x steel_plate {2}\(basic_iron_smelting\) {2}have 1$/m);
    assert.match(text,/^ {4}│ {3}│ {3}└── 30x iron_ore {2}\[mine\] {2}have 50$/m);
    assert.match(text,/└── 2x copper_ore {2}\[mine\] · cheapest ask 2 at Far Depot \(\d+ ticks old\)/);
    assert.match(text,/^Raw materials:\n {2}Have: {2}40x iron_ore \(have 50: 10 aboard, 40 at frontier_station\)\n {2}Mine: {2}2x copper_ore · cheapest ask 2 at Far Depot/m);
    assert.match(text,/^Alternates:\n {2}hull_plate: facility_hull_plate \[facility\] \(steel_plate x1 → 1\)\n {2}steel_plate: nodule_smelting \(nodule x3 → 2\)$/m,
      'mined iron is the route; the bought nodule is the alternate');
    assert.match(text,/^Crafting time: 14 ticks at the base rate/m);
    assert.equal(f.sent.length,0,'a trace sends no game command');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('trace picks the cheaper of two mined routes when memory prices both, and stops at a cycle',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-trace-'));
  const f=world(runtime);
  try {
    keepBook(runtime,{base_id:'ore_depot',at:new Date().toISOString(),tick:5,items:['iron_ore','copper_ore'].map((item_id,i)=>
      ({item_id,best_buy:0,best_buy_qty:0,best_sell:i?1:3,best_sell_qty:99,buy_quantity:0,sell_quantity:99,buy_orders:[],sell_orders:[{price_each:i?1:3,quantity:99}]})).flatMap(listing)});
    const wire=await trace('wire',2);
    assert.deepEqual(wire.detail.steps,[{recipe:'wire_from_copper',runs:2,facility_only:false}],'2 copper at 1 beats 5 iron at 3');
    const bred=await trace('breed_catalyst');
    assert.equal(bred.status,'done',bred.why);
    assert.deepEqual(bred.detail.steps,[{recipe:'breed_catalyst',runs:1,facility_only:false}]);
    assert.match(f.printed(),/├── 1x catalyst {2}\[made from itself\]/);
    assert.equal(bred.detail.tree?.inputs[0]?.cycle,true);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('trace takes a unique part of a name, and names the candidates when there are several',async()=>{
  world();
  try {
    assert.equal((await trace('armor')).detail.tree?.item_id,'armor_plate');
    const many=await trace('plate');
    assert.equal(many.status,'refused');
    assert.match(many.why!,/names more than one: steel_plate, hull_plate, armor_plate/);
    assert.match((await trace('nothing_like_it')).why!,/no item or recipe in the catalog matches/);
  } finally {unbind();}
});

const row=(item_id:string,ask:number,bid=0)=>listing({item_id,best_buy:bid,best_buy_qty:bid?9:0,best_sell:ask,best_sell_qty:ask?9:0,buy_quantity:0,sell_quantity:0,buy_orders:[],sell_orders:[]});
const book=(base_id:string,...items:ReturnType<typeof row>[])=>({base_id,at:'',tick:1,items:items.flat()});

test('unitValue: the median ask, else the median bid, else base_value, else unknown; an outlier does not set it',()=>{
  const books=[book('a',row('steel',10),row('ore',0,4)),book('b',row('steel',12),row('ore',0,6)),book('c',row('steel',2000)),book('d',row('steel',1),row('ore',0,5))];
  assert.deepEqual(unitValue(books,'steel'),{unit:11,source:'median ask',markets:4},'a 2,000 ask and a 1 ask do not move it');
  assert.deepEqual(unitValue(books,'ore',99),{unit:5,source:'median bid',markets:3});
  assert.deepEqual(unitValue(books,'plate',100),{unit:100,source:'base value',markets:0});
  assert.equal(unitValue(books,'plate'),null);
});

test('trace prints the root recipe\'s components and output at market value, side by side, and says what it could not value',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-trace-'));
  const f=world(runtime);
  try {
    writeFileSync(join(runtime,'catalog.json'),JSON.stringify({catalog:{items:[{id:'hull_plate',base_value:100}]}}));
    for(const [base,steel] of [['x',10],['y',12],['z',2000]] as const)keepBook(runtime,{...book(base,row('steel_plate',steel),row('iron_ore',3)),at:new Date().toISOString()});
    keepBook(runtime,{...book('w',row('copper_ore',0,4)),at:new Date().toISOString()});
    const hull=await trace('press_hull_plate',3);
    // 3 runs: 6 steel at the median ask 12, 3 copper at the one bid 4; 3 plates at base value 100.
    assert.match(f.printed(),/^3x hull_plate {2}\(press_hull_plate\)\n {4}components ≈ 84 cr \(median ask \+ median bid, 1–3 markets\) · output ≈ 300 cr \(base value\)$/m);
    assert.deepEqual(hull.detail.value?.inputs.map(row=>[row.item_id,row.quantity,row.unit,row.source,row.markets]),
      [['steel_plate',6,12,'median ask',3],['copper_ore',3,4,'median bid',1]]);
    assert.match(hull.did,/components ≈ 84 cr, output ≈ 300 cr at market/);
    const bred=await trace('breed_catalyst');
    assert.match(f.printed(),/components ≈ 3 cr \(median ask, 3 markets\), 1 of 2 inputs valued · output no value known/);
    assert.match(bred.did,/components ≈ 3 cr \(1 of 2 valued\), output ≈ \? at market/);
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});

test('trace and catalog name where a facility-only step is rented: a listed station with its fee, and one a no_facility refusal named',async()=>{
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-trace-'));
  const f=world(runtime);
  try {
    writeFileSync(join(runtime,'names.json'),JSON.stringify({far_depot:'Far Depot'}));
    rememberFacilities(runtime,'far_depot','sol',{structuredContent:{action:'list',base_id:'far_depot',station_facilities:[],player_facilities:[],faction_facilities:[],
      public_facilities:[{facility_id:'f1',type:'hull_press',name:'Hull Press',production:{public:true,rental_fee_per_run:40,output_per_run:1,queued_runs:0,backlog_ticks:0}},
        {facility_id:'f2',type:'hull_press',name:'Hull Press',production:{public:true,rental_fee_per_run:55,queued_runs:3,backlog_ticks:30}},
        {facility_id:'f3',type:'repair_bay',name:'Repair Bay',production:{public:false,queued_runs:0,backlog_ticks:0}}]}},100);
    rememberNoFacility(runtime,'facility_hull_plate',"'facility hull plate' is made in a Hull Press, and no facility here can make it. "
      +'Nearest public one: Crimson War Citadel in Krynn (1 jump(s) away) — travel there to queue it',100);
    rememberNoFacility(runtime,'facility_hull_plate','a text that names nothing',100);
    const out=await trace('facility_hull_plate',2);
    assert.equal(out.status,'done',out.why);
    assert.match(f.printed(),/^ {2}facility_hull_plate → Hull Press: Far Depot \(sol\) 40 cr\/run, \d+t old; Crimson War Citadel \(Krynn\) fee unknown, \d+t old$/m,
      'the cheaper of two presses at one station, then the station the refusal named');
    await catalog({makes:'hull_plate'});
    assert.match(f.printed(),/\(facility_hull_plate\) {2}\[Components\] {2}2 ticks {2}facility only — Hull Press: Far Depot \(sol\) 40 cr\/run/);
    assert.equal(f.sent.length,0,'the facility book is memory, not a game command');
  } finally {unbind();rmSync(runtime,{recursive:true,force:true});}
});
