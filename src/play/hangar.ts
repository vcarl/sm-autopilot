/** The hangar: modules on the ship you fly, and the next hull. */
import type {CommissionQuoteResponse,InsurancePolicy,OwnedShipInfo,ShipClass,ShipListing,V2Module,V2Ship} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import * as Wire from '../wire.gen.ts';
import {Game,field,reread,type GameError} from './game.ts';
import {acct,admit,edge,jobEffect,pilot,step} from './runtime.ts';
import {withdrawEffect} from './storage.ts';
import type {Outcome} from './types.ts';
import {replyBody} from '../storage.ts';

export interface Fit {
  installed:string[];removed:string[];
  /** The fitted modules after the change. */
  modules:V2Module[];
  /** The grid after the change: `cpu_used/cpu_capacity`, `power_used/power_capacity`. */
  ship:Pick<V2Ship,'cpu_used'|'cpu_capacity'|'power_used'|'power_capacity'|'utility_slots'|'weapon_slots'|'defense_slots'>;
  /** Module ids that would not fit and why. */
  short:{id:string;why:string}[];
}

/** The grid a change is measured against: the hull, the modules on it, and the draw so far.
 * A simulated remove takes a module off this copy, which is how the slot a later install
 * needs is known to be free before anything is sent. */
export interface Bench {ship:V2Ship|undefined;fitted:V2Module[];cpu:number;power:number}

/** The bench as the ship stands right now. */
export function bench():Bench {
  const {ship,modules=[]}=acct().state;
  return {ship,fitted:[...modules],cpu:ship?.cpu_used??0,power:ship?.power_used??0};
}

const slotCap=(ship:V2Ship|undefined,slot:string):number|undefined=>
  slot==='utility'?ship?.utility_slots:slot==='weapon'?ship?.weapon_slots:slot==='defense'?ship?.defense_slots:undefined;
const names=(rows:V2Module[])=>rows.map(row=>row.type_id).join(', ')||'nothing';

/** What this reads of the catalog's answer to `inspect`: what kind of thing it is, and its entries as
 * they come (each is decoded against the kind it should be, because the spec's entry union is `oneOf`). */
const decodeInspect=Schema.decodeUnknownOption(Wire.InspectResponse.mapFields(fields=>({kind:fields.kind,
  catalog:Schema.optionalKey(Schema.NullOr(Schema.Struct({items:Schema.Array(Schema.Unknown)})))})));
const firstEntry=(reply:unknown)=>{const read=decodeInspect(replyBody(reply));return Option.isSome(read)?{kind:read.value.kind,entry:read.value.catalog?.items[0]}:{kind:undefined,entry:undefined};};
/** The slot kind a module takes and its grid draw: all `refit` and `buy` need to know of it. */
const ModuleSpec=Wire.Module.mapFields(Struct.pick(['name','slot','type','cpu_usage','power_usage','size']));
export type ModuleSpec=typeof ModuleSpec.Type;
const decodeSpec=Schema.decodeUnknownOption(ModuleSpec);
/** What is read of a hull class: the fields `versus`, the menu and the board name. The spec's other fields are not required of it:
 * the live server leaves some out. The surface still hands the pilot the raw entry. */
const ClassRead=Wire.ShipClass.schema.mapFields(Struct.pick(['id','name','cargo_capacity','base_speed','base_fuel','utility_slots','weapon_slots',
  'defense_slots','minimum_crew','piloting_required']));
const decodeClass=Schema.decodeUnknownOption(ClassRead);

/** What the catalog says fitting this module costs: the slot kind it takes and its grid
 * draw (`spacemolt/inspect`, which answers `kind: 'module'` only for a module). `null` for
 * anything that is not a module, which is how `buy` tells ore from a cargo expander.
 * `undefined` when the answer was there but not readable: said in a step, and not the same as
 * "not a module". */
export const moduleSpecEffect=(typeId:string)=>Effect.gen(function*() {
  const {kind,entry}=firstEntry(yield* (yield* Game).command('spacemolt/inspect',{id:typeId}));
  if(kind!==undefined&&kind!=='module')return null;
  const spec=kind==='module'?decodeSpec(entry):Option.none();
  if(Option.isSome(spec))return spec.value;
  step(`spacemolt/inspect: the catalog's answer for ${typeId} did not read as a module`);
  return undefined;
});


