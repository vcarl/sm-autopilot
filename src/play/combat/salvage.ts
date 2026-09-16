/** Wrecks at the POI you are at: loot them into the hold. Also the recovery job after your
 * own death: ~70% of your modules and half your cargo sit in a wreck where you died. */
import type {EnrichedWreck,LootedItem,LootedModule} from '@spacemolt/lib';
import type {Outcome} from '../types.ts';

export interface Salvaged {
  wrecks:EnrichedWreck[];
  looted:{wreck_id:string;items:LootedItem[];modules:LootedModule[]}[];
  /** Left behind for want of room, by wreck. */
  left:{wreck_id:string;cargo:EnrichedWreck['cargo']}[];
}

/** Loot every wreck here (`salvage/wrecks` then `salvage/loot`), modules first, then cargo
 * by `salvage_value`, until the hold is full. Your own wreck (`victim_id` is you) is looted
 * first. Never tows: a tow costs the speed the way home needs; `next` says when a wreck is
 * worth a tow-and-sell trip instead. Idempotent: no wreck, or nothing that fits, is `done`
 * with an empty list. Trains salvaging. Costs nothing; a wreck in police-0 space is the risk
 * `scout` reports. */
export function salvage():Promise<Outcome<Salvaged>> {throw new Error('unimplemented');}
