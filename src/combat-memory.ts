/** What a fight cost and what it bought, folded from the battle pushes as they arrive.
 *
 * The lib pushes `battle_update` every tick and `battle_damage` per shot; the runner listed
 * neither, so combat was played blind — three ships were lost on 2026-09-24 and nothing
 * recorded would have let anyone choose better. These frames are NOT journalled: a battle
 * pushes several a tick and `gameplay.jsonl` is already 36 MB, so they are folded here on
 * arrival into roughly a dozen numbers per fight and dropped.
 *
 * Like `markets.json`, this is memory the game does not publish: the server has no "how did I
 * do against this species last time" endpoint, so the only way to have the number is to have
 * kept it. Same discipline as `remember()` in `play/market.ts` — temp file then rename,
 * bounded by count, every entry tagged with its age.
 */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Option,Schema} from 'effect';

const MEMORY='combat.json';
/** ponytail: the last 60 fights, whole. A night's hunting is twenty; sixty is three nights and
 * about 25 KB. Age out by tick instead the day a pilot fights more than that in a session. */
export const CAP=60;
/** Fights below which every number here is an anecdote and the shape says so. */
export const THIN=3;
/** A battle tick is ten seconds of real time (`play/combat/hunting.ts`'s `pace`).
 * ponytail: ages are wall-clock elapsed converted at this rate, not a server tick delta —
 * `account.currentTick` is only reachable inside the bridge, and neither the menu nor a
 * running job has it. `FightRecord.tick` stores the real tick for the day one of them does. */
export const TICK_MS=10_000;

/** Shots seen at one range band, one direction. `hits` is `battle_damage.hit_success`, which is
 * the only place accuracy is published at all. */
const Shots=Schema.Struct({shots:Schema.Number,hits:Schema.Number});
export type Shots=typeof Shots.Type;
/** `Shots` as the live fold counts it, in place. */
type Tally={-readonly [K in keyof Shots]:Shots[K]};

/** The live server publishes FIVE values in `battle_update.your_zone`, not the three this file
 * was written for: `outer`, `mid`, `inner`, `engaged`, and nothing at all. Measured on the kvothe
 * profile's `combat.json`: inner 168 shots, engaged 11, unknown 10, outer 12, mid 8.
 *
 * `engaged` folds into `inner` — it is the closest band, and keeping them apart starves both
 * samples of the shots that would make either one a rate. `unknown` does NOT fold: a tick whose
 * zone was never pushed is a shot we cannot place, and attributing it to the last known zone
 * would invent a band to make a sample look thicker, which is a lie about a measurement. It stays
 * visible as itself so the pilot can see how much of the record is unplaced. */
export const bandOf=(zone:string|undefined):string=>zone==='engaged'?'inner':zone||'unknown';

/** One fight as memory keeps it: aggregates, never a transcript. */
const FightRecord=Schema.Struct({
  /** The opponent as the frames name it — `battle_update.participants[].username`, which for
   * wildlife is its display name and is what `get_nearby` calls it too. The frames carry no
   * species id, so this is the key. */
  opponent:Schema.String,
  /** The opponent's hull class when the frames named one. */
  opponent_class:Schema.optionalKey(Schema.String),
  /** OUR hull class in this fight. Win chance is species versus class, not species alone, so
   * both are recorded and neither is baked into the key. */
  ship_class:Schema.optionalKey(Schema.String),
  /** Battle ticks the fight lasted (`battle_ended.duration`). */
  ticks:Schema.Number,
  /** Shots per range band, both directions: `at_us` is their accuracy against us, `at_them`
   * ours against them. A tick whose band was never pushed lands under `unknown`. */
  by_range:Schema.Record(Schema.String,Schema.Struct({at_us:Shots,at_them:Shots})),
  /** The server's own fight totals (`battle_ended.participants[]`), hull and shield together. */
  dealt:Schema.Number,taken:Schema.Number,
  /** The stances that were actually in force, in order, collapsed to the changes. */
  stances:Schema.Array(Schema.String),
  /** Ticks observed in the `flee` stance. The retreat COMMAND is not in the push frames — the
   * command seam journals every `spacemolt_battle/retreat` — so this is the stance, not the ask. */
  flee_ticks:Schema.Number,
  /** `victory` when our side won, `defeat` when we did not survive, and the server's own
   * `stalemate`/`mutual_destruction`/`interrupted` otherwise. */
  ending:Schema.String,
  /** Our hull as a percentage of max, first tick to last: the fight's cost. */
  hull_pct_from:Schema.optionalKey(Schema.Number),hull_pct_to:Schema.optionalKey(Schema.Number),
  /** Global engine tick at close, and the wall clock the age is read from. */
  tick:Schema.optionalKey(Schema.Number),at:Schema.String,
});
export type FightRecord=typeof FightRecord.Type;

