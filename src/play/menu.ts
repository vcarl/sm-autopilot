/** The menu: anti-stagnation guidance, not a list of admissible jobs. Every move is a real
 * library call with literal arguments taken from the present, passed through the same rules
 * the helper applies (`jobStop`, the mood's margins, permissions, Tired); a move the rules
 * refuse is under `not_now` with the reason. The juncture delivers it once, headed by the
 * stagnation `menuDue` names. Reads only; writes nothing (DESIGN §4). */
import type {ActiveMissionInfo,GetNearbyResponse,GetMissionsResponse,MapSystemInfo,MarketListingItem,ShipClass,ShipListing,
  ShippingListResponse,StationPassengersResponse,SystemInfo,SystemPoi,V2Module,ViewMarketResponse,ViewStorageResponse} from '@spacemolt/lib';
import {resolveFuelReserve} from '../mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {details} from '../response-details.ts';
import {evaluateMenu,jobStop,type CounterName,type Facts} from '../rules-table.ts';
import {readJournal} from '../run-record.ts';
import {PACKAGE_CARGO} from './hauling/freight.ts';
import {bench,moduleSpec,whyNotFit} from './hangar.ts';
import {knownBooks,ticksOld} from './market.ts';
import {stuck} from './missions.ts';
import {acct,command,pilot,present,runCalls,type Pilot} from './runtime.ts';
import {serviceElsewhere} from './service.ts';
import type {Status} from './types.ts';

export type Advances='knowledge'|'skill'|'credits'|'influence'|'ship'|'objective';
export interface Move {call:string;why:string;advances:Advances}
export interface Menu {stagnation?:string;moves:Move[];not_now:{move:string;why:string}[]}
/** One run as the menu remembers it: the first work call `main()` made, how it ended, what
 * the whole run gained, and where the ship ended up. Written by `run` into the journal. */
export interface RunSummary {fn:string;arg:string;status:Status;credits:number;items:number;xp:number;at:string}

const READS=new Set(['orient','scout','missions','prices','storage','shipsForSale']);
/** The run that just ended, from the runtime's record of top-level calls. `status` is how the
 * run itself ended, not how its first work call did: a run that went on to end `partial` or
 * `refused` read as `done` here, and the stagnation checks below take their answer from it. */
export function runSummary(status:Status):RunSummary|null {
  const calls=runCalls(),work=calls.find(c=>!READS.has(c.fn))??calls[0];
  if(!work)return null;
  const {location}=acct().state;
  return {fn:work.fn,arg:work.arg,status,credits:calls.reduce((n,c)=>n+c.credits,0),
    items:calls.reduce((n,c)=>n+c.items,0),xp:calls.reduce((n,c)=>n+c.xp,0),at:location?.docked_at??location?.poi_id??'?'};
}
/** The last `limit` runs, oldest first. */
export function recentRuns(runtime:string,limit=10):RunSummary[] {
  return readJournal(runtime,4000).filter(e=>e.event==='run'&&e.phase==='ended'&&e.work).map(e=>e.work as RunSummary).slice(-limit);
}

const same=(a:RunSummary,b:RunSummary)=>a.fn===b.fn&&a.arg===b.arg;
/** How many of the latest runs repeat the last one's call. */
function repeats(runs:RunSummary[]):number {
  const last=runs.at(-1);
  let n=last?1:0;while(last&&n<runs.length&&same(runs[runs.length-1-n]!,last))n++;
  return n;
}
/** Why the menu is due, or null when a productive loop should stay quiet: the last three
 * runs repeat one call, the last two did not end done, or the last gained nothing. The sentence is the menu's `stagnation` line. */