/** Why one more module of this spec would not fit the bench, naming the fix; `null` when it
 * fits. The one check `refit` and `buy` share: a module that could not be fitted is refused
 * at the counter, not discovered after 2,080 cr have left the wallet. */
export function whyNotFit(spec:ModuleSpec,at:Bench):string|null {
  const {ship}=at,cap=slotCap(ship,spec.slot),inSlot=at.fitted.filter(row=>row.slot===spec.slot);
  if(cap!==undefined&&inSlot.length>=cap)
    return `no free ${spec.slot} slot: ${inSlot.length} of ${cap} fitted; remove one of ${names(inSlot)} first`;
  if(ship&&at.cpu+spec.cpu_usage>ship.cpu_capacity)
    return `cpu ${at.cpu}+${spec.cpu_usage} over capacity ${ship.cpu_capacity}; remove one of ${names(at.fitted)} first`;
  if(ship&&at.power+spec.power_usage>ship.power_capacity)
    return `power ${at.power}+${spec.power_usage} over capacity ${ship.power_capacity}; remove one of ${names(at.fitted)} first`;
  return null;
}

/** The grid line every refit ends with, and `buy` suggests. */
export function room(ship:V2Ship|undefined):string {
  if(!ship)return 'no ship read';
  const fitted=acct().state.modules??[];
  const free=(['utility','weapon','defense'] as const).map(slot=>
    `${(slotCap(ship,slot)??0)-fitted.filter(row=>row.slot===slot).length} ${slot}`);
  return `cpu ${ship.cpu_used}/${ship.cpu_capacity}, power ${ship.power_used}/${ship.power_capacity}; free slots: ${free.join(', ')}`;
}

/** A refusal or a lost reply as the pilot reads it: the action and the server's code, or that the reply is gone. */
const told=(error:GameError)=>error._tag==='ReplyLost'?`reply lost on ${error.action}`:`${error.action}: ${error.code} — ${error.message}`;

/** Install and/or remove modules while docked. Ids are `module_id`s or `type_id`s from the
 * hold or this base's store (a stored module is withdrawn first). Removes go before
 * installs, because a remove is what frees the slot. Every install is checked against the
 * slot count, the CPU and the power the change leaves BEFORE anything is sent, so an
 * unfittable one is `refused` with the exact reason and the fix and the ship untouched.
 * An id that is a fitted `module_id`, or names nothing fitted to remove, is `done` with
 * nothing sent; a `type_id` you already fly one of is a second copy, and the grid decides
 * whether there is room for it. Removed modules go to
 * the hold, or the store when the hold is full. Costs nothing. Fitting to 90%+
 * `power_used/power_capacity` trains engineering passively; `next` says how far under the
 * grid you are. */
export function refit(change:{install?:string[];remove?:string[]}):Promise<Outcome<Fit>> {
  return edge(refitEffect(change));
}

/** `refit` as an Effect, for `edge` and for converted callers; never in a barrel. A mutation the
 * game refuses or loses ends the flight, naming the action and the code; none is ever re-sent. */
