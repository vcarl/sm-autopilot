/** The hangar: modules on the ship you fly, and the next hull. */
import type {BrowseShipsResponse,BuyListedShipResponse,CommissionQuoteResponse,CommissionShipResponse,InsurancePolicy,InspectResponse,ListShipsResponse,Module,ShipClass,ShipListing,SwitchShipResponse,V2Module,V2Ship} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {acct,admit,command,job,pilot,step} from './runtime.ts';
import {withdraw} from './storage.ts';
import type {Outcome} from './types.ts';

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
export interface Bench {ship:V2Ship;fitted:V2Module[];cpu:number;power:number}

/** The bench as the ship stands right now. */
export function bench():Bench {
  const ship=acct().state.ship as V2Ship,fitted=(acct().state.modules??[]) as V2Module[];
  return {ship,fitted:[...fitted],cpu:ship?.cpu_used??0,power:ship?.power_used??0};
}

const slotCap=(ship:V2Ship,slot:string):number|undefined=>
  ({utility:ship?.utility_slots,weapon:ship?.weapon_slots,defense:ship?.defense_slots} as Record<string,number|undefined>)[slot];
const names=(rows:V2Module[])=>rows.map(row=>row.type_id).join(', ')||'nothing';

/** What the catalog says fitting this module costs: the slot kind it takes and its grid
 * draw (`spacemolt/inspect`, which answers `kind: 'module'` only for a module). `null` for
 * anything that is not a module, which is how `buy` tells ore from a cargo expander. */
export async function moduleSpec(typeId:string):Promise<Module|null> {
  const reply=details(await command('spacemolt/inspect',{id:typeId})) as InspectResponse;
  const entry=reply.kind==='module'?reply.catalog?.items?.[0]:undefined;
  return entry&&'cpu_usage' in entry&&'slot' in entry?entry as Module:null;
}

/** Why one more module of this spec would not fit the bench, naming the fix; `null` when it
 * fits. The one check `refit` and `buy` share: a module that could not be fitted is refused
 * at the counter, not discovered after 2,080 cr have left the wallet. */
export function whyNotFit(spec:Module,at:Bench):string|null {
  const cap=slotCap(at.ship,spec.slot),inSlot=at.fitted.filter(row=>row.slot===spec.slot);
  if(cap!==undefined&&inSlot.length>=cap)
    return `no free ${spec.slot} slot: ${inSlot.length} of ${cap} fitted; remove one of ${names(inSlot)} first`;
  if(at.cpu+spec.cpu_usage>at.ship.cpu_capacity)
    return `cpu ${at.cpu}+${spec.cpu_usage} over capacity ${at.ship.cpu_capacity}; remove one of ${names(at.fitted)} first`;
  if(at.power+spec.power_usage>at.ship.power_capacity)
    return `power ${at.power}+${spec.power_usage} over capacity ${at.ship.power_capacity}; remove one of ${names(at.fitted)} first`;
  return null;
}

