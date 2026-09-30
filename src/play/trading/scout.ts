/** Scouting: going to read the books nobody has read lately. A route can only be planned over a
 * book someone read, the faction ledger covers a fraction of the stations, and `get_map` lists
 * systems but not their bases, so a base is learned from a book, a `find_route`, the faction's
 * intel map (`query_intel`), or a `get_system` in its own system. `candidates` is the one choice
 * of where to go next, read by the pilot's `scoutMarkets` and by a waiting freighter's host alike. */
import type {FactionQueryIntelResponse,SystemPoi} from '@spacemolt/lib';
import type {ReadinessCommand} from '../../readiness.ts';
import {details} from '../../response-details.ts';
import {jumpsFrom,readMap} from '../exploration/exploration.ts';
import {IGNORE_TICKS} from '../freighter/index.ts';
import {book,marketTick} from '../market.ts';
import {markExplored,markPlace,readExplored,readPlaces} from '../places.ts';
import {acct,admit,checkStop,command,job,runtimeDir} from '../runtime.ts';
import {goTo} from '../travel.ts';
import type {Outcome} from '../types.ts';
import {farBooks,pilotSeat,seatInFaction,type Seat} from './trading.ts';

/** ponytail: how far scouting looks, in jumps from where the ship is. Tunable. */
export const SCOUT_JUMPS=4;
/** Where scouting may go: a base known by id with no book (`unknown`), a system on the map within
 * range whose bases were never listed (`unexplored`, no `base_id`), or a base whose freshest book,
 * ledger or memory, is older than `IGNORE_TICKS` (`stale`, `age` in ticks). */
export interface Candidate {kind:'unknown'|'unexplored'|'stale';system_id:string;base_id?:string;jumps:number;age?:number}
/** The id a candidate is flown to by. */
export const target=(row:Candidate)=>row.base_id??row.system_id;
/** ponytail: the faction intel map read a page of 50 systems at a time, at most 4 pages a read. */
const INTEL_PAGE=50,INTEL_PAGES=4;

/** Every candidate within `jumps` of the ship's system, unknown and unexplored first, then stale;
 * nearer first, a base before a system. Books are aged against `now`. Reads only, through `seat`:
 * `get_map` once, the faction ledger (`farBooks`) and intel map (`query_intel`, each base it names
 * kept in `places.json`), and the runtime's `places.json`, `explored.json` and market memory. A
 * system with a base already placed counts as explored; its other bases are listed by the
 * `explore` after a hop there. */
export async function candidates(seat:Seat,now:number,jumps=SCOUT_JUMPS):Promise<Candidate[]> {
  const here=seat.account.state.location?.system_id,dir=seat.runtime;
  if(!here)return [];
  const places=new Map(Object.entries(dir?readPlaces(dir):{})),mapped=new Set<string>();
  const pages=seatInFaction(seat)?INTEL_PAGES:0;
  for(let page=0;page<pages;page++) {
    seat.stop();
    try {
      const reply=details(await seat.command('spacemolt_intel/query_intel',{limit:INTEL_PAGE,offset:page*INTEL_PAGE})) as FactionQueryIntelResponse;
      for(const entry of reply.entries??[]) {
        mapped.add(entry.system_id);
        for(const poi of entry.pois??[])if(poi.base_id&&!places.has(poi.base_id)) {
          places.set(poi.base_id,entry.system_id);
          if(dir)markPlace(dir,poi.base_id,entry.system_id);
        }
      }
      if(!reply.entries?.length||(page+1)*INTEL_PAGE>=Number(reply.total??0))break;
    } catch {break;/* no faction, or no intel map: the files stand */}
  }
  const far=await farBooks('',now,seat);
  for(const known of far)if(known.system_id&&!places.has(known.base_id))places.set(known.base_id,known.system_id);
  const map=await readMap(seat.command);
  const dist=jumpsFrom(map,here,jumps);
  const books=new Map(far.map(known=>[known.base_id,known])),out:Candidate[]=[];
  for(const [base_id,system_id] of places) {
    const n=dist.get(system_id),known=books.get(base_id);
    if(n===undefined)continue;
    if(!known)out.push({kind:'unknown',system_id,base_id,jumps:n});
    else if(known.age>IGNORE_TICKS)out.push({kind:'stale',system_id,base_id,jumps:n,age:known.age});
  }
  const explored=new Set([...dir?readExplored(dir):[],...mapped,...places.values()]);
  for(const row of map) {
    const n=dist.get(row.system_id);
    if(n!==undefined&&row.poi_count>0&&!explored.has(row.system_id))out.push({kind:'unexplored',system_id:row.system_id,jumps:n});
  }
  const rank=(row:Candidate)=>row.kind==='stale'?1:0;
  return out.sort((a,b)=>rank(a)-rank(b)||a.jumps-b.jumps||Number(!a.base_id)-Number(!b.base_id));
}