export const refitEffect=(change:{install?:string[];remove?:string[]})=>{
  const install=change.install??[],remove=change.remove??[];
  return jobEffect('refit',[...remove.map(id=>`-${id}`),...install.map(id=>`+${id}`)].join(' '),Effect.gen(function*() {
    const game=yield* Game;
    const grid=():Fit['ship']=>{
      const s=acct().state.ship;
      return {cpu_used:s?.cpu_used??0,cpu_capacity:s?.cpu_capacity??0,power_used:s?.power_used??0,power_capacity:s?.power_capacity??0,
        utility_slots:s?.utility_slots??0,weapon_slots:s?.weapon_slots??0,defense_slots:s?.defense_slots??0};
    };
    const nothing=(short:Fit['short']=[]):Fit=>({installed:[],removed:[],modules:acct().state.modules??[],ship:grid(),short});
    const no=(why:string,short:Fit['short']=[])=>
      ({status:'refused' as const,did:'refitted nothing',why,detail:nothing(short)});
    if(!acct().state.location?.docked_at)return no('refit needs a docked ship: modules come off at a station');
    if(!install.length&&!remove.length)return no('name modules to install or remove');

    // The whole change is simulated first: removes off the bench, then installs onto what is
    // left. One install that cannot fit refuses the lot, with nothing sent.
    const at=bench(),off:V2Module[]=[],alreadyOff:string[]=[];
    for(const id of remove) {
      const row=at.fitted.find(module=>module.module_id===id||module.type_id===id);
      if(!row){alreadyOff.push(id);continue;}
      at.fitted.splice(at.fitted.indexOf(row),1);
      at.cpu-=row.cpu_usage;at.power-=row.power_usage;
      off.push(row);
    }
    const on:{id:string;spec:ModuleSpec}[]=[],alreadyOn:string[]=[],short:Fit['short']=[];
    for(const id of install) {
      if(at.fitted.some(module=>module.module_id===id)){alreadyOn.push(id);continue;}
      const spec=yield* moduleSpecEffect(id);
      if(!spec){short.push({id,why:spec===null?'no module by that id in the catalog':'the catalog entry for it was unreadable'});continue;}
      const why=whyNotFit(spec,at);
      if(why){short.push({id,why});continue;}
      at.fitted.push({module_id:id,type_id:id,name:spec.name,slot:spec.slot,type:spec.type,
        cpu_usage:spec.cpu_usage,power_usage:spec.power_usage,size:spec.size});
      at.cpu+=spec.cpu_usage;at.power+=spec.power_usage;
      on.push({id,spec});
    }
    if(short.length)return no(short.map(row=>`${row.id}: ${row.why}`).join('; '),short);

    // The module has to be aboard. A stored one is withdrawn; one that is nowhere is refused.
    const held=(id:string)=>(acct().state.cargo??[]).some(row=>row.item_id===id&&row.quantity>0);
    for(const row of on) {
      if(held(row.id))continue;
      yield* withdrawEffect([{item_id:row.id,quantity:1}]);
      if(!held(row.id))short.push({id:row.id,why:'not in the hold or this base\'s store; buy one first'});
    }
    if(short.length)return no(short.map(row=>`${row.id}: ${row.why}`).join('; '),short);

    for(const row of off) {
      yield* game.command('spacemolt/uninstall_mod',{id:row.module_id});
      step(`uninstall ${row.type_id}`);
    }
    for(const row of on) {
      yield* game.command('spacemolt/install_mod',{id:row.id});
      step(`install ${row.id} (${row.spec.slot}, cpu ${row.spec.cpu_usage}, power ${row.spec.power_usage})`);
    }
    yield* reread;
    const said=[off.length?`removed ${off.map(row=>row.type_id).join(', ')}`:'',
      on.length?`installed ${on.map(row=>row.id).join(', ')}`:'',
      alreadyOn.length?`already fitted: ${alreadyOn.join(', ')}`:'',
      alreadyOff.length?`already unfitted: ${alreadyOff.join(', ')}`:''].filter(Boolean).join('; ');
    return {status:'done' as const,did:said||'the fit already held',
      detail:{installed:on.map(row=>row.id),removed:off.map(row=>row.type_id),
        modules:acct().state.modules??[],ship:grid(),short:[]},
      next:[room(acct().state.ship)]};
  }));
};

/** A player listing or a yard commission, each beside the class it is and one line on how
 * it compares with the hull you fly ("cargo +110, speed -1, minimum_crew 1"). */
export type ForSale=
  |{kind:'listing';listing:ShipListing;class:ShipClass;versus:string}
  |{kind:'commission';quote:CommissionQuoteResponse;class:ShipClass;versus:string};
/** A class the yard would not quote you, with the game's reason ("requires Piloting level 20"). */
export interface Locked {class_id:string;why:string}

/** Ship classes are catalogue data, so each is read once per process — a class the catalogue says
 * it has no entry for included (live 2026-09-28: `inspect rubble` on every menu render). Any other
 * failure is not remembered. The game sends no code for it that this repo has seen, so the refusal
 * is read by its message ("Ship class X not found"), as it always was. */
const classes=new Map<string,ShipClass|undefined>();
export const catalogClassEffect=(id:string)=>Effect.gen(function*() {
  if(classes.has(id))return classes.get(id);
  const reply=yield* (yield* Game).command('spacemolt/inspect',{id}).pipe(
    Effect.catchTag('Rejected',refused=>{
      if(/not found/i.test(refused.message))classes.set(id,undefined);
      return Effect.fail(refused);
    }));
  const {kind,entry}=firstEntry(reply);
  // A catalogue answer that is some other kind of thing is definitive and remembered, as before; one that
  // did not read is said and not remembered.
  if(kind!==undefined&&kind!=='ship_class'){classes.set(id,undefined);return undefined;}
  if(kind===undefined||Option.isNone(decodeClass(entry))){step(`spacemolt/inspect: the catalog's answer for ${id} did not read as a ship class`);return undefined;}
  // The surface's ShipClass is the lib's full type; the entry is passed as the game sent it.
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const klass=entry as ShipClass; // cast: frozen surface (ShipClass)
  classes.set(id,klass);
  return klass;
});

