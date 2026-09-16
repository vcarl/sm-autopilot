/** One fake game the bridge and the script runner are both driven against.
 *
 * Two systems, a station with a base behind it, a belt in each, and a server that answers
 * only what a real one would: every mine reply over-claims (99 ore), so a yield any test
 * asserts can only have come from an authoritative cargo read.
 */
import assert from 'node:assert/strict';
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
  pois:[{id:'outpost',name:'Deep Range Outpost',type:'station'},
    {id:'far_belt',name:'Far Belt',type:'asteroid_belt'}],
  connections:[{system_id:'sol',name:'Sol',distance:4}]};
// Where each nameable id lives, as the server's find_route answers it. A base id is
// nameable too, and answers with the POI it sits at.
const homeOf:Record<string,string>={sol:'sol',station:'sol',belt:'sol',sol_base:'sol',
  deep_range:'deep_range',outpost:'deep_range',far_belt:'deep_range'};
const poiOf:Record<string,string>={sol_base:'station'};

export interface WorldOptions {
  services?:string[];
  /** The hold at the start. 12 of 12 is a full hold: a gather job mines nothing and still
   * has to come home, settle and service before it may call itself done. */
  cargoUsed?:number;
  /** What the station store holds before anything is deposited. */
  store?:{item_id:string;name?:string;quantity:number}[];
  /** How much ore one mining cycle puts in the hold. */
  minePerCycle?:number;
  /** The one recipe this world's bench knows, as the server quotes and runs it. */
  craft?:CraftOptions;
  /** The creatures at this world's POIs, and how a fight with one goes. */
  wildlife?:WildlifeOptions;
}

/** A habitat with creatures in it: what a look answers, how a battle resolves over a few
 * polls, and what the kill leaves in a wreck. The ship's own weapon is here too, because a
 * hunt's first gate is the fit, not the target. */
