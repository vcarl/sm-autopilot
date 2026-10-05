/** The menu: anti-stagnation guidance, not a list of admissible jobs. Every move is a real
 * library call with literal arguments taken from the present, passed through the same rules
 * the helper applies (`jobStop`, the mood's margins, permissions, Tired); a move the rules
 * refuse is under `not_now` with the reason. The juncture delivers it once, headed by the
 * stagnation `menuDue` names. Reads only; writes nothing (DESIGN §4). */
import {Cause,Effect,Exit,Option,Schema,Struct} from 'effect';
import type {ReadinessAccount} from '../readiness.ts';
import {replyBody,rows} from '../storage.ts';
import * as Wire from '../wire.gen.ts';
import {evaluateMenu,jobStop,type CounterName,type Facts} from '../rules-table.ts';
import {combatLine,readCombat,statsFor} from '../combat-memory.ts';
import {cellReserve} from '../mining-inventory.ts';
import {readJournal} from '../run-record.ts';
import {readFleet} from './freighter/host.ts';
import {readPlaces} from './places.ts';
import {PACKAGE_CARGO} from './hauling/freight.ts';
import {Game,field} from './game.ts';
import {bench,catalogClassEffect,moduleSpecEffect,whyNotFit} from './hangar.ts';
import {readSightings,recall,TICK_MS} from '../sighting-memory.ts';
import {bestFarBid,knownBooks,ticksOld} from './market.ts';
import {activeEffect,nextStep,stuck} from './missions.ts';
import {num} from './rows.ts';
import {acct,defect,pilot,present,runCalls,step,type Pilot} from './runtime.ts';
import {serviceElsewhereEffect} from './service.ts';
import {IGNORE_TICKS} from './freighter/index.ts';
import {around,mapOf,nearFacts,readSeen,type Near} from './exploration/exploration.ts';
import {candidatesEffect,SCOUT_JUMPS,target,type Candidate} from './trading/scout.ts';
import {pilotSeat} from './trading/trading.ts';
import type {Status} from './types.ts';

export type Advances='knowledge'|'skill'|'credits'|'influence'|'ship'|'objective';
export interface Move {call:string;why:string;advances:Advances}
/** `held` is each active mission led by its next step, for the juncture's Missions block. */
export interface Held {title:string;next:string;expires_at?:string}
export interface Menu {stagnation?:string;moves:Move[];not_now:{move:string;why:string}[];held?:{max:number;missions:Held[]}}
/** One run as the menu remembers it: the first work call `main()` made, how it ended, what
 * the whole run gained, and where the ship ended up. Written by `run` into the journal. */
const Work=Schema.Struct({fn:Schema.String,arg:Schema.String,status:Schema.Literals(['done','partial','refused','failed']),
  credits:Schema.Number,items:Schema.Number,xp:Schema.Number,at:Schema.optionalKey(Schema.String)});
export interface RunSummary extends Schema.Schema.Type<typeof Work> {}
const decodeWork=Schema.decodeUnknownOption(Work);

/** The calls that only read: a run is named for the first call that is not one of these (live
 * 2026-09-28, a buy/craft/sell run was labelled `quote`). */
const READS=new Set(['orient','scout','missions','prices','storage','shipsForSale','quote','recipes','routes','spreads','buyers',
  'reflection','freighters','freightBoard','jobs','materials','facilities']);
/** Worse is bigger: `done` is fine, `failed` is worst. Ranks the four `Status` values so two
 * of them can be compared. */
const STATUS_RANK:Record<Status,number>={done:0,partial:1,refused:2,failed:3};

/** The run that just ended, from the runtime's record of top-level calls. `status` is the run's
 * own final status — trusted, UNLESS it is only there because some later top-level call read
 * that way itself, which is a different call's outcome, not this one's, AND that later call's
 * status is worse than the work call's own. Live: a `gatherUntil` that finished `done` was
 * reported `refused`, because the program went on to call `completeMissions()`, the server
 * refused it, and that refusal (worse than `done`) became the run's own status — the work call's
 * own record (`calls`, kept per top-level call) said `done` all along. The reverse also happens:
 * a `gatherUntil` that came back `refused` (hold full) followed by a `sell` that finished `done`
 * — the run's `done` is not worse than the work call's `refused`, so the run's status (the real
 * outcome) wins and the work call is not stamped with its own stale refusal.
 * An explicit final `outcome()` the program composes itself is not a later call — nothing pushes
 * one to `calls` — so its verdict still stands over the first work call's mechanical status. */
export function runSummary(status:Status):RunSummary|null {
  const calls=runCalls(),work=calls.find(c=>!READS.has(c.fn))??calls[0];
  if(!work)return null;
  const explainedByLater=calls.slice(calls.indexOf(work)+1).some(c=>c.status===status);
  const keepWork=explainedByLater&&STATUS_RANK[status]>STATUS_RANK[work.status];
  const {location}=acct().state;
  return {fn:work.fn,arg:work.arg,status:keepWork?work.status:status,
    credits:calls.reduce((n,c)=>n+c.credits,0),
    items:calls.reduce((n,c)=>n+c.items,0),xp:calls.reduce((n,c)=>n+c.xp,0),at:location?.docked_at??location?.poi_id??'?'};
}
/** The last `limit` runs, oldest first. */
export function recentRuns(runtime:string,limit=10):RunSummary[] {
  return readJournal(runtime,4000).filter(e=>e.event==='run'&&e.phase==='ended').flatMap(e=>Option.toArray(decodeWork(e.work))).slice(-limit);
}