/** The catalog entry for a ship class (`spacemolt/inspect`), or nothing when the catalogue cannot
 * answer for it.
 *
 * A yard lists hulls whose class its own catalogue rejects: live 2026-09-26, `browse_ships` handed us
 * `class_id: 'rubble'` and `inspect` answered `Ship class "rubble" not found.` three times in one
 * turn. That is the game being inconsistent with itself, and it used to throw straight out through
 * `shipsForSale()` and end the run `failed` — at the same yard, every turn. A hull we cannot read is
 * a hull we cannot compare, so it is left off the board; the listings we CAN read are still worth
 * having, which is why this skips rather than propagates. Only the game's own answers are skipped
 * (a refusal, a lost reply); a bug still goes up. */
const shipClass=(id:string)=>{
  const skip=(error:GameError)=>Effect.sync(()=>{step(`${id}: no catalogue entry (${told(error)}); listing skipped`);return undefined;});
  return catalogClassEffect(id).pipe(Effect.catchTags({Rejected:skip,InBattle:skip,ReplyLost:skip}));
};

/** The difference against the hull you fly, in the fields that decide a trip. */
function versus(klass:ShipClass,ship:V2Ship|undefined):string {
  const gap=(label:string,now:number|undefined,then:number|undefined)=>
    then===undefined||now===undefined?'':`${label} ${then-now>=0?'+':''}${then-now}`;
  return [gap('cargo',ship?.cargo_capacity,klass.cargo_capacity),gap('speed',ship?.speed,klass.base_speed),
    gap('fuel',ship?.max_fuel,klass.base_fuel),gap('utility',ship?.utility_slots,klass.utility_slots),
    gap('weapon',ship?.weapon_slots,klass.weapon_slots),gap('defense',ship?.defense_slots,klass.defense_slots),
    klass.minimum_crew?`minimum_crew ${klass.minimum_crew}`:''].filter(Boolean).join(', ');
}

const decodeServices=Schema.decodeUnknownOption(Wire.GetBaseResponse.mapFields(Struct.pick(['services'])));
/** Whether this base has the named service; a reply that does not read is said, and the answer is no. */
const serves=(service:string)=>Effect.gen(function*() {
  const base=decodeServices(replyBody(yield* (yield* Game).command('spacemolt/get_base',{})));
  if(Option.isNone(base)){step(`spacemolt/get_base: the reply did not read; ${service} not known`);return false;}
  return base.value.services.includes(service);
});

/** The rows of a reply's list that decode, each beside the row as the game sent it. A row whose read fields do not
 * is left out and said in a step, naming the action and the row; a reply with no list is said too. */
const rowsOf=<A>(reply:unknown,action:string,key:string,decode:(row:unknown)=>Option.Option<A>):{raw:unknown;read:A}[]=>{
  const rows=field(replyBody(reply),key);
  if(!Array.isArray(rows)){step(`${action}: the reply has no ${key} list`);return [];}
  return rows.flatMap(raw=>{
    const read=decode(raw);
    if(Option.isSome(read))return [{raw,read:read.value}];
    step(`${action}: a ${key} row (${field(raw,'listing_id')??field(raw,'ship_id')??'no id'}) did not read; left out`);
    return [];
  });
};
/** What is read of a listing: its ids, its class and its price. The spec's other fields are not required of it. */
const decodeListed=Schema.decodeUnknownOption(Wire.ShipListing.mapFields(Struct.pick(['listing_id','ship_id','class_id','price'])));
const decodeOwned=Schema.decodeUnknownOption(Wire.OwnedShipInfo.mapFields(Struct.pick(['ship_id','class_id','class_name','is_active'])));
const decodeBuilt=Schema.decodeUnknownOption(Wire.CommissionShipResponse.mapFields(fields=>({status:fields.status,
  credits_paid:Schema.optionalKey(fields.credits_paid),materials_to_source:fields.materials_to_source})));
