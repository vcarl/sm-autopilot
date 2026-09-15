/** One read of storage: at the current base, or a named base without travelling there — the
 * game's own doc for `station_id` on `spacemolt_storage.view` says exactly that (it is
 * read-only and does not reach deposit/withdraw, which still require presence). Kept compact:
 * an item list capped, no per-ship detail, no gifts or messages — a menu fact, not a transcript. */
import {details} from './response-details.ts';
import type {ReadinessCommand} from './readiness.ts';

const ITEM_CAP=40;

export interface StorageView {
  base_id:string;base_name?:string;
  items:{item_id:string;name?:string;quantity:number}[];
  truncated?:number;
  ships:number;
  locations:{base_id:string;base_name:string;system_name:string;item_count:number;ship_count:number}[];
}

export async function viewStorage(command:ReadinessCommand,stationId?:string):Promise<StorageView> {
  const reply=details(await command('spacemolt_storage/view',stationId?{station_id:stationId}:{}));
  const baseId=String(reply.base_id??'');
  const items=Array.isArray(reply.items)?reply.items:[];
  const locations=(Array.isArray(reply.locations)?reply.locations:[]).map((row:any)=>({
    base_id:String(row.base_id),base_name:String(row.base_name),system_name:String(row.system_name),
    item_count:Number(row.item_count),ship_count:Number(row.ship_count)}));
  // The response carries no top-level base name; the locations index does, keyed by base_id.
  const baseName=locations.find(row=>row.base_id===baseId)?.base_name;
  return {
    base_id:baseId,...baseName?{base_name:baseName}:{},
    items:items.slice(0,ITEM_CAP).map((row:any)=>({item_id:String(row.item_id),
      ...row.name?{name:String(row.name)}:{},quantity:Number(row.quantity)})),
    ...items.length>ITEM_CAP?{truncated:items.length-ITEM_CAP}:{},
    ships:Array.isArray(reply.ships)?reply.ships.length:0,
    locations,
  };
}