export function menuDue(runs:RunSummary[]):string|null {
  const last=runs.at(-1);
  if(!last)return null;
  const n=repeats(runs);
  if(n>=3) {
    const credits=runs.slice(-n).reduce((sum,r)=>sum+r.credits,0);
    return `${n} runs of ${last.fn} at ${last.arg}, credits ${credits?`+${credits}`:'flat'}`;
  }
  const two=runs.slice(-2);
  if(two.length===2&&two.every(r=>r.status!=='done'))return `last 2 runs ended ${two.map(r=>r.status).join(', ')} (${two.map(r=>r.fn).join(', ')})`;
  if(!last.credits&&!last.items&&!last.xp)return `the last run (${last.fn} ${last.arg}) gained nothing`;
  return null;
}

const attempt=async<T>(read:()=>Promise<T>):Promise<T|undefined>=>{try {return await read();} catch {return undefined;}};

/** A trade-run spread, which is the only kind J6 means: buy here at the ask, sell at the best
 * bid a book read on an earlier visit shows, with depth on both ends. The game publishes no
 * cross-station prices (see `market.ts`), so the far end is this runtime's market memory; with
 * no memory there is no spread, which is the same answer J6 gives today. */
function bestSpread(here:Map<string,MarketListingItem>,at:string,now:number,runtime?:string):{item_id:string;margin:number;age:number}|undefined {
  return (runtime?knownBooks(runtime):[]).filter(book=>book.base_id!==at)
    .flatMap(book=>book.items.map(far=>({far,age:ticksOld(book.tick,now)})))
    .flatMap(({far,age})=>{
      const mine=here.get(far.item_id);
      // Depth on both ends: an ask nobody is filling and a bid for nothing are not a trade.
      return mine&&mine.best_sell>0&&mine.best_sell_qty>0&&far.best_buy_qty>0
        ?[{item_id:far.item_id,margin:far.best_buy-mine.best_sell,age}]:[];
    }).filter(row=>row.margin>0).sort((a,b)=>b.margin-a.margin)[0];
}

/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A dock ends the engagement (safety.dock
 * says so), so a docked ship observes no threat — otherwise one NPC brawling outside a busy
 * station would hold the menu at safety-only forever, with no rest and no resupply on it.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate — counting them would
 * refuse every job the Hunter woke up to do. Upgrade when the spec names the statuses. */
function threatsHere(location:ReadinessAccount['state']['location'],docked:string|null):string[] {
  if(docked||!location)return [];
  return [...(location.nearby_players??[]).filter(row=>row.in_combat).map(row=>row.username??row.player_id),
    ...(location.nearby_empire_npcs??[]).filter(row=>row.in_combat).map(row=>row.name??row.npc_id)];
}

/** The facts the rules table reads, assembled from live state and the pilot record. The
 * bridge's `rest` and the menu build them the same way, so what one refuses the other does.
 *
 * The stance decides which counters are worth a round trip: only a Hunter's J8 reads
 * `observed.targets`, only a Carrier's J4/J5 read the board, only a Trader's J6 reads a
 * spread, so those reads are behind the stance that consumes them and a menu build costs the
 * same as before for everyone else. Every one of them is `attempt`ed: a counter that refuses
 * leaves its field absent, which is the answer the rule already gave before it was wired. */
