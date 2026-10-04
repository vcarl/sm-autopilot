/** Wrecks at the POI you are at: loot them into the hold. Also the recovery job after your
 * own death: ~70% of your modules and half your cargo sit in a wreck where you died. */
import type {EnrichedWreck,LootedItem,LootedModule,ShipCargoItem} from '@spacemolt/lib';
import {Effect,Option,Schema,Struct} from 'effect';
import {miningInventory} from '../../mining-inventory.ts';
import {replyBody} from '../../storage.ts';
import * as Wire from '../../wire.gen.ts';
import {Game,GameLive,attempt,field,rawError,type GameError} from '../game.ts';
import {acct,checkStop,command,edge,jobEffect,step} from '../runtime.ts';
import type {Outcome} from '../types.ts';

export interface Salvaged {
  wrecks:EnrichedWreck[];
  looted:{wreck_id:string;items:LootedItem[];modules:LootedModule[]}[];
  /** Left behind for want of room, by wreck. */
  left:{wreck_id:string;cargo:EnrichedWreck['cargo']}[];
  /** The wreck a tow line was attached to, when `tow` named one. */
  towed?:string;
}

// Only what this file (and hunting.ts) reads of a wreck. `ship_class` and `salvage_value` are only said in the tow line, so a row
// without them still loots: the live server and the test world leave spec fields out. An absent or `null` `cargo`/`modules` reads as
// none and is said (live 2026-10-03, F-U17: `cargo: null`); a present one of the wrong type, or whose rows lack what is read, drops the row.
const Wreck=Wire.EnrichedWreck.mapFields(fields=>({...Struct.pick(fields,['id','victim_id','ship_name']),
  ship_class:Schema.optionalKey(fields.ship_class),salvage_value:Schema.optionalKey(fields.salvage_value),
  cargo:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ShipCargoItem.mapFields(Struct.pick(['item_id','quantity']))))),
  modules:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.LootedModule.mapFields(Struct.pick(['id'])))))}));
const decodeWreck=Schema.decodeUnknownOption(Wreck);

/** Every wreck at this POI, as `salvage/wrecks` answers it; a row that does not read is dropped and said. */
export const wrecksHereEffect=()=>Effect.gen(function*() {
  const listed=field(replyBody(yield* (yield* Game).command('spacemolt_salvage/wrecks',{})),'wrecks');
  const wrecks:EnrichedWreck[]=[];
  for(const row of Array.isArray(listed)?listed:[]) {
    const read=decodeWreck(row);
    if(Option.isNone(read)){step(`spacemolt_salvage/wrecks: wreck ${String(field(row,'id')??'(no id)')} did not read, skipped`);continue;}
    for(const key of ['cargo','modules'] as const)
      if((read.value[key]??undefined)===undefined)step(`wreck ${read.value.id}: no ${key} listed, read as none`);
    // oxlint-disable-next-line typescript/consistent-type-assertions
    wrecks.push(Object.assign({},row,{cargo:field(row,'cargo')??[],modules:field(row,'modules')??[]}) as EnrichedWreck); // cast: frozen surface (EnrichedWreck[])
  }
  return wrecks;
});
/** The Promise twin for callers not yet converted: throws the lib's raw error. */
async function viaCommand<A>(effect:Effect.Effect<A,GameError,Game>):Promise<A> {
  const exit=await Effect.runPromiseExit(effect.pipe(Effect.provide(GameLive({send:command})))); // bridge: U21 (caller: combat/hunting.ts)
  if(exit._tag==='Failure')throw rawError(exit.cause);
  return exit.value;
}
export const wrecksHere=():Promise<EnrichedWreck[]>=>viaCommand(wrecksHereEffect());

const room=()=>{const ship=acct().state.ship;return Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0);};
/** Why a row stayed in the wreck: the game's refusal (the error itself), or a condition of this side. */
type Reason=Exclude<GameError,{_tag:'ReplyLost'}>|'hold full'|'nothing that fits';
/** The only place an error becomes a string: the action and the server's code. */
const told=(reason:Reason)=>typeof reason==='string'?reason:`${reason.action}: ${reason.code} — ${reason.message}`;

/** One wreck emptied into the hold: modules first (they take a slot each and are the value),
 * then cargo, row by row, until the hold is full. The hold after each send is the evidence,
 * never the reply's claim — a `loot` reply over-states the quantity. What stayed in the wreck
 * carries its reason: the game's refusal as the error itself, or a local condition. A lost
 * reply ends it, and the loot is never re-sent. */
