/** The menu: anti-stagnation guidance, not a list of admissible jobs. Every move is a real
 * library call with literal arguments taken from the present, passed through the same rules
 * the helper applies (`jobStop`, the mood's margins, permissions, Tired); a move the rules
 * refuse is under `not_now` with the reason. The juncture delivers it once, headed by the
 * stagnation `menuDue` names. Reads only; writes nothing (DESIGN §4). */
import type {ActiveMissionInfo,GetMissionsResponse,MapSystemInfo,MarketListingItem,ShipClass,ShipListing,
  SystemInfo,SystemPoi,V2Module,ViewMarketResponse,ViewStorageResponse} from '@spacemolt/lib';
import {resolveFuelReserve} from '../mood-policy.ts';
import type {ReadinessAccount,ReadinessCommand} from '../readiness.ts';
import {details} from '../response-details.ts';
import {evaluateMenu,jobStop,type CounterName,type Facts} from '../rules-table.ts';
import {readJournal} from '../run-record.ts';
import {bench,moduleSpec,whyNotFit} from './hangar.ts';
import {stuck} from './missions.ts';
import {acct,command,pilot,present,runCalls,type Pilot} from './runtime.ts';
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

/** The facts the rules table reads, assembled from live state and the pilot record. The
 * bridge's `rest` and the menu build them the same way, so what one refuses the other does. */
export async function factsNow(account:ReadinessAccount,send:ReadinessCommand,who:Pilot):Promise<Facts> {
  if(!who.mood)throw new Error('The pilot record names no mood; the runner sets stance and mood at rest');
  await account.refresh();
  const {location,ship,player}=account.state;
  const system=details(await send('spacemolt/get_system',{})).system as Record<string,any>|undefined;
  const rows=(system?.pois??[]) as Record<string,any>[];
  const docked=location?.docked_at??null;
  const counters:CounterName[]=[];
  let service_prices:{fuel?:number;hull?:number}|undefined;
  if(docked) {
    const base=details(await send('spacemolt/get_base',{}));
    const fuel=base.fuel_price_all_in,hull=base.base?.repair_price_per_hull;
    service_prices={...Number.isFinite(fuel)?{fuel}:{},...Number.isFinite(hull)?{hull}:{}};
    if(service_prices.fuel!==undefined||service_prices.hull!==undefined)counters.push('Services');
    const services=(Array.isArray(base.services)?base.services:[]).map(String);
    if(services.includes('storage'))counters.push('Storage');
    if(services.includes('crafting'))counters.push('Workshop / recipes');
    if(services.includes('shipyard'))counters.push('Hangar / refit');
  }
  let quoted=NaN;
  if(location?.system_id&&!location.in_transit)
    quoted=Number(details(await send('spacemolt/find_route',{id:location.system_id})).estimated_fuel);
  const sites=Number.isFinite(quoted)?rows.filter(poi=>poi.id!==location?.poi_id).map(poi=>({
    poi_id:String(poi.id),quoted_fuel:quoted,
    ...poi.type==='asteroid_belt'?{resource:String(poi.type)}:{},
    ...poi.base_id?{serviced_base:true}:{}})):[];
  return {
    ...who.stance?{stance:who.stance}:{},
    mood:who.mood,
    place:{kind:docked?'base':location?.poi_id?'poi':'space',...docked?{base_id:docked}:{},
      ...docked&&who.home===docked?{is_home:true}:{},counters,
      ...service_prices?{service_prices}:{},sites},
    holdings:{fuel:ship?.fuel as number,max_fuel:ship?.max_fuel as number,
      hull:ship?.hull as number,max_hull:ship?.max_hull as number,
      cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits??0,
      inputs:Array.isArray(account.state.cargo)?[...new Set(account.state.cargo.map(row=>String(row.item_id)))]:[]},
    obligations:{},permissions:who.permissions??{},observed:{},
  };
}

const lit=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');
const attempt=async<T>(read:()=>Promise<T>):Promise<T|undefined>=>{try {return await read();} catch {return undefined;}};
/** The loop that trains a skill, by the lib's `SkillProgress.category` or the skill id. */
const TRAINS:[RegExp,string][]=[[/mining/,'gatherUntil'],[/trad|commerce/,'sell'],[/navigation|piloting|explor/,'goTo'],
  [/weapon|gunnery|tactic|xeno|combat|bounty/,'hunt'],[/engineer/,'refit']];
