/** The journal oracle: where the pilot is, how it is, and what it has been up to lately, as one
 * record of facts (the `Scene`) for the picture templates. Everything is as of one run's `ended`
 * line: the journal is read up to it and every timestamped sidecar row after it is left out, so a
 * scene from yesterday is yesterday's. The one exception is the picture's subject: when the frames
 * say where the pilot was and what it flew at the depicted moment, `where` and the ship are that. It
 * never calls the game. A fact the files cannot supply is null, never guessed. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readCombat} from '../combat-memory.ts';
import {resolveFuelReserve,resolveWalkAway,type Mood} from '../mood-policy.ts';
import {readSeen} from '../play/exploration/exploration.ts';
import {readNames,readPlaces} from '../play/places.ts';
import {isRecord,readJournal,type JournalLine} from '../run-record.ts';
import {readSightings} from '../sighting-memory.ts';
import {loadGalaxy,type Galaxy} from './galaxy.ts';
import {INVOLVEMENT,depicted,fightsOf,idsOf,moments,pictured,type Fight,type Moment,type Pilot,type PoiFact,type Source} from './moments.ts';
import {subjectOf,type SubjectKind} from './refs.ts';
import {catalogItems,speciesName} from './species.ts';

type Row=Record<string,unknown>;
export interface Named {id:string;name:string|null}
export interface Creatures {poi:string;poi_name:string|null;species:string;count:number;seen_at:string}
export interface Ships {kind:string;class:string|null;count:number}
export interface RunWork {run_id:string;ended:string;outcome:string|null;fn:string|null;arg:string|null;status:string|null;credits:number|null;items:number|null;xp:number|null}
export type Fresh='hunt'|'mine'|'trade'|'travel';
export interface Scene {
  juncture_id:string|null;run_id:string;started:string|null;ended:string;outcome:string|null;mood:string|null;
  /** The run's end, or the depicted moment's lead event when the frames give the pilot's place there. */
  /** `poi_class` and `sun` (the spectral class of the system's sun) from the frames' `get_system` charts (moments.ts `poisOf`). */
  where:{system:string|null;system_name:string|null;poi:string|null;poi_name:string|null;poi_type:string|null;poi_class:string|null;sun:string|null;
    docked_at:string|null;base_name:string|null;security:string|null;empire:string|null};
  status:{hull:number|null;max_hull:number|null;fuel:number|null;max_fuel:number|null;credits:number|null;
    cargo_used:number|null;cargo_capacity:number|null;cargo:{item_id:string;quantity:number}[];
    /** The ship at the depicted moment when the frames name it, else at the end. */
    ship_class:string|null;ship_class_seen_at:string|null;
    /** The class is the newest known from any source, seen only after the end: a lookahead, see `sceneOf`. */
    ship_class_seen_after_end:boolean;ship_name:string|null;ship_faction:string|null;ship_role:string|null};
  /** The run's own work summary, as `run` `ended` keeps it. */
  work:RunWork|null;
  /** `creatures`: sighted at this POI; `nearby`: at the system's other POIs. `ships` is the live
   * location's, so it is empty for an end-of-flight scene. */
  company:{creatures:Creatures[];nearby:Creatures[];ships:Ships[]};
  lately:{runs:RunWork[];span:{start:string;end:string;hours:number};wallet:{start:number|null;end:number|null;change:number|null};
    /** From the frames when they cover the window (moments.ts `fightsOf`), else the journal's battle_ended pushes. */
    fights:{count:number;won:number;lost:number;other:number;last_opponent:string|null};
    trades:{bought:Record<string,number>;sold:Record<string,number>;places:Named[]};
    deaths:number;strandings:number;systems:Named[]};
  flags:{in_battle:boolean;hull_low:boolean|null;fuel_low:boolean|null;fresh_from:Fresh|null};
  /** The best moment of `scope` (moments.ts), null when it holds no scoring event. */
  moment:Moment|null;
  /** Where the moment is looked for: the flight, from the previous ended run's end (the previous picture) to this run's end;
   * the `lately` window's start when the journal read holds no earlier run. Live 2026-10-20 (kvothe 58746f94): a juncture of 40
   * runs over 9.5 h looked for each post's moments in all of it, so one flight could post another's. */
  scope:{start:string;end:string};
  /** Display names for the ids the moment names (its events' identities and id-like facts): names.json, galaxy.json, else the journal's own words up to the end, as `where` is named. An id with no known name is left out. */
  names:Record<string,string>;
  /** The one subject the picture draws from a reference (refs.ts `subjectOf`), with what the catalog says of it: a ship's
   * `faction`, `role` (its class) and `weapon_slots`, an item's `description`; `fought` when its event is the pilot's own fight,
   * and for a battle the pilot only heard of, its `other_side`: `creature`, the catalog class of its ship, or `ship`. Null when the moment has none. */
  subject:{kind:SubjectKind;id:string;category:string;name:string;faction:string|null;role:string|null;weapon_slots:number|null;description:string|null;
    fought:boolean;other_side:string|null}|null;
  /** The pilot's look in a few words of its profile's SOUL.md (`pilotLook`); null when it has none. */
  look:string|null;
  /** The pilot's eyes in SOUL.md's words (`pilotEyes`), for the camera that shows the face; null when it says none. */
  eyes:string|null;
}

