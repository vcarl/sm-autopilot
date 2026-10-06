/** Scouting: going to read the books nobody has read lately. A route can only be planned over a
 * book someone read, the faction ledger covers a fraction of the stations, and `get_map` lists
 * systems but not their bases, so a base is learned from a book, a `find_route`, the faction's
 * intel map (`query_intel`), or a `get_system` in its own system. `candidates` is the one choice
 * of where to go next, read by the pilot's `scoutMarkets` and by a waiting freighter's host alike. */
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {replyBody} from '../../storage.ts';
import * as Wire from '../../wire.gen.ts';
import {jumpsFrom,mapOf} from '../exploration/exploration.ts';
import {IGNORE_TICKS} from '../freighter/index.ts';
import {Game} from '../game.ts';
import {bookEffect,marketTick,tickNow} from '../market.ts';
import {markExplored,markPlace,readDockRefusals,readExplored,readPlaces} from '../places.ts';
import {Stopped,acct,admit,edge,jobEffect,stopped} from '../runtime.ts';
import {goToEffect} from '../travel.ts';
import type {Outcome} from '../types.ts';
import {farBooksEffect,halt,pilotSeat,seatInFaction,seatLine,type Seat} from './trading.ts';

/** ponytail: how far scouting looks, in jumps from where the ship is. Tunable. */
export const SCOUT_JUMPS=4;
/** Where scouting may go: a base known by id with no book (`unknown`), a system on the map within
 * range whose bases were never listed (`unexplored`, no `base_id`), or a base whose freshest book,
 * ledger or memory, is older than `IGNORE_TICKS` (`stale`, `age` in ticks). */
export interface Candidate {kind:'unknown'|'unexplored'|'stale';system_id:string;base_id?:string;jumps:number;age?:number;
  /** The game's words when this base last refused the dock (`docking.json`): it ranks last. */
  refused?:string}
/** The id a candidate is flown to by. */
export const target=(row:Candidate)=>row.base_id??row.system_id;
/** ponytail: the faction intel map read a page of 50 systems at a time, at most 4 pages a read. */
const INTEL_PAGE=50,INTEL_PAGES=4;
/** A page of the intel map as `candidates` reads it: each system's id and its bases, picked from the spec's reply, because
 * the live server omits spec fields and sends `null` for an empty list. */
const decodeIntel=Schema.decodeUnknownOption(Wire.FactionQueryIntelResponse.mapFields(fields=>({total:Schema.optionalKey(fields.total),
  entries:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.IntelEntry.mapFields(entry=>({system_id:entry.system_id,
    pois:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.IntelPOI.mapFields(Struct.pick(['base_id'])))))})))))})));
/** The bases of the system the ship is in, as `get_system` lists them. */
const decodeBases=Schema.decodeUnknownOption(Wire.GetSystemResponse.mapFields(fields=>({system:fields.system.mapFields(system=>({id:system.id,
  pois:Schema.optionalKey(Schema.NullOr(Schema.Array(Wire.ClientPOIInfo_2.mapFields(Struct.pick(['base_id'])))))}))})));

/** Every candidate within `jumps` of the ship's system, unknown and unexplored first, then stale,
 * then bases that refused the dock (`docking.json`); nearer first, a base before a system. Books are aged against `now`. Reads only, through `seat`:
 * `get_map` once, the faction ledger (`farBooks`) and intel map (`query_intel`, each base it names
 * kept in `places.json`), and the runtime's `places.json`, `explored.json` and market memory. A
 * system with a base already placed counts as explored; its other bases are listed by the
 * `explore` after a hop there. */