/** The system the ship is in, listed live (`get_system`): each base's place kept in `places.json`,
 * the system kept in `explored.json`. The base ids. */
export async function explore(send:ReadinessCommand,dir:string|undefined):Promise<string[]> {
  const system=(details(await send('spacemolt/get_system',{})) as {system?:{id?:string;pois?:SystemPoi[]}}).system;
  if(!system?.id)return [];
  const bases=(system.pois??[]).flatMap(poi=>poi.base_id?[poi.base_id]:[]);
  if(dir) {
    for(const base of bases)markPlace(dir,base,system.id);
    markExplored(dir,system.id);
  }
  return bases;
}

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
 * Refused when not docked (ages are read against a counter's tick) or in a mood that may not start
 * a job. A hop that fails is said and skipped; `partial` when one did. Trains navigation. */
export function scoutMarkets(opts:{jumps?:number;max?:number}={}):Promise<Outcome<Scouted>> {
  const jumps=opts.jumps??SCOUT_JUMPS,max=opts.max??3;
  return job<Scouted>('scoutMarkets',`${max} within ${jumps} jumps`,async()=>{
    const detail:Scouted={filed:[],explored:[],left:0},short:string[]=[],tried=new Set<string>();
    const blocked=await admit('scoutMarkets');
    if(blocked)return {status:'refused',did:'scouted nothing',why:blocked,detail};
    if(!acct().state.location?.docked_at)return {status:'refused',did:'scouted nothing',why:'not docked; book ages are read against a counter\'s tick',detail,
      next:['goTo a base, then scoutMarkets()']};
    await book();
    const seat=pilotSeat();
    let list:Candidate[];
    for(;;) {
      checkStop();
      list=(await candidates(seat,marketTick(),jumps)).filter(row=>!tried.has(target(row)));
      const next=list[0];
      if(!next||tried.size>=max)break;
      tried.add(target(next));
      const trip=await goTo(target(next));
      if(trip.status!=='done'){short.push(`${target(next)}: ${trip.why??trip.did}`);continue;}
      const bases=await explore(command,runtimeDir());
      if(!next.base_id)detail.explored.push({system_id:next.system_id,bases});
      const docked=acct().state.location?.docked_at;
      if(docked){await book();detail.filed.push(docked);}
    }
    detail.left=list.length;
    const did=`${detail.filed.length?`read and filed ${detail.filed.length} book(s): ${detail.filed.join(', ')}`:'filed no book'}`
      +(detail.explored.length?`; listed the bases of ${detail.explored.map(row=>`${row.system_id} (${row.bases.length})`).join(', ')}`:'')
      +(tried.size?'':`; nothing to scout within ${jumps} jumps: every base known there has a book younger than ${IGNORE_TICKS} ticks`)
      +(detail.left?`; ${detail.left} more within ${jumps} jumps`:'');
    const status=short.length?(detail.filed.length||detail.explored.length?'partial':'refused'):'done';
    return {status,did,...short.length?{why:short.join('; ')}:{},detail,
      next:[...detail.left?['scoutMarkets() again for the next ones']:[],'routes() over the books just read']};
  });
}
