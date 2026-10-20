/** The moment scorer: the most interesting stretch of a flight, for the end-of-flight picture to depict.
 * Picture-only and offline: it reads the runtime's files (raw frames, else the journal), never the bridge.
 *
 * Every frame (or journal line) becomes an event; an event scores
 * `weight(category) × (rarity + change + first) × involvement × habituation`, each term in [0,1]:
 * rarity is the surprisal of its (type, variant) in this pilot's history before it, change is how far its
 * state deltas exceed this pilot's typical ones, first is identities never seen before, and habituation
 * damps a type repeating within the curve's time constant. The scores feed an excitement curve decaying
 * with `TAU_MS`; a moment is a maximal span where the curve stays at or above half its own peak, scored by
 * the sum of its events and a recency half-life from the target run's end. No lookahead: an event is
 * scored only against what came before it. */
import {closeSync,existsSync,openSync,readSync} from 'node:fs';
import {ACTIONS} from '@spacemolt/lib';
import {Option} from 'effect';
import {readCombat} from '../combat-memory.ts';
import {readSightings} from '../sighting-memory.ts';
import {decodeLine,isRecord,journalFiles,type JournalLine} from '../run-record.ts';
import {CATEGORY,EXCLUDED_QUERIES,WRECK_SALVAGE,type Category} from './catalogue.ts';

export const WEIGHTS:Record<Category,number>={hazard:3,combat:2,discovery:1.5,progression:1.5,economy:1,extraction:1,crafting:1,missions:1,holdings:1,faction:1,travel:0.7,social:0.5,system:0};
export const UNCATALOGUED_WEIGHT=1;
/** The pilot is the subject (its own act or reply, its own battle, addressed to it); merely nearby (its
 * system or POI); a broadcast to everyone. */
export const INVOLVEMENT={self:1,nearby:0.5,global:0.2};
export const TAU_MS=180_000,RECENCY_HALF_LIFE_MS=3*3600_000;
/** Rarity is `-log2 p / RARITY_BITS`, capped at 1: an event 1 in 4096 or rarer is maximal. */
export const RARITY_BITS=12;
/** A relative field's change is 0 at this pilot's typical |Δ| and 1 at `CHANGE_FULL` times it; a field
 * with no history yet counts `NEW_FIELD_CHANGE`. Typical is the geometric mean of the |Δ| seen before. */
export const CHANGE_FULL=4,NEW_FIELD_CHANGE=0.5;
/** Categorical changes, per unit: a system jump, a POI move, a skill level, a mission taken/finished/dropped, a ship lost. */
export const FIXED_CHANGE:Record<string,number>={system:0.5,poi:0.2,level:0.5,mission:0.3,ship:1};
const RELATIVE=['credits','hull','fuel','cargo','damage'];
/** Each identity never seen before adds this much to `first`, capped at 1. */
export const FIRST_EACH=0.5;
/** Supporting events: the top event of up to this many categories other than the lead's. */
export const SUPPORTING=2;
/** An event that changed nothing and named nothing new keeps this share of its rarity term. */
export const DULL_RARITY=0.5;
/** A moment's longest span (4 tau): a longer run above the half line keeps its best sub-span this long. */
export const MAX_SPAN_MS=4*TAU_MS;

export type Kind='species'|'item'|'opponent'|'ship_class'|'system'|'poi'|'player';
export interface Identity {kind:Kind;id:string}
export interface MomentEvent {
  at:string;ms:number;type:string;variant:string|null;category:Category|'uncatalogued';involvement:number;
  /** Relative fields (credits, hull, fuel, cargo, damage) as signed changes; categorical ones (system, poi,
   * level, mission, ship) as counts. */
  delta:Record<string,number>;identities:Identity[];note:string|null;
  /** The event's own scalar fields (a push's payload, a reply's details, a journal command's params and its
   * trade or mission line), for the words a picture puts to it. */
  facts:Record<string,string|number>;
  /** From the journal: pushes capped at 20/min per type, per-shot battle frames dropped, few deltas. */
  approximate:boolean;
  /** Where the pilot was and what it flew at this event, as the frames last said (after a reply's own state); absent from the journal. */
  pilot?:Pilot;
}
/** The pilot's place and ship as the frames last gave them: a reply's or the login's state sections, its own row in a
 * battle's `participants`, a death's `ship_lost`. */
export interface Pilot {system:string|null;poi:string|null;docked_at:string|null;ship_class:string|null;
  /** The POI's kind as the location section says it (`sun`, `planet`, `gas_cloud`, `station`, …), for what the picture can draw there. */
  poi_type?:string|null}
/** `rarity` is the term as used: halved when the event changed nothing and named nothing new. */
export interface Scored extends MomentEvent {score:number;rarity:number;change:number;first:number;habituation:number}
export interface Moment {start:string;end:string;score:number;raw:number;approximate:boolean;events:Scored[];lead:Scored;supporting:Scored[];identities:Identity[];
  /** The best event of each category that came earlier in the scope but is not in the moment (system left out). */
  earlier:Scored[]}
export type Source='frames'|'journal';

type Row=Record<string,unknown>;
const str=(v:unknown)=>typeof v==='string'&&v?v:null;
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const rec=(v:unknown):Row=>isRecord(v)?v:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];

const IDENTITY:Record<string,Kind>={system_id:'system',wreck_system_id:'system',source_system:'system',prize_system:'system',transit_dest_system_id:'system',
  poi_id:'poi',wreck_poi_id:'poi',source_poi:'poi',prize_poi:'poi',base_id:'poi',docked_at:'poi',respawn_base:'poi',
  item_id:'item',resource_id:'item',species_id:'species',
  killer_name:'opponent',pirate_name:'opponent',target_name:'opponent',attacker_name:'opponent',opponent:'opponent',
  ship_class:'ship_class',class_id:'ship_class',scanner_ship_class:'ship_class',
  player_id:'player',sender_id:'player',scanner_id:'player',source_player_id:'player',challenger_id:'player',offerer_id:'player',captor_id:'player'};