const decodeBought=Schema.decodeUnknownOption(Wire.BuyListedShipResponse.mapFields(fields=>({ship_id:fields.ship_id,
  class_id:Schema.optionalKey(fields.class_id),price:Schema.optionalKey(fields.price)})));
const decodeSwitched=Schema.decodeUnknownOption(Wire.SwitchShipResponse.mapFields(fields=>({active_ship_id:fields.active_ship_id,
  active_ship_class:Schema.optionalKey(fields.active_ship_class),cargo_note:fields.cargo_note})));
const decodeCan=Schema.decodeUnknownOption(Wire.CommissionQuoteResponse.mapFields(fields=>({can_commission:fields.can_commission,
  credits_only_total:fields.credits_only_total,blockers:fields.blockers,message:Schema.optionalKey(fields.message)})));

/** A quote is one command each: the classes worth asking about are capped. */
const QUOTES=5;

/** Hulls for sale within a budget, here or at a named base: `ship/browse_ships` listings and
 * `ship/commission_quote` for the classes this yard can build (the ones a listing names,
 * plus `classId` when you pass one — the lib has no way to enumerate a yard's catalogue).
 * Budget defaults to credits minus `permissions.credit_reserve`. Sorted by
 * `cargo_capacity`, then price, because cargo multiplies every loop. Reads only. Flags crew
 * traps: a class whose `minimum_crew` exceeds your crew capacity is listed with a warning in
 * `versus`, not hidden. */
export function shipsForSale(opts:{budget?:number;baseId?:string;classId?:string}={}):Promise<Outcome<{for_sale:ForSale[];locked:Locked[]}>> {
  return edge(shipsForSaleEffect(opts));
}

/** `shipsForSale` as an Effect, for `edge` and for converted callers; never in a barrel. */
export const shipsForSaleEffect=(opts:{budget?:number;baseId?:string;classId?:string}={})=>
  jobEffect('shipsForSale',[opts.classId,opts.baseId].filter(Boolean).join(' '),Effect.gen(function*() {
    const game=yield* Game;
    const ship=acct().state.ship,who=pilot();
    const credits=acct().state.player?.credits??0,reserve=who.permissions?.credit_reserve??0;
    const budget=opts.budget??credits-reserve;
    const locked:Locked[]=[];
    const for_sale:ForSale[]=[];
    if(!(budget>0))return {status:'refused' as const,did:'listed no hulls',
      why:`budget ${budget}: credits ${credits} less reserve ${reserve}`,detail:{for_sale,locked}};
    // Live 2026-09-30 (kvothe 13:06Z): undocked, browse_ships answered "Specify a base_id or dock at a
    // station" and the whole read broke.
    if(!opts.baseId&&!acct().state.location?.docked_at)return {status:'refused' as const,did:'listed no hulls',
      why:'not docked: listings are read at a base; dock, or name one with shipsForSale({baseId})',detail:{for_sale,locked}};
    const browsed=yield* game.command('spacemolt_ship/browse_ships',
      {...opts.baseId?{base_id:opts.baseId}:{},...opts.classId?{class_id:opts.classId}:{},max_price:budget});
    const known=new Map<string,ShipClass>();
    const load=(id:string)=>Effect.gen(function*() {
      if(!known.has(id)){const klass=yield* shipClass(id);if(klass)known.set(id,klass);}
      return known.get(id);
    });
    for(const {raw,read} of rowsOf(browsed,'spacemolt_ship/browse_ships','listings',decodeListed).filter(row=>row.read.price<=budget)) {
      const klass=yield* load(read.class_id);
      // ForSale.listing is the lib's full ShipListing; the row is passed as the game sent it.
      // oxlint-disable-next-line typescript/consistent-type-assertions
      if(klass)for_sale.push({kind:'listing',listing:raw as ShipListing,class:klass,versus:versus(klass,ship)}); // cast: frozen surface (ShipListing)
    }
    // A yard quote is only answerable at the yard you are docked at.
    if(!opts.baseId&&(yield* serves('shipyard')))
      for(const id of [...new Set([opts.classId,...known.keys()].flatMap(each=>each?[each]:[]))].slice(0,QUOTES)) {
        // Live 2026-09-30 (kvothe 13:10Z): one quote answered "Flying a Tier 3 ship requires Piloting
        // level 20 (you have 10)" and the throw took every listing with it. A class the game will not
        // quote is a row that says why; a lost reply is not a lock and still goes up.
        const tried=yield* Effect.result(game.command('spacemolt_ship/commission_quote',{id}));
        if(Result.isFailure(tried)) {
          if(tried.failure._tag==='ReplyLost')return yield* tried.failure;
          locked.push({class_id:id,why:told(tried.failure)});
          continue;
        }
        const reply=tried.success;
        const decoded=decodeCan(replyBody(reply));
        if(Option.isNone(decoded)){step(`spacemolt_ship/commission_quote: the quote for ${id} did not read; left out`);continue;}
        if(!decoded.value.can_commission||decoded.value.credits_only_total>budget)continue;
        const klass=yield* load(id);
        // ForSale.quote is the lib's full CommissionQuoteResponse; the reply is passed as the game sent it.
        // oxlint-disable-next-line typescript/consistent-type-assertions
        if(klass)for_sale.push({kind:'commission',quote:replyBody(reply) as CommissionQuoteResponse,class:klass,versus:versus(klass,ship)}); // cast: frozen surface (CommissionQuoteResponse)
      }
    const cargo=(row:ForSale)=>row.class.cargo_capacity??0;
    const price=(row:ForSale)=>row.kind==='listing'?row.listing.price:row.quote.credits_only_total;
    for_sale.sort((a,b)=>cargo(b)-cargo(a)||price(a)-price(b));
    const best=for_sale[0];
    return {status:'done' as const,
      did:`${for_sale.length} hull(s) at or under ${budget} cr; you fly a ${ship?.class_name} with ${ship?.cargo_capacity} cargo`
        +(locked.length?`; not offered to you: ${locked.map(row=>`${row.class_id} (${row.why})`).join(', ')}`:''),
      detail:{for_sale,locked},
      next:best?[`${best.kind==='listing'?best.listing.listing_id:best.class.id}: ${best.class.name} ${price(best)} cr, ${best.versus}`,
        best.kind==='commission'?'a commission is buyShip(classId, {commission:true})':'buyShip(listingId)']:[]};
  }));

