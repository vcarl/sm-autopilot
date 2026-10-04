/** One read of storage: at the current base, or a named base without travelling there — the
 * game's own doc for `station_id` on `spacemolt_storage.view` says exactly that (it is
 * read-only and does not reach deposit/withdraw, which still require presence). Kept compact:
 * an item list capped, no per-ship detail, no gifts or messages — a menu fact, not a transcript. */
import {Effect} from 'effect';
import {Game,field} from './play/game.ts';

const ITEM_CAP=40;

export interface StorageView {
  base_id:string;base_name?:string;
  items:{item_id:string;name?:string;quantity:number}[];
  truncated?:number;
  ships:number;
  locations:{base_id:string;base_name:string;system_name:string;item_count:number;ship_count:number}[];
}

/** A game reply's body: the structured content, a state delta's details, or the reply itself. */
export const replyBody=(reply:unknown):unknown=>field(reply,'structuredContent')??field(field(reply,'delta'),'details')??reply??{};
export const rows=(value:unknown):unknown[]=>Array.isArray(value)?value:[];

export const viewStorageEffect=(stationId?:string)=>Effect.gen(function*() {
  const reply=replyBody(yield* (yield* Game).command('spacemolt_storage/view',stationId?{station_id:stationId}:{}));
  const baseId=String(field(reply,'base_id')??'');
  const items=rows(field(reply,'items'));
  const locations=rows(field(reply,'locations')).map(row=>({
    base_id:String(field(row,'base_id')),base_name:String(field(row,'base_name')),system_name:String(field(row,'system_name')),
    item_count:Number(field(row,'item_count')),ship_count:Number(field(row,'ship_count'))}));
  // The response carries no top-level base name; the locations index does, keyed by base_id.
  const baseName=locations.find(row=>row.base_id===baseId)?.base_name;
  const view:StorageView={
    base_id:baseId,...baseName?{base_name:baseName}:{},
    items:items.slice(0,ITEM_CAP).map(row=>({item_id:String(field(row,'item_id')),
      ...field(row,'name')?{name:String(field(row,'name'))}:{},quantity:Number(field(row,'quantity'))})),
    ...items.length>ITEM_CAP?{truncated:items.length-ITEM_CAP}:{},
    ships:rows(field(reply,'ships')).length,
    locations,
  };
  return view;
});
