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
export interface Shots {shots:number;hits:number}

/** One fight as memory keeps it: aggregates, never a transcript. */
export interface FightRecord {
  /** The opponent as the frames name it — `battle_update.participants[].username`, which for
   * wildlife is its display name and is what `get_nearby` calls it too. The frames carry no
   * species id, so this is the key. */
  opponent:string;
  /** The opponent's hull class when the frames named one. */
  opponent_class?:string;
  /** OUR hull class in this fight. Win chance is species versus class, not species alone, so
   * both are recorded and neither is baked into the key. */
  ship_class?:string;
  /** Battle ticks the fight lasted (`battle_ended.duration`). */
  ticks:number;
  /** Shots per range band, both directions: `at_us` is their accuracy against us, `at_them`
   * ours against them. A tick whose band was never pushed lands under `unknown`. */
  by_range:Record<string,{at_us:Shots;at_them:Shots}>;
  /** The server's own fight totals (`battle_ended.participants[]`), hull and shield together. */
  dealt:number;taken:number;
  /** The stances that were actually in force, in order, collapsed to the changes. */
  stances:string[];
  /** Ticks observed in the `flee` stance. The retreat COMMAND is not in the push frames — the
   * command seam journals every `spacemolt_battle/retreat` — so this is the stance, not the ask. */
  flee_ticks:number;
  /** `victory` when our side won, `defeat` when we did not survive, and the server's own
   * `stalemate`/`mutual_destruction`/`interrupted` otherwise. */
  ending:string;
  /** Our hull as a percentage of max, first tick to last: the fight's cost. */
  hull_pct_from?:number;hull_pct_to?:number;
  /** Global engine tick at close, and the wall clock the age is read from. */
  tick?:number;at:string;
}

interface Store {fights:FightRecord[]}

/** Whatever is on disk, newest fight first, or nothing: a torn or absent file is no memory. */
export function readCombat(dir:string|undefined):FightRecord[] {
  if(!dir)return [];
  try {
    const stored=JSON.parse(readFileSync(join(dir,MEMORY),'utf8')) as Store;
    return (Array.isArray(stored?.fights)?stored.fights:[])
      .filter((row):row is FightRecord=>Boolean(row&&typeof row.opponent==='string'));
  } catch {return [];}
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
  } catch {/* a fight this pilot cannot remember is still a fight it fought */}
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
  /** Average damage per battle tick, ours out and theirs in. */
  dealt_per_tick:number;taken_per_tick:number;
  /** Measured accuracy by range band, 0..1, each with the shots it rests on. A band with no
   * shots is absent rather than 0 — nothing was measured there. */
  accuracy:Record<string,{at_us?:number;at_us_shots:number;at_them?:number;at_them_shots:number}>;
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
  for(const row of mine)for(const [band,tally] of Object.entries(row.by_range??{})) {
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
  return {opponent,fights:mine.length,won,
    newest_ticks_old:Math.min(...ages),oldest_ticks_old:Math.max(...ages),
    ship_classes:[...new Set(mine.map(row=>row.ship_class).filter((one):one is string=>Boolean(one)))],
    dealt_per_tick:ticks?Math.round(10*mine.reduce((sum,row)=>sum+row.dealt,0)/ticks)/10:0,
    taken_per_tick:ticks?Math.round(10*mine.reduce((sum,row)=>sum+row.taken,0)/ticks)/10:0,
    accuracy,...mine.length>=THIN?{win_chance:won/mine.length}:{},thin:mine.length<THIN};
}

/** One terse line for a juncture, where the choice to engage is actually made. It is prompt
 * budget, so: the record, the damage race, their accuracy by band, and the age. A thin sample
 * says "1 fight" rather than "0%", because that is what it is. */
export function combatLine(stats:CombatStats):string {
  const bands=Object.entries(stats.accuracy)
    .filter(([,band])=>band.at_us!==undefined)
    .map(([band,row])=>`${Math.round(100*row.at_us!)}% ${band}`).join('/');
  return [`${stats.won}/${stats.fights} won${stats.thin?` (${stats.fights} fight${stats.fights>1?'s':''}, not a rate)`:''}`,
    `${stats.taken_per_tick} dmg/tick in`,
    ...stats.dealt_per_tick?[`${stats.dealt_per_tick} out`]:[],
    ...bands?[`they hit ${bands}`]:[],
    `${stats.newest_ticks_old}t old`].join(', ');
}

/** The fold in flight. ponytail: one fight at a time, because `battle_damage` carries no
 * `battle_id` — nothing in the frame says which battle a shot belongs to, so a pilot in two
 * battles at once would have them merged. Hunting is serial, which is what makes that safe. */