/** The identities a record names at its top level and in its arrays of records, the pilot's own left out: its
 * id and name, and any row of an array that is the pilot's (a battle's `participants` row carries its ship class). */
function identitiesOf(row:Row,self:Self={}):Identity[] {
  const found:Identity[]=[];
  for(const r of [row,...Object.values(row).flatMap(v=>list(v).filter(isRecord).filter(x=>self.id===undefined||x.player_id!==self.id))])
    for(const [key,kind] of Object.entries(IDENTITY)) {const id=str(r[key]);if(id&&id!==self.id&&id!==self.name)found.push({kind,id});}
  return found;
}
const unique=(ids:Identity[])=>[...new Map(ids.map(i=>[`${i.kind}:${i.id}`,i])).values()];

interface Self {id?:string|undefined;name?:string|undefined}
function involvementOf(type:string,variant:string|null,p:Row,self:Self):number {
  const mine=(...vs:unknown[])=>vs.some(v=>v!==undefined&&(v===self.id||v===self.name));
  switch(type) {
    case 'pirate_radio':case 'market_update':case 'observation_update':
    case 'faction_alliance_broken':case 'faction_alliance_formed':case 'faction_alliance_proposal':case 'faction_peace_accepted':case 'faction_peace_proposal':case 'faction_war_declared':
      return INVOLVEMENT.nearby;
    case 'base_destroyed':case 'base_raid_update':return mine(p.owner_id)?INVOLVEMENT.self:INVOLVEMENT.global;
    case 'pirate_destroyed':return mine(p.killer,p.operator_id)||!self.id?INVOLVEMENT.self:INVOLVEMENT.global; // edge: no login seen, so the kill is taken as ours, as it usually is
    case 'battle_damage':return mine(p.attacker_id,p.target_id)||!self.id?INVOLVEMENT.self:INVOLVEMENT.nearby;
    case 'battle_started':case 'battle_joined':return mine(...list(p.participants).map(x=>rec(x).player_id))||!self.id?INVOLVEMENT.self:INVOLVEMENT.nearby;
    // Live 2026-10-19 (kvothe 06:02Z): the pirate's alert listed the pilot among its participants and scored as nearby. An alert
    // is everyone's in the system, so with no login seen it is not taken as ours.
    case 'battle_alert':return mine(...list(p.participants).map(x=>rec(x).player_id))?INVOLVEMENT.self:INVOLVEMENT.nearby;
    case 'battle_left':return mine(p.player_id)||!self.id?INVOLVEMENT.self:INVOLVEMENT.nearby;
    case 'chat_message':return p.channel==='private'||mine(p.target_id)?INVOLVEMENT.self:p.channel==='system'||p.channel==='local'?INVOLVEMENT.nearby:INVOLVEMENT.global;
    case 'ok':return variant==='new_forum_post'?INVOLVEMENT.global:INVOLVEMENT.self;
    default:return INVOLVEMENT.self;
  }
}

const categoryOf=(type:string,variant:string|null)=>(variant!==null?CATEGORY.get(`${type}:${variant}`):undefined)??CATEGORY.get(type)??'uncatalogued';
function event(at:string,type:string,variant:string|null,p:Row,self:Self,o:{delta?:Record<string,number>;identities?:Identity[];note?:string|null;approximate:boolean}):MomentEvent {
  return {at,ms:Date.parse(at),type,variant,category:categoryOf(type,variant),involvement:involvementOf(type,variant,p,self),
    delta:o.delta??{},identities:unique(o.identities??identitiesOf(p,self)),note:o.note??null,facts:factsOf(p),approximate:o.approximate};
}
const factsOf=(p:Row)=>Object.fromEntries(Object.entries(p).flatMap(([k,v])=>typeof v==='string'&&v&&v.length<=80||num(v)!==null?[[k,typeof v==='string'?v:Number(v)]]:[]));

/** Magnitudes a push carries itself, the ones not also in a state delta of ours. */
function pushDelta(type:string,p:Row,self:Self):Record<string,number> {
  const d:Record<string,number>={};
  const put=(k:string,v:number|null)=>{if(v)d[k]=v;};
  if(type==='mining_yield')put('cargo',num(p.quantity));
  if(type==='battle_ended')put('damage',num(p.total_damage));
  if(type==='battle_damage'&&self.id!==undefined&&p.target_id===self.id)put('hull',-(num(p.hull_hit)??0));
  if(type==='player_died')d.ship=1;
  if(type==='skill_level_up')d.level=1;
  if(type==='pirate_destroyed')put('credits',num(p.credits_earned));
  if(type==='complete_mission'){put('credits',num(rec(p.rewards).credits));d.mission=1;}
  if(type==='gift_received')put('credits',num(p.credits));
  if(type==='refueled_by')put('fuel',num(p.fuel));
  if(type==='repaired_by')put('hull',num(p.repaired));
  return d;
}

/** The command a reply answers, by its key, or the `command` an `action_result` names. */
const KEYS=Object.keys(ACTIONS);
const commandKey=(command:string)=>ACTIONS[command]?command:KEYS.find(k=>k===`spacemolt/${command}`)??KEYS.find(k=>k.endsWith(`/${command}`))??command;

