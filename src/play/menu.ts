/** The menu: the few concrete acts open from where the ship stands, each a call the pilot can paste and the raw facts
 * it rests on — credits, minutes, jumps, the age of its books, who issues a mission. Offers, never refusals: nothing
 * here stops a run. Each generator offers at most one move, so the choice is between different kinds of act; they rank
 * by the credits a minute their own facts state, and one slot keeps the move the objective leads with. Reads only, but
 * for the book memory every book read keeps. */
import {Cause,Effect,Exit,Option,Schema,Struct} from 'effect';
import type {ReadinessAccount} from '../readiness.ts';
import {replyBody,rows} from '../storage.ts';
import * as Wire from '../wire.gen.ts';
import {disposable} from '../mining-inventory.ts';
import {readJournal} from '../run-record.ts';
import {TICK_MS} from '../sighting-memory.ts';
import {readPlaces} from './places.ts';
import {Game,field} from './game.ts';
import {activeEffect,caveats,nextStep,stuck} from './missions.ts';
import {acct,defect,pilot,runCalls,step,type Pilot} from './runtime.ts';
import {around,jumpsFrom,mapOf,nearFacts,readSeen} from './exploration/exploration.ts';
import {keptSearch,tickNow} from './trading/trading.ts';
import {holdings,itemView,readBooks,readStores,type Quoted} from './world.ts';
import {literal} from './rows.ts';
import type {Status} from './types.ts';

/** Which generator offered a move. */
export type Gen='route'|'again'|'settle'|'missions'|'explore';
/** One offer: an id within this juncture, the call to paste, its facts as data (journalled), and as words (printed). */
export interface Move {id:string;gen:Gen;call:string;facts:{credits:number;minutes:number}&Record<string,unknown>;said:string}
/** `held` is each active mission led by its next step, for the juncture's Missions block. */
export interface Held {title:string;next:string;expires_at?:string}
export interface Menu {moves:Move[];held?:{max:number;missions:Held[]}}
/** One run as the journal keeps it: the first work call `main()` made, how it ended, what the whole run gained, where the
 * ship ended up, and the work call as written when its job keeps it. Written by `run` into the journal. */
export interface RunSummary {fn:string;arg:string;call?:string;status:Status;credits:number;items:number;xp:number;at?:string}

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
  return {fn:work.fn,arg:work.arg,...work.call?{call:work.call}:{},status:keepWork?work.status:status,
    credits:calls.reduce((n,c)=>n+c.credits,0),
    items:calls.reduce((n,c)=>n+c.items,0),xp:calls.reduce((n,c)=>n+c.xp,0),at:location?.docked_at??location?.poi_id??'?'};
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
/** A call's function name: what is before the first `(`. */
const fnOf=(call:string)=>call.split('(')[0]??'';

/** What the menu reads of a board row: the spec's fields, the ones a choice turns on — reward, issuer, first objective. */
const Offered=Wire.MissionInfo.mapFields(fields=>({mission_id:fields.mission_id,title:Schema.optionalKey(fields.title),
  rewards:Schema.optionalKey(Schema.NullOr(Wire.MissionRewardsInfo_1.mapFields(Struct.pick(['credits'])))),
  giver:Schema.optionalKey(Schema.NullOr(fields.giver)),faction_name:fields.faction_name,issuing_base:fields.issuing_base,
  warnings:fields.warnings,required_modules:fields.required_modules,
  objectives:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ObjectiveInfo_2.mapFields(fields=>({description:Schema.optionalKey(fields.description),
    target_base_id:fields.target_base_id,system_id:fields.system_id,item_id:fields.item_id,quantity:fields.quantity})))))}));
const decodeOffered=Schema.decodeUnknownOption(Offered);
/** A top-level call as `run ended` journals it: what the again-move reads. */
const Called=Schema.Struct({fn:Schema.String,call:Schema.optionalKey(Schema.String),credits:Schema.Number,
  seconds:Schema.optionalKey(Schema.Number),stops:Schema.optionalKey(Schema.Array(Schema.String))});
const decodeCalled=Schema.decodeUnknownOption(Called);

/** Who issues a board mission, as the game reports it: the giver, the faction, the base. */
const issuer=(m:typeof Offered.Type)=>[m.giver?`${m.giver.name}${m.giver.title?` (${m.giver.title})`:''}`:'',m.faction_name??'',m.issuing_base??'']
  .filter(Boolean).join(', ')||'unnamed';