/** One `switch_ship` sent, its answer read, the account re-read: true when `shipId` is flown after it.
 * The one place the hull is named on the wire. The lib types the param `{id}` (COMMANDS.md), but the
 * live server reads `ship_id`: kvothe's `{ship_id}` switched every time (2026-10-07 14:26Z, 2026-10-09
 * 00:34Z, 02:16Z, 02:43Z), and no `{id}` alone ever did — both 2026-09-30 sends answered `already_active`.
 * Both keys go, so a server that comes to read `id` still switches. Nothing is re-sent. */
const swap=(shipId:string,label:string)=>Effect.gen(function*() {
  const reply=yield* (yield* Game).command('spacemolt_ship/switch_ship',{ship_id:shipId,id:shipId});
  const decoded=decodeSwitched(replyBody(reply));
  yield* reread;
  if(Option.isSome(decoded)) {
    const swapped=decoded.value;
    step(`switch to ${swapped.active_ship_class??label}${swapped.cargo_note?`; ${swapped.cargo_note}`:''}`);
    return swapped.active_ship_id===shipId;
  }
  // The reply did not read: the refreshed state says which hull is flown, and nothing is re-sent.
  const switched=acct().state.ship?.id===shipId;
  step(`spacemolt_ship/switch_ship: the reply did not read; the account shows ${switched?'the new hull':'the old hull'} flown`);
  return switched;
});

export interface Swap {switched:boolean;ship:V2Ship}
/** `switchShip` as an Effect, for `edge`; never in a barrel. */
export const switchShipEffect=(shipId:string)=>jobEffect<Swap>('switchShip',shipId,Effect.gen(function*() {
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const flying=()=>acct().state.ship??({} as V2Ship); // cast: frozen surface (Swap.ship)
  const no=(why:string)=>({status:'refused' as const,did:`did not switch to ${shipId}`,why,detail:{switched:false,ship:flying()}});
  const blocked=yield* admit('switchShip');
  if(blocked)return no(blocked);
  if(acct().state.ship?.id===shipId)return {status:'done' as const,did:`already flying ${shipId}`,detail:{switched:true,ship:flying()}};
  const base=acct().state.location?.docked_at;
  if(!base)return no('not docked; a hull is switched at the station it is parked at');
  if(!(yield* serves('shipyard')))return no(`${base} has no shipyard: the switch needs one`);
  const switched=yield* swap(shipId,shipId);
  return {status:switched?'done' as const:'failed' as const,did:switched?`switched to ${flying().class_name??shipId}`:`sent a switch to ${shipId}`,
    ...switched?{}:{why:'the account still shows the old hull flown; ships() says where each is parked'},
    detail:{switched,ship:flying()},next:switched?[room(acct().state.ship)]:[]};
}));