/** An unrequested `action_result` this soon after a push of its command's name is that push's state report. */
export const TWIN_MS=2000;
/** Raw frames (`frames.jsonl`) to events, the pilot's own connection only. Outbound frames name the command
 * a reply answers, by `request_id`; state sections in `action_result`s are absolute, so a running state
 * turns them into deltas. Every event carries the pilot's place and ship at it (`pilot`). The events of a
 * battle the pilot is in carry its `battle_id` and its other participants (ship class, player, name), which
 * only the battle's opening frame lists, and its other side's kind, pilot and ship name (`foe_*`) when that flies a
 * ship. A shot at the pilot from outside its battle (a station's guns) names its shooter and weapons (`gunner`, `weapons`). */
export function fromFrames(lines:readonly JournalLine[],species:ReadonlySet<string>=new Set()):MomentEvent[] {
  const sent=new Map<string,string>(),state:Record<string,number|string>={},out:MomentEvent[]=[],pushes=new Map<string,MomentEvent>();
  const own:Pilot={system:null,poi:null,docked_at:null,ship_class:null,poi_type:null},put=(e:MomentEvent)=>{e.pilot={...own};out.push(e);return e;};
  let self:Self={},battle:{id:string;ids:Identity[];members:Set<string>;foe:Record<string,string>}|null=null;
  const diff=(r:Row)=>{
    const player=rec(r.player),ship=rec(r.ship),loc=rec(r.location),d:Record<string,number>={},ids:Identity[]=[];
    const skills=isRecord(r.skills)?Object.values(r.skills).reduce<number>((n,s)=>n+(num(rec(s).level)??0),0):null;
    const now:Record<string,number|null>={credits:num(player.credits)??num(r.credits),hull:num(ship.hull),fuel:num(ship.fuel),cargo:num(ship.cargo_used),
      level:skills,mission:isRecord(r.missions)?list(r.missions.active).length:null};
    for(const [k,v] of Object.entries(now)) {
      if(v===null)continue;
      const was=state[k];
      if(typeof was==='number'&&v!==was)d[k]=RELATIVE.includes(k)?v-was:Math.abs(v-was);
      state[k]=v;
    }
    const system=str(loc.system_id),poi=str(loc.poi_id),cls=str(ship.class_id);
    if(cls)own.ship_class=cls;
    if(system){own.system=system;own.poi=poi;own.docked_at=str(loc.docked_at);own.poi_type=str(loc.poi_type);if(state.system!==undefined&&system!==state.system)d.system=1;state.system=system;ids.push({kind:'system',id:system});}
    if(poi){if(state.poi!==undefined&&poi!==state.poi&&!d.system)d.poi=1;state.poi=poi;ids.push({kind:'poi',id:poi});}
    const docked=str(loc.docked_at);
    if(docked)ids.push({kind:'poi',id:docked});
    return {d,ids};
  };
  for(const line of lines) {
    if(line.freighter!==undefined)continue;
    const at=str(line.at),f=rec(line.frame),type=str(f.type),p=rec(f.payload),rid=str(f.request_id);
    if(!at)continue;
    if(line.dir==='out'){const tool=str(f.tool),action=str(f.action);if(rid&&tool&&action)sent.set(rid,`${tool}/${action}`);continue;}
    if(!type||type==='welcome'||type==='registered')continue;
    if(type==='logged_in'){const player=rec(p.player);self={id:str(player.id)??undefined,name:str(player.username)??undefined};diff({player,ship:p.ship,location:{system_id:rec(p.system).id,poi_id:rec(p.poi).id,docked_at:player.docked_at}});continue;}
    const key=rid?sent.get(rid):undefined;
    if(type==='result') {
      if(!key||EXCLUDED_QUERIES.has(key)||ACTIONS[key]?.kind==='mutation')continue; // a mutation's ack; its outcome is the action_result
      const sc=rec(p.structuredContent);
      put(event(at,key,null,sc,self,{note:str(sc.message)??(typeof p.result==='string'?p.result.slice(0,80):null),approximate:false}));
      continue;
    }
    if(type==='action_result') {
      const r=rec(p.result),details=rec(r.details),{d,ids}=diff(r),command=str(p.command)??'?';
      const t=rid?key??commandKey(command):'action_result',v=rid?null:command;
      if(EXCLUDED_QUERIES.has(t))continue;
      // Live 2026-10-19 (kvothe 06:03Z): a death came as its player_died push and, 5 ms later, an unrequested action_result
      // naming player_died with the respawned state; both scored 6. One death is one event, the push; the reply only moves the state.
      // ponytail: pairs a push followed by its reply, the order seen live; a reply first would count twice.
      const twin=rid?undefined:pushes.get(command);
      if(twin&&Date.parse(at)-twin.ms<=TWIN_MS)continue;
      put(event(at,t,v,details,self,{delta:d,identities:[...identitiesOf(details,self),...ids],note:str(r.message),approximate:false}));
      continue;
    }
    if(type==='action_error'||type==='error'){put(event(at,type,key??str(p.command),p,self,{note:str(p.message),identities:[],approximate:false}));continue;}
    const variant=type==='ok'?str(p.action)??str(p.type)??'message':type==='fleet'?str(p.action):null;
    // Live 2026-10-19 (kvothe 06:03Z): the pilot died in a Dust Devil and the run ended in the respawned Cobble; the
    // ship at an event is the one its battle row or its death names.
    const seat=self.id===undefined?undefined:list(p.participants).map(rec).find(x=>x.player_id===self.id);
    const cls=str(seat?.ship_class)??(type==='player_died'?str(p.ship_lost):null),id=str(p.battle_id);
    if(cls)own.ship_class=cls;
    const e=event(at,type,variant,p,self,{delta:pushDelta(type,p,self),note:str(p.message)??str(p.reason)??str(p.content),approximate:false});
    // Live 2026-10-19 (kvothe 08:41Z): a battle nearby listed a creature by its instance id, and the picture spelled it out as
    // "Crt Dc1f7b404…"; a participant is named by its username.
    const others=list(p.participants).map(rec).filter(x=>x.player_id!==self.id);
    e.identities=unique([...e.identities,...others.flatMap(x=>str(x.username)?[{kind:'opponent' as const,id:String(x.username)}]:[])]);
    if((type==='battle_started'||type==='battle_joined')&&id&&e.involvement===INVOLVEMENT.self) {
      // The other side's ship and pilot, when it flies one, for the words a fight or a death in it puts to the opponent.
      const foe=others[0],foeFacts:Record<string,string>=foe&&str(foe.ship_class)&&str(foe.username)?{foe_kind:str(foe.kind)??'player',foe_name:String(foe.username),...str(foe.ship_name)?{foe_ship:String(foe.ship_name)}:{}}:{};
      e.facts={...e.facts,...foeFacts,battle_id:id};
      battle={id,ids:e.identities.filter(i=>i.kind==='ship_class'||i.kind==='player'||i.kind==='opponent'),members:new Set(others.flatMap(x=>str(x.player_id)??[])),foe:foeFacts};
    } else if(battle&&(e.category==='combat'||type==='player_died')&&(id??battle.id)===battle.id){e.facts={...e.facts,...battle.foe,battle_id:battle.id};e.identities=unique([...e.identities,...battle.ids]);}
    // Live 2026-10-19 (kvothe 7b7030a8): a battle the pilot only heard of drew its Dialectic diving at us. Such a battle names its
    // first ship's other side, `creature` or a ship's class, for a picture that shows it at a distance.
    if(e.involvement!==INVOLVEMENT.self&&others.length) {
      const ship=others.find(x=>str(x.ship_class)),other=ship&&others.find(x=>x!==ship&&(x.side_id===undefined||x.side_id!==ship.side_id));
      const side=other?other.kind==='creature'?'creature':str(other.ship_class)??'ship':null;
      if(side)e.facts.other_side=side;
    }
    // Live 2026-10-19 (kvothe 06:03Z): the shot that destroyed the Dust Devil was Kael Arsenal Station's, not the pirate's it fought;
    // a shooter that is no participant is named with what it fired.
    if(type==='battle_damage'&&self.id!==undefined&&p.target_id===self.id&&str(p.attacker_name)&&!battle?.members.has(String(p.attacker_id))) {
      e.facts.gunner=String(p.attacker_name);
      const fired=[...new Set(list(p.weapons_fired).flatMap(w=>str(w)??[]))];
      if(fired.length)e.facts.weapons=fired.join('|');
    }
    // Live 2026-10-19 (kvothe 06:03Z): `battle_left` reason destroyed came 24 ms before the death; the death is still that battle's.
    if(battle&&(type==='battle_ended'&&id===battle.id||type==='battle_left'&&e.involvement===INVOLVEMENT.self&&p.reason!=='destroyed'||type==='player_died'))battle=null;
    pushes.set(type,put(e));
  }
  return wrecks(withSpecies(out,species));
}