export interface WildlifeOptions {
  creatures?:{creature_id:string;species:string;name?:string;role?:string;hull?:number;
    max_hull?:number;speed?:number;in_combat?:boolean;branded?:boolean}[];
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
  const account=new FakeLibGoalAccount({
    location:{system_id:'sol',poi_id:'station',docked_at:'sol_base' as string|null,in_transit:false},
    // Hull stays above the Cautious D3 line: a ship below it is Tired and starts no job.
    ship:{id:'ship',fuel:100,max_fuel:120,hull:96,max_hull:100,cargo_used:cargoUsed,
      cargo_capacity:12,speed:3,incapacitated:false},
    player:{credits:1_000},
    cargo:(cargoUsed?[{item_id:'ore',quantity:cargoUsed}]:[]) as {item_id:string;quantity:number}[],
    modules:[] as Record<string,any>[],
  });
  const add=(item:string,quantity:number)=>{
    const room=account.server.ship.cargo_capacity-account.server.ship.cargo_used;
    const moved=Math.min(room,quantity);
    if(moved<=0)return;
    const row=account.server.cargo.find(current=>current.item_id===item);
    if(row)row.quantity+=moved;else account.server.cargo.push({item_id:item,quantity:moved});
    account.server.ship.cargo_used+=moved;
  };
  const take=(item:string,quantity:number)=>{
    const row=account.server.cargo.find(current=>current.item_id===item);
    const moved=Math.min(row?.quantity??0,quantity);
    if(row) {
      row.quantity-=moved;
      if(!row.quantity)account.server.cargo=account.server.cargo.filter(current=>current!==row);
    }
    account.server.ship.cargo_used-=moved;
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
    incapacitateOn:0,...options.wildlife,
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
  const wrecks:Record<string,any>[]=[];
  let battle:{target:string;left:number;ticks:number}|null=null;
  const tick=()=>{
    if(!battle)return;
    battle.ticks++;
    account.server.ship.hull=Math.max(0,account.server.ship.hull-fauna.damage);
    if(fauna.incapacitateOn&&battle.ticks>=fauna.incapacitateOn)
      account.server.ship.incapacitated=true;
    if(battle.left>0){battle.left--;return;}
    // The creature is down: it leaves the habitat and leaves a wreck with its drops in it.
    const target=battle.target;
    fauna.creatures=fauna.creatures.filter(row=>row.creature_id!==target);
    wrecks.push({id:`wreck-${wrecks.length+1}`,victim_id:target,type:'creature',
      poi_id:account.server.location.poi_id,cargo:structuredClone(fauna.drops),modules:[]});
    battle=null;
  };
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
    'spacemolt/get_nearby':()=>({structuredContent:{poi_id:account.server.location.poi_id,
      count:fauna.creatures.length,creature_count:fauna.creatures.length,
      creatures:structuredClone(fauna.creatures),nearby:[],pirates:[],empire_npcs:[],prizes:[],
      arena_npcs:[],pirate_count:0,empire_npc_count:0,prize_count:0,arena_npc_count:0}}),
    'spacemolt/hunt':params=>{
      const target=fauna.creatures.find(row=>row.creature_id===String(params.id));
      if(!target)throw new Error(`No creature ${params.id} here`);
      battle={target:target.creature_id,left:Math.max(0,fauna.polls),ticks:0};
      return {delta:{details:{command:'attack',message:'Engaging.',pending:true}}};
    },
    // The server's own refusal when the fight is over, which is how a caller learns it ended.
    'spacemolt_battle/status':()=>{
      if(!battle)throw new Error('No active battle. Use attack to engage a target.');
      const target=battle.target;
      tick();
      const {ship}=account.server;
      return {structuredContent:{battle_id:'battle-1',is_participant:true,system_id:'sol',
        combat_state:{effective_speed:ship.speed,max_weapon_reach:2,incapacitated:ship.incapacitated},
        participants:[{player_id:'ship',kind:'player',side_id:2,stance:'fire',
          hull_pct:Math.round(100*ship.hull/ship.max_hull),zone:'inner',zone_distance:2},
        ...fauna.creatures.filter(row=>row.creature_id===target).map(row=>({player_id:row.creature_id,
          kind:'creature',is_npc:true,side_id:1,username:row.name,
          hull_pct:Math.round(100*row.hull/row.max_hull),zone:'inner',zone_distance:2}))]}};
    },
    'spacemolt_battle/advance':()=>({structuredContent:{action:'advance',message:'Advancing toward the enemy.'}}),
    'spacemolt_battle/retreat':()=>{battle=null;
      return {structuredContent:{action:'retreat',message:'Breaking off.'}};},
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
      system:account.server.location.system_id==='sol'?system:deepRange}}),
    'spacemolt/find_route':params=>{
      const target=homeOf[String(params.id)];
      if(!target)return {found:false,message:`No route to ${params.id}`};
      const from=account.server.location.system_id;
      const route=from===target?[from]:[from,target];
      return {found:true,target_system:target,target_poi:poiOf[String(params.id)]??String(params.id),
        total_jumps:route.length-1,
        estimated_fuel:7,fuel_per_jump:7,fuel_available:account.server.ship.fuel,
        cargo_used:account.server.ship.cargo_used,route:route.map((system_id,jumps)=>({system_id,jumps}))};
    },
    'spacemolt/jump':params=>{account.server.ship.fuel-=7;account.server.location.system_id=String(params.id);
      account.server.location.poi_id='gate';return {};},
    'spacemolt/undock':()=>{account.server.location.docked_at=null;return {};},
    'spacemolt/dock':()=>{account.server.location.docked_at='sol_base';return {};},
    // The server settles the move before the next authoritative read, as a same-system hop does.
    'spacemolt/travel':params=>{account.server.ship.fuel-=7;account.server.location.poi_id=String(params.id);return {};},
    // The reply over-claims: only the cargo delta says what the trip actually took.
    'spacemolt/mine':()=>{add('ore',minePerCycle);
      return {command:'mine',delta:{details:{kind:'yield',resource_id:'ore',quantity:99}}};},
    'spacemolt_market/view_market':()=>({delta:{details:{items:[{item_id:'ore',item_name:'Ore',buy_price:10,best_buy:10,best_buy_qty:99,best_sell:12,best_sell_qty:5}]}}}),
    'spacemolt/sell':params=>{
      const quantity=take(String(params.id),Number(params.quantity));
      account.server.player.credits+=quantity*10;
      return {delta:{details:{action:'sell',item_id:params.id,quantity_sold:quantity,total_earned:quantity*10}}};
    },
    'spacemolt/get_base':()=>({delta:{details:{services,fuel_price_all_in:1,
      base:{poi_id:'station',repair_price_per_hull:1}}}}),
    'spacemolt/refuel':()=>{
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
      hint:'',items:structuredClone(store),
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
        have_inputs:bench.have_inputs,have_credits:bench.have_credits,
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
      const moved=Math.min(row?.quantity??0,Number(params.quantity),Math.max(0,room));
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
  return {account,sent,command,store,queued,
    count:(action:string)=>sent.filter(call=>call.action===action).length};
}
