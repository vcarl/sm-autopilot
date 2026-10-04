// One table of rules: facts in, permitted/selected out. The menu is its first
// consumer (R1); skill surfacing and running scripts read the same rows. Nothing here
// decides what to do next, and nothing here talks to the game.
import {resolveFuelReserve,resolveServiceSpend,resolveWalkAway,type Mood} from './mood-policy.ts';

export type StanceName='Prospector'|'Industrialist'|'Trader'|'Carrier'|'Hunter'|'Scout';
/** D7 section 3. Four of them can come back empty; the menu says so (D7 decision). */
export type CounterName='Market'|'Workshop / recipes'|'Boards — missions'|'Boards — shipping'
  |'Storage'|'Hangar / refit'|'Comms / news'|'Services'|'Obligations desk'|'Home desk'
  |'Progression desk'|'Citizenship / empire'|'Facilities desk'|'Distress';

export interface Stance {
  name:StanceName;
  /** Playtested first (D7). A flag on the data: no code branches on it. */
  active_first:boolean;
  jobs:string[];
  counters:CounterName[];
  initial_moods:Mood[];
}
export const STANCES:readonly Stance[]=Object.freeze([
  {name:'Prospector',active_first:false,jobs:['J1','J2','J3','J11','J12'],
    counters:['Market','Storage','Hangar / refit','Services'],initial_moods:['Focused','Opportunistic']},
  {name:'Industrialist',active_first:true,jobs:['J7','J1','J12'],
    counters:['Workshop / recipes','Market','Storage','Facilities desk','Obligations desk'],
    initial_moods:['Cautious','Focused']},
  {name:'Trader',active_first:false,jobs:['J6','J9','J12'],
    counters:['Market','Storage','Obligations desk','Comms / news'],initial_moods:['Opportunistic','Cautious']},
  {name:'Carrier',active_first:true,jobs:['J4','J5','J12'],
    counters:['Boards — shipping','Boards — missions','Storage','Hangar / refit','Obligations desk'],
    initial_moods:['Cautious','Focused']},
  {name:'Hunter',active_first:true,jobs:['J8','J3','J12'],
    counters:['Hangar / refit','Market','Services','Obligations desk'],initial_moods:['Focused','Aggressive']},
  {name:'Scout',active_first:false,jobs:['J2','J9','J10','J12'],
    counters:['Comms / news','Market','Services'],initial_moods:['Cautious','Opportunistic']},
] as const satisfies readonly Stance[]);

/** The working mood a stance flies in: its first initial mood, Cautious with no stance. The mood
 * is never chosen or stored; `moodNow` turns this into Tired when a margin is crossed. */
export const stanceMood=(stance?:string):Mood=>STANCES.find(row=>row.name===stance)?.initial_moods[0]??'Cautious';

export interface Site {poi_id:string;quoted_fuel:number;resource?:string;serviced_base?:boolean}
export interface Facts {
  stance?:StanceName;
  mood:Mood;
  place:{kind:'base'|'poi'|'space';base_id?:string;counters?:CounterName[];
    workshop?:boolean;service_prices?:{fuel?:number;hull?:number};sites?:Site[];
    board?:{contracts?:{id:string;cargo:number;liability:number}[];passengers?:number}};
  holdings:{fuel:number;max_fuel:number;hull:number;max_hull:number;cargo_free:number;credits:number;inputs?:string[]};
  obligations:{contracts?:string[];passengers?:number};
  permissions:{max_liability?:number;credit_reserve?:number};
  observed:{threats?:string[];targets?:string[];spread?:{item_id:string;base_id:string;margin:number;age:number}};
}
export interface Bounds {spend:number;fuelReserve:number;walkAway:number}
/** Resolved from the mood alone (D2/R7). Never passed per call, never per option. */
export const resolveBounds=(mood:Mood):Bounds=>
  ({spend:resolveServiceSpend(mood),fuelReserve:resolveFuelReserve(mood),walkAway:resolveWalkAway(mood)});