export interface Fight {battle_id:string;ending:string|null;opponent:string|null}
/** The pilot's fights among `events` (the frames'; the journal's carry no battle membership): one per battle it
 * started or joined, its opponent the first other participant's name, its ending the battle's `battle_ended`
 * reason, else `defeat` when the pilot was destroyed in it or died, else the reason it left. */
export function fightsOf(events:readonly MomentEvent[]):Fight[] {
  const fights=new Map<string,Fight>();
  for(const e of events) {
    const id=str(e.facts.battle_id);
    if(!id)continue;
    if((e.type==='battle_started'||e.type==='battle_joined')&&e.involvement===INVOLVEMENT.self&&!fights.has(id))fights.set(id,{battle_id:id,ending:null,opponent:e.identities.find(i=>i.kind==='opponent')?.id??null});
    const f=fights.get(id),reason=str(e.facts.reason);
    if(!f||f.ending)continue;
    if(e.type==='battle_ended')f.ending=reason;
    else if(e.type==='player_died'||e.type==='battle_left'&&e.involvement===INVOLVEMENT.self)f.ending=e.type==='player_died'||reason==='destroyed'?'defeat':reason;
  }
  return [...fights.values()];
}

/** A wreck salvaged within this long of a fight is that fight's opponent's. */
export const WRECK_WITHIN_MS=15*60_000;
/** Salvage from a wreck (`WRECK_SALVAGE`) names the wreck's ship as `facts.wreck_of`: the opponent of the
 * last fight before it, when that is recent. Neither the journal nor the loot reply says whose wreck it is. */
function wrecks(events:MomentEvent[]):MomentEvent[] {
  let fought:{e:MomentEvent;id:string}|undefined;
  for(const e of events) {
    const opponent=e.category==='combat'?e.identities.find(i=>i.kind==='opponent')?.id:undefined;
    if(opponent)fought={e,id:opponent};
    if(!WRECK_SALVAGE.has(e.type)||!fought||e.ms-fought.e.ms>WRECK_WITHIN_MS)continue;
    e.facts.wreck_of=fought.id;
    const foe=foeOf(fought.e);
    if(foe)e.facts.wreck_foe=foe;
    e.identities=unique([...e.identities,...fought.e.identities.filter(i=>i.kind==='species')]);
  }
  return events;
}

/** A species id from a display name: case, hyphens and spaces folded ("Veil-Ray" is `veil_ray`). */
export const speciesKey=(name:string)=>name.trim().toLowerCase().replace(/[-\s]+/g,'_');
/** A fight whose opponent's name is a known species (sightings.json) names that species too, so the
 * picture knows a creature from a ship. */