/** What the objective's own words lead with, as a call name. The phase the words name first wins, by where the match lands
 * in the text; the stance is the fallback. Every alternative is anchored at a word start: unanchored, `kill` matched
 * "skill" and `ore` matched "before", "store" and "explore" (live, 2026-09-24).
 * ponytail: position only. A career mentioned to be ruled out ("no hunting today") still leads; an intent parser is not wanted. */
const OBJECTIVES:[RegExp,string][]=[[/\b(?:hunt|fauna|creature|kill|cull|bounty|pirate)/,'hunt'],
  [/\b(?:mine|mining|ore|gather|prospect)/,'gatherUntil'],[/\b(?:haul|courier|freight|package)/,'haul'],
  [/\b(?:explor|scout|survey|visit|map)/,'goTo'],[/\b(?:trade|sell|market|credit|profit)/,'tradeRun'],[/\b(?:mission|contract)/,'acceptMission']];
const LEADS:Record<string,string>={Prospector:'gatherUntil',Trader:'tradeRun',Hunter:'hunt',Scout:'goTo',Carrier:'acceptMission',Industrialist:'craft'};
export const leadCall=(who:Pilot):string=>{
  const text=`${who.objective??''} ${who.goal??''}`.toLowerCase();
  const hit=OBJECTIVES.map(([re,call])=>({call,at:text.search(re)})).filter(row=>row.at>=0).sort((a,b)=>a.at-b.at)[0];
  return hit?.call??LEADS[who.stance??'']??'';
};
/** Whether a move is the kind the objective leads with: its own call, or any mission move for a mission lead. */
const serves=(move:Omit<Move,'id'>,lead:string)=>fnOf(move.call)===lead||lead==='acceptMission'&&move.gen==='missions';

/** ponytail: how far the explore offer reaches. Tunable. */
const EXPLORE_JUMPS=5;
/** ponytail: the again-move looks back this far for a paying call. */
const AGAIN_MS=12*3600_000;
/** The mission calls the missions generator owns: never offered again as a loop. */
const MISSION_FNS=new Set(['acceptMission','abandonMission','completeMissions']);
/** The moves block's size, so it is never what a full context gives up: 4 lines of about 160 characters. */
export const MOVES=4,MOVES_CHARS=640;

/** Minutes a jump and a stop take: the median of this pilot's own `jump`, and `dock` plus `travel`, commands in the journal
 * tail. ponytail: 1.2 and 1 min when the tail has none (kvothe 10-04: a jump 72 s, a dock 13 s, a travel 46 s). */
function pace(lines:readonly Record<string,unknown>[]):{jump:number;stop:number} {
  const median=(action:string,none:number)=>{
    const ms=lines.flatMap(l=>l.event==='command'&&l.action===action&&l.ok===true&&typeof l.ms==='number'?[l.ms]:[]).sort((a,b)=>a-b);
    return ms.length?(ms[Math.floor(ms.length/2)]??0)/60_000:none;
  };
  return {jump:median('jump',1.2),stop:median('dock',0.2)+median('travel',0.8)};
}
const round=(n:number)=>Math.round(n*10)/10;
const cr=(n:number)=>`${n>0?'+':''}${Math.round(n).toLocaleString('en-US')} cr`;
/** A book's age as said: `live` for one read this tick, else ticks, `?` when unknown. */
const ageSaid=(age:number|null|undefined)=>age===null||age===undefined?'?':age<=1?'live':`${age}t`;