const Store=Schema.fromJsonString(Schema.Struct({fights:Schema.Array(Schema.Unknown)}));
const decodeStore=Schema.decodeUnknownOption(Store),decodeFight=Schema.decodeUnknownOption(FightRecord);

/** Whatever is on disk, newest fight first, or nothing: a torn or absent file is no memory. */
export function readCombat(dir:string|undefined):FightRecord[] {
  if(!dir)return [];
  try {
    const stored=decodeStore(readFileSync(join(dir,MEMORY),'utf8'));
    // A bad row is dropped and the good ones kept; a file that is not a store at all reads as nothing.
    return Option.isSome(stored)?stored.value.fights.flatMap(row=>{const one=decodeFight(row);return Option.isSome(one)?[one.value]:[];}):[];
  } catch {return [];} // edge: a torn or absent file is no memory
}

/** Temp file then rename, as `remember()` and `writeAlerts` do: a torn write would price the
 * next fight on a lie. Newest first, oldest evicted past `CAP`. */
export function writeFight(dir:string,fight:FightRecord):void {
  if(!dir||!fight.opponent)return;
  try {
    mkdirSync(dir,{recursive:true});
    const kept=[fight,...readCombat(dir)].slice(0,CAP);
    const path=join(dir,MEMORY),temp=`${path}.${process.pid}.tmp`;
    writeFileSync(temp,`${JSON.stringify({fights:kept})}\n`,{mode:0o600});
    renameSync(temp,path);
  } catch {} // edge: a fight this pilot cannot remember is still a fight it fought
}

/** The three metrics the record exists to answer, for one opponent. Every number carries the
 * sample it rests on, because an estimate from one fight is an anecdote and must read as one. */
export interface CombatStats {
  opponent:string;
  /** Fights folded in, and the age of the newest and oldest, in ticks. */
  fights:number;won:number;
  newest_ticks_old:number;oldest_ticks_old:number;
  /** Our hull classes across those fights. Two classes is two different questions answered as one. */
  ship_classes:string[];
  /** Average damage per battle tick, ours out and theirs in. **Shield and hull together** —
   * `battle_damage` publishes `shield_hit` and `hull_hit` and this is their sum, which on the live
   * server is overwhelmingly shield. Read as hull it is wildly alarming: a 25-tick fight taking 39
   * damage moved the hull 2 percentage points. Never compare it against the walk-away line. */
  dealt_per_tick:number;taken_per_tick:number;
  /** Hull percentage points lost in an average fight with this opponent — the number the
   * walk-away decision actually turns on, since the mood's line is a fraction of max hull.
   * `undefined` when no fight recorded a hull reading at both ends. */
  hull_pct_lost?:number;
  /** Measured accuracy by range band, 0..1, each with the shots it rests on. A band with no
   * shots is absent rather than 0 — nothing was measured there. */
  accuracy:Record<string,{at_us?:number|undefined;at_us_shots:number;at_them?:number|undefined;at_them_shots:number}>;
  /** Wins over fights, present only once there are `THIN` fights to divide. Below that the
   * caller has `won` and `fights` and no rate is offered, because none would be one. */
  win_chance?:number;
  /** True while the sample is under `THIN`: every number above is an anecdote. */
  thin:boolean;
}

/** Age in ticks, computed at read and never stored. An entry written before ages were tagged,
 * or with an unparseable stamp, reads as 0 — "as fresh as this call" is the reading that makes
 * a pilot distrust nothing it should trust; the fight count is what bounds the confidence. */
export const fightTicksOld=(at:string,now:number):number=>{
  const stamped=Date.parse(at);
  return Number.isNaN(stamped)?0:Math.max(0,Math.round((now-stamped)/TICK_MS));
};

const ratio=(part:number,whole:number)=>whole>0?Math.round(100*part/whole)/100:undefined;

