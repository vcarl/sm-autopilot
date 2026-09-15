/** One fake game the bridge and the script runner are both driven against.
 *
 * Two systems, a station with a base behind it, a belt in each, and a server that answers
 * only what a real one would: every mine reply over-claims (99 ore), so a yield any test
 * asserts can only have come from an authoritative cargo read.
 */
import assert from 'node:assert/strict';
import type {ReadinessCommand} from '../readiness.ts';
import {FakeLibGoalAccount} from './fake-lib-account.ts';

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
    ship:{id:'ship',fuel:100,max_fuel:120,hull:96,max_hull:100,cargo_used:cargoUsed,cargo_capacity:12},
    player:{credits:1_000},
    cargo:(cargoUsed?[{item_id:'ore',quantity:cargoUsed}]:[]) as {item_id:string;quantity:number}[],
    modules:[] as {module_id:string;type_id:string;slot:string}[],
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
  const sent:{action:string;params:Record<string,unknown>}[]=[];
  const handlers:Record<string,(params:Record<string,unknown>)=>unknown>={
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
    'spacemolt_market/view_market':()=>({delta:{details:{items:[{item_id:'ore',buy_price:10}]}}}),
    'spacemolt/sell':params=>{
      const quantity=take(String(params.id),Number(params.quantity));
      account.server.player.credits+=quantity*10;
      return {delta:{details:{action:'sell',quantity_sold:quantity}}};
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
  };
  const command:ReadinessCommand=async(action,params)=>{
    sent.push({action,params:structuredClone(params)});
    assert.ok(Object.hasOwn(handlers,action),`Unexpected command: ${action}`);
    return handlers[action]!(params);
  };
  return {account,sent,command,store,queued,
    count:(action:string)=>sent.filter(call=>call.action===action).length};
}