export async function factsNow(account:ReadinessAccount,send:ReadinessCommand,who:Pilot,runtime?:string):Promise<Facts> {
  if(!who.mood)throw new Error('The pilot record names no mood; the runner sets stance and mood at rest');
  await account.refresh();
  const {location,ship,player}=account.state;
  const system=details(await send('spacemolt/get_system',{})).system as Record<string,any>|undefined;
  const rows=(system?.pois??[]) as Record<string,any>[];
  const docked=location?.docked_at??null;
  const counters:CounterName[]=[];
  let service_prices:{fuel?:number;hull?:number}|undefined,workshop=false;
  if(docked) {
    const base=details(await send('spacemolt/get_base',{}));
    const fuel=base.fuel_price_all_in,hull=base.base?.repair_price_per_hull;
    // A posted price is an estimate, never the counter's existence: `repair_price_per_hull` is
    // owner-set on player stations, so an ordinary station posts none and repairs anyway. What
    // the counter runs is `services`.
    service_prices={...Number.isFinite(fuel)?{fuel}:{},...Number.isFinite(hull)?{hull}:{}};
    const services=(Array.isArray(base.services)?base.services:[]).map(String);
    if(services.includes('refuel')||services.includes('repair'))counters.push('Services');
    if(services.includes('storage'))counters.push('Storage');
    // The bench J7 needs is the same fact as the counter that reaches it, read once.
    workshop=services.includes('crafting');
    if(workshop)counters.push('Workshop / recipes');
    if(services.includes('shipyard'))counters.push('Hangar / refit');
  }
  let quoted=NaN;
  if(location?.system_id&&!location.in_transit)
    quoted=Number(details(await send('spacemolt/find_route',{id:location.system_id})).estimated_fuel);
  const sites=Number.isFinite(quoted)?rows.filter(poi=>poi.id!==location?.poi_id).map(poi=>({
    poi_id:String(poi.id),quoted_fuel:quoted,
    ...poi.type==='asteroid_belt'?{resource:String(poi.type)}:{},
    ...poi.base_id?{serviced_base:true}:{}})):[];

  const observed:Facts['observed']={},board:NonNullable<Facts['place']['board']>={};
  const threats=threatsHere(location,docked);
  if(threats.length)observed.threats=threats;
  // Seated berths are the passengers aboard: `total - free` per class, already in the ship
  // section, so J5's own half of its question costs nothing.
  const berths=Object.values(ship?.berths??{}) as {total?:number;free?:number}[];
  const aboard=berths.reduce((n,row)=>n+((row.total??0)-(row.free??0)),0);
  if(who.stance==='Hunter') {
    // One read, and only for the stance that acts on it. Declined for the same two reasons
    // `hunt` declines a creature, so a target on the menu is one the loop will take.
    const near=await attempt(async()=>details(await send('spacemolt/get_nearby',{})) as GetNearbyResponse);
    const legal=(near?.creatures??[]).filter(row=>!row.in_combat&&!row.branded);
    if(legal.length)observed.targets=legal.map(row=>row.name);
  }
  if(who.stance==='Carrier'&&docked) {
    const listed=await attempt(async()=>details(await send('spacemolt_shipping/list',{sort:'reward'})) as ShippingListResponse);
    const contracts=(listed?.shipments??[]).filter(row=>row.eligible!==false).map(row=>({id:row.contract.id,
      cargo:PACKAGE_CARGO,liability:row.contract.reserved_exposure??row.contract.appraised_value??0}));
    if(contracts.length)board.contracts=contracts;
    const platform=await attempt(async()=>details(await send('spacemolt/list_station_passengers',{})) as StationPassengersResponse);
    if(platform?.waiting?.length)board.passengers=platform.waiting.length;
  }
  if(who.stance==='Trader'&&docked) {
    // The reply carries the tick the ages are measured against, so it is kept, not discarded.
    const reply=await attempt(async()=>details(await send('spacemolt_market/view_market',{})) as ViewMarketResponse);
    const here=reply&&new Map((reply.items??[]).map(row=>[row.item_id,row]));
    const spread=here&&bestSpread(here,docked,Number(reply.current_tick??0),runtime);
    if(spread)observed.spread=spread;
  }
  return {
    ...who.stance?{stance:who.stance}:{},
    mood:who.mood,
    place:{kind:docked?'base':location?.poi_id?'poi':'space',...docked?{base_id:docked}:{},
      counters,workshop,
      ...service_prices?{service_prices}:{},sites,
      ...board.contracts||board.passengers?{board}:{}},
    holdings:{fuel:ship?.fuel as number,max_fuel:ship?.max_fuel as number,
      hull:ship?.hull as number,max_hull:ship?.max_hull as number,
      cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits??0,
      inputs:Array.isArray(account.state.cargo)?[...new Set(account.state.cargo.map(row=>String(row.item_id)))]:[]},
    // Nothing in the rules table reads `obligations.contracts`, so nothing fills it; the
    // berths J5 asks about are the one obligation a rule consumes.
    obligations:aboard?{passengers:aboard}:{},permissions:who.permissions??{},observed,
  };
}