export const candidatesEffect=(seat:Seat,now:number,jumps=SCOUT_JUMPS)=>Effect.gen(function*() {
  const game=yield* Game;
  const here=seat.account.state.location?.system_id,dir=seat.runtime,none:Candidate[]=[];
  if(!here)return none;
  const places=new Map(Object.entries(dir?readPlaces(dir):{})),mapped=new Set<string>();
  const pages=seatInFaction(seat)?INTEL_PAGES:0;
  for(let page=0;page<pages;page++) {
    yield* halt(seat);
    // A read: no faction, no intel map, or a lost reply all leave the files standing.
    const asked=yield* Effect.result(game.command('spacemolt_intel/query_intel',{limit:INTEL_PAGE,offset:page*INTEL_PAGE}));
    if(Result.isFailure(asked))break;
    const body=replyBody(asked.success),read=decodeIntel(body);
    if(Option.isNone(read)){seatLine(seat,{action:'query_intel',offset:page*INTEL_PAGE,reply:body},'scout_unread');break;}
    const reply=read.value;
    for(const entry of reply.entries??[]) {
      mapped.add(entry.system_id);
      for(const poi of entry.pois??[])if(poi.base_id&&!places.has(poi.base_id)) {
        places.set(poi.base_id,entry.system_id);
        if(dir)markPlace(dir,poi.base_id,entry.system_id);
      }
    }
    if(!reply.entries?.length||(page+1)*INTEL_PAGE>=(reply.total??0))break;
  }
  const far=yield* farBooksEffect('',now,seat);
  for(const known of far)if(known.system_id&&!places.has(known.base_id))places.set(known.base_id,known.system_id);
  const map=mapOf(yield* game.command('spacemolt/get_map',{}));
  const dist=jumpsFrom(map,here,jumps);
  const books=new Map(far.map(known=>[known.base_id,known])),out:Candidate[]=[],refusals=readDockRefusals(dir);
  for(const [base_id,system_id] of places) {
    const n=dist.get(system_id),known=books.get(base_id),refused=refusals[base_id]?{refused:refusals[base_id].message}:{};
    if(n===undefined)continue;
    if(!known)out.push({kind:'unknown',system_id,base_id,jumps:n,...refused});
    else if(known.age>IGNORE_TICKS)out.push({kind:'stale',system_id,base_id,jumps:n,age:known.age,...refused});
  }
  const explored=new Set([...dir?readExplored(dir):[],...mapped,...places.values()]);
  for(const row of map) {
    const n=dist.get(row.system_id);
    if(n!==undefined&&row.poi_count>0&&!explored.has(row.system_id))out.push({kind:'unexplored',system_id:row.system_id,jumps:n});
  }
  // Live 2026-10-02 (kvothe 16:37Z): scoutMarkets flew straight back to Proxima's only base a minute
  // after it said `Access denied`. Ranked last, not dropped: a refusal may lift.
  const rank=(row:Candidate)=>row.refused!==undefined?2:row.kind==='stale'?1:0;
  return out.sort((a,b)=>rank(a)-rank(b)||a.jumps-b.jumps||Number(!a.base_id)-Number(!b.base_id));
});

/** The system the ship is in, listed live (`get_system`): each base's place kept in the seat's `places.json`,
 * the system kept in its `explored.json`. The base ids; none, journalled to the seat, when the reply does not read. */
export const exploreEffect=(seat:Seat)=>Effect.gen(function*() {
  const dir=seat.runtime,body=replyBody(yield* (yield* Game).command('spacemolt/get_system',{})),read=decodeBases(body);
  if(Option.isNone(read)){seatLine(seat,{action:'get_system',reply:body},'scout_unread');return [];}
  const system=read.value.system;
  const bases=(system.pois??[]).flatMap(poi=>poi.base_id?[poi.base_id]:[]);
  if(dir) {
    for(const base of bases)markPlace(dir,base,system.id);
    markExplored(dir,system.id);
  }
  return bases;
});

export interface Scouted {
  /** Bases whose book was read, remembered and filed, in order. */
  filed:string[];
  /** Systems flown to for their bases, in order, and the bases each listed. */
  explored:{system_id:string;bases:string[]}[];
  /** Candidates still within range after the last hop. */
  left:number;
}