function withSpecies(events:MomentEvent[],species:ReadonlySet<string>):MomentEvent[] {
  if(!species.size)return events;
  for(const e of events)if(e.category==='combat'){
    const found=e.identities.filter(i=>i.kind==='opponent').map(i=>speciesKey(i.id)).filter(id=>species.has(id));
    if(found.length)e.identities=unique([...e.identities,...found.map(id=>({kind:'species' as const,id}))]);
  }
  return events;
}

/** What a fight was against, as far as its event says: a creature (a species), a ship (a ship class, a
 * player, a pirate), or null when nothing says. */
export function foeOf(e:Pick<MomentEvent,'type'|'identities'|'facts'>):'creature'|'ship'|null {
  if(e.identities.some(i=>i.kind==='species'))return 'creature';
  if(e.identities.some(i=>i.kind==='ship_class'||i.kind==='player')||typeof e.facts.pirate_name==='string'||e.type==='pirate_destroyed'||e.type==='player_kill')return 'ship';
  return null;
}

/** The command parameter that names an identity, per command (the journal keeps params, not the reply). */
const PARAM_ID:Record<string,Kind>={'spacemolt/jump':'system','spacemolt/travel':'poi','spacemolt/sell':'item','spacemolt/buy':'item'};

/** The journal (`gameplay*.jsonl`) to the same events, approximately: a command line is its reply, a
 * `trade` or `mission` line adds its credits and cargo to the command just before it, and a fight's
 * opponent comes from `combat.json` by battle id. Lines written inside a query or by a freighter are left out. */
export function fromJournal(lines:readonly JournalLine[],opponents:ReadonlyMap<string,string>=new Map(),species:ReadonlySet<string>=new Set()):MomentEvent[] {
  const out:MomentEvent[]=[],self:Self={},o={approximate:true};
  // Where the pilot is docked as of each line (the run's start, then dock/undock and the runtime's "docked at"
  // line), and the opponent the current battle's `target` command named: the journal keeps neither on the event.
  let last:MomentEvent|undefined,lastRun:unknown,docked:string|null=null,target:string|undefined;
  for(const l of lines) {
    const at=str(l.at);
    if(!at||l.query_id!==undefined||l.freighter!==undefined)continue;
    if(l.event==='run'&&l.phase==='started'){docked=str(rec(l.start_state).docked_at);target=undefined;continue;}
    if(l.event==='line'){const m=/\bdocked at ([a-z][a-z0-9_]+)/.exec(String(l.text??''));if(m?.[1])docked=m[1];continue;}
    if(l.event==='command') {
      const key=`${String(l.tool)}/${String(l.action)}`,p=rec(l.params),kind=PARAM_ID[key],id=str(p.id);
      if(EXCLUDED_QUERIES.has(key))continue;
      if(l.ok!==true){out.push(event(at,'action_error',key,p,self,{...o,identities:[],note:str(l.code)}));continue;}
      if(key==='spacemolt/dock'||key==='spacemolt/undock')docked=null; // a dock's base comes from the "docked at" line after it
      if(key==='spacemolt_battle/target')target=/Target set to (.+?)\.?$/.exec(String(l.summary??''))?.[1]??target;
      const delta:Record<string,number>={};
      if(key==='spacemolt/jump')delta.system=1;
      if(key==='spacemolt/travel')delta.poi=1;
      if(l.action==='loot'&&num(p.quantity))delta.cargo=Number(p.quantity);
      last=event(at,key,null,p,self,{...o,delta,identities:[...identitiesOf(p),...kind&&id?[{kind,id}]:[]],note:str(l.summary)});
      if(docked&&(last.category==='economy'||last.category==='missions'))last.facts.base_id=docked;
      out.push(last);lastRun=l.run_id;
    } else if(l.event==='trade'&&last&&l.run_id===lastRun) {
      const total=num(l.total)??0,q=num(l.quantity)??0,item=str(l.item_id);
      if(l.side==='sell'){last.delta.credits=(last.delta.credits??0)+total;last.delta.cargo=(last.delta.cargo??0)-q;}
      else if(l.side==='buy'){last.delta.credits=(last.delta.credits??0)-total;last.delta.cargo=(last.delta.cargo??0)+q;}
      else {last.delta.credits=(last.delta.credits??0)-total;if(num(l.fuel))last.delta.fuel=Number(l.fuel);}
      if(item)last.identities=unique([...last.identities,{kind:'item',id:item}]);
      last.facts={...last.facts,...factsOf({side:l.side,service:l.service,item_id:l.item_id,quantity:l.quantity,total:l.total})};
    } else if(l.event==='mission'&&last&&l.run_id===lastRun&&last.type.endsWith('_mission')) {
      last.delta.mission=1;
      last.facts={...last.facts,...factsOf({title:l.title,mission_id:l.mission_id,verb:l.verb})};
    } else if(l.event==='push'&&typeof l.push==='string') {
      const variant=l.push==='ok'?str(l.action)??str(l.type)??'message':l.push==='fleet'?str(l.action):null;
      const opponent=l.push==='battle_ended'?opponents.get(String(l.battle_id))??target:opponents.get(String(l.battle_id));
      if(l.push==='battle_ended')target=undefined;
      const e=event(at,l.push,variant,l,self,{...o,delta:pushDelta(l.push,l,self),identities:[...identitiesOf(l),...opponent?[{kind:'opponent' as const,id:opponent}]:[]],
        note:str(l.reason)??str(l.message)??str(l.cause)});
      if(opponent)e.facts.opponent=opponent;
      out.push(e);
    } else if(l.event==='stranded') {
      // The runtime's own line, not a game frame: out of fuel or hull where no one sells it. Hazard, and the pilot's own.
      const ids=[str(l.system)?{kind:'system' as const,id:String(l.system)}:[],str(l.poi)?{kind:'poi' as const,id:String(l.poi)}:[]].flat();
      out.push({...event(at,'stranded',null,l,self,{...o,identities:ids,note:str(l.tired_by)}),category:'hazard',involvement:INVOLVEMENT.self});
    } else if(l.event==='unsolicited_move') {
      const system=/system=(\S+)/.exec(String(l.evidence))?.[1];
      out.push(event(at,'ok',str(l.cause),l,self,{...o,delta:system?{system:1}:{},identities:system?[{kind:'system',id:system}]:[],note:str(l.evidence)}));
    }
  }
  return wrecks(withSpecies(out,species));
}