const LEADS:Record<string,string>={Prospector:'gatherUntil',Trader:'sell',Hunter:'hunt',Scout:'goTo',Carrier:'acceptMission',Industrialist:'refit'};
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
  const facts=await factsNow(acct(),command,who);
  await attempt(()=>command('spacemolt/get_skills',{}));
  await acct().refresh();
  const now=present(),{location,ship}=acct().state;
  const docked=location?.docked_at??null;
  const verdicts=evaluateMenu(facts);
  const system=(await attempt(async()=>(details(await command('spacemolt/get_system',{})) as {system:SystemInfo}).system));
  const pois:SystemPoi[]=system?.pois??[];
  const serviced=verdicts.find(v=>v.job==='J12 Home, serviced');
  const stations=pois.filter(p=>p.base_id&&p.id!==location?.poi_id);

  if(who.mood==='Tired') {
    if(docked)moves.push({call:'service()',why:`Tired (${now.tired_by??'margin crossed'}): resupply here clears it`,advances:'ship'});
    else {
      const base=stations[0]?.base_id??who.home;
      if(base)moves.push({call:`goTo('${base}')`,why:`Tired (${now.tired_by??'margin crossed'}): the nearest serviced base; service() there clears it`,advances:'ship'});
    }
    return {...stagnation?{stagnation}:{},moves,not_now};
  }

  const reserve=resolveFuelReserve(who.mood??'Cautious'),fuel=ship?.fuel??0;
  const stop=jobStop(facts);
  /** A move that starts work: refused under a threat or a mood that may not start a job. */
  const work=(move:Move)=>stop?not_now.push({move:move.call.split('(')[0]!,why:stop}):moves.push(move);
  const flies=async(id:string):Promise<string|null>=>{
    if((who.permissions?.no_go??[]).includes(id))return `${id} is in permissions.no_go`;
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
  const credits=now.credits,creditReserve=who.permissions?.credit_reserve??0,cap=who.permissions?.max_spend;
  const budget=Math.min(credits-creditReserve,cap??Infinity);
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

  // Service; go home when the objective is done or the shift is long.
  if(docked&&serviced) {
    if(serviced.admissible)moves.push({call:'service()',why:serviced.reason,advances:'ship'});
    else if(!/already at the serviced-dock targets/.test(serviced.reason))not_now.push({move:'service',why:serviced.reason});
  }
  if(who.home&&docked!==who.home&&(who.objective_done||runs.length>=10)) {
    const blocked=await flies(who.home);
    if(blocked)not_now.push({move:`goTo('${who.home}')`,why:blocked});
    else moves.push({call:`goTo('${who.home}')`,why:`${who.objective_done?'the objective is done':`${runs.length} runs this shift`}; rest at home`,advances:'objective'});
  }

  // Rank: break the repetition first, then the goal's own words, then what similar runs measured.
  const repeated=repeats(runs)>=3?runs.at(-1)!.fn:'';
  const goal=`${who.goal??''} ${who.objective??''}`.toLowerCase();
  const wants:Record<Advances,RegExp>={credits:/credit|money|cr\b/,skill:/skill|level|train/,ship:/ship|hull|cargo|upgrade/,
    knowledge:/know|explor|world|visit|scout/,influence:/influence|reputation|faction/,objective:/objective|goal|home|rest/};
  const gain=(fn:string)=>{const past=runs.filter(r=>r.fn===fn);return past.length?past.reduce((n,r)=>n+r.credits,0)/past.length:0;};
  const key=(m:Move)=>{const fn=m.call.split('(')[0]!;
    return [repeated&&fn!==repeated?1:0,wants[m.advances].test(goal)?1:0,LEADS[who.stance??'']===fn?1:0,gain(fn)];};
  const seen=new Set<string>();
  const ranked=moves.filter(m=>!seen.has(m.call)&&seen.add(m.call)).map(m=>({m,k:key(m)}))
    .sort((a,b)=>b.k[0]!-a.k[0]!||b.k[1]!-a.k[1]!||b.k[2]!-a.k[2]!||b.k[3]!-a.k[3]!).map(({m})=>m).slice(0,5);
  return {...stagnation?{stagnation}:{},moves:ranked,not_now};
}

/** The menu as text: one line per move with the call in backticks, then what is not on it. */
export function renderMenu(built:Menu):string {
  const out=[`Menu${built.stagnation?` — ${built.stagnation}`:''}:`];
  if(!built.moves.length)out.push('  (nothing to suggest from here)');
  for(const m of built.moves)out.push(`  - \`${m.call}\` — ${m.why} [${m.advances}]`);
  if(built.not_now.length)out.push('Not now:',...built.not_now.map(row=>`  - ${row.move}: ${row.why}`));
  return out.join('\n');
}
