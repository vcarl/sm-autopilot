/** Where wildlife was, and where it was NOT, the last time anyone looked.
 *
 * `get_nearby` answers "what is here, now", and only here: there is no endpoint that says which
 * POI had prey an hour ago, so the only way to have that is to have kept it. Same discipline as
 * `remember()` in `play/market.ts` and `writeFight` in `combat-memory.ts` — temp file then
 * rename, bounded by count, every row aged at read and never on disk.
 *
 * An empty look is a row. A POI that was looked at and held nothing is the more useful fact of
 * the two: it is the one that stops a pilot burning fuel on the same dead rock twice. It is
 * stored as a row with NO `species` — "looked here, saw no wildlife at all" — rather than a zero
 * row per species asked about, because that is what `get_nearby` actually establishes: it lists
 * everything present, so an empty list rules out every species at once, not just the one asked.
 * A zero row for a named species exists only if a caller chooses to write one.
 *
 * The load-bearing rule: a remembered absence must not age into a recommendation. An absence is
 * a fact with a shelf life — creatures wander in, the server respawns them — so once it is older
 * than `ABSENCE_STALE` it reads as `stale`, which is "we no longer know", and `stale` deliberately
 * carries no counts at all so that nothing in it can be misread as "zero prey here".
 */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const MEMORY='sightings.json';
/** ponytail: the last 200 rows, which is roughly forty looks at five species each and about
 * 20 KB — a wider circuit than the 12 bases `play/market.ts` keeps books for. Age rows out by
 * tick instead the day a pilot sweeps more POIs than that in one session. */
export const CAP=200;
/** A tick is ten seconds of real time, as in `combat-memory.ts`.
 * ponytail: ages are wall-clock elapsed converted at this rate, not a server tick delta —
 * `account.currentTick` is only reachable inside the bridge. `Sighting.tick` stores the real
 * tick for the day a caller has one. */
export const TICK_MS=10_000;
/** How long a sighting of live prey is still worth flying to. A guess, not a measurement: the
 * game publishes no wander or respawn rate, so nothing observable pins this. Believing a
 * presence too long only costs a wasted look, which is the cheap direction to be wrong in. */
export const PRESENCE_STALE=180;
/** How long an absence is trusted, deliberately shorter than `PRESENCE_STALE`: believing an
 * absence too long costs a POI that has prey being skipped forever, which is the expensive
 * direction. Also a guess. */
export const ABSENCE_STALE=90;

/** One species at one POI at one look. `count` is how many were seen, `legal` how many were
 * engageable — neither `in_combat` nor `branded`, the two refusals `play/combat/hunting.ts`
 * spends a trip discovering. A row with no `species` is an empty look: nothing was there. */
export interface Sighting {poi_id:string;species?:string;count:number;legal:number;at:string;tick?:number}

/** A whole look at one POI, which is the unit that gets written: a look supersedes everything
 * remembered about that POI, because a fresher answer about the same rock is the only answer.
 * An empty `seen` is the empty look. */
export interface Look {poi_id:string;tick?:number;seen:{species:string;count:number;legal:number}[]}

/** Whatever is on disk, newest row first, or nothing: a torn or absent file is no memory. */
export function readSightings(dir:string|undefined):Sighting[] {
  if(!dir)return [];
  try {
    const stored=JSON.parse(readFileSync(join(dir,MEMORY),'utf8')) as {sightings?:Sighting[]};
    return (Array.isArray(stored?.sightings)?stored.sightings:[])
      .filter((row):row is Sighting=>Boolean(row&&typeof row.poi_id==='string'&&typeof row.count==='number'));
  } catch {return [];}
}

/** Temp file then rename, as `writeFight` does: a torn write would send a pilot somewhere on a
 * lie. Rows for this POI are replaced, not appended to, and the oldest are evicted past `CAP`. */
export function writeLook(dir:string,look:Look,now=()=>new Date()):Sighting[] {
  if(!dir||!look.poi_id)return [];
  const at=now().toISOString(),stamp={at,...look.tick?{tick:look.tick}:{}};
  const written:Sighting[]=look.seen.length
    ?look.seen.map(one=>({poi_id:look.poi_id,species:one.species,count:one.count,legal:one.legal,...stamp}))
    :[{poi_id:look.poi_id,count:0,legal:0,...stamp}];
  try {
    mkdirSync(dir,{recursive:true});
    const kept=[...written,...readSightings(dir).filter(row=>row.poi_id!==look.poi_id)].slice(0,CAP);
    const path=join(dir,MEMORY),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,`${JSON.stringify({sightings:kept})}\n`,{mode:0o600});
    renameSync(temp,path);
  } catch {/* a POI this pilot cannot remember is still a POI it can look at again */}
  return written;
}

/** Age in ticks, computed at read and never stored. Unlike `fightTicksOld`, an unparseable or
 * missing stamp reads as infinitely old rather than as 0: a fight record is sizing a risk the
 * pilot has already taken, but this memory decides where to GO, and an undateable row that
 * reads as fresh would send it there on nothing. Old is the safe direction here — a presence
 * that reads stale costs one look, an absence that reads fresh costs the POI. */
export const sightingTicksOld=(at:string,now:number):number=>{
  const stamped=Date.parse(at);
  return Number.isNaN(stamped)?Number.POSITIVE_INFINITY:Math.max(0,Math.round((now-stamped)/TICK_MS));
};

/** The three states memory can be in about a POI, as a discriminated union so the caller
 * branches on `state` and never parses prose: `seen` carries the counts and their age,
 * `stale` carries only an age (we looked, we no longer know), `unlooked` carries nothing. */
export type Recall={poi_id:string;species?:string}&(
  {state:'seen';count:number;legal:number;ticks_old:number}
  |{state:'stale';ticks_old:number}
  |{state:'unlooked'});

/** What we remember about `species` at `poi_id`, and how old it is. A species-less row — an
 * empty look — answers for every species, since `get_nearby` lists all that are present. With
 * no species named, the whole newest look at that POI is summed. */
export function recall(rows:Sighting[],poi_id:string,species?:string,now=Date.now()):Recall {
  const asked={poi_id,...species?{species}:{}};
  const mine=rows.filter(row=>row.poi_id===poi_id
    &&(species===undefined||row.species===species||row.species===undefined));
  if(!mine.length)return {...asked,state:'unlooked'};
  const ticks_old=Math.min(...mine.map(row=>sightingTicksOld(row.at,now)));
  // Every row from the same look shares a stamp; only the newest look is believed, and the
  // rows of older looks at the same POI are ignored rather than added into its counts.
  const newest=mine.filter(row=>sightingTicksOld(row.at,now)===ticks_old);
  const count=newest.reduce((sum,row)=>sum+Math.max(0,row.count),0);
  const legal=newest.reduce((sum,row)=>sum+Math.max(0,row.legal),0);
  return ticks_old<=(count>0?PRESENCE_STALE:ABSENCE_STALE)
    ?{...asked,state:'seen',count,legal,ticks_old}
    :{...asked,state:'stale',ticks_old};
}