/** What memory knows about fighting this opponent, or undefined when it has never met one. */
export function statsFor(fights:FightRecord[],opponent:string,now=Date.now()):CombatStats|undefined {
  const mine=fights.filter(row=>row.opponent===opponent);
  if(!mine.length)return undefined;
  const ticks=mine.reduce((sum,row)=>sum+Math.max(0,row.ticks),0);
  const ages=mine.map(row=>fightTicksOld(row.at,now));
  const accuracy:CombatStats['accuracy']={};
  // Folded at READ, not at write, so the fights already on disk — ten of them on the live profile,
  // written before anyone knew there were five bands — are read the same way as the next one.
  for(const row of mine)for(const [zone,tally] of Object.entries(row.by_range??{})) {
    const band=bandOf(zone);
    const kept=accuracy[band]??={at_us_shots:0,at_them_shots:0};
    kept.at_us_shots+=tally.at_us.shots;kept.at_them_shots+=tally.at_them.shots;
    kept.at_us=(kept.at_us??0)+tally.at_us.hits;kept.at_them=(kept.at_them??0)+tally.at_them.hits;
  }
  // The running sums above are hit COUNTS; turn each into the rate it stands for, or drop it
  // when nothing was fired in that band — an unmeasured band must not read as 0% accuracy.
  for(const band of Object.values(accuracy)) {
    band.at_us=ratio(band.at_us??0,band.at_us_shots);
    band.at_them=ratio(band.at_them??0,band.at_them_shots);
  }
  const won=mine.filter(row=>row.ending==='victory').length;
  // Hull cost per fight, from the fights that read the hull at both ends. Kept apart from the
  // damage totals because it is a different quantity in a different unit, and it is the one the
  // pilot's walk-away line is expressed in.
  const hulls=mine.flatMap(row=>row.hull_pct_from!==undefined&&row.hull_pct_to!==undefined?[Math.max(0,row.hull_pct_from-row.hull_pct_to)]:[]);
  return {opponent,fights:mine.length,won,
    ...hulls.length?{hull_pct_lost:Math.round(10*hulls.reduce((sum,one)=>sum+one,0)/hulls.length)/10}:{},
    newest_ticks_old:Math.min(...ages),oldest_ticks_old:Math.max(...ages),
    ship_classes:[...new Set(mine.map(row=>row.ship_class).filter((one):one is string=>Boolean(one)))],
    dealt_per_tick:ticks?Math.round(10*mine.reduce((sum,row)=>sum+row.dealt,0)/ticks)/10:0,
    taken_per_tick:ticks?Math.round(10*mine.reduce((sum,row)=>sum+row.taken,0)/ticks)/10:0,
    accuracy,...mine.length>=THIN?{win_chance:won/mine.length}:{},thin:mine.length<THIN};
}

/** One terse line for a juncture, where the choice to engage is actually made. It is prompt
 * budget, so: the record, what a fight costs the hull, the damage race, their accuracy by band,
 * and the age. A thin sample says "1 fight" rather than "0%", because that is what it is.
 *
 * Every number here names its unit. The damage figures say `shield+hull` because that is what
 * they sum, and the hull figure is given separately in percentage points — a pilot that read the
 * damage total as hull would break off many times too early, and the walk-away line it is
 * deciding against is measured in hull. */
export function combatLine(stats:CombatStats):string {
  const bands=Object.entries(stats.accuracy)
    .flatMap(([band,row])=>row.at_us===undefined?[]:[`${Math.round(100*row.at_us)}% ${band}`]).join('/');
  return [`${stats.won}/${stats.fights} won${stats.thin?` (${stats.fights} fight${stats.fights>1?'s':''}, not a rate)`:''}`,
    ...stats.hull_pct_lost!==undefined?[`costs ${stats.hull_pct_lost}% hull a fight`]:[],
    `${stats.taken_per_tick} shield+hull dmg/tick in`,
    ...stats.dealt_per_tick?[`${stats.dealt_per_tick} out`]:[],
    ...bands?[`they hit ${bands}`]:[],
    `${stats.newest_ticks_old}t old`].join(', ');
}

/** The fold in flight. ponytail: one fight at a time, because `battle_damage` carries no
 * `battle_id` — nothing in the frame says which battle a shot belongs to, so a pilot in two
 * battles at once would have them merged. Hunting is serial, which is what makes that safe. */
interface Live {
  battle_id:string;our_side?:number|undefined;opponent?:string;opponent_class?:string;ship_class?:string;
  /** The band the ship is in right now, from the latest `battle_update.your_zone` — the only place
   * the band is published at all. `unknown` until one arrives. */
  zone:string;
  /** Shots per band, accumulated as they arrive rather than bucketed by tick and resolved at close.
   *
   * The tick number cannot carry this. `battle_update.tick` is not a usable round counter — live it
   * stalls for minutes and has been observed going backwards — so several real rounds share one
   * number, and bucketing by it collapsed their shots onto whichever band that number last
   * reported. A fight that closed from outer to inner recorded every shot at inner and lost outer
   * entirely, which is the accuracy-by-range measurement averaging two ranges into one and
   * presenting it as measured.
   *
   * ponytail: attribution is by the band in force when the frame ARRIVED, which is an
   * approximation — `battle_damage` carries no band of its own, and a frame that arrives out of
   * order lands in the band that was current rather than the one it was fired in. It is the honest
   * approximation rather than a silent merge, and the `unknown` band stays visible so how much of
   * the record is unplaced can be read off it. Upgrade the day a damage frame names its own zone,
   * or the day `get_battle_log` is read per fight (it carries a real per-tick `entries[].tick`). */
  by_range:Record<string,{at_us:Tally;at_them:Tally}>;
  stances:string[];flee_ticks:number;
  hull_from?:number;hull_to?:number;
  dealt:number;taken:number;last_tick:number;
}
let live:Live|null=null;