const same=(a:RunSummary,b:RunSummary)=>a.fn===b.fn&&a.arg===b.arg;
/** How many of the latest runs repeat the last one's call. */
function repeats(runs:RunSummary[]):number {
  const last=runs.at(-1);
  let n=last?1:0;
  for(;last&&n<runs.length;n++){const prev=runs.at(-1-n);if(!prev||!same(prev,last))break;}
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

/** A section of the menu: whatever stops its read — the server's refusal, a lost reply, a failed re-read, or a bug — leaves
 * that section out and the menu still builds, because the menu is the juncture's context and a context with none is a pilot
 * flying blind. A bug also journals a `defect` line naming `fn`, so it still reaches developers. An interrupt goes up. */
const section=<A,E,R>(fn:string,read:Effect.Effect<A,E,R>)=>Effect.gen(function*() {
  const exit=yield* Effect.exit(read);
  if(Exit.isSuccess(exit))return Option.some(exit.value);
  if(Cause.hasInterruptsOnly(exit.cause))return yield* Effect.interrupt;
  defect(fn,exit.cause);
  return Option.none<A>();
});
/** One read as a section: the reply's body. */
const look=(action:string,params:Record<string,unknown>={})=>Effect.gen(function*() {
  return Option.map(yield* section(action,(yield* Game).command(action,params)),replyBody);
});
/** The rows of a list that decode, as the read fields; one that does not is left out and said in a step. */
const each=<A>(action:string,key:string,list:unknown,decode:(row:unknown)=>Option.Option<A>):A[]=>rows(list).flatMap(row=>{
  const read=decode(row);
  if(Option.isNone(read))step(`${action}: a ${key} row did not read; left out`);
  return Option.toArray(read);
});
/** A call's function name: what is before the first `(`. */
const fnOf=(call:string)=>call.split('(')[0]??'';

/** What the menu reads of a reply, picked from the spec's schema: the live server omits spec fields and sends `null` for an
 * empty list, so a field the code defaults when absent is optional, and a list reads `null` as none. */
const Poi=Wire.ClientPOIInfo_2.mapFields(fields=>({id:fields.id,type:fields.type,name:Schema.optionalKey(fields.name),base_id:fields.base_id,
  position:Schema.optionalKey(Wire.Position_3)}));
type Poi=Omit<typeof Poi.Type,'name'>&{readonly name:string};
const decodePoi=(row:unknown):Option.Option<Poi>=>Option.map(Schema.decodeUnknownOption(Poi)(row),poi=>({...poi,name:poi.name??poi.id}));
const Creature=Wire.CreatureInfo_1.mapFields(fields=>({name:fields.name,in_combat:Schema.optionalKey(fields.in_combat),branded:fields.branded}));
const decodeCreature=Schema.decodeUnknownOption(Creature);
const Shipment=Wire.ShippingListing.mapFields(fields=>({eligible:Schema.optionalKey(fields.eligible),
  contract:Wire.ShipmentContract_4.mapFields(Struct.pick(['id','reserved_exposure','appraised_value']))}));
const decodeShipment=Schema.decodeUnknownOption(Shipment);
const Book=Wire.MarketListingItem.mapFields(Struct.pick(['item_id','best_buy','best_buy_qty','best_sell','best_sell_qty']));
type Book=typeof Book.Type;
const decodeBook=Schema.decodeUnknownOption(Book);
const Stored=Wire.CargoItem_14.schema.mapFields(Struct.pick(['item_id','quantity']));
const decodeStored=Schema.decodeUnknownOption(Stored);
const Offered=Wire.MissionInfo.mapFields(fields=>({mission_id:fields.mission_id,title:Schema.optionalKey(fields.title),type:Schema.optionalKey(fields.type),
  rewards:Schema.optionalKey(Schema.NullOr(Wire.MissionRewardsInfo_1.mapFields(Struct.pick(['credits'])))),
  objectives:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ObjectiveInfo_2.mapFields(fields=>({description:Schema.optionalKey(fields.description),item_id:fields.item_id})))))}));
const decodeOffered=Schema.decodeUnknownOption(Offered);
const Listed=Wire.ShipListing.mapFields(Struct.pick(['class_id','price','listing_id']));
type Listed=typeof Listed.Type;
const decodeListed=Schema.decodeUnknownOption(Listed);

/** Whether Piloting clears a hull class's `piloting_required`, and by how much when it does
 * not: the line `not_now` names, or null when the class asks nothing this pilot's skill has
 * not already cleared (including a class that asks nothing at all), or when the Piloting skill
 * itself is unread — `get_skills` failed and its section was left out, so `piloting` is
 * `undefined` here, not 0; an unknown level is not a gap, it is offered as before. */
export function pilotingGap(required:number|undefined,piloting?:{level:number;xp:number;next_level_xp?:number}):string|null {
  const need=required??0;
  if(!need||!piloting)return null;
  const have=piloting.level;
  if(have>=need)return null;
  return `needs Piloting ${need}, you have ${have}${piloting.next_level_xp?` (xp ${piloting.xp}/${piloting.next_level_xp})`:''}`;
}

/** A trade-run spread, which is the only kind J6 means: buy here at the ask, sell at the best
 * bid a book read on an earlier visit shows, with depth on both ends. The game publishes no
 * cross-station prices (see `market.ts`), so the far end is this runtime's market memory; with
 * no memory there is no spread, which is the same answer J6 gives today. */
function bestSpread(here:Map<string,Book>,at:string,now:number,runtime?:string):NonNullable<Facts['observed']['spread']>|undefined {
  return (runtime?knownBooks(runtime):[]).filter(book=>book.base_id!==at)
    .flatMap(book=>book.items.map(far=>({far,base_id:book.base_id,age:ticksOld(book.tick,now)})))
    .flatMap(({far,base_id,age})=>{
      const mine=here.get(far.item_id);
      // Depth on both ends: an ask nobody is filling and a bid for nothing are not a trade.
      return mine&&mine.best_sell>0&&mine.best_sell_qty>0&&far.best_buy_qty>0
        ?[{item_id:far.item_id,base_id,margin:far.best_buy-mine.best_sell,age}]:[];
    }).filter(row=>row.margin>0).sort((a,b)=>b.margin-a.margin)[0];
}

/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A dock ends the engagement (safety.dock
 * says so), so a docked ship observes no threat — otherwise one NPC brawling outside a busy
 * station would hold the menu at safety-only forever, with no rest and no resupply on it.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate — counting them would
 * refuse every job the Hunter woke up to do. Upgrade when the spec names the statuses. */
export function threatsHere(location:ReadinessAccount['state']['location'],docked:string|null):string[] {
  if(docked||!location)return [];
  return [...(location.nearby_players??[]).filter(row=>row.in_combat).map(row=>row.username??row.player_id),
    ...(location.nearby_empire_npcs??[]).filter(row=>row.in_combat).map(row=>row.name??row.npc_id)];
}

/** The facts the rules table reads, assembled from live state and the pilot record. The
 * menu and `jobStop` read them the same way, so what one refuses the other does.
 *
 * The stance decides which counters are worth a round trip: only a Hunter's J8 reads
 * `observed.targets`, only a Carrier's J4/J5 read the board, only a Trader's J6 reads a
 * spread, so those reads are behind the stance that consumes them and a menu build costs the
 * same as before for everyone else. Every one of them is a `look`: a counter that refuses
 * leaves its field absent, which is the answer the rule already gave before it was wired.
 * So are the refresh (the cached state stands), `get_system` (no sites), `get_base` (no counters, no posted prices) and
 * the route quote (no sites). */