/** `safety` survives danger; `safety` and `resupply` survive Tired — resupply is what clears it. */
type Tag='safety'|'resupply'|'shared'|'stance';
/** `play` is the exact line from the `play` barrel an option would be taken with, so the pilot
 * is never left to invent parameters (playtest 2026-09-15: a gather dispatched twice at the
 * station the ship was already docked at). It is what the pilot pastes, which is why it is a
 * barrel call and not an MCP tool name — this field used to hold `{tool,params}`, a shape no
 * consumer ever read and no pilot could use.
 *
 * A verdict the rules refuse carries none: handing back a call the same build just refused is
 * how a menu contradicts itself. A verdict with **no** `play` has no barrel primitive behind it
 * at all, and the menu leaves it unoffered rather than inventing one — the three `safety` rows
 * are the standing cases. */
export interface Verdict {job:string;reason:string;admissible:boolean;tag:Tag;play?:string}
interface Rule {id:string;stance?:StanceName;apply(facts:Facts):Verdict|Verdict[]|null}

const yes=(tag:Tag,job:string,reason:string,play?:string):Verdict=>
  ({job,reason,admissible:true,tag,...play?{play}:{}});
const no=(tag:Tag,job:string,reason:string):Verdict=>({job,reason,admissible:false,tag});
const threats=(facts:Facts)=>facts.observed.threats??[];
const sites=(facts:Facts)=>facts.place.sites??[];
const serviced=(facts:Facts)=>facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull;

/** The same arithmetic travelTo applies before departure, from the same table, so an
 * option on the menu is one the script will accept (R5). */
function trip(facts:Facts,site:Site,tag:Tag):Verdict {
  const {fuel,max_fuel}=facts.holdings;
  const required=site.quoted_fuel,job=`Travel to ${site.poi_id}`;
  const quote=`route quotes ${site.quoted_fuel} fuel`,have=Number.isFinite(fuel)?fuel:'?';
  if(required>max_fuel)return no(tag,job,`${quote}, beyond the ${max_fuel} unit tank; a nearer site or a bigger tank admits it`);
  if(fuel<required)return no(tag,job,`${quote}, have ${have}; shortfall ${required-fuel} fuel units — refuel here or pick a nearer site`);
  // `goTo` is the barrel's one flight primitive and it takes any nameable id — a POI, a base or
  // a system — so the option carries the line the pilot pastes. It used to name
  // `travel(ctx,'<poi>')`, a script helper the barrel does not export: a pilot wedged below its
  // fuel reserve out in the open sat Tired for six hours with that sentence as its only exit
  // (live 2026-09-24). The rules already knew the base and the quote; only the call was wrong.
  return yes(tag,job,`${quote} and have ${have}${site.resource?`; ${site.poi_id} lists ${site.resource}`:''}; goTo('${site.poi_id}') flies it`,
    `goTo('${site.poi_id}')`);
}

/** The same estimate and margin serviceShip enforces at the counter. A posted price is
 * owner-set on a player station, so most counters post none and bill after the fact: an
 * unpriced service is an unknown bill, never a refusal. */
function service(facts:Facts):Verdict {
  const job='J12 Home, serviced',margin=resolveServiceSpend(facts.mood),{place,holdings}=facts;
  if(place.kind!=='base')return no('resupply',job,'dock at a base with a service counter to refuel and repair');
  if(serviced(facts))return no('resupply',job,'fuel and hull are already at the serviced-dock targets');
  const owedFuel=holdings.max_fuel-holdings.fuel,owedHull=holdings.max_hull-holdings.hull;
  const {fuel,hull}=place.service_prices??{};
  // The margin meters the repair only: fuel is resupply, bounded by the reserve alone.
  const repair=owedHull*(hull??0),quoted=owedFuel*(fuel??0)+repair,reserve=facts.permissions.credit_reserve??0;
  if(repair>margin)return no('resupply',job,
    `quoted ${repair} credits of repair exceeds the ${facts.mood} service spend margin ${margin}; a calmer bill or a bolder mood admits it`);
  if(holdings.credits-quoted<reserve||(!quoted&&holdings.credits<=reserve))return no('resupply',job,
    `credits ${holdings.credits} less reserve ${reserve} cannot cover the ${quoted?`quoted ${quoted} credits`:'unpriced counter'}`);
  return yes('resupply',job,quoted
    ?`full tank and hull quoted at ${quoted} credits, inside the ${facts.mood} margin ${margin}`
    :`full tank and hull; this counter posts no price, so service() bills it and holds the reserve ${reserve}`,
    'service()');
}