/** The grid line every refit ends with, and `buy` suggests. */
export function room(ship:V2Ship):string {
  const free=(['utility','weapon','defense'] as const).map(slot=>
    `${(slotCap(ship,slot)??0)-((acct().state.modules??[]) as V2Module[]).filter(row=>row.slot===slot).length} ${slot}`);
  return `cpu ${ship.cpu_used}/${ship.cpu_capacity}, power ${ship.power_used}/${ship.power_capacity}; free slots: ${free.join(', ')}`;
}

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
  const install=change.install??[],remove=change.remove??[];
  return job<Fit>('refit',[...remove.map(id=>`-${id}`),...install.map(id=>`+${id}`)].join(' '),async()=>{
    const grid=():Fit['ship']=>{
      const s=(acct().state.ship??{}) as V2Ship;
      return {cpu_used:s.cpu_used,cpu_capacity:s.cpu_capacity,power_used:s.power_used,power_capacity:s.power_capacity,
        utility_slots:s.utility_slots,weapon_slots:s.weapon_slots,defense_slots:s.defense_slots};
    };
    const nothing=(short:Fit['short']=[]):Fit=>({installed:[],removed:[],
      modules:(acct().state.modules??[]) as V2Module[],ship:grid(),short});
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
    const on:{id:string;spec:Module}[]=[],alreadyOn:string[]=[],short:Fit['short']=[];
    for(const id of install) {
      if(at.fitted.some(module=>module.module_id===id)){alreadyOn.push(id);continue;}
      const spec=await moduleSpec(id);
      if(!spec){short.push({id,why:'no module by that id in the catalog'});continue;}
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
      await withdraw([{item_id:row.id,quantity:1}]);
      if(!held(row.id))short.push({id:row.id,why:'not in the hold or this base\'s store; buy one first'});
    }
    if(short.length)return no(short.map(row=>`${row.id}: ${row.why}`).join('; '),short);

    for(const row of off) {
      await command('spacemolt/uninstall_mod',{id:row.module_id});
      step(`uninstall ${row.type_id}`);
    }
    for(const row of on) {
      await command('spacemolt/install_mod',{id:row.id});
      step(`install ${row.id} (${row.spec.slot}, cpu ${row.spec.cpu_usage}, power ${row.spec.power_usage})`);
    }
    await acct().refresh();
    const said=[off.length?`removed ${off.map(row=>row.type_id).join(', ')}`:'',
      on.length?`installed ${on.map(row=>row.id).join(', ')}`:'',
      alreadyOn.length?`already fitted: ${alreadyOn.join(', ')}`:'',
      alreadyOff.length?`already unfitted: ${alreadyOff.join(', ')}`:''].filter(Boolean).join('; ');
    return {status:'done',did:said||'the fit already held',
      detail:{installed:on.map(row=>row.id),removed:off.map(row=>row.type_id),
        modules:(acct().state.modules??[]) as V2Module[],ship:grid(),short:[]},
      next:[room(acct().state.ship as V2Ship)]};
  });
}

/** A player listing or a yard commission, each beside the class it is and one line on how
 * it compares with the hull you fly ("cargo +110, speed -1, minimum_crew 1"). */
export type ForSale=
  |{kind:'listing';listing:ShipListing;class:ShipClass;versus:string}
  |{kind:'commission';quote:CommissionQuoteResponse;class:ShipClass;versus:string};

/** The catalog entry for a ship class (`spacemolt/inspect`), or nothing when the catalogue cannot
 * answer for it.
 *
 * A yard lists hulls whose class its own catalogue rejects: live 2026-09-26, `browse_ships` handed us
 * `class_id: 'rubble'` and `inspect` answered `Ship class "rubble" not found.` three times in one
 * turn. That is the game being inconsistent with itself, and it used to throw straight out through
 * `shipsForSale()` and end the run `failed` — at the same yard, every turn. A hull we cannot read is
 * a hull we cannot compare, so it is left off the board; the listings we CAN read are still worth
 * having, which is why this skips rather than propagates. */
async function shipClass(id:string):Promise<ShipClass|undefined> {
  try {
    const entry=(details(await command('spacemolt/inspect',{id})) as InspectResponse).catalog?.items?.[0];
    return entry&&'class' in entry?entry as ShipClass:undefined;
  } catch(error) {
    step(`${id}: no catalogue entry (${error instanceof Error?error.message:String(error)}); listing skipped`);
    return undefined;
  }
}

/** The difference against the hull you fly, in the fields that decide a trip. */
function versus(klass:ShipClass,ship:V2Ship):string {
  const gap=(label:string,now:number|undefined,then:number|undefined)=>
    then===undefined||now===undefined?'':`${label} ${then-now>=0?'+':''}${then-now}`;
  return [gap('cargo',ship?.cargo_capacity,klass.cargo_capacity),gap('speed',ship?.speed,klass.base_speed),
    gap('fuel',ship?.max_fuel,klass.base_fuel),gap('utility',ship?.utility_slots,klass.utility_slots),
    gap('weapon',ship?.weapon_slots,klass.weapon_slots),gap('defense',ship?.defense_slots,klass.defense_slots),
    klass.minimum_crew?`minimum_crew ${klass.minimum_crew}`:''].filter(Boolean).join(', ');
}

/** Whether this base has the named service. */
async function serves(service:string):Promise<boolean> {
  const base=details(await command('spacemolt/get_base',{}));
  return (Array.isArray(base.services)?base.services:[]).map(String).includes(service);
}

