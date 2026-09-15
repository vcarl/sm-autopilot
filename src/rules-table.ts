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

export interface Site {poi_id:string;quoted_fuel:number;resource?:string;serviced_base?:boolean}
export interface Facts {
  stance?:StanceName;
  mood:Mood;
  place:{kind:'base'|'poi'|'space';base_id?:string;is_home?:boolean;counters?:CounterName[];
    workshop?:boolean;service_prices?:{fuel?:number;hull?:number};sites?:Site[];
    board?:{contracts?:{id:string;cargo:number;liability:number}[];passengers?:number}};
  holdings:{fuel:number;max_fuel:number;hull:number;max_hull:number;cargo_free:number;credits:number;inputs?:string[]};
  obligations:{contracts?:string[];passengers?:number};
  permissions:{max_liability?:number;credit_reserve?:number};
  observed:{threats?:string[];targets?:string[];spread?:{item_id:string;margin:number}};
}
export interface Bounds {spend:number;fuelReserve:number;walkAway:number}
/** Resolved from the mood alone (D2/R7). Never passed per call, never per option. */
export const resolveBounds=(mood:Mood):Bounds=>
  ({spend:resolveServiceSpend(mood),fuelReserve:resolveFuelReserve(mood),walkAway:resolveWalkAway(mood)});

/** `safety` survives danger; `safety`, `resupply` and `rest` survive Tired — a pilot that
 * reached home may put the evening down whatever the world imposed on it, and rest is what
 * clears an imposed mood for good. */
type Tag='safety'|'resupply'|'rest'|'shared'|'stance';
/** The one rest option, named once: the runner's own rest action asks this same rule, so
 * what the menu offers and what the runner accepts cannot drift (R5). */
export const REST_JOB='Rest and reflect at home';
/** The exact call an option would be taken with, so the pilot is never left to invent
 * parameters (playtest 2026-09-15: a gather dispatched at the home station twice). A call
 * that names several poi ids offers a choice; it never picks the destination. */
export interface Call {tool:string;params:Record<string,unknown>}
export interface Verdict {job:string;reason:string;admissible:boolean;tag:Tag;call?:Call|null}
interface Rule {id:string;stance?:StanceName;apply(facts:Facts):Verdict|Verdict[]|null}

const yes=(tag:Tag,job:string,reason:string,call:Call|null=null):Verdict=>({job,reason,admissible:true,tag,call});
const no=(tag:Tag,job:string,reason:string):Verdict=>({job,reason,admissible:false,tag});
const threats=(facts:Facts)=>facts.observed.threats??[];
const sites=(facts:Facts)=>facts.place.sites??[];
const serviced=(facts:Facts)=>facts.holdings.fuel>=facts.holdings.max_fuel&&facts.holdings.hull>=facts.holdings.max_hull;

/** The same arithmetic travelTo applies before departure, from the same table, so an
 * option on the menu is one the script will accept (R5). */
function trip(facts:Facts,site:Site,tag:Tag):Verdict {
  const {fuel,max_fuel}=facts.holdings,reserve=resolveFuelReserve(facts.mood);
  const required=site.quoted_fuel+reserve,job=`Travel to ${site.poi_id}`;
  const quote=`route quotes ${site.quoted_fuel} fuel; with the ${facts.mood} reserve ${reserve} you need ${required}`;
  if(required>max_fuel)return no(tag,job,`${quote}, beyond the ${max_fuel} unit tank; a nearer site or a bigger tank admits it`);
  if(fuel<required)return no(tag,job,`${quote}, have ${fuel}; shortfall ${required-fuel} fuel units — refuel here or pick a nearer site`);
  return yes(tag,job,`${quote} and have ${fuel}${site.resource?`; ${site.poi_id} lists ${site.resource}`:''}`,
    {tool:'spacemolt_travel',params:{poi_id:site.poi_id}});
}

