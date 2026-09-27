/** One fake game the bridge and the script runner are both driven against.
 *
 * Two systems, a station with a base behind it, a belt in each, and a server that answers
 * only what a real one would: every mine reply over-claims (99 ore), so a yield any test
 * asserts can only have come from an authoritative cargo read.
 */
import {moodNow} from '../mood-policy.ts';
import type {Pilot} from '../play/runtime.ts';
import assert from 'node:assert/strict';
import {SpacemoltError} from '@spacemolt/lib';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ReadinessCommand} from '../readiness.ts';
import {readJournal} from '../run-record.ts';
import {FakeLibGoalAccount} from './fake-lib-account.ts';

/** A runtime directory a job's `ctx` can write its journal into, and the step lines it wrote.
 *
 * A job with no runtime journals nothing, so a test that wants the steps has to give it
 * somewhere to put them. The directory is the test's to clean up. */
/** A test's record as the bridge would hand it to the runtime: its `mood` is the working mood,
 * and Tired is derived from the live ship on every read, as `flying` does in production. */
export function derived(who:()=>Pilot,account:{state:any}):()=>Pilot {
  return ()=>{const w=who();
    return {...w,...moodNow(w.mood??'Cautious',account.state.ship)};};
}

export function journalTrap() {
  const runtime=mkdtempSync(join(tmpdir(),'spacemolt-steps-'));
  const lines=(event:string)=>readJournal(runtime,10_000).filter(entry=>entry.event===event);
  return {runtime,lines,
    /** Each step as `[job, step, outcome]`, in the order the job wrote them. */
    steps:()=>lines('step').map(entry=>[entry.job,entry.step,entry.outcome] as const),
    close:()=>rmSync(runtime,{recursive:true,force:true})};
}

// The station POI and the base docked at it carry different ids, as the live game does.
export const system={id:'sol',name:'Sol',pois:[
  {id:'station',name:'Sol Station',type:'station',position:{x:0,y:0},has_base:true,
    base_id:'sol_base',base_name:'Sol Base'},
  {id:'belt',name:'Inner Belt',type:'asteroid_belt',position:{x:1,y:1}},
],connections:[{system_id:'deep_range',name:'Deep Range',distance:4}]};
// One jump away, so a POI the pilot names may live somewhere it has to fly to.
export const deepRange={id:'deep_range',name:'Deep Range',
  pois:[{id:'outpost',name:'Deep Range Outpost',type:'station',has_base:true,
    base_id:'range_base',base_name:'Deep Range Base'},
  {id:'far_belt',name:'Far Belt',type:'asteroid_belt'}],
  connections:[{system_id:'sol',name:'Sol',distance:4}]};
// Where each nameable id lives, as the server's find_route answers it. A base id is
// nameable too, and answers with the POI it sits at.
const homeOf:Record<string,string>={sol:'sol',station:'sol',belt:'sol',sol_base:'sol',
  deep_range:'deep_range',outpost:'deep_range',far_belt:'deep_range',range_base:'deep_range'};
const poiOf:Record<string,string>={sol_base:'station',range_base:'outpost'};
/** The base docked at a POI, which is what `dock` answers with — never a fixed id. */
const baseAt:Record<string,string>={station:'sol_base',outpost:'range_base'};
/** The global tick every `view_market` reply in this world comes back on, so a test can date
 * a `markets.json` fixture relative to "now". */
export const TICK=1000;

export interface WorldOptions {
  services?:string[];
  /** POIs in Sol beside the built-in station and belt: nameable to `find_route`, listed by
   * `get_system`, dockable when they carry a `base_id`. A second station is how a world
   * where "the station in Sol" names no one place is expressible. */
  pois?:{id:string;name?:string;type?:string;base_id?:string;base_name?:string;
    /** What that base's counter posts, as `inspect({id:<base_id>})` answers for it — the one
     * read that quotes a station the ship is not standing at. Absent means it posts nothing
     * readable from here, which is what a live station usually does. */
    fuel_price?:number;repair_price?:number}[];
  /** The hold at the start. 12 of 12 is a full hold: a gather job mines nothing and still
   * has to come home, settle and service before it may call itself done. */
  cargoUsed?:number;
  /** The hold at the start, row by row, when it is not `cargoUsed` of plain ore. */
  cargo?:{item_id:string;quantity:number}[];
  /** The hold's size. 12 is the Cobble's; freight needs 100 free for one package. */
  cargoCapacity?:number;
  /** Book rows beside the default ore one, so a crafted output has a price here. */
  market?:MarketRow[];
  /** Books at other bases, keyed by base id. `view_market` answers with the one for the base
   * the ship is docked at, so a second visit reads a different counter — which is the only
   * way a pilot learns that the ore nobody buys here sells there. A base listed here answers
   * with exactly these rows, default ore row and all. */
  markets?:Record<string,MarketRow[]>;
  /** The faction trade ledger `query_trade_intel` answers with. Absent means no faction:
   * the command throws, as it does for a pilot with no trade-intel facility. */
  tradeIntel?:{base_id:string;station_name?:string;submitted_at_tick?:number;
    items:{item_id:string;item_name?:string;best_buy:number;best_sell?:number;buy_volume?:number;sell_volume?:number}[]}[];
  /** What the station store holds before anything is deposited. */
  store?:{item_id:string;name?:string;quantity:number}[];
  /** How much ore one mining cycle puts in the hold. */
  minePerCycle?:number;
  /** The one recipe this world's bench knows, as the server quotes and runs it. */
  craft?:CraftOptions;
  /** The creatures at this world's POIs, and how a fight with one goes. */
  wildlife?:WildlifeOptions;
  /** The modules on the ship and the hulls listed at this base. */
  hangar?:HangarOptions;
  /** The shipping board here, and the carrier record the tier limits come from. */
  shipping?:ShippingOptions;
  /** The berths on the hull and the citizens waiting on the platform. */
  passengers?:PassengerOptions;
  /** Sales tax on a buy, in basis points. As live: `estimate_purchase` quotes it, the wallet pays
   * it, and the `buy` reply's `total_cost` leaves it out. Absent: no rate is published, none charged. */
  taxBps?:number;
  /** The docked base's `fuel_price_all_in`. Default 1. */
  fuelPrice?:number;
  /** Systems beyond Sol and Deep Range, each linked both ways to the systems it names, with its
   * POIs: on `get_map`, listed by `get_system` there, nameable to `find_route` (routed over the
   * links, a jump each), dockable where a POI carries a `base_id`. */
  systems?:{id:string;connections:string[];pois:{id:string;type?:string;base_id?:string}[]}[];
}

/** The freight board and the carrier behind it. A listing's `reserved_exposure` is the
 * liability it puts against the tier's allowance, which is the number a board filters on. */