const TIRED_OPEN:CounterName[]=['Services','Distress'];
/** The barrel read that stands at each counter. The desks with no row here are read at the
 * station by hand — there is no export that reaches them — so they carry no call rather than a
 * name the gate would refuse.
 *
 * `Services` is deliberately absent: the act at that counter is `service()`, which J12 owns and
 * states the bill for. Two rows offering the same call with different reasoning is how a menu
 * stops meaning anything.
 *
 * A full hold at a base that takes deposits wants the act rather than the read (playtest
 * 2026-09-15: a day of gathers on cargo_free 0), but the act is `stow(rows)` and the rows that
 * belong in it are the ones this base has no bid for — which the rules table cannot know,
 * because `Facts` carries no book. That remedy is the menu's own stow row, built where the book
 * is in hand, and this stays the read. */
const COUNTER_READS:Partial<Record<CounterName,string>>={
  Market:'prices()','Workshop / recipes':'recipes()',Storage:'storage()','Hangar / refit':'shipsForSale()',
  'Boards — missions':'missions()','Boards — shipping':'freightBoard()'};
/** Counters are the base's, shared by every stance (VISION: station tools are neither jobs
 * nor flight primitives); stance guidance points at jobs and skills, never at admissibility
 * here. Danger and Tired still gate which tag survives, in evaluateMenu. Counters need no
 * stocked board, which is why an empty board never empties the menu. */
function counters(facts:Facts):Verdict[] {
  if(facts.place.kind!=='base')return [];
  const bounds=resolveBounds(facts.mood);
  return (facts.place.counters??[]).map(name=>{
    const job=`Counter: ${name}`,tag:Tag=TIRED_OPEN.includes(name)?'resupply':'shared';
    return yes(tag,job,
      // The walk-away bound is a FRACTION of max hull; the other two are absolute (credits, fuel
      // units). Printed bare as "0.9" beside them it reads as an absolute, and everywhere else the
      // pilot meets it — `present.walk_away`, the juncture's "break off below hull 90" — it is
      // already resolved against max_hull. The facts here carry no max_hull, so a percentage is the
      // honest rendering rather than a number in the wrong company.
      `offered here; reading a counter spends nothing, within the ${facts.mood} bounds (spend ${bounds.spend}, fuel reserve ${bounds.fuelReserve}, walk-away ${Math.round(bounds.walkAway*100)}% of max hull)`,
      COUNTER_READS[name]);
  });
}

