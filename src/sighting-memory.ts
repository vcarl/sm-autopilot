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
import {Option,Schema} from 'effect';

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
/** How long a sighting of live prey is still worth flying to. Thirty minutes at ten seconds a tick.
 * The game publishes no wander or respawn rate, so this started as a guess — but it now has one
 * real data point behind it, and the point is consistent with it: on 2026-09-25 a belt that had held
 * every one of the day's ten fights was empty on two visits four hours later, and the region's only
 * fauna had moved to a nebula. Presence decays over hours, so believing one for half an hour is
 * inside the evidence. Believing it too long only costs a wasted look, which is the cheap direction
 * to be wrong in. */
export const PRESENCE_STALE=180;
/** How long an absence is trusted, deliberately shorter than `PRESENCE_STALE`: believing an
 * absence too long costs a POI that has prey being skipped forever, which is the expensive
 * direction. Also a guess. */
export const ABSENCE_STALE=90;

/** One species at one POI at one look. `count` is how many were seen, `legal` how many were
 * engageable — neither `in_combat` nor `branded`, the two refusals `play/combat/hunting.ts`
 * spends a trip discovering. A row with no `species` is an empty look: nothing was there. */
const Sighting=Schema.Struct({poi_id:Schema.String,species:Schema.optionalKey(Schema.String),count:Schema.Number,legal:Schema.Number,at:Schema.String,tick:Schema.optionalKey(Schema.Number)});
export type Sighting=typeof Sighting.Type;
const Store=Schema.fromJsonString(Schema.Struct({sightings:Schema.Array(Schema.Unknown)}));
const decodeStore=Schema.decodeUnknownOption(Store),decodeSighting=Schema.decodeUnknownOption(Sighting);

/** A whole look at one POI, which is the unit that gets written: a look supersedes everything
 * remembered about that POI, because a fresher answer about the same rock is the only answer.
 * An empty `seen` is the empty look.
 *
 * **`seen` must be complete.** It is every creature `get_nearby` listed at that POI, not a
 * filtered subset — there is no per-species query to make a partial look out of. `recall` leans
 * on this: a species missing from a look is a species that was not there, which is half of what
 * a look is worth. A caller that writes a filtered `seen` would turn that into a lie. */
export interface Look {poi_id:string;tick?:number;seen:{species:string;count:number;legal:number}[]}

/** Whatever is on disk, newest row first, or nothing: a torn or absent file is no memory. */
export function readSightings(dir:string|undefined):Sighting[] {
  if(!dir)return [];
  try {
    const stored=decodeStore(readFileSync(join(dir,MEMORY),'utf8'));
    // A bad row is dropped and the good ones kept; a file that is not a store at all reads as nothing.
    return Option.isSome(stored)?stored.value.sightings.flatMap(row=>{const one=decodeSighting(row);return Option.isSome(one)?[one.value]:[];}):[];
  } catch {return [];} // edge: a torn or absent file is no memory
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
  } catch {} // edge: a POI this pilot cannot remember is still a POI it can look at again
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
  // Having looked is a property of the POI, not of the species asked about. A look is complete
  // (see `Look`), so a species missing from it was absent, and that is an answer — `unlooked` is
  // reserved for a rock nobody has been to. Collapsing the two would make "we flew out there and
  // it was empty" indistinguishable from "nobody has ever checked", which is the one distinction
  // this memory exists to draw.
  const looked=rows.filter(row=>row.poi_id===poi_id);
  if(!looked.length)return {...asked,state:'unlooked'};
  const ticks_old=Math.min(...looked.map(row=>sightingTicksOld(row.at,now)));
  // Every row from the same look shares a stamp; only the newest look is believed, and the
  // rows of older looks at the same POI are ignored rather than added into its counts.
  const newest=looked.filter(row=>sightingTicksOld(row.at,now)===ticks_old);
  // A species-less row is the empty look, which answers for every species at once.
  const mine=species===undefined?newest:newest.filter(row=>row.species===species||row.species===undefined);
  const count=mine.reduce((sum,row)=>sum+Math.max(0,row.count),0);
  const legal=mine.reduce((sum,row)=>sum+Math.max(0,row.legal),0);
  // Which bound applies is decided by the answer, not by the row: the same look is a presence
  // for what it saw and an absence for what it did not, and an absence expires sooner.
  return ticks_old<=(count>0?PRESENCE_STALE:ABSENCE_STALE)
    ?{...asked,state:'seen',count,legal,ticks_old}
    :{...asked,state:'stale',ticks_old};
}