export const lootWreckEffect=(wreck:EnrichedWreck)=>Effect.gen(function*() {
  const game=yield* Game;
  const refresh=attempt('refresh',()=>acct().refresh()); // bridge: U31
  const items:LootedItem[]=[],modules:LootedModule[]=[];
  const left:{row:ShipCargoItem;reason:Reason}[]=[];
  const modulesLeft:{module:LootedModule;reason:Reason}[]=[];
  for(const module of wreck.modules) {
    checkStop();
    if(room()<=0){modulesLeft.push({module,reason:'hold full'});continue;}
    const sent=yield* Effect.result(game.command('spacemolt_salvage/loot',{id:wreck.id,module_id:module.id}));
    if(sent._tag==='Failure') {
      if(sent.failure._tag==='ReplyLost')return yield* sent.failure;
      modulesLeft.push({module,reason:sent.failure});continue;
    }
    modules.push(module);
    yield* refresh;
  }
  for(const row of wreck.cargo) {
    checkStop();
    const quantity=Math.min(row.quantity,Math.max(0,room()));
    if(quantity<=0){left.push({row,reason:'hold full'});continue;}
    const before=miningInventory(acct().state)[row.item_id]??0;
    const sent=yield* Effect.result(game.command('spacemolt_salvage/loot',{id:wreck.id,item_id:row.item_id,quantity}));
    if(sent._tag==='Failure') {
      if(sent.failure._tag==='ReplyLost')return yield* sent.failure;
      left.push({row,reason:sent.failure});continue;
    }
    yield* refresh;
    const moved=(miningInventory(acct().state)[row.item_id]??0)-before;
    if(moved>0)items.push({item_id:row.item_id,quantity:moved});
    if(moved<row.quantity)left.push({row:{...row,quantity:row.quantity-moved},reason:room()<=0?'hold full':'nothing that fits'});
  }
  // No cargo and no modules: the hull is all that is left.
  return {items,modules,left,modulesLeft,empty:!wreck.modules.length&&!wreck.cargo.length};
});
/** The Promise twin for hunting.ts: a refusal is a value, a lost reply rejects with the lib's raw error. */
export async function lootWreck(wreck:EnrichedWreck):Promise<{items:LootedItem[];modules:LootedModule[];left:ShipCargoItem[]}> {
  const {items,modules,left}=await viaCommand(lootWreckEffect(wreck)); // bridge: U21 (caller: combat/hunting.ts)
  return {items,modules,left:left.map(one=>one.row)};
}

const say=(rows:LootedItem[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** `salvage` as an Effect, for `edge` and for converted callers; never in a barrel. A tow the game refuses or
 * a lost reply ends the run, naming the action; a refused loot is said in the wreck's line and in `did`. */
export const salvageEffect=(opts:{tow?:string}={})=>
  jobEffect<Salvaged,Game>('salvage',opts.tow?`tow ${opts.tow}`:'',Effect.gen(function*() {
    const game=yield* Game;
    const result:Salvaged={wrecks:[],looted:[],left:[]};
    result.wrecks=yield* wrecksHereEffect();
    const poi=acct().state.location?.poi_id??'here';
    if(!result.wrecks.length)
      return {status:'done',did:`no wreck at ${poi}`,detail:result};
    if(opts.tow) {
      const wreck=result.wrecks.find(row=>row.id===opts.tow);
      if(!wreck)return {status:'refused',did:'towed nothing',why:`no wreck ${opts.tow} at ${poi}`,detail:result};
      yield* game.command('spacemolt_salvage/tow',{id:wreck.id});
      result.towed=wreck.id;
      return {status:'done',did:`towed ${wreck.ship_name??wreck.ship_class} (${wreck.salvage_value} cr of salvage) from ${poi}`,
        detail:result,next:['a tow costs speed: goTo a base with a salvage yard before anything else']};
    }
    const me=acct().state.player?.id;
    const order=[...result.wrecks].sort((a,b)=>Number(b.victim_id===me)-Number(a.victim_id===me));
    const problems:string[]=[];
    let full=false,hull=false;
    for(const wreck of order) {
      checkStop();
      const took=yield* lootWreckEffect(wreck);
      if(took.items.length||took.modules.length)
        result.looted.push({wreck_id:wreck.id,items:took.items,modules:took.modules});
      if(took.left.length)result.left.push({wreck_id:wreck.id,cargo:took.left.map(one=>one.row)});
      const said:string[]=[];
      const leave=(reason:Reason,text:string)=>{
        said.push(`${text}: ${told(reason)}`);
        problems.push(typeof reason==='string'?`${wreck.id}: ${text}: ${reason}`:`${wreck.id} refused: ${told(reason)}`);
        full||=reason==='hold full';
      };
      for(const one of took.left)leave(one.reason,`left ${one.row.quantity} ${one.row.item_id}`);
      for(const one of took.modulesLeft)leave(one.reason,`left module ${one.module.id}`);
      if(took.empty) {
        said.push(`empty (hull only): salvage({tow:'${wreck.id}'}) or scrap it`);
        problems.push(`${wreck.id} empty (hull only)`);
        hull=true;
      }
      const got=[say(took.items),took.modules.length?`${took.modules.length} module(s)`:''].filter(Boolean).join(', ');
      step(`loot ${wreck.id}  ${[got,...said].filter(Boolean).join('; ')}`);
    }
    const items=result.looted.flatMap(row=>row.items);
    return {status:'done',
      did:`looted ${result.looted.length} of ${result.wrecks.length} wreck(s) at ${poi}: ${[say(items),...new Set(problems)].filter(Boolean).join('; ')||'nothing'}`,
      detail:result,
      next:[...full?['the hold filled before the wrecks emptied; stow or sell, then salvage() again']:[],
        ...hull?['a wreck with nothing in it is a hull: tow it to a salvage yard, or scrap it']:[]]};
  }));

/** Loot every wreck here (`salvage/wrecks` then `salvage/loot`), modules first, then cargo,
 * until the hold is full. Your own wreck (`victim_id` is you) is looted first. `tow: '<wreck
 * id>'` attaches a tow line to that wreck instead of looting it — a tow costs the speed the
 * way home needs, so it is asked for by name and never chosen here; selling or scrapping the
 * tow is the market's, not this function's. Idempotent: no wreck, or nothing that fits, is
 * `done` with an empty list. Each wreck's line, and `did`, say what stayed behind and why: the hold
 * was full, the game refused (with its code), or the wreck was only a hull. Trains salvaging.
 * Costs nothing; a wreck in police-0 space is the risk `scout` reports. */
export function salvage(opts:{tow?:string}={}):Promise<Outcome<Salvaged>> {return edge(salvageEffect(opts));}