/** The bound on `lately`: about the last ten runs or six hours, whichever is less (the spec). */
export const LATELY_RUNS=10,LATELY_MS=6*3600_000,TOP_CARGO=5;
const FIRST_READ=4000,MOST_READ=800_000;
const FRESH:Record<string,Fresh>={hunt:'hunt',arena:'hunt',duel:'hunt',gatherUntil:'mine',sell:'trade',buy:'trade',tradeRun:'trade',goTo:'travel',exploreNearby:'travel'};
const MOODS=['Relaxed','Cautious','Focused','Opportunistic','Aggressive','Tired'] as const;
const isMood=(m:unknown):m is Mood=>MOODS.some(x=>x===m);

const str=(v:unknown)=>typeof v==='string'&&v?v:null;
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const rec=(v:unknown):Row=>isRecord(v)?v:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const ms=(v:unknown)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isNaN(t)?undefined:t;};
const isRun=(line:JournalLine,phase:string)=>line.event==='run'&&line.phase===phase&&typeof line.run_id==='string';

interface Ended {line:JournalLine;index:number;run_id:string;started:JournalLine|undefined}

function endedRuns(lines:readonly JournalLine[]):Ended[] {
  const started=new Map(lines.filter(l=>isRun(l,'started')).map(l=>[String(l.run_id),l]));
  return lines.flatMap((line,index)=>{
    if(!isRun(line,'ended'))return [];
    const run_id=String(line.run_id),start=started.get(run_id);
    return [{line,index,run_id,started:start}];
  });
}

/** The runs `select` names: `latest`, a run id or a juncture id (a prefix of either), the
 * juncture's last ended run; with `last` > 1, that many runs ending at it, oldest first. */
function pick(runs:Ended[],select:string,last:number):Ended[] {
  const target=select==='latest'?runs.at(-1)
    :runs.findLast(r=>r.run_id.startsWith(select))??runs.findLast(r=>str(r.started?.juncture_id)?.startsWith(select));
  if(!target)return [];
  return runs.filter(r=>r.index<=target.index).slice(-last);
}

/** Enough journal for `picked`: the oldest has ten ended runs before it, or six hours of lines. */
function enough(lines:readonly JournalLine[],select:string,last:number):boolean {
  const runs=endedRuns(lines),picked=pick(runs,select,last),first=picked[0];
  if(!first||picked.length<last)return false;
  const before=runs.filter(r=>r.index<first.index).length,oldest=ms(lines[0]?.at),end=ms(first.line.at);
  // Live 2026-10-19 (kvothe 3db6ff6c): a juncture of 30 runs read from its middle took a run whose start was cut off for the
  // previous juncture's, and the moment was looked for in its last 1.7 hours of 5.2. The scope's start needs a run read whole.
  return (before>=LATELY_RUNS||(oldest!==undefined&&end!==undefined&&end-oldest>=LATELY_MS))&&runs.some(r=>r.index<first.index&&r.started);
}