export const factsNowEffect=(account:ReadinessAccount,who:Pilot,runtime?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  yield* section('refresh',game.refresh);
  const {location,ship,player}=account.state;
  const system=Option.getOrUndefined(yield* look('spacemolt/get_system'));
  const pois=each('get_system','poi',field(field(system,'system'),'pois'),decodePoi);
  const docked=location?.docked_at??null;
  const kind:Facts['place']['kind']=docked?'base':location?.poi_id?'poi':'space';
  const counters:CounterName[]=[];
  let service_prices:{fuel?:number;hull?:number}|undefined,workshop=false;
  const base=docked?Option.getOrUndefined(yield* look('spacemolt/get_base')):undefined;
  if(base!==undefined) {
    const fuel=num(base,'fuel_price_all_in'),hull=num(field(base,'base'),'repair_price_per_hull');
    // A posted price is an estimate, never the counter's existence: `repair_price_per_hull` is
    // owner-set on player stations, so an ordinary station posts none and repairs anyway. What
    // the counter runs is `services`.
    service_prices={...fuel!==undefined&&Number.isFinite(fuel)?{fuel}:{},...hull!==undefined&&Number.isFinite(hull)?{hull}:{}};
    const listed=field(base,'services'),services=(Array.isArray(listed)?listed:[]).map(String);
    if(services.includes('refuel')||services.includes('repair'))counters.push('Services');
    if(services.includes('storage'))counters.push('Storage');
    // The bench J7 needs is the same fact as the counter that reaches it, read once.
    workshop=services.includes('crafting');
    if(workshop)counters.push('Workshop / recipes');
    if(services.includes('shipyard'))counters.push('Hangar / refit');
  }
  let quoted=NaN;
  if(location?.system_id&&!location.in_transit)
    quoted=Number(field(Option.getOrUndefined(yield* look('spacemolt/find_route',{id:location.system_id})),'estimated_fuel'));
  const sites=Number.isFinite(quoted)?pois.filter(poi=>poi.id!==location?.poi_id).map(poi=>({
    poi_id:poi.id,quoted_fuel:quoted,
    ...poi.type==='asteroid_belt'?{resource:poi.type}:{},
    ...poi.base_id?{serviced_base:true}:{}})):[];

  const observed:Facts['observed']={},board:NonNullable<Facts['place']['board']>={};
  const threats=threatsHere(location,docked);
  if(threats.length)observed.threats=threats;
  // Seated berths are the passengers aboard: `total - free` per class, already in the ship
  // section, so J5's own half of its question costs nothing.
  const aboard=Object.values(ship?.berths??{}).reduce((n,row)=>n+(row.total-row.free),0);
  if(who.stance==='Hunter') {
    // One read, and only for the stance that acts on it. Declined for the same two reasons
    // `hunt` declines a creature, so a target on the menu is one the loop will take.
    const near=Option.getOrUndefined(yield* look('spacemolt/get_nearby'));
    const legal=each('get_nearby','creature',field(near,'creatures'),decodeCreature).filter(row=>!row.in_combat&&!row.branded);
    // The juncture is where the choice to engage is made, so what memory knows about fighting
    // this thing rides along with its name — the same string the `hunt` row's `why` repeats.
    // A creature never fought before stays a bare name: there is nothing measured to say.
    const fought=readCombat(runtime);
    if(legal.length)observed.targets=legal.map(row=>{
      const stats=statsFor(fought,row.name);
      return stats?`${row.name} — ${combatLine(stats)}`:row.name;
    });
  }
  if(who.stance==='Carrier'&&docked) {
    const listed=Option.getOrUndefined(yield* look('spacemolt_shipping/list',{sort:'reward'}));
    const contracts=each('shipping/list','shipment',field(listed,'shipments'),decodeShipment).filter(row=>row.eligible!==false).map(row=>({id:row.contract.id,
      cargo:PACKAGE_CARGO,liability:row.contract.reserved_exposure??row.contract.appraised_value??0}));
    if(contracts.length)board.contracts=contracts;
    const platform=Option.getOrUndefined(yield* look('spacemolt/list_station_passengers'));
    const waiting=rows(field(platform,'waiting')).length;
    if(waiting)board.passengers=waiting;
  }
  if(who.stance==='Trader'&&docked) {
    // The reply carries the tick the ages are measured against, so it is kept, not discarded.
    const reply=Option.getOrUndefined(yield* look('spacemolt_market/view_market'));
    const here=reply===undefined?undefined:new Map(each('view_market','item',field(reply,'items'),decodeBook).map(row=>[row.item_id,row]));
    const spread=here&&bestSpread(here,docked,Number(field(reply,'current_tick')??0),runtime);
    if(spread)observed.spread=spread;
  }
  return {
    ...who.stance?{stance:who.stance}:{},
    mood:who.mood??'Cautious',
    place:{kind,...docked?{base_id:docked}:{},
      counters,workshop,
      ...service_prices?{service_prices}:{},sites,
      ...board.contracts||board.passengers?{board}:{}},
    // An unread ship is NaN, which compares false to everything as the absent field did.
    holdings:{fuel:ship?.fuel??NaN,max_fuel:ship?.max_fuel??NaN,
      hull:ship?.hull??NaN,max_hull:ship?.max_hull??NaN,
      cargo_free:(ship?.cargo_capacity??0)-(ship?.cargo_used??0),credits:player?.credits??0,
      inputs:Array.isArray(account.state.cargo)?[...new Set(account.state.cargo.map(row=>String(row.item_id)))]:[]},
    // Nothing in the rules table reads `obligations.contracts`, so nothing fills it; the
    // berths J5 asks about are the one obligation a rule consumes.
    obligations:aboard?{passengers:aboard}:{},permissions:who.permissions??{},observed,
  };
});

/** What a verdict's own call serves, keyed by the barrel function it names. The verdict decides
 * whether the move is admissible and says why; this only labels it for the pilot. A call with no
 * row here is not offered — a move the menu cannot tag is one nobody decided what it was for. */
const SERVES:Record<string,Advances>={goTo:'knowledge',service:'ship',
  prices:'credits',storage:'knowledge',recipes:'knowledge',shipsForSale:'ship',missions:'credits',
  freightBoard:'credits',haul:'credits',carryPassengers:'credits',spreads:'credits',
  hunt:'objective',gatherUntil:'credits'};
/** Calls that only read. They spend nothing and start nothing, which makes them the floor of the
 * menu: worth offering when there is room, never worth offering over work. */
const READ_CALLS=new Set(['prices','storage','recipes','shipsForSale','missions','freightBoard','spreads']);
/** Verdict calls the menu builds for itself, with facts the rules table does not have: POI
 * positions for the nearest habitat, and this runtime's sighting memory. The verdict's own call
 * would name a different site off `Facts.place.sites`, so two rows would disagree about where to
 * go — and the one built here knows more. */
const MENU_OWNS=new Set(['gatherUntil','hunt']);

/** Where fauna has been seen, as a PREFERENCE and never a filter. Hunting needs somewhere to look,
 * not a particular kind of rock, and every type we have not yet seen fauna in is a habitat a
 * whitelist wrongly excludes. Live 2026-09-25: the only fauna in the region was in a `nebula`,
 * which the old `/belt|field|cloud/` filter did not match, so a Hunter could never be sent there —
 * while `combat/README.md` had documented "exotics in nebulae" all along.
 *
 * Mining keeps its typing: a gather needs ore, so a planet is genuinely wrong for it. This ordering
 * is only about which places to try first when looking for something alive. */