/** Each event scored against the stream before it, in time order. */
export function score(events:readonly MomentEvent[]):Scored[] {
  const counts=new Map<string,number>(),typical=new Map<string,{n:number;logs:number}>(),seen=new Set<string>(),habit=new Map<string,{h:number;ms:number}>();
  let total=0;
  return [...events].sort((a,b)=>a.ms-b.ms).map(e=>{
    const key=`${e.type}|${e.variant??''}`,c=counts.get(key)??0;
    const rarity=c===0?1:Math.min(1,-Math.log2((c+1)/(total+counts.size+1))/RARITY_BITS);
    let change=0;
    for(const [field,v] of Object.entries(e.delta)) {
      const size=Math.abs(v);
      if(!size)continue;
      if(!RELATIVE.includes(field)){change+=(FIXED_CHANGE[field]??0)*size;continue;}
      // A sale is measured against past sales; a type's first change of this field against the field at large.
      const own=`${e.type}|${field}`,t=typical.get(own)??typical.get(field);
      change+=t?Math.min(1,Math.max(0,(size/Math.exp(t.logs/t.n)-1)/(CHANGE_FULL-1))):NEW_FIELD_CHANGE;
      for(const k of [own,field]){const was=typical.get(k);typical.set(k,{n:(was?.n??0)+1,logs:(was?.logs??0)+Math.log(size)});}
    }
    const fresh=e.identities.filter(i=>!seen.has(`${i.kind}:${i.id}`)).length;
    for(const i of e.identities)seen.add(`${i.kind}:${i.id}`);
    const was=habit.get(key),h=was?was.h*Math.exp(-(e.ms-was.ms)/TAU_MS):0;
    habit.set(key,{h:h+1,ms:e.ms});
    counts.set(key,c+1);total++;
    const weight=e.category==='uncatalogued'?UNCATALOGUED_WEIGHT:WEIGHTS[e.category];
    const first=Math.min(1,fresh*FIRST_EACH),changed=Math.min(1,change);
    const s={rarity:changed===0&&first===0?rarity*DULL_RARITY:rarity,change:changed,first,habituation:1/(1+h)};
    return {...e,...s,score:weight*(s.rarity+s.change+s.first)*e.involvement*s.habituation};
  });
}

/** The moments of `scored` between `start` and `end` (ISO), best first. The curve is each event's score
 * decaying both ways from it with `TAU_MS`, so a fight's opening shots belong to it as much as its last
 * (a curve that only decays forward puts the build-up below half the peak it leads to). A moment grows
 * from the highest point of the curve not yet in one to each neighbouring event while the curve between
 * them stays at or above the half line, halfway from the scope's median excitement to that peak (so a
 * steady loop is the floor and a moment is a rise above it), stopping at another moment's events; a run
 * longer than `MAX_SPAN_MS` keeps the sub-span of that length round the peak with the most score. It
 * spans its first event to its last. */
export function momentsIn(scored:readonly Scored[],start:string,end:string):Moment[] {
  const lo=Date.parse(start),hi=Date.parse(end),es=scored.filter(e=>e.ms>=lo&&e.ms<=hi&&e.score>0);
  const k=(d:number)=>Math.exp(-d/TAU_MS),ms=(i:number)=>es[i]?.ms??0,s=(i:number)=>es[i]?.score??0,fwd:number[]=[],back:number[]=[];
  for(let i=0;i<es.length;i++)fwd[i]=s(i)+(i>0?(fwd[i-1]??0)*k(ms(i)-ms(i-1)):0);
  for(let i=es.length-1;i>=0;i--)back[i]=s(i)+(i<es.length-1?(back[i+1]??0)*k(ms(i+1)-ms(i)):0);
  const curve=(i:number)=>(fwd[i]??0)+(back[i]??0)-s(i);
  // The lowest the curve gets between events i and i+1: what came before decaying right plus what comes after decaying left.
  const dip=(i:number)=>{const f=fwd[i]??0,b=back[i+1]??0,d=ms(i+1)-ms(i),t=d/2+TAU_MS/2*Math.log(f/b);
    return t>0&&t<d?2*Math.sqrt(f*b*k(d)):Math.min(curve(i),curve(i+1));};
  const order=es.map((_,i)=>i).sort((a,b)=>curve(b)-curve(a)),base=curve(order[Math.floor(order.length/2)]??0);
  const sum:number[]=[0];
  es.forEach((e,i)=>sum.push((sum[i]??0)+e.score));
  const between=(a:number,b:number)=>(sum[b+1]??0)-(sum[a]??0);
  const taken=new Array<boolean>(es.length).fill(false),moments:Moment[]=[];
  for(const peak of order) {
    if(taken[peak])continue;
    const half=base+Math.max(0,curve(peak)-base)/2;
    let a=peak,b=peak;
    while(a>0&&!taken[a-1]&&dip(a-1)>=half)a--;
    while(b+1<es.length&&!taken[b+1]&&dip(b)>=half)b++;
    if(ms(b)-ms(a)>MAX_SPAN_MS) {
      let best:[number,number]=[peak,peak],j=a;
      for(let i=a;i<=peak;i++) {
        while(j<b&&ms(j+1)-ms(i)<=MAX_SPAN_MS)j++;
        if(j>=peak&&between(i,j)>between(...best))best=[i,j];
      }
      [a,b]=best;
    }
    for(let i=a;i<=b;i++)taken[i]=true;
    const events=es.slice(a,b+1),until=ms(b),raw=between(a,b);
    moments.push({start:new Date(ms(a)).toISOString(),end:new Date(until).toISOString(),score:raw*2**(-(hi-until)/RECENCY_HALF_LIFE_MS),raw,
      approximate:events.some(e=>e.approximate),events,...picked(events,es.filter(e=>e.ms<ms(a))),identities:unique(events.flatMap(e=>e.identities))});
  }
  return moments.sort((x,y)=>y.score-x.score);
}