const RULES:Rule[]=[
  // Danger first (R15): a fighting ship looks idle to every other rule, so these run
  // before the rest and the evaluator drops everything else while a threat is seen.
  {id:'safety.watch',apply:facts=>{
    const seen=threats(facts);
    return yes('safety','Hold position and watch',seen.length
      ?`threat seen: ${seen.join(', ')}; watch until it clears before starting anything`
      :'the world moves between looks; watching costs nothing and starts nothing');
  }},
  {id:'safety.retreat',apply:facts=>{
    const seen=threats(facts);
    return seen.length?yes('safety',`Retreat from ${seen.join(', ')}`,
      `threat seen: ${seen.join(', ')}; disengage below the ${facts.mood} walk-away hull fraction`):null;
  }},
  {id:'safety.dock',apply:facts=>{
    const seen=threats(facts);
    return seen.length?yes('safety',`Dock at ${facts.place.base_id??'the nearest base'}`,
      `threat seen: ${seen.join(', ')}; a dock ends the engagement; a script docks with dock(ctx)`):null;
  }},
  {id:'resupply.service',apply:service},
  {id:'resupply.travel',apply:facts=>sites(facts).filter(site=>site.serviced_base).map(site=>trip(facts,site,'resupply'))},
  {id:'shared.counters',apply:counters},
  {id:'shared.travel',apply:facts=>sites(facts).filter(site=>!site.serviced_base).map(site=>trip(facts,site,'shared'))},
  // Stance rows (D7 section 2). A stance sees only its own; jobs carry the proposal's
  // numbers and end-state names.
  {id:'stance.prospector.J1',stance:'Prospector',apply:facts=>{
    const job='J1 Hold full of ore';
    const mining=sites(facts).filter(site=>site.resource);
    if(!mining.length)return no('stance',job,'no reachable POI is quoted with resources; survey or travel to a system that has one');
    const found=mining.map(site=>trip(facts,site,'stance'));
    const open=found.findIndex(verdict=>verdict.admissible);
    const first=found[open];
    if(first===undefined)return no('stance',job,`${found[0]?.reason}`);
    if(facts.holdings.cargo_free<=0)return no('stance',job,'the hold is full; settle cargo at a market or storage first');
    // Every mining site the fuel admits, named in the reason so the pilot picks one; a station
    // is never among them. The call takes the nearest of them, because a call must name one
    // destination and the reason still carries the rest.
    const poi_id=mining.filter((_,index)=>found[index]?.admissible).map(site=>site.poi_id);
    // `gatherUntil` refuses outright with no base to settle at — it falls back to `docked_at`
    // and there is none out at a POI (mining.ts). So undocked the option is real and the call
    // is not: the reason says to dock or name a base, rather than handing over a line that
    // costs a juncture to discover is wrong.
    const home=facts.place.base_id;
    return yes('stance',job,
      `${first.reason}; ${facts.holdings.cargo_free} free cargo to fill${poi_id.length>1?`; the fuel also admits ${poi_id.slice(1).join(', ')}`:''}${home?'':'; dock first or name the base the trip settles at, which gatherUntil needs'}`,
      home?`gatherUntil({poi:'${poi_id[0]}',base:'${home}'})`:undefined);
  }},
  {id:'stance.industrialist.J7',stance:'Industrialist',apply:facts=>{
    const job='J7 Inputs at the bench',inputs=facts.holdings.inputs??[];
    if(!facts.place.workshop)return no('stance',job,'no workshop or facility at this base; a base with one admits it');
    if(!inputs.length)return no('stance',job,'no recipe inputs in hand; buy or mine the inputs a quoted recipe needs');
    // `recipes()` is the honest first move: `craft` and `quote` both need a recipe id, and no
    // fact here names one — what the bench can make from these inputs is a read away.
    return yes('stance',job,`a workshop here and ${inputs.join(', ')} in hand; quote the craft dry-run before committing escrow`,'recipes()');
  }},
  {id:'stance.trader.J6',stance:'Trader',apply:facts=>{
    const job='J6 Trade run closed',spread=facts.observed.spread;
    if(!spread||spread.margin<=0)return no('stance',job,'no quoted spread with depth on both ends; walk a price circuit first');
    // A remembered bid is a lead, not a price: `tradeRun` needs the base to sell at and the
    // spread fact carries no base id, so the call is the read that turns memory into a live
    // destination. `spreads()` walks this runtime's market memory and names both ends.
    return yes('stance',job,`a ${spread.margin} credit spread on ${spread.item_id} off a remembered bid ${spread.age} ticks old, inside the ${facts.mood} spend margin ${resolveServiceSpend(facts.mood)}`,'spreads()');
  }},
  {id:'stance.carrier.J4',stance:'Carrier',apply:facts=>{
    const job='J4 Freight delivered',allowed=facts.permissions.max_liability??0;
    const board=facts.place.board?.contracts??[];
    if(!board.length)return no('stance',job,'the shipping board is empty here; another station may have a package');
    const fits=board.filter(row=>row.cargo<=facts.holdings.cargo_free&&row.liability<=allowed),fit=fits[0];
    if(fit===undefined)return no('stance',job,
      `no package fits ${facts.holdings.cargo_free} free cargo inside the standing ${allowed} credit liability permission`);
    return yes('stance',job,`${fits.length} package(s) fit the hold and the ${allowed} credit liability permission`,
      `haul('${fit.id}')`);
  }},
  {id:'stance.carrier.J5',stance:'Carrier',apply:facts=>{
    const job='J5 Passengers landed',waiting=facts.place.board?.passengers??0,aboard=facts.obligations.passengers??0;
    if(!waiting&&!aboard)return no('stance',job,'nobody is waiting here and no berth is occupied; a station with citizens admits it');
    // No destination: `carryPassengers()` takes whoever is aboard where they are going, and
    // the berths decide that, not the pilot.
    return yes('stance',job,aboard?`${aboard} aboard owed a landing`:`${waiting} waiting for transport`,'carryPassengers()');
  }},
  {id:'stance.hunter.J8',stance:'Hunter',apply:facts=>{
    const job='J8 Creature down',targets=facts.observed.targets??[];
    if(!targets.length)return no('stance',job,'no unowned creature is known here; scan or travel to a habitat');
    // The targets are what a look answered where the ship stands, so the hunt needs no
    // destination: `hunt()` engages here.
    return yes('stance',job,`${targets.join(', ')} known; break off below the ${facts.mood} walk-away hull fraction`,'hunt()');
  }},
  {id:'stance.scout.J9',stance:'Scout',apply:facts=>{
    const job='J9 Price circuit walked';
    const loop=sites(facts).filter(site=>site.serviced_base).map(site=>trip(facts,site,'stance')).filter(verdict=>verdict.admissible);
    if(loop.length<2)return no('stance',job,'fewer than two stations are quoted inside the tank; a nearer pair admits it');
    // The circuit's first act is reading the book where the ship already is: every `prices()`
    // writes the whole book to this runtime's market memory, which is the only place a far bid
    // can come from later (market.ts). The hops themselves are the travel rows.
    return yes('stance',job,`${loop.length} stations inside the tank (${loop.map(v=>v.job.replace('Travel to ','')).join(', ')}); observations only, no capital committed`,
      facts.place.kind==='base'?'prices()':undefined);
  }},
];