/** The tally for the band in force, made on first use. */
const bucket=(fold:Live)=>fold.by_range[fold.zone]??=({at_us:{shots:0,hits:0},at_them:{shots:0,hits:0}});

const isRow=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null;
const participantsOf=(payload:Record<string,unknown>)=>Array.isArray(payload.participants)?payload.participants.filter(isRow):[];

/** `battle_update`: the tick, the band, the stance in force, and who is on the other side. */
export function foldBattleUpdate(payload:Record<string,unknown>):void {
  const battle_id=String(payload.battle_id??'');
  if(!battle_id)return;
  if(live?.battle_id!==battle_id)
    live={battle_id,zone:'unknown',by_range:{},stances:[],flee_ticks:0,dealt:0,taken:0,last_tick:0};
  const fold=live;
  const tick=Number(payload.tick??0);
  fold.last_tick=Math.max(fold.last_tick,tick);
  fold.our_side=typeof payload.your_side_id==='number'?payload.your_side_id:fold.our_side;
  if(typeof payload.your_zone==='string')fold.zone=bandOf(payload.your_zone);
  const stance=typeof payload.your_stance==='string'?payload.your_stance:'';
  if(stance) {
    if(fold.stances.at(-1)!==stance)fold.stances.push(stance);
    if(stance==='flee')fold.flee_ticks+=1;
  }
  const rows=participantsOf(payload);
  const us=rows.find(row=>row.side_id===fold.our_side);
  const them=rows.find(row=>row.side_id!==fold.our_side);
  if(typeof us?.ship_class==='string')fold.ship_class=us.ship_class;
  if(typeof us?.hull_pct==='number'){fold.hull_from??=us.hull_pct;fold.hull_to=us.hull_pct;}
  if(typeof them?.username==='string')fold.opponent=them.username;
  if(typeof them?.ship_class==='string')fold.opponent_class=them.ship_class;
}

/** `battle_damage`: one shot. `hit_success` is the accuracy measurement, and the shot is credited to
 * the band in force when this frame arrived — the frame carries no band of its own and the tick
 * number cannot stand in for one (see `Live.by_range`). */
export function foldBattleDamage(payload:Record<string,unknown>,me:string|undefined):void {
  if(!live)return;
  const hit=payload.hit_success===true;
  const damage=Number(payload.total_damage??0)||Number(payload.hull_hit??0)+Number(payload.shield_hit??0);
  const row=bucket(live);
  // Attribution needs to know which hull is ours; without it a shot is still a shot, so it is
  // counted in neither direction rather than guessed into one.
  if(me&&payload.target_id===me){row.at_us.shots+=1;if(hit){row.at_us.hits+=1;live.taken+=damage;}}
  else if(me&&payload.attacker_id===me){row.at_them.shots+=1;if(hit){row.at_them.hits+=1;live.dealt+=damage;}}
}

/** `battle_ended`: close the fold and write it. The server's own participant totals win over
 * the summed shot frames — a dropped frame would understate them, and these cannot be. */
export function foldBattleEnded(dir:string,payload:Record<string,unknown>,me:string|undefined,
  tick?:number,now=()=>new Date()):FightRecord|undefined {
  const fold=live;
  live=null;
  if(!fold||!fold.opponent)return undefined;
  const rows=participantsOf(payload);
  const ours=rows.find(row=>row.player_id===me)??rows.find(row=>row.side_id===fold.our_side);
  const dealt=Number(ours?.damage_dealt??fold.dealt),taken=Number(ours?.damage_taken??fold.taken);
  const reason=String(payload.reason??'unresolved');
  const ending=ours?.survived===false?'defeat'
    :typeof payload.winning_side==='number'&&payload.winning_side===fold.our_side?'victory':reason;
  const fight:FightRecord={opponent:fold.opponent,
    ...fold.opponent_class?{opponent_class:fold.opponent_class}:{},
    ...fold.ship_class?{ship_class:fold.ship_class}:{},
    ticks:Number(payload.duration??fold.last_tick)||fold.last_tick,
    by_range:fold.by_range,dealt,taken,stances:fold.stances,flee_ticks:fold.flee_ticks,ending,
    ...fold.hull_from!==undefined?{hull_pct_from:fold.hull_from}:{},
    ...fold.hull_to!==undefined?{hull_pct_to:fold.hull_to}:{},
    ...tick?{tick}:{},at:now().toISOString()};
  writeFight(dir,fight);
  return fight;
}

/** Drop the fold in flight. Used by the tests; a real battle ends with `battle_ended`. */
export const resetCombatFold=():void=>{live=null;};