/** The text the journal holds that names things: line texts, summaries, reasons and each call's `did`. */
const textOf=(lines:readonly JournalLine[])=>lines.flatMap(l=>[l.text,l.summary,l.reason,...list(l.calls).map(c=>rec(c).did)].filter(t=>typeof t==='string')).join('\n');
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** An id's display name: `names.json` or the galaxy, else its title-cased id where the journal holds
 * those exact words, else the journal's own `Name (id)` or `id (Name)`. A parenthesised name that is
 * a system's is not taken for anything else: `orient` writes `docked at <base> (<system name>)`. Else the id title-cased.
 * Names are identities, not state: the whole journal read and the sidecars serve, whatever the run's end. */
function nameOf(id:string|null,names:Record<string,string>,text:string,galaxy:Galaxy):string|null {
  if(!id)return null;
  const known=names[id]??galaxy.systems[id]?.name;
  if(known)return known;
  const titled=id.split('_').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  if(text.includes(titled))return titled;
  const systemNames=new Set(Object.values(galaxy.systems).map(s=>s.name));
  const named=[...text.matchAll(new RegExp(`([A-Z][\\w'’-]*(?: [A-Z][\\w'’-]*)*) \\(${escape(id)}\\)|(?:^|[\\s(])${escape(id)} \\(([^)\\n]+)\\)`,'g'))]
    .map(m=>m[1]??m[2]??'').filter(n=>n&&/[A-Z]/.test(n)&&!systemNames.has(n)); // a lower-case list in brackets is ids, not a name: `frontier_station (iridium_ore, standard_rounds_box)`
  return named[0]??titled;
}

const workOf=(r:Ended):RunWork=>{const w=rec(r.line.work);return {run_id:r.run_id,ended:String(r.line.at),outcome:str(r.line.outcome),
  fn:str(w.fn),arg:str(w.arg),status:str(w.status),credits:num(w.credits),items:num(w.items),xp:num(w.xp)};};

/** The catalog's entry for a ship class: `runtime/catalog.json`, the game's public catalog the lib keeps. */
function shipOf(runtime:string,id:string|null):Row {
  if(!id)return {};
  try {return rec(list(rec(rec(JSON.parse(readFileSync(join(runtime,'catalog.json'),'utf8'))).catalog).ships).find(s=>rec(s).id===id));}
  catch {return {};} // edge: no catalog kept yet is no catalog facts
}

/** The catalog categories whose art is a lump or a made part, drawable on the console; a gas, a consumable, ammunition, a module
 * or a creature's leavings is not a prop (refs.ts `subjectOf`). */