/** `ships` as an Effect, for `edge`; never in a barrel. */
export const shipsEffect=()=>jobEffect<{ships:OwnedShipInfo[]}>('ships','',Effect.gen(function*() {
  // The read fields decoded, the row kept as the game sent it.
  // oxlint-disable-next-line typescript/consistent-type-assertions
  const ships=rowsOf(yield* (yield* Game).command('spacemolt_ship/list_ships',{}),'spacemolt_ship/list_ships','ships',decodeOwned).map(row=>row.raw as OwnedShipInfo); // cast: frozen surface (OwnedShipInfo)
  const parked=ships.filter(row=>!row.is_active);
  return {status:'done' as const,
    did:`flying ${ships.find(row=>row.is_active)?.class_id??'?'}; ${parked.length} parked${parked.length?`: ${parked.map(row=>`${row.class_id} ${row.ship_id} at ${row.location_base_id??row.location??'?'}`).join(', ')}`:''}`,
    detail:{ships},next:parked.length?['switchShip(ship_id) at the base it is parked at, with a shipyard']:[]};
}));

export interface Purchase {
  /** The hull you now fly, when the switch happened; otherwise the one you still fly. */
  ship:V2Ship;
  price:number;
  switched:boolean;
  /** The previous hull's id and where it is parked. */
  previous:{ship_id:string;base_id:string};
  policy?:InsurancePolicy;
}

/** Buy a listed hull (`listing_id`) or commission a class (`class_id` with `commission:true`)
 * and, with `switchTo` and a shipyard here, switch to it. Refused before anything is sent
 * when the price takes the wallet under `permissions.credit_reserve`, with the numbers. A commission that stalls in `sourcing` is
 * `partial` with `materials_to_source` named. Done when `list_ships` shows the new hull.
 * Costs the price; trains nothing. `next` says what is left to do on the new hull. */
export function buyShip(id:string,opts:{commission?:boolean;switchTo?:boolean}={}):Promise<Outcome<Purchase>> {
  return edge(buyShipEffect(id,opts));
}

/** `buyShip` as an Effect, for `edge` and for converted callers; never in a barrel. A mutation the
 * game refuses or loses ends the flight, naming the action and the code; none is ever re-sent. */