/** The same quote and margin serviceShip enforces at the counter. */
function service(facts:Facts):Verdict {
  const job='J12 Home, serviced',margin=resolveServiceSpend(facts.mood),{place,holdings}=facts;
  if(place.kind!=='base')return no('resupply',job,'dock at a base with a service counter to refuel and repair');
  if(serviced(facts))return no('resupply',job,'fuel and hull are already at the serviced-dock targets');
  const owedFuel=holdings.max_fuel-holdings.fuel,owedHull=holdings.max_hull-holdings.hull;
  const {fuel,hull}=place.service_prices??{};
  if((owedFuel>0&&!(typeof fuel==='number'))||(owedHull>0&&!(typeof hull==='number')))
    return no('resupply',job,'this base posts no all-in fuel or repair quote; a station that does admits it');
  const quoted=owedFuel*(fuel??0)+owedHull*(hull??0),reserve=facts.permissions.credit_reserve??0;
  if(quoted>margin)return no('resupply',job,
    `quoted ${quoted} credits exceeds the ${facts.mood} service spend margin ${margin}; a calmer bill or a bolder mood admits it`);
  if(holdings.credits-quoted<reserve)return no('resupply',job,
    `credits ${holdings.credits} less reserve ${reserve} cannot cover the quoted ${quoted} credits`);
  return yes('resupply',job,`full tank and hull quoted at ${quoted} credits, inside the ${facts.mood} margin ${margin}`);
}

const TIRED_OPEN:CounterName[]=['Services','Distress'];
/** The counters a tool reaches today. The rest are read at the station by hand, so they
 * carry no call rather than a name that would fail. */
const COUNTER_CALLS:Partial<Record<CounterName,Call>>={Storage:{tool:'spacemolt_storage',params:{}},
  'Workshop / recipes':{tool:'spacemolt_recipes',params:{}}};
/** A full hold at a base that takes deposits wants the act, not the read: the store is still
 * readable through its own tool, and what the pilot needs here is the free hold a gather
 * cannot start without (playtest 2026-09-15: a day of gathers on cargo_free 0). */