/** The best event of each category among `events`, best first, leaving out `but` and system & connection. */
function bestOf(events:readonly Scored[],but:ReadonlySet<string>):Scored[] {
  const best=new Map<string,Scored>();
  for(const e of events)if(!but.has(e.category)&&e.category!=='system'&&e.score>(best.get(e.category)?.score??0))best.set(e.category,e);
  return [...best.values()].sort((x,y)=>y.score-x.score);
}
function picked(events:readonly Scored[],before:readonly Scored[]) {
  const lead=events.reduce((x,e)=>e.score>x.score?e:x);
  return {lead,supporting:bestOf(events,new Set([lead.category])).slice(0,SUPPORTING),earlier:bestOf(before,new Set(events.map(e=>e.category)))};
}

/** A POI as the system's chart lists it: its kind, its class (a sun's spectral class, a planet's or a cloud's kind) and its system. */
export interface PoiFact {type:string;class:string|null;system:string}
/** Every POI the frames' `get_system` replies list (`structuredContent.system.pois[]`), by id. Identities, not state: a POI's kind
 * and class do not change, so the whole history serves whatever the scene's end. */
export function poisOf(lines:readonly JournalLine[]):Map<string,PoiFact> {
  const found=new Map<string,PoiFact>();
  for(const l of lines) {
    const sys=rec(rec(rec(rec(l.frame).payload).structuredContent).system),system=str(sys.id);
    if(system)for(const p of list(sys.pois).map(rec)){const id=str(p.id),type=str(p.type);if(id&&type)found.set(id,{type,class:str(p.class),system});}
  }
  return found;
}

/** How far before the earliest window the frames are read: rarity, change and first-seen are against this much play. */
export const HORIZON_MS=72*3600_000;
/** Replies `fromFrames` drops unread (`EXCLUDED_QUERIES`), but for `get_system`'s, which `poisOf` reads. */
const UNREAD=new Set([...EXCLUDED_QUERIES].filter(k=>k!=='spacemolt/get_system'));
const LEAD=/^\{"at":"([^"]+)","dir":"(in|out)","frame":\{"(?:type":"([^"]+)|tool":"([^"]+)","action":"([^"]+))"/,RID=/"request_id":"([^"]+)"\}\}$/;

/** A file's lines as bytes, oldest first, a megabyte at a time: a frame log is hundreds of megabytes, never held whole, and a
 * line left unread never becomes a string. A newline byte never falls inside a UTF-8 character, so splitting on it is safe. */
function* linesOf(path:string):Generator<Buffer> {
  const fd=openSync(path,'r');
  // One buffer, reused: the unfinished line moves to its front and the next read lands after it; it doubles for a longer line.
  let buf=Buffer.alloc(1<<20),kept=0;
  try {
    for(let n=readSync(fd,buf,kept,buf.length-kept,null);n>0;n=readSync(fd,buf,kept,buf.length-kept,null)) {
      const end=kept+n;
      let from=0;
      for(let nl=buf.indexOf(10);nl>=0&&nl<end;from=nl+1,nl=buf.indexOf(10,from))yield buf.subarray(from,nl);
      kept=end-from;
      if(from===0&&kept===buf.length) {const grown=Buffer.alloc(buf.length*2);buf.copy(grown);buf=grown;}
      else buf.copy(buf,0,from,end);
    }
    if(kept)yield buf.subarray(0,kept);
  } finally {closeSync(fd);}
}

const AT=/^\{"at":"([^"]+)"/;
/** A rotated record (`frames`, `gameplay`) from `since` (ISO) on, oldest first: files newest first, none older opened once one
 * reaches back past `since`. In the frames, the pilot's reply to a query `fromFrames` never reads (`UNREAD`: `get_status` and
 * `get_map` are most of the bytes) is matched to its request by id on the raw line and never parsed; a line that does not match
 * the shapes above is parsed, so a miss costs time, never a frame. Live 2026-10-19 (kvothe): the whole frame log was 506 MB,
 * 2.6 GB resident and 2 s for one scene, and grows ~225 MB a day; read so, 440-510 MB at the peak (220 MB of it the modules) and 0.7 s. */
export function readSince(runtime:string,since:string,name='frames'):JournalLine[] {
  const files:JournalLine[][]=[];
  for(const path of journalFiles(runtime,name)) {
    if(!existsSync(path))continue;
    const unread=new Set<string>(),kept:JournalLine[]=[];
    let past=false;
    for(const bytes of linesOf(path)) {
      // What is matched here is ASCII, so latin1 reads it exactly from the raw bytes.
      const head=bytes.toString('latin1',0,200),at=AT.exec(head)?.[1];
      if(at&&at<since){past=true;continue;}
      const lead=LEAD.exec(head),rid=lead&&RID.exec(bytes.toString('latin1',Math.max(0,bytes.length-80)))?.[1];
      // Request ids restart with every connection, so each request sets or clears its own id.
      if(lead?.[2]==='out'&&rid){if(UNREAD.has(`${lead[4]}/${lead[5]}`))unread.add(rid);else unread.delete(rid);}
      else if(lead?.[3]==='result'&&rid&&unread.has(rid))continue;
      const line=bytes.toString('utf8');
      if(line.trim())kept.push(...Option.toArray(decodeLine(line)));
    }
    files.unshift(kept);
    if(past)break;
  }
  return files.flat();
}