/** D2/D3: Relaxed and Tired are not initial moods (Relaxed is rest-like, Tired is
 * derived from a crossed margin), so neither may initiate a stance job. Counters, watch, and travel
 * (including to a resource site) are unaffected — only J-numbered stance work is blocked. */
function jobMoodBlock(mood:Mood):string|null {
  return mood==='Relaxed'||mood==='Tired'
    ?`${mood} may not initiate a job${mood==='Tired'?'; resupply clears it':''}`
    :null;
}

/** The rules between one job and the next, from the same two rules the menu applies to
 * stance work: a threat seen, or a mood that may not initiate a job. A run asks this before
 * every job, so what the menu refuses mid-script is what the runner refuses too (R5). */
export function jobStop(facts:Facts):string|null {
  const seen=threats(facts);
  if(seen.length)return `threat seen: ${seen.join(', ')}; watch until it clears before starting anything`;
  return jobMoodBlock(facts.mood);
}

/** Danger first, then the mood block on stance jobs, then Tired's own filter. */
export function evaluateMenu(facts:Facts):Verdict[] {
  resolveBounds(facts.mood); // an unknown mood yields no menu at all, for any consumer (R10)
  const dangerous=threats(facts).length>0;
  const blocked=jobMoodBlock(facts.mood);
  const verdicts=RULES.filter(rule=>!rule.stance||rule.stance===facts.stance)
    .flatMap(rule=>{const out=rule.apply(facts);return out===null?[]:Array.isArray(out)?out:[out];})
    .map(verdict=>blocked&&verdict.tag==='stance'?no('stance',verdict.job,blocked):verdict);
  if(dangerous)return verdicts.filter(verdict=>verdict.tag==='safety');
  if(facts.mood==='Tired')return verdicts.filter(verdict=>
    verdict.tag==='safety'||verdict.tag==='resupply');
  return verdicts;
}