interface Live {
  battle_id:string;our_side?:number;opponent?:string;opponent_class?:string;ship_class?:string;
  /** Our range band at each tick, from `battle_update.your_zone`: the only place the band is
   * published. Bounded by the fight's tick count. */
  zones:Map<number,string>;
  /** Shots per tick, resolved to a band at close. Bounded by ticks, not by shots. */
  ticks:Map<number,{at_us:Shots;at_them:Shots}>;
  stances:string[];flee_ticks:number;
  hull_from?:number;hull_to?:number;
  dealt:number;taken:number;last_tick:number;
}
let live:Live|null=null;

const bucket=(fold:Live,tick:number)=>{
  let row=fold.ticks.get(tick);
  if(!row){row={at_us:{shots:0,hits:0},at_them:{shots:0,hits:0}};fold.ticks.set(tick,row);}
  return row;
};

/** `battle_update`: the tick, the band, the stance in force, and who is on the other side. */
export function foldBattleUpdate(payload:Record<string,unknown>):void {
  const battle_id=String(payload.battle_id??'');
  if(!battle_id)return;
  if(live?.battle_id!==battle_id)
    live={battle_id,zones:new Map(),ticks:new Map(),stances:[],flee_ticks:0,dealt:0,taken:0,last_tick:0};
  const fold=live;
  const tick=Number(payload.tick??0);
  fold.last_tick=Math.max(fold.last_tick,tick);
  fold.our_side=typeof payload.your_side_id==='number'?payload.your_side_id:fold.our_side;
  if(typeof payload.your_zone==='string')fold.zones.set(tick,payload.your_zone);
  const stance=typeof payload.your_stance==='string'?payload.your_stance:'';
  if(stance) {
    if(fold.stances.at(-1)!==stance)fold.stances.push(stance);
    if(stance==='flee')fold.flee_ticks+=1;
  }
  const rows=Array.isArray(payload.participants)?payload.participants as Record<string,unknown>[]:[];
  const us=rows.find(row=>row.side_id===fold.our_side);
  const them=rows.find(row=>row.side_id!==fold.our_side);
  if(typeof us?.ship_class==='string')fold.ship_class=us.ship_class;
  if(typeof us?.hull_pct==='number'){fold.hull_from??=us.hull_pct;fold.hull_to=us.hull_pct;}
  if(typeof them?.username==='string')fold.opponent=them.username;
  if(typeof them?.ship_class==='string')fold.opponent_class=them.ship_class;
}

/** `battle_damage`: one shot. `hit_success` is the accuracy measurement; the band it was fired
 * at is bound by tick at close, so the frames may arrive in any order. */
export function foldBattleDamage(payload:Record<string,unknown>,me:string|undefined):void {
  if(!live)return;
  const tick=Number(payload.tick??live.last_tick);
  const hit=payload.hit_success===true;
  const damage=Number(payload.total_damage??0)||Number(payload.hull_hit??0)+Number(payload.shield_hit??0);
  const row=bucket(live,tick);
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
  const rows=Array.isArray(payload.participants)?payload.participants as Record<string,unknown>[]:[];
  const ours=rows.find(row=>row.player_id===me)??rows.find(row=>row.side_id===fold.our_side);
  const dealt=Number(ours?.damage_dealt??fold.dealt),taken=Number(ours?.damage_taken??fold.taken);
  const reason=String(payload.reason??'unresolved');
  const ending=ours?.survived===false?'defeat'
    :typeof payload.winning_side==='number'&&payload.winning_side===fold.our_side?'victory':reason;
  const by_range:FightRecord['by_range']={};
  for(const [at,row] of fold.ticks) {
    const band=fold.zones.get(at)??'unknown';
    const kept=by_range[band]??={at_us:{shots:0,hits:0},at_them:{shots:0,hits:0}};
    kept.at_us.shots+=row.at_us.shots;kept.at_us.hits+=row.at_us.hits;
    kept.at_them.shots+=row.at_them.shots;kept.at_them.hits+=row.at_them.hits;
  }
  const fight:FightRecord={opponent:fold.opponent,
    ...fold.opponent_class?{opponent_class:fold.opponent_class}:{},
    ...fold.ship_class?{ship_class:fold.ship_class}:{},
    ticks:Number(payload.duration??fold.last_tick)||fold.last_tick,
    by_range,dealt,taken,stances:fold.stances,flee_ticks:fold.flee_ticks,ending,
    ...fold.hull_from!==undefined?{hull_pct_from:fold.hull_from}:{},
    ...fold.hull_to!==undefined?{hull_pct_to:fold.hull_to}:{},
    ...tick?{tick}:{},at:now().toISOString()};
  writeFight(dir,fight);
  return fight;
}

/** Drop the fold in flight. Used by the tests; a real battle ends with `battle_ended`. */
export const resetCombatFold=():void=>{live=null;};