const HABITAT_FIRST=/nebula|cloud|belt|field|asteroid/;
const lit=(value:unknown)=>JSON.stringify(value).replace(/"/g,"'").replace(/'(\w+)':/g,'$1:');
/** The loop that trains a skill, by the lib's `SkillProgress.category` or the skill id. */
const TRAINS:[RegExp,string][]=[[/mining/,'gatherUntil'],[/trad|commerce/,'sell'],[/navigation|piloting|explor/,'goTo'],
  [/weapon|gunnery|tactic|xeno|combat|bounty/,'hunt'],[/engineer/,'refit']];
const LEADS:Record<string,string>={Prospector:'gatherUntil',Trader:'tradeRun',Hunter:'hunt',Scout:'goTo',Carrier:'acceptMission',Industrialist:'refit'};
/** The call the pilot's own words name as the work. The objective and the goal decide; the
 * stance is the fallback. A Hunter told to cull fauna was offered gatherUntil and selling and
 * no hunt at all, every line tagged [credits]: the menu answered the belt, not the orders. */
/** Every alternative is anchored at a word start. Unanchored, `kill` matched "skill" and `ore`
 * matched "before", "store" and "explore", so "train every skill to level 5" read as a hunting
 * objective (live, 2026-09-24) — the earliest match in that whole sentence was `kill` at index 13.
 * `visit` matched only "unvisited" there, which `explor` catches anyway. Suffixes stay free, which
 * is the stemming these words rely on ("hunts", "trading", "exploration"); "mining" is spelled out
 * because `mine` never matched it. */
const OBJECTIVES:[RegExp,string][]=[[/\b(?:hunt|fauna|creature|kill|cull|bounty|pirate)/,'hunt'],
  [/\b(?:mine|mining|ore|gather|prospect)/,'gatherUntil'],[/\b(?:haul|courier|freight|package)/,'haul'],
  [/\b(?:explor|scout|survey|visit|map)/,'goTo'],[/\b(?:trade|sell|market)/,'sell']];
export const leadCall=(who:Pilot):string=>{
  const text=`${who.objective??''} ${who.goal??''}`.toLowerCase();
  // The phase the pilot's own words name first wins, by where the match lands in the text rather
  // than by which pattern sits earliest in the array. Orders that read "close the gaps in this
  // order: a gatherUntil mining trip → sell → exploreNearby → hunts → a pirate fight" name five
  // careers, and the lead is the one they put first.
  // ponytail: position only. A career mentioned to be ruled out ("no hunting today") still leads,
  // and a goal read after the objective counts as later text. Upgrade when the orders need
  // negation or weighting — an intent parser is not wanted here.
  const hit=OBJECTIVES.map(([re,call])=>({call,at:text.search(re)})).filter(row=>row.at>=0)
    .sort((a,b)=>a.at-b.at)[0];
  return hit?.call??LEADS[who.stance??'']??'';
};
/** ponytail: how far the menu offers an unvisited system as a goTo; beyond it the nearest is
 * named under not_now. Tunable. */
const EXPLORE_JUMPS=5;
const FITS:Record<string,string[]>={Prospector:['gatherUntil','goTo'],Hunter:['hunt','goTo'],Scout:['goTo'],Carrier:['haul','goTo'],
  Trader:['tradeRun','goTo','haul'],Industrialist:['gatherUntil','goTo']};

type Klass=NonNullable<Effect.Success<ReturnType<typeof catalogClassEffect>>>;
/** The menu from where the ship stands: the present in one read, the last ten runs, the
 * skills, the store, and when docked the board, the market and the yard. At most five
 * moves, ranked with the move that clears a stated blocker first, then to break the repetition
 * seen, then by what the goal names, then by what similar runs measured. */
export const menuEffect=(runtime?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  const who=pilot(),moves:Move[]=[],not_now:Menu['not_now']=[];
  const runs=runtime?recentRuns(runtime):[];
  const stagnation=menuDue(runs)??undefined;
  const facts=yield* factsNowEffect(acct(),who,runtime);
  yield* look('spacemolt/get_skills');
  yield* section('refresh',game.refresh);
  const now=present(),{location,ship}=acct().state;
  const docked=location?.docked_at??null;
  const verdicts=evaluateMenu(facts);
  const system=Option.getOrUndefined(yield* look('spacemolt/get_system'));
  const pois=each('get_system','poi',field(field(system,'system'),'pois'),decodePoi);
  // The whole map in one read, walked from here: the jumps to a mission's next base, and the
  // nearest unvisited systems for the explore row below.
  const map=location?.system_id?Option.getOrUndefined(yield* section('spacemolt/get_map',Effect.map(game.command('spacemolt/get_map',{}),reply=>mapOf(replyBody(reply))))):undefined;
  const nearby=map&&location?.system_id?around(map,location.system_id,Infinity,readSeen(runtime)):[];
  // Read fresh: the juncture names every held mission's next step.
  const mine=Option.getOrUndefined(yield* section('spacemolt/get_active_missions',activeEffect()));
  const bases=runtime?readPlaces(runtime):{};
  const jumpsTo=(o:{system_id?:string;target_base?:string})=>{
    const system=o.system_id??bases[o.target_base??''];
    return !system||!map?undefined:system===location?.system_id?0:nearby.find(row=>row.system_id===system)?.jumps;
  };
  const shown=mine?{held:{max:mine.max_missions,missions:mine.active.map(m=>({title:m.title,next:nextStep(m,jumpsTo),
    ...!m.community&&m.expires_in_ticks>0?{expires_at:new Date(Date.now()+m.expires_in_ticks*TICK_MS).toISOString()}:{}}))}}:{};

  const fuel=ship?.fuel??0;
  const stop=jobStop(facts);
  /** A move that starts work: refused under a threat or a mood that may not start a job. */
  const work=(move:Move)=>stop?not_now.push({move:fnOf(move.call),why:stop}):moves.push(move);
  /** The fuel refusal the last `flies` produced, if any. A pilot that cannot reach anywhere it
   * was offered needs the way to a counter, whatever the mood — the wedge that stranded the
   * pilot on 2026-09-24 was an Aggressive one, too far above reserve 12 for Tired to fire.
   * A route is reachable when the tank covers it; the reserve is where Tired begins, not a margin. */
  let shortFuel='';
  const flies=(id:string)=>Effect.gen(function*() {
    const quote=Option.getOrUndefined(yield* look('spacemolt/find_route',{id}));
    if(!field(quote,'found'))return `no route to ${id}`;
    const need=Number(field(quote,'estimated_fuel'));
    if(fuel>=need)return null;
    shortFuel=`fuel ${fuel}, the route to ${id} needs ${need}`;
    return shortFuel;
  });

  const full=!!ship&&ship.cargo_used>=ship.cargo_capacity;
  const cells=cellReserve(acct().state);
  if(docked&&cells.due)moves.push({call:'service()',why:`fuel cells ${cells.held}/${cells.target}: service() tops them up to 5% of the hold`,advances:'ship'});
  /** Calls that clear a blocker the menu also states under `not_now`; ranked above everything
   * else, because a move that unblocks three jobs is worth more than the best of the three. */
  const unblocks=new Set<string>();
  /** Calls that cannot be a repeat of any run: a goTo to a system never visited. */
  const fresh=new Set<string>();

  // Sell what you hold where there is a bid.
  const market=docked?Option.getOrUndefined(yield* look('spacemolt_market/view_market')):undefined;
  const book=market===undefined?undefined:new Map(each('view_market','item',field(market,'items'),decodeBook).map(row=>[row.item_id,row]));
  const tick=Number(field(market,'current_tick')??0);
  /** The best remembered bid for an item at a base other than here, with its age. Hoisted above
   * the sell rows so a lower local bid can say a better one was seen elsewhere, and reused below
   * for the strand search, which is where this was first written. */
  const books=docked&&book?knownBooks(runtime):[];
  const far=(item_id:string)=>bestFarBid(books,item_id,docked,tick);
  /** One sell row's line: the local bid, the local ask when the counter posts one (it is
   * information, not an offer to buy), and a remembered bid elsewhere when it beats the local
   * one. Live: the menu named only "bids 1" and never said the counter itself was asking 180 for
   * the same item, or that another base remembered a better bid. */
  const sellLine=(item_id:string,quantity:number,local:Book)=>{
    const ask=local.best_sell>0?`, asks ${local.best_sell} here`:'';
    const elsewhere=far(item_id);
    const beats=elsewhere&&elsewhere.best_buy>local.best_buy
      ?`; ${elsewhere.base_id} bid ${elsewhere.best_buy} ${elsewhere.age} ticks ago`:'';
    return `${quantity} ${item_id} bids ${local.best_buy}${ask}${beats}`;
  };
  const hold=(acct().state.cargo??[]).filter(row=>row.quantity>0);
  const bids=hold.flatMap(row=>{const local=book?.get(row.item_id);return local&&local.best_buy>0?[{row,local}]:[];});
  const bidRows=new Set(bids.map(bid=>bid.row));
  if(bids.length) {
    const call=`sell(${lit(bids.map(({row})=>({item_id:row.item_id,quantity:row.quantity})))})`;
    moves.push({call,why:`${bids.map(({row,local})=>sellLine(row.item_id,row.quantity,local)).join(', ')} at ${docked}`,advances:'credits'});
    if(full)unblocks.add(call);
  }
  const store=docked?Option.getOrUndefined(yield* look('spacemolt_storage/view')):undefined;
  const inStore=each('storage/view','item',field(store,'items'),decodeStored);
  const stored=inStore.flatMap(row=>{const local=book?.get(row.item_id);return row.quantity>0&&local&&local.best_buy>0?[{row,local}]:[];});
  if(stored.length)moves.push({call:`sell(${lit(stored.map(({row})=>({item_id:row.item_id})))}, {from:'store'})`,
    why:`the store here holds ${stored.map(({row,local})=>sellLine(row.item_id,row.quantity,local)).join(', ')}`,advances:'credits'});
  // Goods with no bid here, aboard or in the store here, and a remembered book elsewhere that bids
  // for them: every stance strands ore this way. Live 2026-09-24: 63 units stowed at
  // sirius_observatory_station, which bids for none of them, and no move ever pointed further.
  // `tradeRun({stops:[{at}]})` delivers what is aboard there; a stored row is taken out of the store
  // here first, as the first stop's `buy` with `from:'store'`.
  if(docked&&book) {
    const strand=[...hold.filter(row=>!bidRows.has(row)).map(row=>({item_id:row.item_id,quantity:row.quantity,from:'hold' as const})),
      ...inStore.filter(row=>row.quantity>0&&!((book.get(row.item_id)?.best_buy??0)>0)).map(row=>({item_id:row.item_id,quantity:row.quantity,from:'store' as const}))];
    const priced=strand.map(row=>({row,buyer:far(row.item_id)})).filter(({row},i,all)=>
      all.findIndex(other=>other.row.item_id===row.item_id)===i);
    const unknown=priced.filter(row=>!row.buyer).map(({row})=>`${row.quantity} ${row.item_id}${row.from==='store'?' (stored)':''}`);
    if(unknown.length)not_now.push({move:'sell',why:`no bid at ${docked} and no remembered book bids for ${unknown.slice(0,5).join(', ')}; goTo another base and prices() there to learn one`});
    // ponytail: the two most valuable, one find_route each. Widen when a menu has room for more.
    const offered=new Set<string>();
    const bought=priced.flatMap(({row,buyer})=>buyer?[{row,buyer}]:[]);
    for(const {row,buyer} of bought.sort((a,b)=>
      b.buyer.best_buy*Math.min(b.buyer.best_buy_qty,b.row.quantity)-a.buyer.best_buy*Math.min(a.buyer.best_buy_qty,a.row.quantity)).slice(0,2)) {
      const call=`tradeRun(${lit({stops:[...row.from==='store'?[{at:docked,buy:row.item_id,from:'store'}]:[],{at:buyer.base_id}]})})`;
      if(offered.has(call))continue;
      offered.add(call);
      const blocked=yield* flies(buyer.base_id);
      if(blocked){not_now.push({move:call,why:blocked});continue;}
      work({call,advances:'credits',why:`${row.quantity} ${row.item_id}${row.from==='store'?' in the store here':' aboard'} has no bid at ${docked}; `
        +`${buyer.base_id} bid ${buyer.best_buy} for ${buyer.best_buy_qty} in a book remembered ${buyer.age} ticks old — the book may have moved, and the fuel there is not priced in`});
      if(full&&row.from==='hold')unblocks.add(call);
    }
  }
  // A full hold with no bid here for what fills it: the store is the remedy, and the menu owes
  // the call rather than the diagnosis. Live 2026-09-24: `not_now` read "the hold is full;
  // sell(rows) or stow(rows) first" while sirius_observatory_station bid for none of the 63 units
  // aboard — so the sell was rightly absent, and stow was never a move the menu could offer.
  // Rows with a bid are left to the sell above: selling them pays, stowing them does not.
  const noBid=full?hold.filter(row=>!bidRows.has(row)):[];
  if(noBid.length&&facts.place.counters?.includes('Storage')) {
    const call=`stow(${lit(noBid.map(row=>({item_id:row.item_id})))})`;
    moves.push({call,advances:'ship',
      why:`the hold is full and ${docked} bids for ${bids.length?'none of the rest':'none of it'}; the store here takes ${noBid.map(row=>`${row.quantity} ${row.item_id}`).join(', ')}`});
    unblocks.add(call);
  }

  // Turn in a mission; take a fitting one when a slot is free.
  const active=mine?.active??[];
  const ready=active.filter(m=>m.community?(m.community_percent??0)>=100:m.percent_complete>=100);
  if(ready.length)moves.push({call:'completeMissions()',why:`${ready.length} mission(s) at 100%: ${ready.map(m=>m.title).join(', ')}`,advances:'credits'});
  const free=(mine?.max_missions??5)-active.filter(m=>!m.community&&m.expires_in_ticks>0).length;
  // A full board with nothing completable is a dead end until a slot is freed: name the
  // mission that cannot be finished from here and the call that drops it. It unblocks
  // acceptMission the way stow unblocks sell, so it ranks first rather than being the row the
  // 5-row cap cuts.
  if(free<=0)for(const m of active.filter(row=>!row.community).map(row=>({row,why:stuck(row)})).filter(row=>row.why).slice(0,2)) {
    const call=`abandonMission('${m.row.mission_id}')`;
    work({call,why:`${m.row.title}: ${m.why}; ${active.length} of ${mine?.max_missions??5} active, no slot free`,advances:'objective'});
    unblocks.add(call);
  }
  if(docked) {
    const board=each('get_missions','mission',field(Option.getOrUndefined(yield* look('spacemolt/get_missions')),'missions'),decodeOffered);
    const fits=FITS[who.stance??'']??['gatherUntil','goTo'];
    const fitting=board.filter(m=>!active.some(a=>a.mission_id===m.mission_id)).map(m=>{
      const text=`${m.type} ${(m.objectives??[]).map(o=>o.description??'').join(' ')}`.toLowerCase();
      const fit=/wreck|salvage yard/.test(text)?'':/mine|ore|gather|deliver/.test(text)&&(m.objectives??[]).some(o=>o.item_id)?'gatherUntil'
        :/kill|hunt|creature|destroy/.test(text)?'hunt':/visit|explore|survey|travel|scout/.test(text)?'goTo':/shipment|package|haul|courier/.test(text)?'haul':/\b(?:trade|sell|buy|market)/.test(text)?'tradeRun':'';
      return {m,fit};
    }).filter(row=>fits.includes(row.fit)).slice(0,2);
    // Said once, whatever the board holds: a full board is one fact, not one per fitting mission.
    if(fitting.length&&free<=0)
      not_now.push({move:'acceptMission',why:`no slot free: ${active.length} of ${mine?.max_missions??5} active${ready.length?'':', none completable'}`});
    for(const {m,fit} of fitting)if(free>0)
      work({call:`acceptMission('${m.mission_id}')`,why:`${m.title}, ${m.rewards?.credits??0} cr, fits ${fit}`,advances:'credits'});
  }

  // A Trader's run: buy here at the ask, sell at the far bid the J6 spread names. J6 is the gate;
  // a refused or absent spread is said under not_now, never dropped. A full hold is no refusal:
  // `tradeRun` plans from the hold it has, selling here what pays better here first.
  if(who.stance==='Trader'&&docked) {
    const j6=verdicts.find(v=>v.job.startsWith('J6')),spread=facts.observed.spread;
    if(!spread)not_now.push({move:'tradeRun',why:j6?.reason??'no quoted spread with depth on both ends'});
    else if(j6&&!j6.admissible)not_now.push({move:'tradeRun',why:j6.reason});
    else work({call:`tradeRun(${lit({stops:[{at:docked,buy:spread.item_id},{at:spread.base_id}]})})`,advances:'credits',
      why:`${spread.margin} cr a unit on ${spread.item_id} at ${spread.base_id}, a bid remembered ${spread.age} ticks old; the book may have moved, and the fuel there is not priced in`});
    // The search, not the menu's to run: routes() costs a map read and up to ~6 find_route calls.
    // Whatever the hold: every route is planned from it.
    work({call:'routes()',advances:'credits',
      why:'ranks every known route of up to 3 stops, from the hold you have, by net per jump after book depth, fuel and tax; each row carries a pasteable next call. The trading README\'s "the best trade known" acts on the top row in one run'});
    // Books nobody has read lately, near: a route is only ever planned over a book someone read, and
    // the ledger covers a fraction of the stations. Knowledge, so it ranks under the trades above.
    const near=Option.getOrElse(yield* section('scoutMarkets',candidatesEffect(pilotSeat(),Number(field(market,'current_tick')??0))),():Candidate[]=>[]);
    const first=near[0];
    if(first) {
      const blocked=yield* flies(target(first));
      const count=(kind:Candidate['kind'])=>near.filter(row=>row.kind===kind).length;
      if(blocked)not_now.push({move:'scoutMarkets()',why:blocked});
      else work({call:'scoutMarkets()',advances:'knowledge',
        why:`within ${SCOUT_JUMPS} jumps: ${count('unknown')} base(s) never read, ${count('unexplored')} system(s) never listed, ${count('stale')} book(s) older than ${IGNORE_TICKS} ticks; `
          +`the nearest is ${target(first)} (${first.kind}, ${first.jumps} jump(s)). It reads up to 3 and files them, for routes() to plan over`});
    }
  }

  // Freighters re-plan themselves when a ring drains; the one thing left to the pilot is stopping one.
  // Said, not offered: it earns nothing, and the rows ride on the juncture as `freighters`.
  if(runtime) {
    const flying=Object.entries(readFleet(runtime)).filter(([,entry])=>(entry.state==='running'||entry.state==='waiting'||entry.state==='scouting')&&!entry.stop_after_lap);
    const [soonest]=flying;
    if(soonest)not_now.push({move:`recall('${soonest[0]}', {after:'lap'})`,
      why:`${flying.map(([name])=>name).join(', ')} fl${flying.length===1?'ies':'y'} and re-plan${flying.length===1?'s':''} on a drained ring by itself; this stops one after the lap it is on`});
  }

  // Mine the nearest belt.
  const here=pois.find(p=>p.id===location?.poi_id);
  const dist=(p:Poi)=>Math.hypot((p.position?.x??0)-(here?.position?.x??0),(p.position?.y??0)-(here?.position?.y??0));
  const belt=pois.filter(p=>/belt|field|cloud/.test(p.type)).sort((a,b)=>dist(a)-dist(b))[0];
  if(belt) {
    // `gatherUntil` settles the take at a base and refuses outright without one: `base` falls
    // back to `docked_at`, and out at a POI there is none (mining.ts). So the base is named in
    // the call the menu offers — a row emitted without it cost a whole live juncture to the
    // refusal "no base to return to" (2026-09-25). Docked, that is where the ship stands;
    // undocked, the nearest station in this system, which is where the trip would settle anyway.
    const home=docked??pois.filter(poi=>poi.base_id).sort((a,b)=>dist(a)-dist(b))[0]?.base_id;
    const blocked=full?'the hold is full; sell(rows) or stow(rows) first'
      :(yield* flies(belt.id))??(home?null:'no base to settle the take at: dock, or name the base the trip returns to');
    if(blocked)not_now.push({move:'gatherUntil',why:blocked});
    else work({call:`gatherUntil({poi:'${belt.id}',base:'${home}'})`,why:`${belt.type} ${belt.name}, ${(ship?.cargo_capacity??NaN)-(ship?.cargo_used??NaN)} free in the hold, settling at ${home}`,advances:'credits'});
  }

  // Hunt when the orders say hunt. Fauna is not knowable before arrival — POI rows carry no fauna
  // field and `get_nearby` answers only for where the ship stands — so the offer is a prey and a
  // RANGE of places to look, never one place asserted to hold prey. `hunt` flies each in turn and
  // stops at the first with the quarry in it, so a dock is no blocker.
  const lead=leadCall(who);
  if(lead==='hunt') {
    // J8 reads `observed.targets`; so does the claim here, so the menu cannot assert a creature
    // the same build's verdict says is not known.
    const seen=facts.observed.targets??[];
    const poi=location?.poi_id??'this poi';
    if(!docked&&seen.length)
      work({call:'hunt()',why:`the objective names hunting; ${seen.join(', ')} at ${poi} is legal to engage`,advances:'objective'});
    else {
      // What this runtime remembers of each habitat, and how old it is. A habitat remembered
      // EMPTY and recently enough to still be believed is dropped from the list: sending the
      // pilot back to a rock it looked at an hour ago is the guess-dressed-as-knowledge that
      // makes an empty shift our fault rather than the world's. A remembered absence that has
      // aged past its bound reads `stale` and goes back on the list — `recall` governs absences
      // more strictly than presences for exactly this reason (sighting-memory.ts).
      const sightings=runtime?readSightings(runtime):[];
      const reach:{name:string;id:string;note:string}[]=[],emptied:string[]=[];
      // Every POI in the system, the types fauna is known for first, then by distance — which is
      // fuel. Nothing is excluded: a planet is a worse bet than a nebula, not an impossible one.
      //
      // Where the ship already stands leads the list when it is out at a POI, because looking there
      // costs no fuel at all and `hunt` will move on by itself if it is empty. That is strictly
      // better than the old `hunt()` with no list, which looked once and stopped.
      const at=docked?null:location?.poi_id??null;
      const byPromise=(a:Poi,b:Poi)=>
        (a.id===at?0:1)-(b.id===at?0:1)
        ||(HABITAT_FIRST.test(a.type)?0:1)-(HABITAT_FIRST.test(b.type)?0:1)||dist(a)-dist(b);
      for(const habitat of [...pois].sort(byPromise)) {
        // Docked, the station POI under the ship is not a place to fly to.
        if(docked&&habitat.id===location?.poi_id)continue;
        const known=recall(sightings,habitat.id);
        if(known.state==='seen'&&known.count===0) {
          emptied.push(`${habitat.name} was empty ${known.ticks_old}t ago`);
          continue;
        }
        if(yield* flies(habitat.id))continue;
        reach.push({name:habitat.name,id:habitat.id,
          note:known.state==='seen'?`${known.count} seen ${known.ticks_old}t ago`
            :known.state==='stale'?`last looked at ${known.ticks_old}t ago, too old to trust`
            :'never looked at'});
        if(reach.length>=3)break;
      }
      if(reach.length)
        work({call:`hunt({look:[${reach.map(row=>`'${row.id}'`).join(',')}]})`,advances:'objective',
          why:`the objective names hunting; ${reach.map(row=>`${row.name} (${row.note})`).join(', ')} — hunt looks at each in turn and fights where the prey is${docked?`, flying from ${docked}`:''}`});
      else if(!docked)
        work({call:'hunt()',advances:'objective',
          why:`the objective names hunting; ${emptied.length?`nothing else in ${location?.system_id??'this system'} is worth the fuel (${emptied.join('; ')})`:`nothing scanned at ${poi} yet`} — hunt() reads what is there and spends nothing on an empty habitat`});
      else not_now.push({move:'hunt',why:emptied.length
        ?`every place in ${location?.system_id??'this system'} is remembered empty (${emptied.join('; ')}); goTo a system with unlooked ones`
        :shortFuel||`nothing in ${location?.system_id??'this system'} is reachable to look at from ${docked}; goTo another system`});
    }
  }

  // Explore: the nearest unvisited system, however far. Live 2026-09-30 (kvothe): told to explore,
  // it made 41 jumps between systems it had already visited, because this row looked only at the
  // first three neighbours and said nothing when they were all visited. Danger is the pilot's call:
  // every candidate carries its facts, and none is dropped for them.
  const unvisited=nearby.filter(row=>!row.visited);
  const first=unvisited[0];
  if(!first)not_now.push({move:'goTo',why:nearby.length?`every system on the map is visited (${nearby.length} reachable)`
    :!map?'the map was not read'
    :map.some(row=>row.system_id===location?.system_id)?`no system on the map is reachable from ${location?.system_id}`
    :`${location?.system_id??'this system'} is not on the map (${map.length} systems read)`});
  else if(first.jumps>EXPLORE_JUMPS)not_now.push({move:`goTo('${first.system_id}')`,
    why:`nothing unvisited within ${EXPLORE_JUMPS} jumps; the nearest is ${first.name} (${nearFacts(first)})`});
  else {
    const call=`goTo('${first.system_id}')`,blocked=yield* flies(first.system_id);
    const also=unvisited.slice(1,3).map(row=>`${row.name} '${row.system_id}' (${nearFacts(row)})`);
    if(blocked)not_now.push({move:call,why:blocked});
    else {
      work({call,advances:'knowledge',why:`${first.name} (${nearFacts(first)}); scout() there. `
        +`${also.length?`Next nearest: ${also.join('; ')}. `:''}exploreNearby() visits and scouts them in one run`});
      fresh.add(call);
    }
  }

  // Upgrade the hull when the budget covers a listing plus the reserve.
  const credits=now.credits,creditReserve=who.permissions?.credit_reserve??0;
  const budget=credits-creditReserve;
  if(docked&&facts.place.counters?.includes('Hangar / refit')&&budget>0) {
    const listings=each('browse_ships','listing',field(Option.getOrUndefined(yield* look('spacemolt_ship/browse_ships',{max_price:budget})),'listings'),decodeListed);
    // What Piloting the pilot has — the live journal keys the skill `piloting`. Live: a Tier 2
    // listing was offered every juncture and the server refused it outright —
    // `skill_required: Flying a Tier 2 ship requires Piloting level 10 (you have 9)` —
    // which `catalogClass.piloting_required` says in advance and costs nothing extra to read.
    const piloting=now.skills.piloting;
    let best:{listing:Listed;klass:Klass}|undefined,gapped:{listing:Listed;klass:Klass;gap:string}|undefined;
    for(const listing of listings.filter(row=>row.price<=budget).slice(0,3)) {
      const klass=Option.getOrUndefined(yield* section('catalogClass',catalogClassEffect(listing.class_id)));
      if(!klass||(klass.cargo_capacity??0)<=(ship?.cargo_capacity??0))continue;
      const gap=pilotingGap(klass.piloting_required,piloting);
      if(gap) {
        if(!gapped||(klass.cargo_capacity??0)>(gapped.klass.cargo_capacity??0))gapped={listing,klass,gap};
        continue;
      }
      if(!best||(klass.cargo_capacity??0)>(best.klass.cargo_capacity??0))best={listing,klass};
    }
    if(best)work({call:`buyShip('${best.listing.listing_id}', {switchTo:true})`,
      why:`${best.klass.name} ${best.listing.price} cr, cargo ${ship?.cargo_capacity}→${best.klass.cargo_capacity}; ${credits} cr less reserve ${creditReserve} covers it`,advances:'ship'});
    else if(gapped)not_now.push({move:`buyShip('${gapped.listing.listing_id}')`,
      why:`${gapped.klass.name} ${gapped.listing.price} cr, cargo ${ship?.cargo_capacity}→${gapped.klass.cargo_capacity}; ${gapped.gap}`});
  }

  // Refit: a module in the hold or this base's store that is not fitted. `refit` withdraws a
  // stored id itself (hangar.ts), so the store's own row is offered directly rather than a
  // withdraw the pilot would have to paste first. Live: 5 cargo_expander_i sat in the store and
  // the menu only ever scanned the hold, so the sell move took them instead.
  if(docked) {
    const fitted=acct().state.modules??[];
    const candidates=[...hold.filter(r=>!fitted.some(m=>m.type_id===r.item_id)).map(row=>({row,from:'hold' as const})),
      ...inStore.filter(row=>row.quantity>0&&!fitted.some(m=>m.type_id===row.item_id)&&!hold.some(h=>h.item_id===row.item_id))
        .map(row=>({row,from:'store' as const}))].slice(0,6);
    for(const {row,from} of candidates) {
      const spec=Option.getOrUndefined(yield* section('moduleSpec',moduleSpecEffect(row.item_id)));
      if(!spec)continue;
      const why=whyNotFit(spec,bench());
      if(why)not_now.push({move:`refit({install:['${row.item_id}']})`,why});
      else moves.push({call:`refit({install:['${row.item_id}']})`,
        why:`${spec.name} is ${from==='store'?'in the store here':'in the hold'} and unfitted (${spec.slot} slot free)`,advances:'ship'});
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

  // Everything else the rules already worked out. `evaluateMenu` produces roughly fifteen
  // verdicts and the menu used to consume one of them; the rest were computed and thrown away
  // while this function re-derived a narrower picture inline. A verdict is offerable when it is
  // admissible AND carries a `play` — the barrel line the pilot pastes. The rows with no `play`
  // stay unsaid on purpose: the three `safety` rows have no primitive behind them at all (there
  // is no `watch`, `dock`, `retreat` or `undock`, and `disengage()` answers a different
  // question), and inventing one would hand the pilot code that does not compile.
  /** Calls that are this stance's own J-numbered job. A Carrier's freight and passengers, a
   * Trader's spread: the work the stance exists to do, which must not be crowded off the menu by
   * the generic rows every stance gets. A Hunter offered a mining trip and no hunt at all was the
   * same bug read from the other end (2026-09-24). */
  const stanceWork=new Set<string>();
  /** The rules' own refusals, held back until they can be ranked and capped. `not_now` is prompt
   * budget as much as `moves` is: `shared.travel` refuses once per site, so a single fuel shortfall
   * would otherwise bury the stance row that actually explains why the shift is stuck. */
  const refused:{move:string;why:string;rank:number}[]=[];
  const REFUSAL_RANK:Record<string,number>={stance:0,resupply:1,shared:2,safety:3};
  for(const verdict of verdicts) {
    const fn=verdict.play?.split('(')[0]??'';
    if(!verdict.admissible) {
      // A refused verdict carries no call — `no()` sets no `play` — so the job names it. Deriving
      // the label from `play` meant this branch never fired at all and every rules-table reason
      // was computed and dropped, while `play/README.md` promised the pilot the opposite.
      // `already serviced` is not a refusal worth a line: it is the ship being fine.
      // A refused J6 is said once, by the Trader row above, as the tradeRun it refuses.
      if(!/already at the serviced-dock targets/.test(verdict.reason)&&!(verdict.job.startsWith('J6')&&docked))
        // The job's J-number is the rules table's own key, not a word the game uses: live
        // 2026-09-30 (kvothe), "J9 Price circuit walked" stood in 122 contexts. The pilot reads
        // the name; the number stays in the table and the tests.
        refused.push({move:fn||verdict.job.replace(/^J\d+\s+/,''),why:verdict.reason,rank:REFUSAL_RANK[verdict.tag]??9});
      continue;
    }
    if(!verdict.play||MENU_OWNS.has(fn))continue;
    const advances=SERVES[fn];
    if(!advances)continue;
    // A read is admissible anywhere; work is not. `work` routes it through the same `jobStop`
    // the runner applies, so a threat or a mood that may not start a job refuses it here too.
    const move:Move={call:verdict.play,why:verdict.reason,advances};
    if(verdict.tag==='stance')stanceWork.add(verdict.play);
    if(READ_CALLS.has(fn))moves.push(move);else work(move);
  }

  // A fuel refusal out in the open is the wedge: `service()` refuses undocked, and the rows above
  // are all the shortfall just refused. `serviceElsewhere` is the one code path that names a route
  // to a counter, and it is used rather than the `resupply.travel` verdicts because those carry no
  // pasteable call — `trip()` returns `call:null` and its reason names `travel(ctx,…)`, a script
  // helper, not a barrel call. It unblocks everything the shortfall refused, so it ranks first.
  if(shortFuel&&!docked)for(const row of Option.getOrElse(yield* section('serviceElsewhere',serviceElsewhereEffect()),()=>[])) {
    moves.push({call:row.call,why:`${shortFuel}; ${row.why}`,advances:'ship'});
    unblocks.add(row.call);
  }

  // The rules' refusals, ranked by what they explain and capped. One travel shortfall stands for
  // all of them: five POIs refused for the same missing fuel is one fact, not five.
  const travelSaid=new Set<string>();
  for(const row of refused.sort((a,b)=>a.rank-b.rank)) {
    if(/^Travel to /.test(row.move)) {
      if(travelSaid.size)continue;
      travelSaid.add(row.move);
    }
    if(not_now.some(seen=>seen.move===row.move&&seen.why===row.why))continue;
    if(not_now.length>=6)break;
    not_now.push({move:row.move,why:row.why});
  }

  // Rank: break the repetition first, then the goal's own words, then what similar runs measured.
  const repeated=repeats(runs)>=3?runs.at(-1)?.fn??'':'';
  const goal=`${who.goal??''} ${who.objective??''}`.toLowerCase();
  const wants:Record<Advances,RegExp>={credits:/credit|money|cr\b/,skill:/skill|level|train/,ship:/ship|hull|cargo|upgrade/,
    knowledge:/know|explor|world|visit|scout/,influence:/influence|reputation|faction/,objective:/objective|goal|rest/};
  const gain=(fn:string)=>{const past=runs.filter(r=>r.fn===fn);return past.length?past.reduce((n,r)=>n+r.credits,0)/past.length:0;};
  // Reads rank under work, always. Surfacing more verdicts must not mean a longer menu — the
  // budget is still five rows — so the counters fill the space work leaves rather than competing
  // for it. A read that unblocks something still leads, which is why that term stays first.
  const key=(m:Move):[number,number,number,number,number,number,number]=>{const fn=fnOf(m.call);
    return [unblocks.has(m.call)?1:0,READ_CALLS.has(fn)?0:1,repeated&&(fn!==repeated||fresh.has(m.call))?1:0,
      stanceWork.has(m.call)||fresh.has(m.call)&&lead===fn?1:0,wants[m.advances].test(goal)?1:0,
      LEADS[who.stance??'']===fn?2:who.stance==='Trader'&&fn==='routes'?1:0,gain(fn)];};
  const seen=new Set<string>();
  const ranked=moves.filter(m=>!seen.has(m.call)&&seen.add(m.call)).map(m=>({m,k:key(m)}))
    .sort((a,b)=>b.k[0]-a.k[0]||b.k[1]-a.k[1]||b.k[2]-a.k[2]||b.k[3]-a.k[3]||b.k[4]-a.k[4]
      ||b.k[5]-a.k[5]||b.k[6]-a.k[6])
    .map(({m})=>m).slice(0,5);
  // The tag says what a move serves, and what the objective names serves the objective: the
  // ranking is already settled, so this only corrects the label the pilot reads.
  const tagged=ranked.map(m=>lead&&fnOf(m.call)===lead?{...m,advances:'objective' as const}:m);
  return {...stagnation?{stagnation}:{},moves:tagged,not_now,...shown};
});

/** The menu as text: one line per move with the call in backticks, then what is not on it. */
export function renderMenu(built:Menu):string {
  const out=[`Menu${built.stagnation?` — ${built.stagnation}`:''}:`];
  if(!built.moves.length)out.push('  (nothing to suggest from here)');
  for(const m of built.moves)out.push(`  - \`${m.call}\` — ${m.why} [${m.advances}]`);
  if(built.not_now.length)out.push('Not now:',...built.not_now.map(row=>`  - ${row.move}: ${row.why}`));
  return out.join('\n');
}