/** The menu from where the ship stands. */
export const menuEffect=(runtime?:string)=>Effect.gen(function*() {
  const game=yield* Game;
  const who=pilot();
  yield* section('refresh',game.refresh);
  const {location}=acct().state;
  const docked=location?.docked_at??null,here=location?.system_id;
  const lines=runtime?readJournal(runtime,4000):[];
  const {jump,stop}=pace(lines);
  const minutes=(jumps:number,stops:number)=>round(jumps*jump+stops*stop);
  // The whole map in one read: jumps between any two systems, each system's empire, the nearest unvisited.
  const map=here?Option.getOrUndefined(yield* section('spacemolt/get_map',Effect.map(game.command('spacemolt/get_map',{}),mapOf))):undefined;
  const nearby=map&&here?around(map,here,Infinity,readSeen(runtime)):[];
  const books=readBooks(runtime),places=runtime?readPlaces(runtime):{};
  const systemOf=(base:string)=>base===docked?here:books.find(book=>book.base_id===base)?.system_id??places[base];
  const empireOf=(base:string)=>{const system=systemOf(base);return map?.find(row=>row.system_id===system)?.empire;};
  const jumpsBetween=(a?:string,b?:string)=>a&&b&&map?jumpsFrom(map,a).get(b):undefined;
  const now=tickNow(runtime);
  const bookAge=(base:string)=>{const tick=books.find(book=>book.base_id===base)?.tick;return tick===undefined?null:Math.max(0,now-tick);};
  const offers:Omit<Move,'id'>[]=[];

  // Best route: routes()'s top row, as the pilot would paste it.
  const searched=Option.getOrUndefined(yield* section('routes',keptSearch()));
  const routes=searched?.status==='refused'?[]:searched?.detail.routes??[];
  const top=routes.find(row=>row.total_jumps!==null&&row.net>0);
  if(top) {
    const jumps=top.total_jumps??0,empires=[...new Set(top.legs.flatMap(leg=>empireOf(leg.at)??[]))];
    const ages=top.legs.map(leg=>`${leg.at} ${leg.source==='here'?'live':`${leg.age}t`}`);
    const facts={credits:top.net,minutes:minutes(jumps,top.legs.length),jumps,fuel:top.fuel,books:ages,...empires.length?{empires}:{}};
    // The live book here goes unsaid in the words; the facts keep it.
    const far=top.legs.filter(leg=>leg.source!=='here').map(leg=>`${leg.at} ${leg.age}t`);
    offers.push({gen:'route',call:top.next,facts,
      said:`route: ${cr(top.net)} net, ${jumps} jumps, ~${facts.minutes} min${far.length?`; books ${far.join(', ')}`:''}${empires.length?`; ${empires.join('/')} space`:''}`});
  }

  // Again: the last call that paid, as it was written, with what each of its last runs made and how long it took.
  const cutoff=Date.now()-AGAIN_MS;
  const paid=lines.filter(l=>l.event==='run'&&l.phase==='ended'&&Date.parse(String(l.at))>=cutoff)
    .flatMap(l=>rows(field(l,'calls')).flatMap(row=>Option.toArray(decodeCalled(row))))
    // A loop is a call that takes goods on: one that only sold has nothing left to sell (kvothe 10-05 01:47Z, a sell-only
    // route repeated on an empty hold). Live: what tradeRun's own `next` offers again.
    .filter(c=>c.call&&!MISSION_FNS.has(c.fn)&&/buy:/.test(c.call)&&!c.call.includes("from:'store'"));
  const last=paid.filter(c=>c.credits>0).at(-1);
  if(last?.call) {
    const runs=paid.filter(c=>c.call===last.call).slice(-3);
    const credits=Math.round(runs.reduce((n,c)=>n+c.credits,0)/runs.length),took=round(runs.reduce((n,c)=>n+(c.seconds??0),0)/runs.length/60);
    const ages=(last.stops??[]).map(base=>`${base} ${ageSaid(bookAge(base))}`);
    offers.push({gen:'again',call:last.call,facts:{credits,minutes:took,runs:runs.map(c=>({credits:c.credits,minutes:round((c.seconds??0)/60)})),...ages.length?{books:ages}:{}},
      said:`again: last ${runs.length}: ${runs.map(c=>`${cr(c.credits)} in ${round((c.seconds??0)/60)} min`).join(', ')}${ages.length?`; books now ${ages.join(', ')}`:''}`});
  }

  // Settle what you hold: goods aboard or in any store, at the best bid known for them, when it beats the fuel there.
  const fuelPrice=docked?Number(field(Option.getOrUndefined(yield* look('spacemolt/get_base')),'fuel_price_all_in')??1):1;
  const priced=routes.find(row=>(row.total_jumps??0)>0&&row.fuel!==null);
  let fuelPerJump=priced?(priced.fuel??0)/(priced.total_jumps??1):undefined;
  /** A good to settle: aboard (no `from`) or stored at `from`, with the best bid known for it. */
  type Good={item_id:string;quantity:number;from?:string;bid:Quoted|null};
  const goods:Good[]=[...Object.entries(disposable(acct().state)).filter(([,quantity])=>quantity>0)
    .map(([item_id,quantity])=>({item_id,quantity,bid:itemView(runtime,item_id,quantity,now).bids[0]??null})),
    ...holdings(runtime,now).map(row=>({item_id:row.item_id,quantity:row.quantity,from:row.base_id,bid:row.bid}))];
  // A jump's fuel from the route rows, else one route quote to a far bidder.
  const away=goods.find(row=>row.bid&&row.bid.base_id!==docked)?.bid;
  if(fuelPerJump===undefined&&away)fuelPerJump=Number(field(Option.getOrUndefined(yield* look('spacemolt/find_route',{id:away.base_id})),'fuel_per_jump'))||0;
  const settled=goods.flatMap(row=>{
    const bid=row.bid;
    if(!bid||!(bid.price>0))return [];
    // A stored good sold at its own base needs that dock; anywhere else it is carried there first.
    if(row.from&&row.from===bid.base_id&&row.from!==docked)return [];
    const via=row.from??docked??undefined,jumps=(jumpsBetween(here,systemOf(via??''))??0)+(jumpsBetween(systemOf(via??''),systemOf(bid.base_id))??NaN);
    if(!Number.isFinite(jumps))return [];
    const value=bid.price*Math.min(row.quantity,bid.quantity),net=Math.round(value-jumps*(fuelPerJump??0)*fuelPrice);
    if(net<=0)return [];
    const sellHere=bid.base_id===docked&&(!row.from||row.from===docked);
    const call=sellHere?`sell(${literal([{item_id:row.item_id,quantity:Math.min(row.quantity,bid.quantity)}])}${row.from?`, {from:'store'}`:''})`
      :`tradeRun(${literal({stops:[...row.from?[{at:row.from,buy:row.item_id,from:'store'}]:[],{at:bid.base_id}]})})`;
    const stops=(row.from&&row.from!==docked?1:0)+(sellHere?0:1);
    return [{row,bid,jumps,net,call,minutes:Math.max(minutes(jumps,stops),0.5)}];
  }).sort((a,b)=>b.net/b.minutes-a.net/a.minutes);
  const settle=settled[0];
  if(settle) {
    const {row,bid}=settle,empire=empireOf(bid.base_id);
    offers.push({gen:'settle',call:settle.call,facts:{credits:settle.net,minutes:settle.minutes,jumps:settle.jumps,item_id:row.item_id,quantity:row.quantity,
      from:row.from??'hold',bid:bid.price,bid_qty:bid.quantity,at:bid.base_id,age:bid.age,...empire?{empire}:{}},
      said:`settle: ${row.quantity} ${row.item_id}${row.from?` (store ${row.from})`:''} → ${bid.base_id} bid ${bid.price}×${bid.quantity}, ${ageSaid(bid.age)}${empire?`, ${empire}`:''}; ${settle.jumps} jumps, ${cr(settle.net)} after fuel`});
  }

  // Missions: turn in what is done; else take the best-paying offer here, or name what a freed slot would take.
  const mine=Option.getOrUndefined(yield* section('spacemolt/get_active_missions',activeEffect()));
  const jumpsTo=(o:{system_id?:string;target_base?:string})=>{
    const system=o.system_id??systemOf(o.target_base??'');
    return system===here?0:jumpsBetween(here,system);
  };
  const shown=mine?{held:{max:mine.max_missions,missions:mine.active.map(m=>({title:m.title,next:nextStep(m,jumpsTo),
    ...!m.community&&m.expires_in_ticks>0?{expires_at:new Date(Date.now()+m.expires_in_ticks*TICK_MS).toISOString()}:{}}))}}:{};
  const active=mine?.active??[];
  const ready=active.filter(m=>m.community?(m.community_percent??0)>=100:m.percent_complete>=100);
  const free=(mine?.max_missions??5)-active.filter(m=>!m.community&&m.expires_in_ticks>0).length;
  const board=docked?rows(field(Option.getOrUndefined(yield* look('spacemolt/get_missions')),'missions')).flatMap(row=>{
    const read=decodeOffered(row);
    if(Option.isNone(read))step('get_missions: a mission row did not read; left out');
    return Option.toArray(read);
  }).filter(m=>!active.some(a=>a.mission_id===m.mission_id)).sort((a,b)=>(b.rewards?.credits??0)-(a.rewards?.credits??0)):[];
  const best=board[0],dropped=active.filter(m=>!m.community).find(m=>stuck(m));
  const offer=(m:typeof Offered.Type)=>{
    const o=m.objectives?.[0],jumps=o?jumpsTo({...o.system_id?{system_id:o.system_id}:{},...o.target_base_id?{target_base:o.target_base_id}:{}}):undefined;
    // What the objective asks for against what is had, aboard and in every store: kvothe 10-04 22:02Z, the best-paying
    // offer on the board wanted 2,000 lead ore.
    const have=o?.item_id?(acct().state.cargo??[]).filter(row=>row.item_id===o.item_id).reduce((n,row)=>n+row.quantity,0)
      +readStores(runtime).filter(row=>row.item_id===o.item_id).reduce((n,row)=>n+row.quantity,0):undefined;
    return {credits:m.rewards?.credits??0,minutes:minutes(jumps??1,1),title:m.title??m.mission_id,issuer:issuer(m),
      next:`${o?.description??''}${have===undefined?'':` (have ${have})`}`,...jumps===undefined?{}:{jumps},...have===undefined?{}:{have},
      ...caveats(m).length?{caveats:caveats(m)}:{}};
  };
  if(ready.length) {
    const credits=ready.reduce((n,m)=>n+(m.rewards?.credits??0),0);
    offers.push({gen:'missions',call:'completeMissions()',facts:{credits,minutes:round(stop),missions:ready.map(m=>m.title)},
      said:`missions: ${ready.length} at 100% (${ready.map(m=>m.title).join(', ')})${credits?`, ${cr(credits)}`:''}`});
  } else if(best&&free>0) {
    const facts=offer(best);
    offers.push({gen:'missions',call:`acceptMission('${best.mission_id}')`,facts,
      said:`mission: ${facts.title}, ${cr(facts.credits)}, from ${facts.issuer}; first: ${facts.next}${facts.jumps===undefined?'':`, ${facts.jumps} jumps`}${(facts.caveats??[]).map(c=>`; ${c}`).join('')}`});
  } else if(best&&dropped) {
    const facts=offer(best);
    offers.push({gen:'missions',call:`abandonMission('${dropped.mission_id}')`,facts:{...facts,drops:dropped.title,why:stuck(dropped)},
      said:`drop ${dropped.title} (${stuck(dropped)}); a slot takes ${facts.title} here, ${cr(facts.credits)}, from ${facts.issuer}`});
  }

  // Explore, offered only when the objective leads with it: the nearest unvisited system, with what is known of it.
  const lead=leadCall(who),unvisited=nearby.find(row=>!row.visited);
  if(lead==='goTo'&&unvisited&&unvisited.jumps<=EXPLORE_JUMPS)
    offers.push({gen:'explore',call:`goTo('${unvisited.system_id}')`,
      facts:{credits:0,minutes:minutes(unvisited.jumps,0),jumps:unvisited.jumps,name:unvisited.name,...unvisited.empire?{empire:unvisited.empire}:{}},
      said:`explore: ${unvisited.name}, ${nearFacts(unvisited)}`});

  // Rank by stated credits a minute, one per generator; the objective's move keeps the last slot. Then fit the block.
  const rate=(m:Omit<Move,'id'>)=>m.facts.credits/Math.max(m.facts.minutes,0.5);
  const ranked=offers.filter((m,i)=>offers.findIndex(o=>o.call===m.call)===i).sort((a,b)=>rate(b)-rate(a));
  let chosen=ranked.slice(0,MOVES);
  const objective=ranked.find(m=>serves(m,lead));
  if(objective&&!chosen.includes(objective))chosen=[...chosen.slice(0,MOVES-1),objective];
  const moves:Move[]=[];
  let used=0;
  for(const m of chosen) {
    const move={...m,id:`m${moves.length+1}`},n=line(move).length+1;
    if(used+n>MOVES_CHARS)continue;
    used+=n;moves.push(move);
  }
  return {moves,...shown};
});

/** One move as printed: its id, the call in backticks, then its facts. */
const line=(m:Move)=>`${m.id} \`${m.call}\` — ${m.said}`;
/** The moves as text, one line each; empty when there are none. */
export const renderMenu=(built:Menu):string=>built.moves.map(line).join('\n');

/** What the location section already knows about a fight at this POI: another pilot or an
 * empire patrol in combat where the ship is standing. A docked ship observes no threat.
 * ponytail: pirates present are deliberately NOT threats. `V2NearbyPirate.status` has no
 * published values to read, and a Hunter's own quarry may be a pirate. Upgrade when the spec names the statuses. */
export function threatsHere(location:ReadinessAccount['state']['location'],docked:string|null):string[] {
  if(docked||!location)return [];
  return [...(location.nearby_players??[]).filter(row=>row.in_combat).map(row=>row.username??row.player_id),
    ...(location.nearby_empire_npcs??[]).filter(row=>row.in_combat).map(row=>row.name??row.npc_id)];
}