/** A quote is one command each: the classes worth asking about are capped. */
const QUOTES=5;

/** Hulls for sale within a budget, here or at a named base: `ship/browse_ships` listings and
 * `ship/commission_quote` for the classes this yard can build (the ones a listing names,
 * plus `classId` when you pass one — the lib has no way to enumerate a yard's catalogue).
 * Budget defaults to credits minus `permissions.credit_reserve`. Sorted by
 * `cargo_capacity`, then price, because cargo multiplies every loop. Reads only. Flags crew
 * traps: a class whose `minimum_crew` exceeds your crew capacity is listed with a warning in
 * `versus`, not hidden. */
export function shipsForSale(opts:{budget?:number;baseId?:string;classId?:string}={}):Promise<Outcome<{for_sale:ForSale[]}>> {
  return job<{for_sale:ForSale[]}>('shipsForSale',[opts.classId,opts.baseId].filter(Boolean).join(' '),async()=>{
    const ship=acct().state.ship as V2Ship,who=pilot();
    const credits=acct().state.player?.credits??0,reserve=who.permissions?.credit_reserve??0;
    const budget=opts.budget??credits-reserve;
    if(!(budget>0))return {status:'refused',did:'listed no hulls',
      why:`budget ${budget}: credits ${credits} less reserve ${reserve}`,detail:{for_sale:[]}};
    const browsed=details(await command('spacemolt_ship/browse_ships',
      {...opts.baseId?{base_id:opts.baseId}:{},...opts.classId?{class_id:opts.classId}:{},max_price:budget})) as BrowseShipsResponse;
    const classes=new Map<string,ShipClass>();
    const load=async(id:string)=>{
      if(!classes.has(id)){const klass=await shipClass(id);if(klass)classes.set(id,klass);}
      return classes.get(id);
    };
    const for_sale:ForSale[]=[];
    for(const listing of (browsed.listings??[]).filter(row=>row.price<=budget)) {
      const klass=await load(listing.class_id);
      if(klass)for_sale.push({kind:'listing',listing,class:klass,versus:versus(klass,ship)});
    }
    // A yard quote is only answerable at the yard you are docked at.
    if(!opts.baseId&&await serves('shipyard'))
      for(const id of [...new Set([opts.classId,...classes.keys()].filter(Boolean) as string[])].slice(0,QUOTES)) {
        const quote=details(await command('spacemolt_ship/commission_quote',{id})) as CommissionQuoteResponse;
        if(!quote.can_commission||quote.credits_only_total>budget)continue;
        const klass=await load(id);
        if(klass)for_sale.push({kind:'commission',quote,class:klass,versus:versus(klass,ship)});
      }
    const cargo=(row:ForSale)=>row.class.cargo_capacity??0;
    const price=(row:ForSale)=>row.kind==='listing'?row.listing.price:row.quote.credits_only_total;
    for_sale.sort((a,b)=>cargo(b)-cargo(a)||price(a)-price(b));
    const best=for_sale[0];
    return {status:'done',
      did:`${for_sale.length} hull(s) at or under ${budget} cr; you fly a ${ship?.class_name} with ${ship?.cargo_capacity} cargo`,
      detail:{for_sale},
      next:best?[`${best.kind==='listing'?best.listing.listing_id:best.class.id}: ${best.class.name} ${price(best)} cr, ${best.versus}`,
        best.kind==='commission'?'a commission is buyShip(classId, {commission:true})':'buyShip(listingId)']:[]};
  });
}

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
  return job<Purchase>('buyShip',`${id}${opts.commission?' (commission)':''}`,async()=>{
    const flying=()=>(acct().state.ship??{}) as V2Ship;
    const previous={ship_id:flying().id??'',base_id:acct().state.location?.docked_at??''};
    const nothing=():Purchase=>({ship:flying(),price:0,switched:false,previous});
    const no=(why:string)=>({status:'refused' as const,did:`did not buy ${id}`,why,detail:nothing()});
    const blocked=await admit('buyShip');
    if(blocked)return no(blocked);
    if(!previous.base_id)return no('not docked; a hull changes hands at a station');

    const who=pilot(),credits=acct().state.player?.credits??0;
    const reserve=who.permissions?.credit_reserve??0;
    let price:number,quote:CommissionQuoteResponse|undefined;
    if(opts.commission) {
      quote=details(await command('spacemolt_ship/commission_quote',{id})) as CommissionQuoteResponse;
      if(!quote.can_commission)
        return no(`this yard will not build ${id}: ${(quote.blockers??[]).join('; ')||quote.message}`);
      price=quote.credits_only_total;
    } else {
      const browsed=details(await command('spacemolt_ship/browse_ships',{})) as BrowseShipsResponse;
      const listing=(browsed.listings??[]).find(row=>row.listing_id===id||row.ship_id===id);
      if(!listing)return no(`no listing ${id} at ${previous.base_id}; shipsForSale() names what is here`);
      price=listing.price;
    }
    if(credits-price<reserve)
      return no(`costs ${price}; credits ${credits} less reserve ${reserve} leaves ${credits-reserve}`);

    let bought:string,sourcing='';
    if(opts.commission) {
      const built=details(await command('spacemolt_ship/commission_ship',{id})) as CommissionShipResponse;
      step(`commission ${id} for ${built.credits_paid??price} cr (${built.status})`);
      if(built.status!=='complete') {
        const missing=(built.materials_to_source??[]).map(row=>`${row.quantity} ${row.item_id}`).join(', ');
        return {status:'partial',did:`commissioned ${id} for ${built.credits_paid??price} cr`,
          why:`build is ${built.status}${missing?`; still sourcing ${missing}`:''}`,
          detail:{...nothing(),price:built.credits_paid??price},
          // `ships()` is not built yet (fleet/fleet.ts throws), so the raw command is what can
          // actually be run. A hint naming an unbuilt function costs a juncture to discover.
          next:['account().commands.spacemolt_ship.list_ships() says when the hull is delivered']};
      }
      bought='';
    } else {
      const fill=details(await command('spacemolt_ship/buy_listed_ship',{id})) as BuyListedShipResponse;
      bought=fill.ship_id;
      step(`bought ${fill.class_id} for ${fill.price??price} cr`);
      price=fill.price??price;
    }

    // The fleet list is the evidence the hull is ours, whatever the reply claimed.
    await acct().refresh();
    const fleet=details(await command('spacemolt_ship/list_ships',{})) as ListShipsResponse;
    const mine=(fleet.ships??[]).find(row=>row.ship_id===bought)
      ??(fleet.ships??[]).find(row=>row.ship_id!==previous.ship_id&&!row.is_active);
    if(!mine)return {status:'failed',did:`paid ${price} cr for ${id}`,
      why:'list_ships does not show the new hull; re-observe before buying again',detail:{...nothing(),price}};

    let switched=false;
    if(opts.switchTo) {
      if(!await serves('shipyard'))
        return {status:'partial',did:`bought ${mine.class_id} for ${price} cr`,
          why:`${previous.base_id} has no shipyard: the switch needs one`,
          detail:{ship:flying(),price,switched,previous},
          next:[`goTo a base with a shipyard, then `+`account().commands.spacemolt_ship.switch_ship({id:'${mine.ship_id}'}) — switchShip is not built yet`]};
      const swap=details(await command('spacemolt_ship/switch_ship',{id:mine.ship_id})) as SwitchShipResponse;
      switched=swap.active_ship_id===mine.ship_id;
      step(`switch to ${swap.active_ship_class}${swap.cargo_note?`; ${swap.cargo_note}`:''}`);
      await acct().refresh();
    }
    return {status:'done',
      did:`bought ${mine.class_name??mine.class_id} for ${price} cr${switched?' and switched to it':''}`,
      detail:{ship:flying(),price,switched,previous,...quote?{}:{}},
      next:[switched?room(flying())
        :`account().commands.spacemolt_ship.switch_ship({id:'${mine.ship_id}'}) to fly it — switchShip is not built yet`,
        // `refit()` does not compile: the change argument is required, and it moves nothing by
        // itself — each module is named, one id at a time.
        `refit({install:['<module type_id from the hold>']}) moves a module across, one id at a time`]};
  });
}