const PROPS=new Set(['ore','refined','component']);
/** The moment's subject with its catalog facts; its name the catalog's, a species' as the game said it, else the id's. */
/** The items that are no prop on the console (refs.ts `subjectOf`). */
const noPropOf=(runtime:string)=>new Set(catalogItems(runtime).flatMap(i=>PROPS.has(String(rec(i).category))&&rec(i).extracted_by!=='gas'?[]:[String(rec(i).id)]));
function subjectFacts(runtime:string,moment:Moment|null,name:(id:string)=>string|null):Scene['subject'] {
  const s=subjectOf(moment,noPropOf(runtime));
  if(!s)return null;
  const ship=s.kind==='ship'?shipOf(runtime,s.id):{},item=s.kind==='item'?rec(catalogItems(runtime).find(i=>rec(i).id===s.id)):{};
  const other=s.fought?null:str(s.event.facts.other_side);
  return {kind:s.kind,id:s.id,category:s.event.category,name:s.kind==='creature'?speciesName({moment,names:{}},s.id):str(ship.name)??str(item.name)??name(s.id)??s.id,
    faction:str(ship.faction),role:str(ship.class),weapon_slots:num(ship.weapon_slots),description:str(item.description),
    fought:s.fought,other_side:other&&other!=='creature'&&other!=='ship'?str(shipOf(runtime,other).class)??'ship':other};
}
const BODY=/\b(hair|eyes?|face|hands?|shoulders?|build|built|skin|scars?|scarred|beard|tall|lean|stocky|tattoo\w*|freckle\w*)\b/gi;
const STOP=/\s+(?:a|an|the|of|and|or|with|at|to|in|cut)$/i;
/** The words of a look, at most `n`, function words cut from the end. */
const words=(t:string,n:number)=>{let w=t.trim().split(/\s+/).slice(0,n).join(' ');while(STOP.test(w))w=w.replace(STOP,'');return w;};
/** SOUL.md's sentences, its headings and quotes left out, its most physical paragraph's first. */
function soulSentences(soul:string):{physical:string[];all:string[]} {
  const paras=soul.split(/\n\s*\n/).map(p=>p.trim().replace(/\s+/g,' ')).filter(p=>p&&!/^[>#]/.test(p));
  const best=paras.map(p=>({p,score:p.match(BODY)?.length??0})).sort((a,b)=>b.score-a.score)[0];
  const split=(p:string)=>p.split(/(?<=[.!?])\s/).map(s=>s.replace(/[.!?]$/,''));
  return {physical:best&&best.score>=2?split(best.p):[],all:paras.flatMap(split)};
}
const CLOTHES=/\b(?:wear|wears|wearing|clothes|clothing|dressed|clad|coat|jacket|suit|uniform|overalls|robes?|cloak|boots)\b/i;
/** What the pilot wears, in SOUL.md's words: the first sentence that says it, from the physical paragraph first; after its verb
 * (`You wear …`, `dressed in …`) or, with no verb, from its start with the possessive cut; at most eight words. */
function clothingOf(sentences:{physical:string[];all:string[]}):string|null {
  const said=[...sentences.physical.slice(1),...sentences.all.filter(s=>s!==sentences.physical[0])].find(s=>CLOTHES.test(s)); // the look's own sentence is its head
  if(!said)return null;
  const verb=/\b(?:wears?|wearing|dressed in|clad in)\s+(.*)$/i.exec(said)?.[1];
  const rest=(verb??said.replace(/^(?:your|his|her|their|my)\s+/i,'')).split(/\b(?:you|your|yours|yourself)\b/i)[0]??'';
  // Eight words, back to the last comma when the eighth falls inside a clause: "a long grey greatcoat with brass buttons, its" is cut.
  const all=rest.trim().split(/\s+/),cut=all.slice(0,8).join(' '),inside=all.length>8&&!/[,;:]$/.test(all[7]??'');
  return words((inside&&cut.includes(',')?cut.slice(0,cut.lastIndexOf(',')):cut).replace(/[,;:\s]+$/,''),8).replace(/[,;:]+$/,'')||null;
}
/** The pilot's look in SOUL.md's own words: the first sentence of its most physical paragraph (two body words at least), its
 * subject cut (`You are …` → `a …`), split at commas, parts in the second or third person dropped; its head (the parts until
 * three words), then, when the head does not say it, the hair (the part that names it, cut after `hair`, or to six words when
 * it starts with it), then what the pilot wears (`clothingOf`). Live 2026-10-19: the full sentence ran to 50 words, and the pilot
 * crowded out the scene. Camera spike (2026-10-19): with no clothing named, the pilot was drawn as an airline captain, white
 * shirt and stripes; "in travel-worn utility clothes with many pockets" drew a jacket with pockets in 8 of 8. Null when there is none. */
export function pilotLook(soul:string):string|null {
  const sentences=soulSentences(soul);
  const first=(sentences.physical[0]??'').replace(/^(?:\S+\s){0,3}?(?:are|is)\s+/i,'');
  if(!first)return null;
  const parts=first.split(',').map(p=>(p.split(/\b(?:you|your|yours|yourself)\b/i)[0]??'').trim()).filter(p=>p&&!/\b(?:he|she|his|her|hers|him|they|them|their)\b/i.test(p));
  let n=0;const head=parts.filter(p=>n<3&&(n+=p.split(' ').length));
  const hair=head.some(p=>/\bhair\b/i.test(p))?undefined:parts.find(p=>/\bhair\b/i.test(p));
  const hairWords=hair?(/^(?:with\s+)?hair\b/i.test(hair)?words(hair,6):hair.replace(/(\bhair)\b.*$/i,'$1')).replace(/^with\s+/i,''):'';
  const clothes=clothingOf(sentences);
  const look=`${words(head.join(', '),12)}${hairWords?` with ${hairWords}`:''}${clothes?`, in ${clothes}`:''}`;
  return look||null;
}
/** The pilot's eyes in SOUL.md's words, for the one camera that shows the face: `eyes are a deep green` → "deep green eyes",
 * `steady grey eyes` → "steady grey eyes"; null when no colour is said. */
export function pilotEyes(soul:string):string|null {
  const {physical,all}=soulSentences(soul),text=[...physical,...all].join('. ');
  const after=/\beyes\s+(?:are|is)\s+(?:an?\s+|the\s+)?((?:[a-z-]+\s+){0,1}[a-z-]+)/i.exec(text)?.[1];
  const said=after&&!/\b(?:one|thing|that|which|never|always|the)\b/i.test(after)?after:/\b((?:[a-z-]+\s+)?[a-z-]+)\s+eyes\b/i.exec(text)?.[1];
  const colour=said?.split(/\s+/).filter(w=>!/^(?:your|his|her|their|my|the|a|an|and|with|of|two)$/i.test(w)).join(' ');
  return colour?`${colour.toLowerCase()} eyes`:null;
}
export const soulPath=(runtime:string)=>join(runtime,'..','..','SOUL.md');
const readSoul=(runtime:string)=>{try {return readFileSync(soulPath(runtime),'utf8');} catch {return '';}}; // edge: no SOUL.md is no look

/** POI or base to its system: the id itself, `places.json`, else the longest system id it is prefixed with. */
const systemOf=(id:string,places:Record<string,string>,galaxy:Galaxy)=>galaxy.systems[id]?id:places[id]??
  Object.keys(galaxy.systems).filter(s=>id.startsWith(`${s}_`)).sort((a,b)=>b.length-a.length)[0]??null;

/** The `lately` window ending at `target` (about the last ten runs or six hours) and the moment's `scope`. */
function spansOf(runs:Ended[],target:Ended) {
  const ended=String(target.line.at),endMs=ms(ended)??0;
  const window=runs.filter(r=>r.index<=target.index).slice(-LATELY_RUNS).filter(r=>endMs-(ms(r.line.at)??0)<=LATELY_MS);
  const first=window[0]??target,start=str(first.started?.started)??str(first.started?.at)??ended;
  return {window,first,lately:{start,end:ended},scope:{start:str(runs.filter(r=>r.index<target.index&&r.started).at(-1)?.line.at)??start,end:ended}};
}
/** What moments.ts adds to a scene: the moment (frames or journal), and from the frames only, the pilot at its depicted lead, the ship last named by the end, and the window's fights. */
interface FromFrames {moment:Moment|null;lead:{at:string;pilot:Pilot}|null;endShip:{cls:string;at:string}|null;fights:Fight[]|null;pois:ReadonlyMap<string,PoiFact>}

function sceneOf(runtime:string,lines:readonly JournalLine[],target:Ended,galaxy:Galaxy,spans:ReturnType<typeof spansOf>,frames:FromFrames):Scene {
  const ended=String(target.line.at),endMs=ms(ended)??0,asOf=(at:unknown)=>{const t=ms(at);return t!==undefined&&t<=endMs;};
  const upto=lines.slice(0,target.index+1),text=textOf(lines),names=readNames(runtime),places=readPlaces(runtime);
  const name=(id:string|null)=>nameOf(id,names,text,galaxy);
  const {window,first}=spans,spanStart=spans.lately.start,startMs=ms(spanStart)??endMs;
  // The window's runs, and what came between them unbound: a push or a death between two runs has no run_id.
  // Live 2026-10-19 (kvothe 06:03Z): a death 16 s after a run ended counted no death and no fight.
  const ids=new Set(window.map(r=>r.run_id)),mine=upto.filter(l=>l.query_id===undefined&&l.freighter===undefined&&
    (typeof l.run_id==='string'?ids.has(l.run_id):(ms(l.at)??0)>=startMs));
  const end=rec(target.line.end_state),start=rec(first.started?.start_state);
  // Fights: the frames' when they cover the window, else each battle_ended push in it, its ending and opponent from combat.json by battle_id when still kept.
  const fights=new Map(readCombat(runtime).filter(f=>asOf(f.at)).map(f=>[f.battle_id,f]));
  const ends=frames.fights??mine.filter(l=>l.event==='push'&&l.push==='battle_ended').map(l=>{const f=fights.get(String(l.battle_id));return {ending:f?.ending??str(l.reason),opponent:f?.opponent??null};});
  const sum=(side:string)=>mine.filter(l=>l.event==='trade'&&l.side===side&&typeof l.item_id==='string').reduce<Record<string,number>>((acc,l)=>({...acc,[String(l.item_id)]:(acc[String(l.item_id)]??0)+(num(l.quantity)??0)}),{});
  const traded=[...new Set(window.flatMap(r=>list(r.line.calls).map(rec).filter(c=>FRESH[String(c.fn)]==='trade')
    .flatMap(c=>[...String(c.did??'').matchAll(/ at ([a-z][a-z0-9_]+)/g)].map(m=>m[1]??'')).filter(id=>places[id]!==undefined)))];
  const systems:string[]=[];
  const visit=(s:unknown)=>{const id=str(s);if(id&&systems.at(-1)!==id)systems.push(id);};
  for(const r of window) {
    visit(rec(r.started?.start_state).system);
    for(const l of mine)if(l.run_id===r.run_id&&l.event==='command'&&l.action==='jump'&&l.ok===true)visit(rec(l.params).id);
    visit(rec(r.line.end_state).system);
  }
  const at=frames.lead?.pilot.system?frames.lead.pilot:null,system=at?at.system:str(end.system),poi=at?at.poi:str(end.poi),docked_at=at?at.docked_at:str(end.docked_at);
  // Creatures: the newest look at each POI of this system, inside the span; sightings.json keeps one look per POI.
  const seen=readSightings(runtime).filter(s=>s.species&&s.count>0&&asOf(s.at)&&(ms(s.at)??0)>=startMs&&system!==null&&(s.poi_id===poi||systemOf(s.poi_id,places,galaxy)===system))
    .map(s=>({poi:s.poi_id,poi_name:name(s.poi_id),species:String(s.species),count:s.count,seen_at:s.at}));
  const seenSystem=system?readSeen(runtime)[system]:undefined;
  const ship=[frames.lead?.pilot.ship_class?{cls:frames.lead.pilot.ship_class,at:frames.lead.at}:undefined,str(end.ship_class)?{cls:str(end.ship_class),at:ended}:undefined,frames.endShip??undefined,
    ...upto.filter(l=>str(l.ship_class)).map(l=>({cls:str(l.ship_class),at:String(l.at)})).reverse(),
    ...readCombat(runtime).filter(f=>asOf(f.at)&&f.ship_class).map(f=>({cls:f.ship_class,at:f.at}))].find(x=>x!==undefined);
  // ponytail: no class kept at or before the end (combat.json holds the last 60 fights only), so the newest
  // known from any source stands in, even one after the end, flagged as a lookahead: ships rarely change.
  // Lift it when the run's stateSnapshot carries the class.
  const later=ship?undefined:[...lines.filter(l=>str(l.ship_class)).map(l=>({cls:str(l.ship_class),at:String(l.at)})),
    ...readCombat(runtime).filter(f=>f.ship_class).map(f=>({cls:f.ship_class,at:f.at}))].sort((a,b)=>b.at.localeCompare(a.at))[0];
  const shipSeen=ship??later,shipClass=shipSeen?.cls??null,catalog=shipOf(runtime,shipClass);
  const hull=num(end.hull),maxHull=num(end.max_hull),fuel=num(end.fuel),mood=str(target.started?.mood);
  const soul=readSoul(runtime);
  const known=isMood(mood)?mood:undefined;
  const calls=list(target.line.calls).map(rec).filter(c=>c.status==='done'||c.status==='partial');
  // A call counts by what it moved: a hunt by being flown, mining by items, trade by credits either way, travel by fuel spent.
  const moved:Record<Fresh,(c:Row)=>boolean>={hunt:()=>true,mine:c=>(num(c.items)??0)>0,trade:c=>!!(num(c.credits)||num(rec(c.cost).credits)),travel:c=>(num(rec(c.cost).fuel)??0)>0};
  const did=new Set(calls.flatMap(c=>{const k=FRESH[String(c.fn)];return k&&moved[k](c)?[k]:[];}));
  const battle=mine.filter(l=>l.run_id===target.run_id&&l.event==='push'&&['battle_started','battle_update','battle_ended'].includes(String(l.push))).at(-1);
  const wallet={start:num(start.credits),end:num(end.credits)};
  const scene:Scene={
    juncture_id:str(target.started?.juncture_id),run_id:target.run_id,started:str(target.started?.started),ended,outcome:str(target.line.outcome),mood,
    where:{system,system_name:name(system),poi,poi_name:name(poi),poi_type:at?.poi_type??(poi?frames.pois.get(poi)?.type:null)??null,poi_class:poi?frames.pois.get(poi)?.class??null:null,
      sun:[...frames.pois.values()].find(p=>p.system===system&&p.type==='sun')?.class??null,docked_at,base_name:name(docked_at),
      security:seenSystem&&asOf(seenSystem.at)?seenSystem.security??null:null,empire:null},
    status:{hull,max_hull:maxHull,fuel,max_fuel:num(end.max_fuel),credits:num(end.credits),cargo_used:num(end.cargo_used),cargo_capacity:num(end.cargo_capacity),
      cargo:list(end.cargo).map(rec).flatMap(c=>typeof c.item_id==='string'&&num(c.quantity)!==null?[{item_id:c.item_id,quantity:Number(c.quantity)}]:[])
        .sort((a,b)=>b.quantity-a.quantity).slice(0,TOP_CARGO),
      ship_class:shipClass,ship_class_seen_at:shipSeen?.at??null,ship_class_seen_after_end:later!==undefined,ship_name:str(catalog.name),ship_faction:str(catalog.faction),ship_role:str(catalog.class)},
    work:target.line.work===undefined?null:workOf(target),
    company:{creatures:seen.filter(s=>s.poi===poi),nearby:seen.filter(s=>s.poi!==poi),ships:[]},
    lately:{runs:window.map(workOf),span:{start:spanStart,end:ended,hours:Math.round((endMs-startMs)/36e3)/100},
      wallet:{...wallet,change:wallet.start!==null&&wallet.end!==null?wallet.end-wallet.start:null},
      fights:{count:ends.length,won:ends.filter(f=>f.ending==='victory').length,lost:ends.filter(f=>f.ending==='defeat').length,
        other:ends.filter(f=>f.ending!=='victory'&&f.ending!=='defeat').length,last_opponent:ends.findLast(f=>f.opponent)?.opponent??null},
      trades:{bought:sum('buy'),sold:sum('sell'),places:traded.map(id=>({id,name:name(id)}))},
      deaths:mine.filter(l=>l.event==='death').length,strandings:mine.filter(l=>l.event==='stranded').length,
      systems:systems.map(id=>({id,name:name(id)}))},
    flags:{in_battle:battle!==undefined&&battle.push!=='battle_ended',
      hull_low:known&&hull!==null&&maxHull!==null?hull<Math.floor(resolveWalkAway(known)*maxHull):null,
      fuel_low:known&&fuel!==null?fuel<resolveFuelReserve(known):null,
      fresh_from:(['hunt','mine','trade','travel'] as const).find(k=>did.has(k))??null},
    moment:frames.moment,subject:subjectFacts(runtime,frames.moment,name),look:pilotLook(soul),eyes:pilotEyes(soul),names:frames.moment?Object.fromEntries(idsOf(frames.moment).flatMap(id=>{const n=name(id);return n?[[id,n]]:[];})):{},scope:spans.scope,
  };
  return scene;
}

/** The scenes `select` names (see `pick`), oldest first; empty when the journal has no such run.
 * Reads the journal back until the oldest has its `lately` window or the files run out. Each scene's
 * `moment` is the best of its `scope`, from `source` or the one that covers it (moments.ts).
 *
 * ponytail: re-reads whole files on each doubling, up to 800_000 lines; seek from the end if a
 * journal ever outgrows that. */
export async function scenes(runtime:string,select='latest',last=1,source?:Source):Promise<Scene[]> {
  return (await read(runtime,select,last,source,1)).flatMap(s=>s.slice(0,1));
}

/** Moment 2 of a flight: the best moment of the scope (best first) that does not lead with moment 1's lead and shows the pilot's own
 * act or a fight, preferring another category or another subject so the two pictures differ; null when there is none. A chat is
 * never one. */
export function secondMoment(ms:readonly Moment[],first:Moment|null,noProp:ReadonlySet<string>=new Set()):Moment|null {
  const lead=first?depicted(first)?.lead:undefined;
  if(!first||!lead)return null;
  const subject=subjectOf(first,noProp)?.id;
  const others=ms.filter(m=>{const d=depicted(m)?.lead;return !!d&&!m.events.includes(lead)&&d.category!=='social'&&(d.involvement===INVOLVEMENT.self||d.category==='combat');});
  return others.find(m=>depicted(m)?.lead.category!==lead.category||subjectOf(m,noProp)?.id!==subject)??others[0]??null;
}

/** A flight's scenes for the end-of-flight post: moment 1 (`pictured`), then moment 2 (`secondMoment`) when there is one. Empty
 * when the journal has no such run. */
export async function flightScenes(runtime:string,run_id:string):Promise<Scene[]> {
  return (await read(runtime,run_id,1,undefined,2))[0]??[];
}

async function read(runtime:string,select:string,last:number,source:Source|undefined,count:1|2):Promise<Scene[][]> {
  let limit=FIRST_READ,lines=readJournal(runtime,limit);
  while(!enough(lines,select,last)&&lines.length>=limit&&limit<MOST_READ) {limit=Math.min(limit*2,MOST_READ);lines=readJournal(runtime,limit);}
  const runs=endedRuns(lines),picked=pick(runs,select,last);
  if(!picked.length)return [];
  const galaxy=await loadGalaxy(runtime,{maxAgeMs:Infinity}); // the kept map as it is: fetched only when there is none
  const each=picked.map(r=>({r,spans:spansOf(runs,r)})),found=moments(runtime,each.flatMap(e=>[e.spans.scope,e.spans.lately]),source);
  const noProp=count>1?noPropOf(runtime):new Set<string>();
  return each.map(({r,spans},i)=>{
    const inScope=found[2*i],inLately=found[2*i+1],first=inScope?pictured(inScope.moments,inScope.events):null;
    const second=count>1&&inScope?secondMoment(inScope.moments,first,noProp):null;
    const last=inScope?.events.findLast(e=>e.pilot?.ship_class);
    return [first,...second?[second]:[]].map(moment=>{
      const lead=moment?depicted(moment)?.lead:undefined;
      return sceneOf(runtime,lines,r,galaxy,spans,{moment,lead:lead?.pilot?{at:lead.at,pilot:lead.pilot}:null,
        endShip:last?.pilot?.ship_class?{cls:last.pilot.ship_class,at:last.at}:null,fights:inLately?.source==='frames'?fightsOf(inLately.events):null,pois:inScope?.pois??new Map()});
    });
  });
}

/** The `oracle` line for a scene: the record whole, joinable by `run_id` (oracle.jsonl, pictures.ts). */
export const oracleLine=(scene:Scene)=>({event:'oracle',run_id:scene.run_id,juncture_id:scene.juncture_id,scene});