const lit=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');
/** The loop that trains a skill, by the lib's `SkillProgress.category` or the skill id. */
const TRAINS:[RegExp,string][]=[[/mining/,'gatherUntil'],[/trad|commerce/,'sell'],[/navigation|piloting|explor/,'goTo'],
  [/weapon|gunnery|tactic|xeno|combat|bounty/,'hunt'],[/engineer/,'refit']];
const LEADS:Record<string,string>={Prospector:'gatherUntil',Trader:'sell',Hunter:'hunt',Scout:'goTo',Carrier:'acceptMission',Industrialist:'refit'};
/** The call the pilot's own words name as the work. The objective and the goal decide; the
 * stance is the fallback. A Hunter told to cull fauna was offered gatherUntil and selling and
 * no hunt at all, every line tagged [credits]: the menu answered the belt, not the orders. */
const OBJECTIVES:[RegExp,string][]=[[/hunt|fauna|creature|kill|cull|bounty|pirate/,'hunt'],
  [/mine|ore|gather|prospect/,'gatherUntil'],[/haul|courier|freight|package/,'haul'],
  [/explor|scout|survey|visit|map/,'goTo'],[/trade|sell|market/,'sell']];
export const leadCall=(who:Pilot):string=>
  OBJECTIVES.find(([re])=>re.test(`${who.objective??''} ${who.goal??''}`.toLowerCase()))?.[1]??LEADS[who.stance??'']??'';
const FITS:Record<string,string[]>={Prospector:['gatherUntil','goTo'],Hunter:['hunt','goTo'],Scout:['goTo'],Carrier:['haul','goTo'],
  Trader:['goTo','haul'],Industrialist:['gatherUntil','goTo']};

/** The menu from where the ship stands: the present in one read, the last ten runs, the
 * skills, the store, and when docked the board, the market and the yard. At most five
 * moves, ranked to break the repetition seen first, then by what the goal names, then by
 * what similar runs measured. Under Tired: only service here or the nearest serviced base. */