export const buyShipEffect=(id:string,opts:{commission?:boolean;switchTo?:boolean}={})=>
  jobEffect('buyShip',`${id}${opts.commission?' (commission)':''}`,Effect.gen(function*() {
    const game=yield* Game;
    // A hull not read yet is `{}`: the pilot-facing `Purchase.ship` promises a whole one.
    // oxlint-disable-next-line typescript/consistent-type-assertions
    const flying=()=>acct().state.ship??({} as V2Ship); // cast: frozen surface (Purchase.ship)
    const previous={ship_id:acct().state.ship?.id??'',base_id:acct().state.location?.docked_at??''};
    const nothing=():Purchase=>({ship:flying(),price:0,switched:false,previous});
    const no=(why:string)=>({status:'refused' as const,did:`did not buy ${id}`,why,detail:nothing()});
    const blocked=yield* admit('buyShip');
    if(blocked)return no(blocked);
    if(!previous.base_id)return no('not docked; a hull changes hands at a station');

    const who=pilot(),credits=acct().state.player?.credits??0;
    const reserve=who.permissions?.credit_reserve??0;
    let price:number;
    if(opts.commission) {
      const reply=yield* game.command('spacemolt_ship/commission_quote',{id});
      const decoded=decodeCan(replyBody(reply));
      if(Option.isNone(decoded))return no(`the commission_quote reply for ${id} was unreadable; nothing was bought`);
      const quote=decoded.value;
      if(!quote.can_commission)
        return no(`this yard will not build ${id}: ${(quote.blockers??[]).join('; ')||quote.message||'no reason given'}`);
      price=quote.credits_only_total;
    } else {
      const browsed=yield* game.command('spacemolt_ship/browse_ships',{});
      const listing=rowsOf(browsed,'spacemolt_ship/browse_ships','listings',decodeListed).find(row=>row.read.listing_id===id||row.read.ship_id===id)?.read;
      if(!listing)return no(`no listing ${id} at ${previous.base_id}; shipsForSale() names what is here`);
      price=listing.price;
    }
    if(credits-price<reserve)
      return no(`costs ${price}; credits ${credits} less reserve ${reserve} leaves ${credits-reserve}`);

    let bought:string;
    if(opts.commission) {
      const reply=yield* game.command('spacemolt_ship/commission_ship',{id});
      const decoded=decodeBuilt(replyBody(reply));
      // A reply that does not read is not guessed at and nothing is re-sent: it ends `partial` as any
      // build not yet delivered does, and says so; `list_ships` is what shows whether the hull came.
      if(Option.isNone(decoded)) {
        step(`spacemolt_ship/commission_ship: the reply for ${id} did not read`);
        return {status:'partial' as const,did:`commissioned ${id}; the quote said ${price} cr`,
          why:'the commission_ship reply was unreadable; the commission may have landed',
          detail:{...nothing(),price},
          next:['ships() says when the hull is delivered']};
      }
      const built=decoded.value,paid=built.credits_paid??price;
      step(`commission ${id} for ${paid} cr (${built.status})`);
      if(built.status!=='complete') {
        const missing=(built.materials_to_source??[]).map(row=>`${row.quantity} ${row.item_id}`).join(', ');
        return {status:'partial' as const,did:`commissioned ${id} for ${paid} cr`,
          why:`build is ${built.status}${missing?`; still sourcing ${missing}`:''}`,
          detail:{...nothing(),price:paid},
          next:['ships() says when the hull is delivered']};
      }
      bought='';
    } else {
      const reply=yield* game.command('spacemolt_ship/buy_listed_ship',{id});
      const decoded=decodeBought(replyBody(reply));
      // The fleet list below is the evidence; a reply that did not read only means no ship id to look for.
      if(Option.isNone(decoded))step(`spacemolt_ship/buy_listed_ship: the reply for ${id} did not read; the fleet list will show it`);
      const fill=Option.isSome(decoded)?decoded.value:undefined;
      bought=fill?.ship_id??'';
      if(fill)step(`bought ${fill.class_id??id} for ${fill.price??price} cr`);
      price=fill?.price??price;
    }

    // The fleet list is the evidence the hull is ours, whatever the reply claimed.
    yield* reread;
    const fleet=rowsOf(yield* game.command('spacemolt_ship/list_ships',{}),'spacemolt_ship/list_ships','ships',decodeOwned).map(row=>row.read);
    const others=fleet.filter(row=>row.ship_id!==previous.ship_id);
    const mine=others.find(row=>row.ship_id===bought)??others.find(row=>row.is_active)??others.find(row=>!row.is_active);
    if(!mine)return {status:'failed' as const,did:`paid ${price} cr for ${id}`,
      why:'list_ships does not show the new hull; re-observe before buying again',detail:{...nothing(),price}};

    // Live 2026-09-30 (kvothe 13:34Z, 19:08Z): buy_listed_ship makes the new hull the active one, so
    // switch_ship answered `already_active` and the call read "buyShip broke, nothing gained" over
    // 21k and 18k spent. The fleet list says which hull is flown; only one not yet flown is switched to.
    let switched=Boolean(mine.is_active);
    if(opts.switchTo&&!switched) {
      if(!(yield* serves('shipyard')))
        return {status:'partial' as const,did:`bought ${mine.class_id} for ${price} cr`,
          why:`${previous.base_id} has no shipyard: the switch needs one`,
          detail:{ship:flying(),price,switched,previous},
          next:[`goTo a base with a shipyard, then switchShip('${mine.ship_id}')`]};
      switched=yield* swap(mine.ship_id,mine.class_id);
    }
    return {status:'done' as const,
      did:`bought ${mine.class_name??mine.class_id} for ${price} cr${switched?' and switched to it':''}`,
      detail:{ship:flying(),price,switched,previous},
      next:[switched?room(acct().state.ship)
        :`switchShip('${mine.ship_id}') to fly it`,
        // `refit()` does not compile: the change argument is required, and it moves nothing by
        // itself — each module is named, one id at a time.
        `refit({install:['<module type_id from the hold>']}) moves a module across, one id at a time`]};
  }));