export interface MarketRow {item_id:string;item_name?:string;best_buy:number;best_buy_qty:number;
  best_sell:number;best_sell_qty:number;
  /** The book level by level, as `view_market` gives it; absent, the top of book is the only level. */
  buy_orders?:{price_each:number;quantity:number}[];sell_orders?:{price_each:number;quantity:number}[]}

export interface ShippingOptions {
  listings?:{id:string;destination_base_id:string;base_reward:number;reserved_exposure?:number;
    package_id?:string;origin_base_id?:string;eligible?:boolean;reason?:string}[];
  tier?:'probationary'|'licensed'|'trusted'|'prime';
  single_package_liability_limit?:number;
  aggregate_liability_limit?:number;
  remaining_aggregate_liability?:number;
  debt_blocks_acceptance?:boolean;
  successful_deliveries?:number;
  /** Listing ids already accepted before the run starts: the re-entry the live world hands back. */
  accepted?:string[];
  /** What the delivery pays the carrier. */
  payout?:number;
}

/** The platform and the berths. A waiting citizen is loaded by destination, never by name,
 * because that is the only argument `load_passenger` takes. */
export interface PassengerOptions {
  berths?:{economy?:number;business?:number;first?:number};
  waiting?:{citizen_id:string;name?:string;class?:string;destination:string;
    destination_name?:string;estimated_fare?:number}[];
  /** Citizens already aboard when the run starts. */
  onboard?:{citizen_id:string;name?:string;class?:string;destination:string;base_fare?:number}[];
  fare_surge?:number;
}

/** The fit and the exchange: what is bolted to the hull now, and what is for sale here.
 * The grid is the live Cobble's — two utility slots, one weapon, one defense — because the
 * mistake this guards against is a module bought for a slot that is already full. */
export interface HangarOptions {
  fitted?:{module_id:string;type_id:string;slot:string;cpu_usage:number;power_usage:number}[];
  listings?:{listing_id:string;ship_id:string;class_id:string;price:number}[];
  /** Class ids `inspect` refuses outright, the way the live server does: observed 2026-09-26, a yard
   * listed a hull whose `class_id` was `rubble` and `inspect` answered `Ship class "rubble" not
   * found.` A yard that lists a class its own catalogue cannot answer for is the game being
   * inconsistent with itself, and the library has to survive it. */
  unknownClasses?:string[];
}

/** What `inspect` answers for a module id: the slot it takes and its draw on the grid. */
const MODULES:Record<string,Record<string,unknown>>={
  cargo_expander_ii:{id:'cargo_expander_ii',type_id:'cargo_expander_ii',name:'Cargo Expander II',
    description:'',slot:'utility',type:'utility',cpu_usage:2,power_usage:3,size:1,base_value:2_080},
  mining_laser_i:{id:'mining_laser_i',type_id:'mining_laser_i',name:'Mining Laser I',
    description:'',slot:'utility',type:'mining',cpu_usage:3,power_usage:4,size:1,base_value:400},
  hull_reinforcement_i:{id:'hull_reinforcement_i',type_id:'hull_reinforcement_i',name:'Hull Reinforcement I',
    description:'',slot:'defense',type:'defense',cpu_usage:1,power_usage:2,size:1,base_value:300},
};
/** What `inspect` answers for a ship class id. */
const CLASSES:Record<string,Record<string,unknown>>={
  cobble:{id:'cobble',name:'Cobble',class:'Hauler',cargo_capacity:12,base_speed:3,base_fuel:120,
    utility_slots:2,weapon_slots:1,defense_slots:1,minimum_crew:0},
  hauler_ii:{id:'hauler_ii',name:'Hauler II',class:'Hauler',cargo_capacity:120,base_speed:2,base_fuel:150,
    utility_slots:3,weapon_slots:1,defense_slots:1,minimum_crew:1},
};
/** A sealed package occupies 100 cargo whatever its quantity; the bulky ores their catalog
 * `size` each, as live (48 osmium_ore "Need 96"); everything else is one each. */
const SIZES:Record<string,number>={osmium_ore:2,dark_matter_residue:3};
const footprint=(item:string)=>item.startsWith('package:')?100:SIZES[item]??1;
const BERTH_CLASSES=['economy','business','first'] as const;
/** Berths by class, with `free` counted against who is aboard now. */
function berthsView(options:PassengerOptions,onboard:{class?:string}[]=[]) {
  const seated:Record<string,number>={economy:0,business:0,first:0};
  for(const row of onboard)seated[row.class??'economy']=(seated[row.class??'economy']??0)+1;
  return Object.fromEntries(BERTH_CLASSES.map(name=>{
    const total=options.berths?.[name]??0;
    return [name,{total,free:Math.max(0,total-(seated[name]??0))}];
  })) as Record<typeof BERTH_CLASSES[number],{total:number;free:number}>;
}
const page=(items:Record<string,unknown>[],type:string)=>
  ({items:structuredClone(items),message:'',page:1,page_size:1,total:items.length,total_pages:1,type});

/** A habitat with creatures in it: what a look answers, how a battle resolves over a few
 * polls, and what the kill leaves in a wreck. The ship's own weapon is here too, because a
 * hunt's first gate is the fit, not the target. */
export interface WildlifeOptions {
  /** `poi` pins a creature to one POI, so a look answers differently depending on where the
   * ship is standing — which is what a search across several POIs has to be tested against. A
   * row with no `poi` is everywhere, which is how every habitat behaved before this existed. */
  creatures?:{creature_id:string;species:string;name?:string;role?:string;hull?:number;
    max_hull?:number;speed?:number;in_combat?:boolean;branded?:boolean;poi?:string}[];
  /** Status polls that still show the fight before the creature is down. */
  polls?:number;
  /** Hull the ship loses on each of those polls. */
  damage?:number;
  /** What the kill leaves behind, looted a row at a time. */
  drops?:{item_id:string;quantity:number}[];
  /** The fitted weapon, or null for a ship that has none. */
  weapon?:{name?:string;type_id?:string;ammo_type?:string;current_ammo?:number}|null;
  /** The poll the ship's crew stops being able to fly it on: the world moving the pilot. */
  incapacitateOn?:number;
  /** The quarry that runs: its hull stays flat, the range opens a ring a tick, and when the
   * polls run out the battle simply ends — no kill, no wreck. */
  flees?:boolean;
  /** Retreats the server accepts before the battle actually ends. `retreat` answers
   * "Retreating from the enemy." and the fight carries on, which is what the live server does
   * and what killed three ships on 2026-09-24; 0 is a retreat that ends it at once. */
  retreatTicks?:number;
  /** Ticks under `stance flee` before the ship actually escapes and the battle ends. `flee`
   * is the exit the server has (0% dealt, 100% taken, auto-retreats to escape) and 0 is an
   * escape on the next tick; a high number is the faster opponent that kites the flee and
   * keeps the ship in the fight, which is why breaking off needs somewhere to go. */
  fleeTicks?:number;
}

/** A bench with one recipe on it: what a dry run answers, what a commit escrows and queues,
 * and how many queue reads pass before the output is delivered to the store. */