/** Go and read the nearest books nobody has read lately: up to `max` hops (default 3), each to the
 * next `candidates` row within `jumps` (default `SCOUT_JUMPS`, 4), re-chosen after every hop. A base
 * is flown to with `goTo` and its book read (remembered and filed, as `prices()` does); a system is
 * flown to and its bases listed and kept, so the next hop can dock at one. Never buys or sells.
 * Docked, ages are read against the live book's tick; undocked, against `tickNow`. Refused in a mood
 * that may not start a job. A hop that fails is said and skipped; `partial` when one did. A base that
 * refused the dock is not flown to, and `did` names it. Trains navigation. */
export function scoutMarkets(opts:{jumps?:number;max?:number}={}):Promise<Outcome<Scouted>> {return edge(scoutMarketsEffect(opts));}

/** `scoutMarkets` as an Effect, for `edge`; never in a barrel. A stop, a refusal or a lost reply ends the scout naming the
 * action and the code (every command here is a read, and a leg's own loss is `goTo`'s to re-observe). */
export const scoutMarketsEffect=(opts:{jumps?:number;max?:number}={})=>{
  const jumps=opts.jumps??SCOUT_JUMPS,max=opts.max??3;
  return jobEffect<Scouted>('scoutMarkets',`${max} within ${jumps} jumps`,Effect.gen(function*() {
    const detail:Scouted={filed:[],explored:[],left:0},short:string[]=[],tried=new Set<string>(),refused=new Map<string,string>();
    const blocked=yield* admit('scoutMarkets');
    if(blocked)return {status:'refused' as const,did:'scouted nothing',why:blocked,detail};
    // Live 2026-09-30..10-04 (kvothe, e.g. 3913826a, 658f971c): undocked was refused, `scouted nothing`.
    const seat=pilotSeat();
    if(acct().state.location?.docked_at)yield* bookEffect();
    const now=()=>acct().state.location?.docked_at?marketTick():tickNow(seat.runtime);
    let list:Candidate[];
    for(;;) {
      if(stopped())return yield* Effect.fail(new Stopped());
      // Live 2026-10-03 (kvothe): 46 dock_refused at the same 3 Dheneb bases across 16 scoutMarkets runs, each
      // flown to because nothing else was left. A base that refused the dock is passed until a dock there clears it.
      list=(yield* candidatesEffect(seat,now(),jumps)).filter(row=>{
        if(row.refused!==undefined)refused.set(target(row),row.refused);
        return row.refused===undefined&&!tried.has(target(row));
      });
      const next=list[0];
      if(!next||tried.size>=max)break;
      tried.add(target(next));
      const trip=yield* goToEffect(target(next));
      if(trip.status!=='done'){short.push(`${target(next)}: ${trip.why??trip.did}`);continue;}
      const bases=yield* exploreEffect(seat);
      if(!next.base_id)detail.explored.push({system_id:next.system_id,bases});
      const docked=acct().state.location?.docked_at;
      if(docked){yield* bookEffect();detail.filed.push(docked);}
    }
    detail.left=list.length;
    const did=`${detail.filed.length?`read and filed ${detail.filed.length} book(s): ${detail.filed.join(', ')}`:'filed no book'}`
      +(detail.explored.length?`; listed the bases of ${detail.explored.map(row=>`${row.system_id} (${row.bases.length})`).join(', ')}`:'')
      +(tried.size?'':`; nothing to scout within ${jumps} jumps: every base known there has a book younger than ${IGNORE_TICKS} ticks`)
      +(detail.left?`; ${detail.left} more within ${jumps} jumps`:'')
      +(refused.size?`; passed ${refused.size} base(s) that refused docking: ${[...refused].map(([id,why])=>`${id} (${why})`).join(', ')}`:'');
    const status=short.length?(detail.filed.length||detail.explored.length?'partial' as const:'refused' as const):'done' as const;
    return {status,did,...short.length?{why:short.join('; ')}:{},detail,
      next:[...detail.left?['scoutMarkets() again for the next ones']:[],'routes() over the books just read']};
  }));
};