const counterCall=(name:CounterName,facts:Facts):Call|null=>
  name==='Storage'&&facts.holdings.cargo_free===0
    ?{tool:'spacemolt_run',params:{script:'stow',params:{}}}
    :COUNTER_CALLS[name]??null;
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
      `offered here; reading a counter spends nothing, within the ${facts.mood} bounds (spend ${bounds.spend}, fuel reserve ${bounds.fuelReserve}, walk-away ${bounds.walkAway})`,
      counterCall(name,facts));
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
      `threat seen: ${seen.join(', ')}; a dock ends the engagement`,{tool:'spacemolt_dock',params:{}}):null;
  }},
  {id:'resupply.service',apply:service},
  {id:'resupply.travel',apply:facts=>sites(facts).filter(site=>site.serviced_base).map(site=>trip(facts,site,'resupply'))},
  {id:'shared.counters',apply:counters},
  {id:'shared.travel',apply:facts=>sites(facts).filter(site=>!site.serviced_base).map(site=>trip(facts,site,'shared'))},
  // Rest ends the shift, and only at home (N6). Servicing is wanted only as far as this
  // base can give it: where the counter quotes and the wallet covers, resting on a ship
  // that cannot leave is a shift ended badly; where it cannot, rest still happens and
  // reflection is told the ship is short. Mood does not gate it — rest is what clears one.
  {id:'rest.home',apply:facts=>{
    if(facts.place.kind!=='base'||!facts.place.is_home)
      return no('rest',REST_JOB,'rest happens only at home; travel home to end the shift');
    const counter=service(facts);
    if(!serviced(facts)&&counter.admissible)
      return no('rest',REST_JOB,`refuel and repair first — ${counter.reason}`);
    return yes('rest',REST_JOB,serviced(facts)
      ?'home, safe and serviced: the evening can be put down and a new goal chosen'
      :`home, and this base cannot bring the ship up (${counter.reason}); the evening can still be put down`,
      {tool:'spacemolt_rest',params:{}});
  }},
  // Stance rows (D7 section 2). A stance sees only its own; jobs carry the proposal's
  // numbers and end-state names.
  {id:'stance.prospector.J1',stance:'Prospector',apply:facts=>{
    const job='J1 Hold full of ore';
    const mining=sites(facts).filter(site=>site.resource);
    if(!mining.length)return no('stance',job,'no reachable POI is quoted with resources; survey or travel to a system that has one');
    const found=mining.map(site=>trip(facts,site,'stance'));
    const open=found.findIndex(verdict=>verdict.admissible);
    if(open<0)return no('stance',job,`${found[0]!.reason}`);
    if(facts.holdings.cargo_free<=0)return no('stance',job,'the hold is full; settle cargo at a market or storage first');
    // Every mining site the fuel admits, so the pilot picks one; a station is never among
    // them, and one site still comes as a list rather than as a destination chosen for it.
    const poi_id=mining.filter((_,index)=>found[index]!.admissible).map(site=>site.poi_id);
    return yes('stance',job,`${found[open]!.reason}; ${facts.holdings.cargo_free} free cargo to fill`,
      {tool:'spacemolt_run',params:{script:'gather',
        params:{poi_id,...facts.place.base_id?{base_id:facts.place.base_id}:{}}}});
  }},
  {id:'stance.industrialist.J7',stance:'Industrialist',apply:facts=>{
    const job='J7 Inputs at the bench',inputs=facts.holdings.inputs??[];
    if(!facts.place.workshop)return no('stance',job,'no workshop or facility at this base; a base with one admits it');
    if(!inputs.length)return no('stance',job,'no recipe inputs in hand; buy or mine the inputs a quoted recipe needs');
    return yes('stance',job,`a workshop here and ${inputs.join(', ')} in hand; quote the craft dry-run before committing escrow`);
  }},
  {id:'stance.trader.J6',stance:'Trader',apply:facts=>{
    const job='J6 Trade run closed',spread=facts.observed.spread;
    if(!spread||spread.margin<=0)return no('stance',job,'no quoted spread with depth on both ends; walk a price circuit first');
    return yes('stance',job,`a ${spread.margin} credit spread on ${spread.item_id}, inside the ${facts.mood} spend margin ${resolveServiceSpend(facts.mood)}`);
  }},
  {id:'stance.carrier.J4',stance:'Carrier',apply:facts=>{
    const job='J4 Freight delivered',allowed=facts.permissions.max_liability??0;
    const board=facts.place.board?.contracts??[];
    if(!board.length)return no('stance',job,'the shipping board is empty here; another station may have a package');
    const fits=board.filter(row=>row.cargo<=facts.holdings.cargo_free&&row.liability<=allowed);
    if(!fits.length)return no('stance',job,
      `no package fits ${facts.holdings.cargo_free} free cargo inside the operator's ${allowed} credit liability permission`);
    return yes('stance',job,`${fits.length} package(s) fit the hold and the ${allowed} credit liability permission`);
  }},
  {id:'stance.carrier.J5',stance:'Carrier',apply:facts=>{
    const job='J5 Passengers landed',waiting=facts.place.board?.passengers??0,aboard=facts.obligations.passengers??0;
    if(!waiting&&!aboard)return no('stance',job,'nobody is waiting here and no berth is occupied; a station with citizens admits it');
    return yes('stance',job,aboard?`${aboard} aboard owed a landing`:`${waiting} waiting for transport`);
  }},
  {id:'stance.hunter.J8',stance:'Hunter',apply:facts=>{
    const job='J8 Creature down',targets=facts.observed.targets??[];
    if(!targets.length)return no('stance',job,'no unowned creature is known here; scan or travel to a habitat');
    return yes('stance',job,`${targets.join(', ')} known; break off below the ${facts.mood} walk-away hull fraction`);
  }},
  {id:'stance.scout.J9',stance:'Scout',apply:facts=>{
    const job='J9 Price circuit walked';
    const loop=sites(facts).filter(site=>site.serviced_base).map(site=>trip(facts,site,'stance')).filter(verdict=>verdict.admissible);
    if(loop.length<2)return no('stance',job,'fewer than two stations are quoted inside the fuel reserve; a nearer pair admits it');
    return yes('stance',job,`${loop.length} stations inside the ${facts.mood} fuel reserve; observations only, no capital committed`);
  }},
];

/** D2/D3: Relaxed and Tired are not initial moods (Relaxed is rest-like, Tired is
 * imposed), so neither may initiate a stance job. Counters, watch, rest, and travel
 * (including to a resource site) are unaffected — only J-numbered stance work is blocked. */
function jobMoodBlock(mood:Mood):string|null {
  return mood==='Relaxed'||mood==='Tired'
    ?`${mood} may not initiate a job; a job mood chosen at reflection admits it`
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
    verdict.tag==='safety'||verdict.tag==='resupply'||verdict.tag==='rest');
  return verdicts;
}