export interface CraftOptions {
  recipe_id?:string;
  /** The display name the server answers with, which is never the id. */
  recipe?:string;
  inputs?:{item_id:string;quantity:number}[];
  produces?:{item_id:string;quantity:number}[];
  credits_total?:number;
  /** The runs the server will do, and the output units it will make: either may be under
   * what was asked for when the inputs only stretch so far. */
  runs?:number;
  quantity?:number;
  /** Omitted, the bench answers from what this base's store actually holds. */
  have_inputs?:boolean;
  have_credits?:boolean;
  /** Queue reads that still answer `queued` before the job is delivered. */
  polls?:number;
  eta_ticks?:number;
  /** A bench that refuses this recipe: the server's own text, thrown as the game throws it. */
  refusal?:string;
}

export function bridgeWorld(options:WorldOptions={}) {
  const {services=['refuel','repair'],cargoUsed=12,minePerCycle=2}=options;
  const store=options.store??[{item_id:'ore',name:'Ore',quantity:340},{item_id:'scrap',quantity:2}];
  // The game floors it: 1823 cr at 250 bps paid 45 live, not 46.
  const tax=(subtotal:number)=>Math.floor(subtotal*(options.taxBps??0)/10_000);
  // Sol as this world lists it, and where the ids in it live, so an added station is a place
  // the server knows in every reply that mentions places.
  const extra=(options.pois??[]).map(row=>({type:'station',position:{x:2,y:2},has_base:Boolean(row.base_id),...row,
    name:row.name??row.id}));
  const here={...system,pois:[...system.pois,...extra]};
  // Every system, each one's links both ways: the built-in two, and `options.systems` beyond them.
  const beyond=(options.systems??[]).map(row=>({id:row.id,name:row.id,connections:row.connections.map(system_id=>({system_id,name:system_id,distance:4})),
    pois:row.pois.map(poi=>({type:'station',position:{x:3,y:3},has_base:Boolean(poi.base_id),...poi,name:poi.id}))}));
  const galaxy=[here,deepRange,...beyond].map(row=>({...row,connections:[...row.connections,
    ...beyond.filter(far=>far.connections.some(link=>link.system_id===row.id)&&!row.connections.some(link=>link.system_id===far.id))
      .map(far=>({system_id:far.id,name:far.name,distance:4}))]}));
  const systemAt=(id:string)=>galaxy.find(row=>row.id===id)??deepRange;
  /** Base id → what `inspect` quotes for it. A base with no entry answers no base body at all. */
  const quotes=Object.fromEntries(extra.filter(row=>row.base_id&&(row.fuel_price!==undefined||row.repair_price!==undefined))
    .map(row=>[row.base_id!,{fuel:row.fuel_price,hull:row.repair_price}]));
  /** The faction ledger as filed so far: `options.tradeIntel`, copied, plus what this world's pilots submit. */
  const ledger=options.tradeIntel&&[...options.tradeIntel];
  const homes:Record<string,string>={...homeOf,
    ...Object.fromEntries(extra.flatMap(row=>[[row.id,'sol'],...row.base_id?[[row.base_id,'sol']]:[]])),
    ...Object.fromEntries(beyond.flatMap(row=>[[row.id,row.id],...row.pois.flatMap(poi=>[[poi.id,row.id],...poi.base_id?[[poi.base_id,row.id]]:[]])]))};
  const poiIds:Record<string,string>={...poiOf,
    ...Object.fromEntries([...extra,...beyond.flatMap(row=>row.pois)].filter(row=>row.base_id).map(row=>[row.base_id!,row.id]))};
  const bases:Record<string,string>={...baseAt,
    ...Object.fromEntries([...extra,...beyond.flatMap(row=>row.pois)].filter(row=>row.base_id).map(row=>[row.id,row.base_id!]))};
  /** The systems from one to another over the links, breadth first, both ends included. */
  const path=(from:string,to:string):string[]=>{
    const back=new Map<string,string>([[from,'']]);
    for(let frontier=[from];frontier.length&&!back.has(to);)
      frontier=frontier.flatMap(id=>systemAt(id).connections.map(link=>link.system_id).filter(next=>!back.has(next)&&!!back.set(next,id)));
    if(!back.has(to))return [from,to];
    const out=[to];
    while(out[0]!==from)out.unshift(back.get(out[0]!)!);
    return out;
  };
  const account=new FakeLibGoalAccount({
    // The location section carries who else is at the POI, as the live one does: a scenario
    // that wants a fight happening here pushes a row with `in_combat` set.
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base' as string|null,in_transit:false} as
      {system_id:string;poi_id:string;docked_at:string|null;in_transit:boolean;
        nearby_players?:{player_id:string;username?:string;in_combat:boolean}[];
        nearby_empire_npcs?:{npc_id:string;name:string;in_combat:boolean}[]},
    // Hull stays above the Cautious D3 line: a ship below it is Tired and starts no job.
    ship:{id:'ship',fuel:100,max_fuel:120,hull:96,max_hull:100,cargo_used:cargoUsed,
      cargo_capacity:options.cargoCapacity??12,speed:3,incapacitated:false,class_id:'cobble',class_name:'Cobble',
      cpu_used:0,cpu_capacity:12,power_used:0,power_capacity:24,
      utility_slots:2,weapon_slots:1,defense_slots:1,
      ...options.passengers?{berths:berthsView(options.passengers)}:{}},
    player:{credits:1_000},
    cargo:(options.cargo??(cargoUsed?[{item_id:'ore',quantity:cargoUsed}]:[])) as {item_id:string;quantity:number}[],
    modules:[] as Record<string,any>[],
  });
  // The fit as the world starts, with the grid it draws: the ship's counters and the module
  // list are the same fact, so a test that fits two utility modules gets a full slot bank.
  for(const row of options.hangar?.fitted??[]) {
    account.server.modules.push({...MODULES[row.type_id],...row,
      name:String(MODULES[row.type_id]?.name??row.type_id),type:row.slot,size:1});
    account.server.ship.cpu_used+=row.cpu_usage;
    account.server.ship.power_used+=row.power_usage;
  }
  const listings=structuredClone(options.hangar?.listings??[]);
  const fleet:Record<string,any>[]=[{ship_id:'ship',class_id:'cobble',class_name:'Cobble',
    is_active:true,location_base_id:'sol_base'}];
  const held=(item:string)=>account.server.cargo.find(row=>row.item_id===item)?.quantity??0;
  const add=(item:string,quantity:number)=>{
    const size=footprint(item);
    const room=account.server.ship.cargo_capacity-account.server.ship.cargo_used;
    const moved=Math.min(Math.floor(room/size),quantity);
    if(moved<=0)return;
    const row=account.server.cargo.find(current=>current.item_id===item);
    if(row)row.quantity+=moved;else account.server.cargo.push({item_id:item,quantity:moved});
    account.server.ship.cargo_used+=moved*size;
  };
  const take=(item:string,quantity:number)=>{
    const row=account.server.cargo.find(current=>current.item_id===item);
    const moved=Math.min(row?.quantity??0,quantity);
    if(row) {
      row.quantity-=moved;
      if(!row.quantity)account.server.cargo=account.server.cargo.filter(current=>current!==row);
    }
    account.server.ship.cargo_used-=moved*footprint(item);
    return moved;
  };
  // The bench: one recipe, a queue the pilot's jobs sit in, and a store the output lands in.
  const bench:Required<Omit<CraftOptions,'refusal'>>&{refusal?:string}={
    recipe_id:'refine_steel',recipe:'Refine Steel',
    inputs:[{item_id:'iron_ore',quantity:5}],produces:[{item_id:'steel_plate',quantity:2}],
    credits_total:19,runs:1,quantity:2,have_inputs:true,have_credits:true,polls:0,eta_ticks:0,
    ...options.craft};
  const queued:Record<string,any>[]=[];
  let polls=bench.polls;
  const deliver=(job:Record<string,any>)=>{
    for(const row of job.produces as {item_id:string;quantity:number}[]) {
      const held=store.find(current=>current.item_id===row.item_id);
      if(held)held.quantity+=row.quantity;else store.push({...row});
    }
  };
  // The habitat: creatures at the POI, one battle at a time, and the wrecks a kill leaves.
  const fauna={polls:1,damage:0,drops:[{item_id:'creature_carapace',quantity:1}],
    incapacitateOn:0,retreatTicks:0,fleeTicks:0,...options.wildlife,
    creatures:(options.wildlife?.creatures??[]).map(row=>({role:'grazer',hull:60,max_hull:60,
      name:row.species,in_combat:false,branded:false,...row}))};
  if(options.wildlife) {
    const weapon=fauna.weapon===undefined
      ?{name:'Autocannon I',type_id:'autocannon_i',ammo_type:'autocannon',current_ammo:500}
      :fauna.weapon;
    if(weapon)account.server.modules.push({module_id:'w1',slot:'weapon',type:'weapon',
      cpu_usage:3,power_usage:4,size:10,...weapon,type_id:String(weapon.type_id??'autocannon_i'),
      name:String(weapon.name??'Autocannon I')});
  }
  /** The creatures a look from where the ship stands would answer with. */
  const hereCreatures=()=>fauna.creatures.filter(row=>!row.poi||row.poi===account.server.location.poi_id);
  const wrecks:Record<string,any>[]=[];
  let battle:{target:string;left:number;ticks:number;retreats:number;stance:string;fled:number}|null=null;
  // A battle owns the ship: the live server refuses every move while one is on, by this code.
  const notInBattle=()=>{
    if(battle)throw new SpacemoltError('in_battle',
      "cannot perform this action while in combat. Use the 'battle' command to fight or flee.");
  };
  const tick=()=>{
    if(!battle)return;
    battle.ticks++;
    account.server.ship.hull=Math.max(0,account.server.ship.hull-fauna.damage);
    if(fauna.incapacitateOn&&battle.ticks>=fauna.incapacitateOn)
      account.server.ship.incapacitated=true;
    // Fleeing is the exit: the damage of this tick lands (flee takes all of it) and then the
    // ship is out, once it has held the stance long enough to get away.
    if(battle.stance==='flee'&&battle.fled++>=fauna.fleeTicks){battle=null;return;}
    if(battle.left>0){battle.left--;return;}
    // The one that ran: the battle ends with the creature still in the habitat and no wreck.
    if(fauna.flees){battle=null;return;}
    // The creature is down: it leaves the habitat and leaves a wreck with its drops in it.
    const target=battle.target;
    fauna.creatures=fauna.creatures.filter(row=>row.creature_id!==target);
    wrecks.push({id:`wreck-${wrecks.length+1}`,victim_id:target,type:'creature',
      poi_id:account.server.location.poi_id,cargo:structuredClone(fauna.drops),modules:[]});
    battle=null;
  };
  // The board at this base, and the missions already taken: the game caps the active list
  // at five, and a sixth accept is refused by the server.
  const board=[{mission_id:'m1',title:'Deliver ore',type:'delivery',difficulty:1,
    objectives:[{item_id:'ore',quantity:20,description:'20 ore to Sol Base'}],rewards:{credits:1_000}},
  {mission_id:'m2',title:'Visit the outpost',type:'visit',difficulty:1,
    objectives:[{system_id:'deep_range',description:'visit Deep Range Outpost'}],rewards:{credits:500}}];
  const taken:Record<string,any>[]=[];
  // The shipping house: a board of listings, the carrier record the limits come from, and
  // the contracts already accepted. Accepting drops the sealed package into the origin store.
  const freight={tier:'probationary' as const,single_package_liability_limit:5_000,
    aggregate_liability_limit:10_000,remaining_aggregate_liability:10_000,
    debt_blocks_acceptance:false,successful_deliveries:0,payout:0,accepted:[] as string[],
    listings:[] as Record<string,any>[],...options.shipping};
  freight.accepted=[...freight.accepted];
  const contractOf=(row:Record<string,any>)=>({id:String(row.id),
    package_id:String(row.package_id??`pkg_${row.id}`),origin_base_id:String(row.origin_base_id??'sol_base'),
    destination_base_id:String(row.destination_base_id),base_reward:Number(row.base_reward),
    reserved_exposure:Number(row.reserved_exposure??row.base_reward),failure_debt:Number(row.base_reward),
    status:freight.accepted.includes(String(row.id))?'in_transit':'posted',
    service_level:'standard',risk_band:'probationary',visibility:'public',policy_status:'none',
    insurable:false,max_speed_bonus:0,reward_escrow:Number(row.base_reward),speed_bonus_escrow:0,
    service_fee:0,shipping_house_id:'house',posted_at:'',listing_expires_at:'',
    shipper:{kind:'player',id:'shipper'},recipient:{kind:'station',id:String(row.destination_base_id)}});
  const carrier=()=>({actor:{kind:'player',id:'ship'},tier:freight.tier,active_contracts:freight.accepted.length,
    active_liability:0,breaches:0,defaults:0,delivered_value:0,late_deliveries:0,outstanding_debt:0,
    priority_deliveries:0,returns:0,successful_deliveries:freight.successful_deliveries,updated_at:''});
  // The platform and the manifest. `load_passenger` boards by destination, so the fake does
  // too; `unload_passenger` pays only the ones whose stop this is.
  const platform={fare_surge:1,...options.passengers,
    waiting:(options.passengers?.waiting??[]).map(row=>({class:'economy',name:row.citizen_id,
      destination_name:row.destination,estimated_fare:200,...row})),
    onboard:(options.passengers?.onboard??[]).map(row=>({class:'economy',name:row.citizen_id,
      destination_name:row.destination,base_fare:200,ticks_remaining:540,...row}))};
  const seat=()=>{account.server.ship.berths=berthsView(platform,platform.onboard);};
  if(options.passengers)seat();
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt_shipping/list':params=>{
      const rows=freight.listings.filter(row=>!freight.accepted.includes(String(row.id))
        &&(params.filter_destination===undefined||row.destination_base_id===params.filter_destination));
      return {structuredContent:{action:'list',page:1,per_page:20,total:rows.length,
        shipments:rows.map(row=>({contract:contractOf(row),deadline_ticks:600,target_ticks:300,
          recovery_ticks:900,eligible:row.eligible??true,...row.reason?{reason:row.reason}:{}}))}};
    },
    'spacemolt_shipping/profile':()=>({structuredContent:{action:'profile',profile:carrier(),
      debt_blocks_acceptance:freight.debt_blocks_acceptance,debts:[],
      capacity:{active_contracts:freight.accepted.length,active_contracts_unlimited:true,active_liability:0,
        liability_unlimited:false,single_package_liability_limit:freight.single_package_liability_limit,
        aggregate_liability_limit:freight.aggregate_liability_limit,
        remaining_aggregate_liability:freight.remaining_aggregate_liability},
      progression:{at_maximum_tier:false,current_tier:freight.tier,delivered_value:0,next_tier:'licensed',
        remaining_delivered_value:250,remaining_successful_deliveries:5,required_delivered_value:250,
        required_successful_deliveries:5,successful_deliveries:freight.successful_deliveries}}}),
    'spacemolt_shipping/active':()=>({structuredContent:{action:'active',tick:1,
      shipments:freight.accepted.map(id=>{
        const contract=contractOf(freight.listings.find(row=>String(row.id)===id)!);
        return {contract,role:'carrier',late:false,failure_debt:contract.failure_debt,
          next_step:'withdraw the package and deliver it',payout_if_delivered_now:contract.base_reward,
          package_in_your_cargo:account.server.cargo.some(row=>row.item_id===`package:${contract.package_id}`),
          ticks_to_deadline:600,ticks_to_target:300,ticks_to_recovery_deadline:900};
      })}}),
    'spacemolt_shipping/get':params=>{
      const row=freight.listings.find(current=>String(current.id)===String(params.shipment_id));
      if(!row)throw new Error(`No shipment ${params.shipment_id}`);
      return {structuredContent:{action:'get',contract:contractOf(row)}};
    },
    'spacemolt_shipping/accept':params=>{
      const id=String(params.shipment_id);
      const row=freight.listings.find(current=>String(current.id)===id);
      if(!row)throw new Error(`No shipment ${id}`);
      if(freight.accepted.includes(id))throw new Error(`${id} is already accepted`);
      freight.accepted.push(id);
      // Acceptance deposits the sealed package into the carrier's store at the origin.
      store.push({item_id:`package:${contractOf(row).package_id}`,quantity:1});
      return {delta:{details:{action:'accept',contract:contractOf(row)}}};
    },
    'spacemolt_shipping/deliver':params=>{
      const id=String(params.shipment_id);
      const row=freight.listings.find(current=>String(current.id)===id);
      if(!row||!freight.accepted.includes(id))throw new Error(`No active shipment ${id}`);
      const contract=contractOf(row);
      if(account.server.location.docked_at!==contract.destination_base_id)
        throw new Error(`Not docked at ${contract.destination_base_id}`);
      if(!take(`package:${contract.package_id}`,1))throw new Error('The package is not in your cargo');
      freight.accepted=freight.accepted.filter(current=>current!==id);
      freight.successful_deliveries++;
      const payout=freight.payout||contract.base_reward;
      account.server.player.credits+=payout;
      return {delta:{details:{action:'deliver',contract:{...contract,status:'delivered'},carrier_payout:payout,late:false}}};
    },
    'spacemolt/list_station_passengers':()=>({structuredContent:{station:account.server.location.docked_at,
      count:platform.waiting.length,fare_surge:platform.fare_surge,demand_level:'steady',
      market_conditions:'steady',waiting:structuredClone(platform.waiting)}}),
    'spacemolt/list_passengers':()=>({structuredContent:{count:platform.onboard.length,
      passengers:structuredClone(platform.onboard),berths:berthsView(platform,platform.onboard)}}),
    'spacemolt/load_passenger':params=>{
      const to=String(params.id);
      const free=Object.values(berthsView(platform,platform.onboard)).reduce((n,row)=>n+row.free,0);
      const boarding=platform.waiting.filter(row=>row.destination===to).slice(0,free);
      platform.waiting=platform.waiting.filter(row=>!boarding.includes(row));
      for(const row of boarding)platform.onboard.push({...row,base_fare:row.estimated_fare??200,ticks_remaining:540});
      seat();
      return {delta:{details:{count:boarding.length,loaded:structuredClone(boarding),
        total_fare:boarding.reduce((n,row)=>n+(row.estimated_fare??200),0),message:'Boarded.'}}};
    },
    'spacemolt/unload_passenger':params=>{
      const id=String(params.id);
      assert.notEqual(id,'all','unload_passenger id="all" strands everyone; the validator refuses it');
      const rider=platform.onboard.find(row=>row.citizen_id===id);
      if(!rider)throw new Error(`No passenger ${id} aboard`);
      platform.onboard=platform.onboard.filter(row=>row!==rider);
      seat();
      const delivered=rider.destination===account.server.location.docked_at;
      if(delivered)account.server.player.credits+=rider.base_fare??200;
      return {delta:{details:{kind:'single',delivered,fare_collected:delivered?rider.base_fare??200:0,
        name:rider.name,message:delivered?'Delivered.':'Stranded.'}}};
    },
    'spacemolt/get_missions':()=>({structuredContent:{missions:structuredClone(board)}}),
    'spacemolt/get_active_missions':()=>({structuredContent:{missions:{active:structuredClone(taken),max_missions:5}}}),
    'spacemolt/accept_mission':params=>{
      const wanted=board.find(row=>row.mission_id===String(params.id));
      if(!wanted)throw new Error(`No mission ${params.id} on this board`);
      if(taken.length>=5)throw new Error('5 of 5 missions already active');
      taken.push({...structuredClone(wanted),percent_complete:0});
      return {structuredContent:{mission_id:wanted.mission_id,title:wanted.title}};
    },
    // The server pays only a mission whose objectives are met; anything else is a refusal,
    // which is how a caller learns the withdrawal it made was not enough.
    'spacemolt/complete_mission':params=>{
      const row=taken.find(current=>current.mission_id===String(params.id));
      if(!row)throw new Error(`No active mission ${params.id}`);
      const short=(row.objectives??[]).find((o:Record<string,any>)=>
        (o.required??0)>(o.current??0)+(o.item_id?held(String(o.item_id)):0));
      if(short)throw new Error(`Objective not met: ${short.description}`);
      taken.splice(taken.indexOf(row),1);
      // Paid into the account, not just into the reply: a gain a caller measures has to be real.
      account.server.player.credits+=row.rewards?.credits??0;
      return {delta:{details:{mission_id:row.mission_id,title:row.title,credits_earned:row.rewards?.credits??0,message:'Paid.'}}};
    },
    'spacemolt/abandon_mission':params=>{
      const row=taken.find(current=>current.mission_id===String(params.id));
      if(!row)throw new Error(`No active mission ${params.id}`);
      taken.splice(taken.indexOf(row),1);
      return {delta:{details:{mission_id:row.mission_id,title:row.title,message:'Abandoned.'}}};
    },
    // A look answers for where the ship is standing, which is the whole reason fauna is not
    // knowable before arrival. A creature pinned to another POI is not here; one with no POI at
    // all is everywhere, so a world that never names one behaves exactly as it always did.
    'spacemolt/get_nearby':()=>{
      const here=hereCreatures();
      return {structuredContent:{poi_id:account.server.location.poi_id,
        count:here.length,creature_count:here.length,
        creatures:structuredClone(here),nearby:[],pirates:[],empire_npcs:[],prizes:[],
        arena_npcs:[],pirate_count:0,empire_npc_count:0,prize_count:0,arena_npc_count:0}};
    },
    'spacemolt/hunt':params=>{
      const target=fauna.creatures.find(row=>row.creature_id===String(params.id));
      if(!target)throw new Error(`No creature ${params.id} here`);
      battle={target:target.creature_id,left:Math.max(0,fauna.polls),ticks:0,retreats:0,stance:'fire',fled:0};
      return {delta:{details:{command:'attack',message:'Engaging.',pending:true}}};
    },
    // The server's own refusal when the fight is over, which is how a caller learns it ended.
    'spacemolt_battle/status':()=>{
      if(!battle)throw new Error('No active battle. Use attack to engage a target.');
      const target=battle.target,ticks=battle.ticks+1;
      tick();
      const {ship}=account.server;
      // One tick resolves per status read; `tick_duration` is how the caller tells them apart.
      return {structuredContent:{battle_id:'battle-1',is_participant:true,system_id:'sol',tick_duration:ticks,
        combat_state:{effective_speed:ship.speed,max_weapon_reach:2,incapacitated:ship.incapacitated},
        participants:[{player_id:'ship',kind:'player',side_id:2,stance:'fire',
          hull_pct:Math.round(100*ship.hull/ship.max_hull),zone:'inner',zone_distance:2},
        ...fauna.creatures.filter(row=>row.creature_id===target).map(row=>({player_id:row.creature_id,
          kind:'creature',is_npc:true,side_id:1,username:row.name,
          hull_pct:Math.round(100*row.hull/row.max_hull),
          zone:fauna.flees?'outer':'inner',zone_distance:fauna.flees?2+ticks:2}))]}};
    },
    'spacemolt_battle/advance':()=>({structuredContent:{action:'advance',message:'Advancing toward the enemy.'}}),
    'spacemolt_battle/stance':params=>{
      if(battle)battle.stance=String(params.id);
      return {structuredContent:{action:'stance',stance:String(params.id),message:'Stance set.'}};},
    'spacemolt_battle/target':params=>({structuredContent:{action:'target',target:String(params.id),message:'Target set.'}}),
    // A retreat is an attempt, not an exit: the live server takes it and the battle carries on
    // until it resolves. `retreatTicks` is how many accepted retreats that takes.
    'spacemolt_battle/retreat':()=>{
      if(battle&&battle.retreats++>=fauna.retreatTicks)battle=null;
      return {structuredContent:{action:'retreat',message:'Retreating from the enemy.'}};},
    'spacemolt_salvage/wrecks':()=>({structuredContent:{count:wrecks.length,
      wrecks:structuredClone(wrecks)}}),
    'spacemolt_salvage/loot':params=>{
      const wreck=wrecks.find(row=>row.id===String(params.id));
      if(!wreck)throw new Error(`No wreck ${params.id}`);
      const row=(wreck.cargo as {item_id:string;quantity:number}[])
        .find(item=>item.item_id===String(params.item_id));
      if(!row)throw new Error(`No ${params.item_id} in that wreck`);
      const moved=Math.min(row.quantity,Number(params.quantity),
        account.server.ship.cargo_capacity-account.server.ship.cargo_used);
      add(row.item_id,moved);
      row.quantity-=moved;
      wreck.cargo=(wreck.cargo as {quantity:number}[]).filter(item=>item.quantity>0);
      return {delta:{details:{action:'loot_wreck',item_id:row.item_id,quantity:99,
        wreck_empty:!(wreck.cargo as unknown[]).length}}};
    },
    'spacemolt/get_system':()=>({structuredContent:{kind:'normal',
      system:systemAt(account.server.location.system_id)}}),
    // The map entry for a system, as a far one answers: never visited, so a neighbour is
    // always somewhere the menu can point at.
    'spacemolt/get_map':params=>{
      // No id asked for is the whole galaxy, which is what a name or a near miss is matched
      // against; one id is the entry for that system.
      if(params.system_id===undefined)return {structuredContent:{total_count:galaxy.length,
        systems:galaxy.map(s=>({system_id:s.id,name:s.name,poi_count:s.pois.length,visited:s.id==='sol',
          connections:s.connections.map(link=>link.system_id),online:0,position:{x:0,y:0},visited_at:''}))}};
      const far=systemAt(String(params.system_id));
      return {structuredContent:{system_id:far.id,name:far.name,poi_count:far.pois.length,visited:far.id==='sol',
        connections:far.connections.map(link=>link.system_id),online:0,position:{x:0,y:0},visited_at:''}};
    },
    'spacemolt/find_route':params=>{
      const target=homes[String(params.id)];
      // An id the server cannot place is an error, not a `found:false` body: it assumes the
      // word was a system and says so. That throw is what goTo has to read as "no such place".
      if(!target)throw new Error('Target system not found');
      const from=account.server.location.system_id;
      const route=path(from,target);
      // A system id answers with a system and no POI of its own: there is no one place in a
      // system that "is" the system, which is why naming it as a POI is rejected below.
      return {found:true,target_system:target,
        ...homes[String(params.id)]===String(params.id)?{}:{target_poi:poiIds[String(params.id)]??String(params.id)},
        total_jumps:route.length-1,
        estimated_fuel:7,fuel_per_jump:7,fuel_available:account.server.ship.fuel,
        cargo_used:account.server.ship.cargo_used,route:route.map((system_id,jumps)=>({system_id,jumps}))};
    },
    'spacemolt/jump':params=>{notInBattle();account.server.ship.fuel-=7;account.server.location.system_id=String(params.id);
      account.server.location.poi_id='gate';
      // Arriving is the whole of a `visit_system` objective: the server ticks it over on the
      // jump, and nothing else the pilot sends can.
      for(const row of taken)for(const o of (row.objectives??[]) as Record<string,any>[])
        if(o.type==='visit_system'&&o.system_id===String(params.id)){o.current=o.required??1;o.completed=true;}
      return {};},
    'spacemolt/undock':()=>{notInBattle();account.server.location.docked_at=null;return {};},
    // The base you dock at is the one behind the POI you are standing at, never a fixed id.
    'spacemolt/dock':()=>{account.server.location.docked_at=bases[account.server.location.poi_id]??'sol_base';return {};},
    // The server settles the move before the next authoritative read, as a same-system hop does.
    'spacemolt/travel':params=>{
      notInBattle();
      // The server's own refusal when the id is not a POI in this system — a system id
      // handed on as a destination is rejected here, after the jump was flown and paid for.
      const where=systemAt(account.server.location.system_id);
      if(!where.pois.some((row:{id:string})=>row.id===String(params.id)))throw new Error(`Unknown destination: ${params.id}`);
      account.server.ship.fuel-=7;account.server.location.poi_id=String(params.id);return {};},
    // The reply over-claims: only the cargo delta says what the trip actually took.
    'spacemolt/mine':()=>{add('ore',minePerCycle);
      return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99}}};},
    // The counter you are standing at, never a global book: `markets[base]` overrides the
    // default entirely, so a base with no buyer for ore is expressible.
    'spacemolt_market/view_market':()=>{
      const at=account.server.location.docked_at??'';
      const own=options.markets?.[at];
      const rows=own??[{item_id:'ore',item_name:'Ore',best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5},
        ...options.market??[]];
      return {delta:{details:{current_tick:TICK,items:rows.map(row=>({item_name:row.item_id,buy_price:row.best_sell,...row}))}}};
    },
    // As live: an `item_id` filter answers nothing, even for a filed item; `base_id` (or no
    // filter) answers whole books, paged by `limit`/`offset`; `system_id` is always empty.
    'spacemolt_intel/query_trade_intel':params=>{
      if(!ledger)throw new Error('You are not in a faction');
      const limit=Number(params.limit??10),offset=Number(params.offset??0);
      const matched=params.item_id!==undefined?[]:ledger.filter(row=>params.base_id===undefined||row.base_id===params.base_id);
      const entries=matched.slice(offset,offset+limit)
        .map(row=>({base_id:row.base_id,system_id:'',
          station_name:row.station_name??row.base_id,submitted_at_tick:row.submitted_at_tick??100,
          submitted_by:'someone',submitter_name:'Someone',
          items:row.items.map(cell=>({item_name:cell.item_id,best_sell:0,buy_volume:0,sell_volume:0,...cell}))}));
      return {structuredContent:{entries,intel_level:2,limit,offset,showing:entries.length,total:matched.length}};
    },
    // One entry per base, the latest filing replacing the last, stamped with the tick it came in on.
    'spacemolt_intel/submit_trade_intel':params=>{
      if(!ledger)throw new Error('You are not in a faction');
      const stations=params.stations as {base_id:string;items:{item_id:string;best_buy:number;best_sell:number;buy_volume:number;sell_volume:number}[]}[];
      for(const station of stations) {
        ledger.splice(0,ledger.length,...ledger.filter(row=>row.base_id!==station.base_id));
        ledger.push({base_id:station.base_id,submitted_at_tick:TICK,items:station.items});
      }
      return {delta:{details:{status:'submitted',stations_updated:stations.length,message:`Trade intel submitted for ${stations.length} station(s).`}}};
    },
    'spacemolt/sell':params=>{
      const quantity=take(String(params.id),Number(params.quantity));
      account.server.player.credits+=quantity*10;
      return {delta:{details:{action:'sell',item_id:params.id,quantity_sold:quantity,total_earned:quantity*10}}};
    },
    // The catalog behind a module or a hull: the only place a slot kind and a grid draw
    // are knowable before the thing is bought.
    'spacemolt/inspect':params=>{
      const id=String(params.id);
      // A base named by id answers with the docked-base body, which is how a counter the ship is
      // not standing at can be quoted at all.
      if(Object.hasOwn(quotes,id))return {structuredContent:{id,kind:'base',source:'live',
        base:{...quotes[id]!.fuel===undefined?{}:{fuel_price_all_in:quotes[id]!.fuel},
          base:{poi_id:id,...quotes[id]!.hull===undefined?{}:{repair_price_per_hull:quotes[id]!.hull}}}}};
      if(Object.hasOwn(MODULES,id))return {structuredContent:{id,kind:'module',source:'catalog',
        catalog:page([MODULES[id]!],'items')}};
      if((options.hangar?.unknownClasses??[]).includes(id))
        throw new Error(`Ship class "${id}" not found.`);
      if(Object.hasOwn(CLASSES,id))return {structuredContent:{id,kind:'ship_class',source:'catalog',
        catalog:page([CLASSES[id]!],'ships')}};
      return {structuredContent:{id,kind:'item',source:'catalog',
        catalog:page([{id,name:id,description:'',base_value:1,size:1}],'items')}};
    },
    'spacemolt/install_mod':params=>{
      const spec=MODULES[String(params.id)];
      if(!spec)throw new Error(`No module ${params.id}`);
      const slot=String(spec.slot),cap=Number((account.server.ship as any)[`${slot}_slots`]??0);
      if(account.server.modules.filter(row=>row.slot===slot).length>=cap)
        throw new Error('no_utility_slots');
      take(String(params.id),1);
      account.server.modules.push({...spec,module_id:`m${account.server.modules.length+1}`});
      account.server.ship.cpu_used+=Number(spec.cpu_usage);
      account.server.ship.power_used+=Number(spec.power_usage);
      return {delta:{details:{message:'Installed.',module_id:String(spec.id),
        cpu_used:account.server.ship.cpu_used,power_used:account.server.ship.power_used}}};
    },
    'spacemolt/uninstall_mod':params=>{
      const row=account.server.modules.find(current=>
        current.module_id===String(params.id)||current.type_id===String(params.id));
      if(!row)throw new Error(`No module ${params.id} fitted`);
      account.server.modules=account.server.modules.filter(current=>current!==row);
      account.server.ship.cpu_used-=Number(row.cpu_usage);
      account.server.ship.power_used-=Number(row.power_usage);
      add(String(row.type_id),1);
      return {delta:{details:{message:'Removed.',module_id:String(row.type_id)}}};
    },
    'spacemolt_ship/browse_ships':()=>({structuredContent:{base_id:'sol_base',base_name:'Sol Base',
      count:listings.length,listings:structuredClone(listings)}}),
    'spacemolt_ship/buy_listed_ship':params=>{
      const row=listings.find(current=>current.listing_id===String(params.id));
      if(!row)throw new Error(`No listing ${params.id}`);
      account.server.player.credits-=row.price;
      listings.splice(listings.indexOf(row),1);
      fleet.push({ship_id:row.ship_id,class_id:row.class_id,class_name:CLASSES[row.class_id]?.name??row.class_id,
        is_active:false,location_base_id:'sol_base'});
      return {delta:{details:{message:'Bought.',class_id:row.class_id,price:row.price,
        ship_id:row.ship_id,credits_left:account.server.player.credits}}};
    },
    'spacemolt_ship/list_ships':()=>({structuredContent:{count:fleet.length,
      active_ship_id:'ship',active_ship_class:'cobble',ships:structuredClone(fleet)}}),
    'spacemolt_market/estimate_purchase':params=>{
      const subtotal=Number(params.quantity)*12,sales_tax=tax(subtotal);
      return {structuredContent:{item_id:params.item_id,available:99,quantity:Number(params.quantity),subtotal,
        total_cost:subtotal+sales_tax,sales_tax,...options.taxBps===undefined?{}:{sales_tax_rate_bps:options.taxBps},unfilled:0}};
    },
    'spacemolt/buy':params=>{
      add(String(params.id),Number(params.quantity));
      account.server.player.credits-=Number(params.quantity)*12+tax(Number(params.quantity)*12);
      return {delta:{details:{action:'buy',item_id:params.id,quantity:Number(params.quantity),
        total_cost:Number(params.quantity)*12,unfilled:0}}};
    },
    // A counter posts a price only for a service it runs: a station with no repair service
    // posts no `repair_price_per_hull`, which is the live refusal `service` has to survive.
    'spacemolt/get_base':()=>({delta:{details:{services,
      ...services.includes('refuel')?{fuel_price_all_in:options.fuelPrice??1}:{},
      base:{poi_id:'station',...services.includes('repair')?{repair_price_per_hull:1}:{}}}}}),
    // Undocked, `refuel` burns fuel cells from the hold (lib: "Number of fuel cells to burn");
    // this world's cell is worth 5 fuel. Docked, the counter fills the tank for credits.
    'spacemolt/refuel':params=>{
      if(!account.server.location.docked_at) {
        const burned=take(String(params.id??'fuel_cell'),Number(params.quantity??1));
        if(!burned)throw new Error('No fuel cells in cargo');
        account.server.ship.fuel=Math.min(account.server.ship.max_fuel,account.server.ship.fuel+burned*5);
        return {delta:{details:{action:'refuel',source:'fuel_cell',cells_used:burned,fuel:account.server.ship.fuel}}};
      }
      const cost=account.server.ship.max_fuel-account.server.ship.fuel;
      account.server.ship.fuel=account.server.ship.max_fuel;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'refuel',cost}}};
    },
    'spacemolt/repair':()=>{
      const cost=account.server.ship.max_hull-account.server.ship.hull;
      account.server.ship.hull=account.server.ship.max_hull;
      account.server.player.credits-=cost;
      return {delta:{details:{action:'repair',cost}}};
    },
    'spacemolt_storage/view':()=>({structuredContent:{action:'view_storage',base_id:'sol_base',
      hint:'',items:store.map(row=>({...row,size:footprint(row.item_id)})),
      ships:[{ship_id:'spare',class_id:'hauler',cargo_used:0,modules:0}],
      locations:[{base_id:'sol_base',base_name:'Sol Base',item_count:store.length,ship_count:1,
        system:'sol',system_name:'Sol'}]}}),
    // One action, three replies, as the live server answers it: no id is the queue, dry_run
    // is a quote that consumes nothing, and anything else commits the escrow.
    'spacemolt/craft':params=>{
      if(params.id===undefined) {
        if(queued.length) {
          if(polls>0)polls--;
          else {deliver(queued[0]!);queued.length=0;}
        }
        return {delta:{details:{kind:'queue',jobs:structuredClone(queued),total_jobs:queued.length}}};
      }
      if(bench.refusal)throw new Error(bench.refusal);
      if(params.dry_run)return {delta:{details:{kind:'quote',action:'craft',recipe:bench.recipe,
        cost:{inputs:bench.inputs,labor:10,fee:9},credits_total:bench.credits_total,dry_run:true,
        have_inputs:options.craft?.have_inputs??bench.inputs.every(row=>
          (store.find(current=>current.item_id===row.item_id)?.quantity??0)>=row.quantity),
        have_credits:bench.have_credits,
        produces:bench.produces,quantity:bench.quantity,runs:bench.runs}}};
      // A commit escrows: the inputs leave this base's store and the credits leave the wallet.
      for(const row of bench.inputs) {
        const held=store.find(current=>current.item_id===row.item_id);
        if(held)held.quantity-=row.quantity;
      }
      account.server.player.credits-=bench.credits_total;
      queued.push({base_id:'sol_base',job_id:'job-1',recipe:bench.recipe,mode:'craft',
        deliver_to:'storage',produces:bench.produces,runs_total:bench.runs,runs_done:0,
        status:'queued',eta_ticks:bench.eta_ticks});
      return {delta:{details:{kind:'job',action:'craft',job_id:'job-1',recipe:bench.recipe,
        produces:bench.produces,runs:bench.runs,eta_ticks:bench.eta_ticks,
        escrowed:{inputs:bench.inputs,labor:10,fee:9}}}};
    },
    'spacemolt_storage/deposit':params=>{
      const moved=take(String(params.item_id),Number(params.quantity));
      const row=store.find(current=>current.item_id===String(params.item_id));
      if(row)row.quantity+=moved;else store.push({item_id:String(params.item_id),quantity:moved});
      return {delta:{details:{action:'deposit_items',item_id:params.item_id,quantity:99,storage_total:99}}};
    },
    // The store's side of the same counter, bounded by what it holds and what the hold has
    // room for. Like the deposit, the reply over-claims: only the cargo delta is evidence.
    'spacemolt_storage/withdraw':params=>{
      const item=String(params.item_id);
      const row=store.find(current=>current.item_id===item);
      const room=account.server.ship.cargo_capacity-account.server.ship.cargo_used;
      const moved=Math.min(row?.quantity??0,Number(params.quantity));
      // The live refusal, word for word: the whole ask or nothing.
      if(moved*footprint(item)>room)throw new Error(`cargo_full: Not enough cargo space. Need ${moved*footprint(item)} but only ${room} available. Use 'deposit_items' or 'jettison' to free space.`);
      if(row) {
        row.quantity-=moved;
        if(!row.quantity)store.splice(store.indexOf(row),1);
      }
      add(item,moved);
      return {delta:{details:{action:'withdraw_items',item_id:item,quantity:99,
        cargo_space:account.server.ship.cargo_capacity-account.server.ship.cargo_used,
        cargo_total:account.server.ship.cargo_capacity,storage_remaining:99}}};
    },
  };
  const command:ReadinessCommand=async(action,params)=>{
    sent.push({action,params:structuredClone(params)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]!(params);
  };
  return {account,sent,command,store,queued,board,taken,listings,fleet,wrecks,
    count:(action:string)=>sent.filter(call=>call.action===action).length};
}