export async function menu(runtime?:string):Promise<Menu> {
  const who=pilot(),moves:Move[]=[],not_now:Menu['not_now']=[];
  const runs=runtime?recentRuns(runtime):[];
  const stagnation=menuDue(runs)??undefined;
  const facts=await factsNow(acct(),command,who,runtime);
  await attempt(()=>command('spacemolt/get_skills',{}));
  await acct().refresh();
  const now=present(),{location,ship}=acct().state;
  const docked=location?.docked_at??null;
  const verdicts=evaluateMenu(facts);
  const system=(await attempt(async()=>(details(await command('spacemolt/get_system',{})) as {system:SystemInfo}).system));
  const pois:SystemPoi[]=system?.pois??[];
  const serviced=verdicts.find(v=>v.job==='J12 Home, serviced');

  if(who.mood==='Tired') {
    const why=`Tired (${now.tired_by||'margin crossed'})`;
    // A docked counter refuels and repairs on credits whether or not it posts a price, so the
    // resupply is the move wherever the ship is standing — no splitting the fill by what is
    // quoted. Undocked, every base this runtime can name is offered instead: the same rows a
    // refused `service()` advises, so the menu and the refusal say one thing, and a counter
    // unreadable until docked is still a move the pilot may take.
    if(docked)moves.push({call:'service()',why:`${why}: resupply here clears it`,advances:'ship'});
    else for(const row of await serviceElsewhere())moves.push({...row,why:`${why}: ${row.why}`,advances:'ship'});
    return {...stagnation?{stagnation}:{},moves,not_now};
  }

  const reserve=resolveFuelReserve(who.mood??'Cautious'),fuel=ship?.fuel??0;
  const stop=jobStop(facts);
  /** A move that starts work: refused under a threat or a mood that may not start a job. */
  const work=(move:Move)=>stop?not_now.push({move:move.call.split('(')[0]!,why:stop}):moves.push(move);
  const flies=async(id:string):Promise<string|null>=>{
    const quote=await attempt(async()=>details(await command('spacemolt/find_route',{id})));
    if(!quote?.found)return `no route to ${id}`;
    const need=Number(quote.estimated_fuel)+reserve;
    return fuel<need?`fuel ${fuel}, need ${need} with the ${who.mood} reserve ${reserve}`:null;
  };

  // Sell what you hold where there is a bid.
  const book=docked?await attempt(async()=>new Map(((details(await command('spacemolt_market/view_market',{})) as ViewMarketResponse).items??[])
    .map((row:MarketListingItem)=>[row.item_id,row]))):undefined;
  const hold=(acct().state.cargo??[]).filter(row=>row.quantity>0);
  const bids=hold.filter(row=>(book?.get(row.item_id)?.best_buy??0)>0);
  if(bids.length)moves.push({call:`sell(${lit(bids.map(row=>({item_id:row.item_id,quantity:row.quantity})))})`,
    why:`${bids.map(row=>`${row.quantity} ${row.item_id} bids ${book!.get(row.item_id)!.best_buy}`).join(', ')} at ${docked}`,advances:'credits'});
  const store=docked?await attempt(async()=>details(await command('spacemolt_storage/view',{})) as ViewStorageResponse):undefined;
  const stored=(store?.items??[]).filter(row=>row.quantity>0&&(book?.get(row.item_id)?.best_buy??0)>0);
  if(stored.length)moves.push({call:`sell(${lit(stored.map(row=>({item_id:row.item_id})))}, {from:'store'})`,
    why:`the store here holds ${stored.map(row=>`${row.quantity} ${row.item_id}`).join(', ')} with a bid`,advances:'credits'});

  // Turn in a mission; take a fitting one when a slot is free.
  const mine=await attempt(async()=>{
    const reply=details(await command('spacemolt/get_active_missions',{})) as {missions?:{active:ActiveMissionInfo[];max_missions:number}};
    return reply.missions??{active:[],max_missions:5};
  });
  const active=mine?.active??[];
  const ready=active.filter(m=>m.community?(m.community_percent??0)>=100:m.percent_complete>=100);
  if(ready.length)moves.push({call:'completeMissions()',why:`${ready.length} mission(s) at 100%: ${ready.map(m=>m.title).join(', ')}`,advances:'credits'});
  const free=(mine?.max_missions??5)-active.filter(m=>!m.community&&m.expires_in_ticks>0).length;
  // A full board with nothing completable is a dead end until a slot is freed: name the
  // mission that cannot be finished from here and the call that drops it.
  if(free<=0)for(const m of active.filter(row=>!row.community).map(row=>({row,why:stuck(row)})).filter(row=>row.why).slice(0,2))
    work({call:`abandonMission('${m.row.mission_id}')`,why:`${m.row.title}: ${m.why}; ${active.length} of ${mine?.max_missions??5} active, no slot free`,advances:'objective'});
  if(docked) {
    const board=(await attempt(async()=>(details(await command('spacemolt/get_missions',{})) as GetMissionsResponse).missions))??[];
    const fits=FITS[who.stance??'']??['gatherUntil','goTo'];
    const fitting=board.filter(m=>!active.some(a=>a.mission_id===m.mission_id)).map(m=>{
      const text=`${m.type} ${(m.objectives??[]).map(o=>o.description??'').join(' ')}`.toLowerCase();
      const fit=/mine|ore|gather|deliver/.test(text)&&(m.objectives??[]).some(o=>o.item_id)?'gatherUntil'
        :/kill|hunt|creature|destroy/.test(text)?'hunt':/visit|explore|survey|travel|scout/.test(text)?'goTo':/shipment|package|haul|courier/.test(text)?'haul':'';
      return {m,fit};
    }).filter(row=>fits.includes(row.fit)).slice(0,2);
    for(const {m,fit} of fitting) {
      const move:Move={call:`acceptMission('${m.mission_id}')`,why:`${m.title}, ${m.rewards?.credits??0} cr, fits ${fit}`,advances:'credits'};
      if(free<=0)not_now.push({move:'acceptMission',why:`no slot free: ${active.length} of ${mine?.max_missions??5} active${ready.length?'':', none completable'}`});
      else work(move);
    }
  }

  // Mine the nearest belt.
  const here=pois.find(p=>p.id===location?.poi_id);
  const dist=(p:SystemPoi)=>Math.hypot((p.position?.x??0)-(here?.position?.x??0),(p.position?.y??0)-(here?.position?.y??0));
  const belt=pois.filter(p=>/belt|field|cloud/.test(p.type)).sort((a,b)=>dist(a)-dist(b))[0];
  if(belt) {
    const full=ship&&ship.cargo_used>=ship.cargo_capacity?'the hold is full; sell(rows) or stow(rows) first':null;
    const blocked=full??await flies(belt.id);
    if(blocked)not_now.push({move:'gatherUntil',why:blocked});
    else work({call:`gatherUntil({poi:'${belt.id}'})`,why:`${belt.type} ${belt.name}, ${ship?.cargo_capacity!-ship?.cargo_used!} free in the hold`,advances:'credits'});
  }

  // Hunt when the orders say hunt: the fight is out in the system, never from a dock.
  const lead=leadCall(who);
  if(lead==='hunt') {
    if(docked)not_now.push({move:'hunt',why:`docked at ${docked}; undock or goTo a poi with fauna`});
    else work({call:'hunt()',why:`the objective names hunting; fauna at ${location?.poi_id??'this poi'} is legal to engage`,advances:'objective'});
  }

  // Explore an unvisited neighbour.
  for(const link of (system?.connections??[]).slice(0,3)) {
    const map=await attempt(async()=>details(await command('spacemolt/get_map',{system_id:link.system_id})) as MapSystemInfo);
    if(!map||map.visited)continue;
    const blocked=await flies(link.system_id);
    if(blocked)not_now.push({move:`goTo('${link.system_id}')`,why:blocked});
    else work({call:`goTo('${link.system_id}')`,why:`${map.name} is one jump away and never visited; scout() there`,advances:'knowledge'});
    break;
  }

  // Upgrade the hull when the budget covers a listing plus the reserve.
  const credits=now.credits,creditReserve=who.permissions?.credit_reserve??0;
  const budget=credits-creditReserve;
  if(docked&&facts.place.counters?.includes('Hangar / refit')&&budget>0) {
    const listings=(await attempt(async()=>(details(await command('spacemolt_ship/browse_ships',{max_price:budget})) as {listings?:ShipListing[]}).listings))??[];
    let best:{listing:ShipListing;klass:ShipClass}|undefined;
    for(const listing of listings.filter(row=>row.price<=budget).slice(0,3)) {
      const klass=await attempt(async()=>(details(await command('spacemolt/inspect',{id:listing.class_id})).catalog?.items?.[0]) as ShipClass|undefined);
      if(klass&&(klass.cargo_capacity??0)>(ship?.cargo_capacity??0)&&(!best||(klass.cargo_capacity??0)>(best.klass.cargo_capacity??0)))best={listing,klass};
    }
    if(best)work({call:`buyShip('${best.listing.listing_id}', {switchTo:true})`,
      why:`${best.klass.name} ${best.listing.price} cr, cargo ${ship?.cargo_capacity}→${best.klass.cargo_capacity}; ${credits} cr less reserve ${creditReserve} covers it`,advances:'ship'});
  }

  // Refit: a module in the hold that is not fitted.
  if(docked) {
    const fitted=(acct().state.modules??[]) as V2Module[];
    for(const row of hold.filter(r=>!fitted.some(m=>m.type_id===r.item_id)).slice(0,6)) {
      const spec=await attempt(()=>moduleSpec(row.item_id));
      if(!spec)continue;
      const why=whyNotFit(spec,bench());
      if(why)not_now.push({move:`refit({install:['${row.item_id}']})`,why});
      else moves.push({call:`refit({install:['${row.item_id}']})`,why:`${spec.name} is in the hold and unfitted (${spec.slot} slot free)`,advances:'ship'});
      break;
    }
  }

  // Train the lowest skill by naming the loop that trains it.
  const lowest=Object.entries(now.skills).sort((a,b)=>a[1].level-b[1].level)[0];
  if(lowest) {
    const [id,row]=lowest,loop=TRAINS.find(([re])=>re.test(`${id} ${row.category??''}`.toLowerCase()))?.[1];
    const named=moves.find(m=>loop&&m.call.startsWith(loop));
    if(named)named.why+=`; trains ${row.name??id} (level ${row.level}, the lowest)`;
    else if(loop==='hunt'&&!docked)work({call:`hunt()`,why:`trains ${row.name??id} (level ${row.level}, the lowest)`,advances:'skill'});
  }

  // Service where the counter admits it.
  if(docked&&serviced) {
    if(serviced.admissible)moves.push({call:'service()',why:serviced.reason,advances:'ship'});
    else if(!/already at the serviced-dock targets/.test(serviced.reason))not_now.push({move:'service',why:serviced.reason});
  }

  // Rank: break the repetition first, then the goal's own words, then what similar runs measured.
  const repeated=repeats(runs)>=3?runs.at(-1)!.fn:'';
  const goal=`${who.goal??''} ${who.objective??''}`.toLowerCase();
  const wants:Record<Advances,RegExp>={credits:/credit|money|cr\b/,skill:/skill|level|train/,ship:/ship|hull|cargo|upgrade/,
    knowledge:/know|explor|world|visit|scout/,influence:/influence|reputation|faction/,objective:/objective|goal|rest/};
  const gain=(fn:string)=>{const past=runs.filter(r=>r.fn===fn);return past.length?past.reduce((n,r)=>n+r.credits,0)/past.length:0;};
  const key=(m:Move)=>{const fn=m.call.split('(')[0]!;
    return [repeated&&fn!==repeated?1:0,wants[m.advances].test(goal)?1:0,LEADS[who.stance??'']===fn?1:0,gain(fn)];};
  const seen=new Set<string>();
  const ranked=moves.filter(m=>!seen.has(m.call)&&seen.add(m.call)).map(m=>({m,k:key(m)}))
    .sort((a,b)=>b.k[0]!-a.k[0]!||b.k[1]!-a.k[1]!||b.k[2]!-a.k[2]!||b.k[3]!-a.k[3]!).map(({m})=>m).slice(0,5);
  // The tag says what a move serves, and what the objective names serves the objective: the
  // ranking is already settled, so this only corrects the label the pilot reads.
  const tagged=ranked.map(m=>lead&&m.call.split('(')[0]===lead?{...m,advances:'objective' as const}:m);
  return {...stagnation?{stagnation}:{},moves:tagged,not_now};
}

/** The menu as text: one line per move with the call in backticks, then what is not on it. */
export function renderMenu(built:Menu):string {
  const out=[`Menu${built.stagnation?` — ${built.stagnation}`:''}:`];
  if(!built.moves.length)out.push('  (nothing to suggest from here)');
  for(const m of built.moves)out.push(`  - \`${m.call}\` — ${m.why} [${m.advances}]`);
  if(built.not_now.length)out.push('Not now:',...built.not_now.map(row=>`  - ${row.move}: ${row.why}`));
  return out.join('\n');
}