/** The moments in each window (a Scene's `lately.span`), best first, and every scored event in it, from `source`,
 * else from the frames when they reach back to the window's start, else from the journal.
 *
 * ponytail: the frames are read from `HORIZON_MS` before the earliest window, so rarity, change and first-seen are
 * relative to the last 72 h; a longer memory wants a running summary of the counts kept beside the log. The journal, read
 * for a window the frames do not reach, is bounded the same way. */
export function moments(runtime:string,spans:readonly {start:string;end:string}[],source?:Source):{source:Source;moments:Moment[];events:Scored[];pois:ReadonlyMap<string,PoiFact>}[] {
  const earliest=Math.min(...spans.map(s=>Date.parse(s.start)).filter(Number.isFinite));
  const since=Number.isFinite(earliest)?new Date(earliest-HORIZON_MS).toISOString():'';
  const frames=source==='journal'?[]:readSince(runtime,since),first=Date.parse(str(frames[0]?.at)??'');
  const opponents=()=>new Map(readCombat(runtime).flatMap(f=>f.opponent&&f.battle_id?[[f.battle_id,f.opponent] as const]:[]));
  const read:Partial<Record<Source,Scored[]>>={};
  const species=new Set(readSightings(runtime).flatMap(s=>s.species?[s.species]:[])); // identities, not state: every species ever seen
  const scored=(s:Source)=>read[s]??=score(s==='frames'?fromFrames(frames,species):fromJournal(readSince(runtime,since,'gameplay'),opponents(),species));
  const pois=poisOf(frames);
  return spans.map(span=>{
    const from=source??(first<=Date.parse(span.start)?'frames':'journal');
    const lo=Date.parse(span.start),hi=Date.parse(span.end);
    return {source:from,moments:momentsIn(scored(from),span.start,span.end),events:scored(from).filter(e=>e.ms>=lo&&e.ms<=hi),pois};
  });
}

/** Rare enough to be the picture whatever else the flight was: a fight the pilot was in, its death, a find naming what it had never
 * seen (the scorer's `first`). */
const rare=(e:Scored)=>e.involvement===INVOLVEMENT.self&&(e.category==='combat'||e.type==='player_died'||e.category==='discovery'&&e.first>0);
/** Acts that are a means rather than the work: they vote only when the pilot did nothing else. */
const MEANS=['travel','holdings'];
/** What a flight's picture shows. Carl, 2026-10-19: what the pilot mostly did. Live 2026-10-18 (kvothe 3db6ff6c): five hours of
 * gas harvests drew one deposit of argon at the station, the best-scoring moment. A rare event overrides (`rare`): the moment of
 * `ms` (`momentsIn`) holding the best of them. Else the category of most of the pilot's own commands (a reply to one it sent; a
 * push is no vote, the `ok` echo of a jump would count it twice), travel and upkeep only when nothing else was done, as one
 * moment of all its own events there, led by the best-scoring of them: the scorer's most notable instance (rarest, biggest
 * change, first seen). Null when the pilot did nothing. */
export function pictured(ms:readonly Moment[],events:readonly Scored[]):Moment|null {
  const own=events.filter(e=>e.involvement===INVOLVEMENT.self&&e.category!=='system'&&e.category!=='uncatalogued'&&e.category!=='social');
  const best=(es:readonly Scored[])=>es.reduce<Scored|undefined>((x,e)=>!x||e.score>x.score?e:x,undefined);
  const r=best(own.filter(rare)),held=r&&ms.find(m=>m.events.includes(r));
  if(held)return held;
  const votes=new Map<string,number>();
  for(const e of own)if(e.type.includes('/'))votes.set(e.category,(votes.get(e.category)??0)+1);
  const most=(cs:string[])=>cs.sort((a,b)=>(votes.get(b)??0)-(votes.get(a)??0))[0];
  const category=most([...votes.keys()].filter(c=>!MEANS.includes(c)))??most([...votes.keys()]);
  const work=own.filter(e=>e.category===category),lead=best(work),first=work[0],last=work.at(-1);
  if(!lead||!first||!last)return null;
  const raw=work.reduce((n,e)=>n+e.score,0);
  return {start:first.at,end:last.at,score:raw,raw,approximate:work.some(e=>e.approximate),events:work,lead,supporting:[],earlier:[],identities:unique(work.flatMap(e=>e.identities))};
}

/** The events a picture shows: the best event of the moment that is not system & connection or
 * uncatalogued (those are never depicted), then its supporting events of other depictable categories. */
export function depicted(m:Moment):{lead:Scored;supporting:Scored[]}|null {
  const shows=(e:Scored)=>e.category!=='system'&&e.category!=='uncatalogued';
  const lead=[m.lead,...[...m.events].sort((a,b)=>b.score-a.score)].find(shows);
  return lead?{lead,supporting:m.supporting.filter(e=>shows(e)&&e.category!==lead.category)}:null;
}

const ID_FACTS=['id','item_id','resource_id','base_id','docked_at','poi_id','system_id','species_id'];
/** Every id a moment's events and its earlier ones name, for the picture to put display names to. */
export const idsOf=(m:Moment)=>[...new Set([...m.events,...m.earlier].flatMap(e=>[...e.identities.map(i=>i.id),
  ...ID_FACTS.flatMap(k=>typeof e.facts[k]==='string'?[String(e.facts[k])]:[])]))];
