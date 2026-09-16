/** Wrecks at the POI you are at: loot them into the hold. Also the recovery job after your
 * own death: ~70% of your modules and half your cargo sit in a wreck where you died. */
import type {EnrichedWreck,GetWrecksResponse,LootedItem,LootedModule,ShipCargoItem} from '@spacemolt/lib';
import {miningInventory} from '../../mining-inventory.ts';
import {details} from '../../response-details.ts';
import {acct,checkStop,command,job,step} from '../runtime.ts';
import type {Outcome} from '../types.ts';

export interface Salvaged {
  wrecks:EnrichedWreck[];
  looted:{wreck_id:string;items:LootedItem[];modules:LootedModule[]}[];
  /** Left behind for want of room, by wreck. */
  left:{wreck_id:string;cargo:EnrichedWreck['cargo']}[];
  /** The wreck a tow line was attached to, when `tow` named one. */
  towed?:string;
}

/** Every wreck at this POI, as `salvage/wrecks` answers it. */
export async function wrecksHere():Promise<EnrichedWreck[]> {
  return ((details(await command('spacemolt_salvage/wrecks',{})) as GetWrecksResponse).wrecks??[]);
}

const room=()=>{const ship=acct().state.ship;return Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0);};

/** One wreck emptied into the hold: modules first (they take a slot each and are the value),
 * then cargo, row by row, until the hold is full. The hold after each send is the evidence,
 * never the reply's claim — a `loot` reply over-states the quantity. */
export async function lootWreck(wreck:EnrichedWreck):Promise<{items:LootedItem[];modules:LootedModule[];left:ShipCargoItem[]}> {
  const items:LootedItem[]=[],modules:LootedModule[]=[],left:ShipCargoItem[]=[];
  for(const module of wreck.modules??[]) {
    checkStop();
    if(room()<=0){break;}
    try {await command('spacemolt_salvage/loot',{id:wreck.id,module_id:module.id});modules.push(module);}
    catch {/* the module was taken, or does not fit; the cargo rows still might */}
    await acct().refresh();
  }
  for(const row of wreck.cargo??[]) {
    checkStop();
    const quantity=Math.min(row.quantity,Math.max(0,room()));
    if(quantity<=0){left.push(row);continue;}
    const before=miningInventory(acct().state)[row.item_id]??0;
    try {await command('spacemolt_salvage/loot',{id:wreck.id,item_id:row.item_id,quantity});}
    catch {left.push(row);continue;}
    await acct().refresh();
    const moved=(miningInventory(acct().state)[row.item_id]??0)-before;
    if(moved>0)items.push({item_id:row.item_id,quantity:moved});
    if(moved<row.quantity)left.push({...row,quantity:row.quantity-moved});
  }
  return {items,modules,left};
}

const say=(rows:LootedItem[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** Loot every wreck here (`salvage/wrecks` then `salvage/loot`), modules first, then cargo,
 * until the hold is full. Your own wreck (`victim_id` is you) is looted first. `tow: '<wreck
 * id>'` attaches a tow line to that wreck instead of looting it — a tow costs the speed the
 * way home needs, so it is asked for by name and never chosen here; selling or scrapping the
 * tow is the market's, not this function's. Idempotent: no wreck, or nothing that fits, is
 * `done` with an empty list. Trains salvaging. Costs nothing; a wreck in police-0 space is
 * the risk `scout` reports. */
export function salvage(opts:{tow?:string}={}):Promise<Outcome<Salvaged>> {
  return job<Salvaged>('salvage',opts.tow?`tow ${opts.tow}`:'',async()=>{
    const result:Salvaged={wrecks:[],looted:[],left:[]};
    result.wrecks=await wrecksHere();
    const poi=acct().state.location?.poi_id??'here';
    if(!result.wrecks.length)
      return {status:'done',did:`no wreck at ${poi}`,detail:result};
    if(opts.tow) {
      const wreck=result.wrecks.find(row=>row.id===opts.tow);
      if(!wreck)return {status:'refused',did:'towed nothing',why:`no wreck ${opts.tow} at ${poi}`,detail:result};
      await command('spacemolt_salvage/tow',{id:wreck.id});
      result.towed=wreck.id;
      return {status:'done',did:`towed ${wreck.ship_name??wreck.ship_class} (${wreck.salvage_value} cr of salvage) from ${poi}`,
        detail:result,next:['a tow costs speed: goTo a base with a salvage yard before anything else']};
    }
    const me=acct().state.player?.id;
    const order=[...result.wrecks].sort((a,b)=>Number(b.victim_id===me)-Number(a.victim_id===me));
    for(const wreck of order) {
      checkStop();
      const took=await lootWreck(wreck);
      if(took.items.length||took.modules.length)
        result.looted.push({wreck_id:wreck.id,items:took.items,modules:took.modules});
      if(took.left.length)result.left.push({wreck_id:wreck.id,cargo:took.left});
      step(`loot ${wreck.id}  ${say(took.items)||'nothing that fits'}${took.modules.length?`, ${took.modules.length} module(s)`:''}`);
    }
    const items=result.looted.flatMap(row=>row.items);
    const short=result.left.length>0;
    return {status:'done',
      did:`looted ${result.looted.length} of ${result.wrecks.length} wreck(s) at ${poi}: ${say(items)||'nothing that fits'}`,
      detail:result,
      next:short?['the hold filled before the wrecks emptied; stow or sell, then salvage() again']:[]};
  });
}
