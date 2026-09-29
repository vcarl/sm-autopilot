/** Hunting: wildlife anywhere (legal everywhere), pirates in low-police space. The only loops
 * that train weapons, gunnery, tactics, and — by being hit — shields and armor. */
import type {CreatureInfo,EnrichedWreck,GetBattleStatusResponse,GetNearbyResponse,PirateInfo,V2Module,V2Ship} from '@spacemolt/lib';
import {resolveWalkAway} from '../../mood-policy.ts';
import {details} from '../../response-details.ts';
import {battleEnded} from '../../travel.ts';
import {active as activeMissions} from '../missions.ts';
import {acct,admit,checkStop,command,job,pilot,runtimeDir,step,stopped} from '../runtime.ts';
import {goTo,route} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';
import {readCombat,statsFor,type CombatStats} from '../../combat-memory.ts';
import {writeLook} from '../../sighting-memory.ts';
/** Re-exported so a pilot naming the type in its own helper can reach it through `play`. */
export type {CombatStats} from '../../combat-memory.ts';
import {lootWreck,wrecksHere} from './salvage.ts';

export interface Fight {
  target:CreatureInfo|PirateInfo;
  /** The last `battle/status` read before the battle ended. */
  last_status?:GetBattleStatusResponse;
  outcome:'down'|'escaped'|'broke off'|'unresolved';
  /** What the loop saw, when the outcome needs it: the quarry running is the case that has one. */
  why?:string;
  hull_before:number;hull_after:number;
  /** The wreck it left and what was looted from it. */
  wreck?:EnrichedWreck;loot:Row[];
}

/** One place the search looked at, in the order it was tried. `saw` counts the prey asked for
 * (every creature, when no species was named, or when `strict` is false — a named species is a
 * preference there, not a filter) and `legal` how many of those were engageable under the rules
 * actually applied (species-restricted only under `strict`); `flew` says whether reaching it
 * cost a trip. A stop with `saw: 0` is the useful half of a search — it is the fact that stops
 * the same rock being paid for twice. */
export interface Looked {poi_id:string;saw:number;legal:number;flew:boolean}

export interface Hunted {
  /** Where the hunt ended up: the POI it fought at, or the last one it looked at. */
  poi_id:string;
  fights:Fight[];
  /** Every place looked at, in order. One entry for a hunt that stood still. */
  looked:Looked[];
  /** Why the loop ended: `asked` fights done, nothing at the one place looked, nothing at any
   * of several, a tank that cannot cover the next hop, hull line, hold full, tired. */
  ended:'asked'|'nothing here'|'nothing found'|'fuel'|'hull'|'hold full'|'stopped'|'tired';
}

/** The stances a decision may ask for. `board` is deliberately absent: it needs marines and
 * suppresses our own weapons, so it is a boarding party's call, not a tactical one, and a
 * callback that asks for it should not compile. Percentages are in `README.md`. */
export type CombatStance='fire'|'evade'|'brace'|'flee';

/** What the callback sees on one battle tick: a snapshot read from that tick's own
 * `battle/status`, never a handle on the fight. Every field is measured this tick except
 * `stats`, which is what memory remembers of earlier fights with this opponent. */
export interface TickView {
  /** The battle's own round counter as the server reports it (`GetBattleStatusResponse
   * .tick_duration`, "Ticks the battle has been running") — not the ten-second game tick.
   *
   * **Do not use it to tell rounds apart.** Live it stalls for minutes and has been observed going
   * backwards: 0,1,2,1,1,1,1,1,2 across nine successive polls of one continuous fight, while the
   * quarry's hull fell 100→20. This callback is invoked once per poll, and the poll is the round;
   * the number is passed through for reporting, not for control flow. If you need to count rounds,
   * count your own invocations. */
  tick:number;
  /** Our hull now, and the hull this ship has when whole. */
  hull:number;max_hull:number;
  /** Our shield, percent of max. 0 when the status did not publish one. */
  shield_pct:number;
  /** The quarry's display name, and its hull as a fraction of max (0..1). */
  opponent:string;opponent_hull:number;
  /** The range band between the two ships: `inner`, `mid` or `outer` on the live server.
   * Range is what accuracy is measured against, which is why `closeIn`/`backOff` matter. */
  range:string;
  /** Distance to the quarry and the reach of our longest weapon, in the game's own units. */
  distance:number;reach:number;
  /** Hull lost since the previous tick — and, on the first tick, since the fight opened. */
  damage_taken:number;
  /** The stance the loop last set, or undefined before it has set one. */
  stance?:CombatStance;
  /** The mood's walk-away hull. No decision can cross it: see `README.md`. */
  floor:number;
  /** What memory knows about fighting this opponent, or undefined the first time it is met.
   * `thin` is true while the sample is under three fights, and then every number is an
   * anecdote rather than a measurement. */
  stats?:CombatStats;
}

/** What the callback asks for. Everything is optional and returning `undefined` means "no
 * change" — which is how a pilot deciding every third tick is written without the library
 * baking in a cadence. The server takes one mutation a tick, so at most one field is acted on,
 * in the order below, and the journal says what was asked against what happened. */
export interface TickDecision {
  /** The stance to hold from this tick on. */
  stance?:CombatStance;
  /** A range maneuver, not an exit. `closeIn` is `battle/advance` and shortens the range;
   * `backOff` is `battle/retreat`, which the server answers "Retreating from the enemy." and
   * which opens the range while the battle carries on. Leaving is `disengage`, below. */
  move?:'closeIn'|'backOff';
  /** Focus fire on this participant id. */
  focus?:string;
  /** Break off: `stance flee` until the battle ends, bracing if the flee cannot get away. The
   * only exit there is — `backOff` above opens the range and leaves the ship in the fight. */
  disengage?:true;
}

/** ponytail: one tick and one ceiling, not a config system. A battle tick is ten seconds of
 * real time, the server takes one mutation per tick and throttles reads, so the loop reads
 * once and acts once a tick; five minutes is a fight that is not going to end. `pace` is a
 * knob only because the tests cannot sit through real ticks. */
export const pace={tickMs:10_000};
const FIGHT_CEILING_MS=5*60_000;

const isCreature=(target:CreatureInfo|PirateInfo):target is CreatureInfo=>'creature_id' in target;
const idOf=(target:CreatureInfo|PirateInfo)=>isCreature(target)?target.creature_id:target.pirate_id;
const nameOf=(target:CreatureInfo|PirateInfo)=>target.name;
// Ref'd: the awaited sleep IS the work in flight. Unref'd, the process may exit under it with the
// promise pending (Node 22.18's test runner did exactly that).
const sleep=(ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms);});

/** The loadout floor, in the one form the state can answer: a fitted module whose `type` is
 * `weapon`, holding rounds for its `ammo_type`. An empty magazine with its ammunition in the
 * hold is reloaded rather than refused — that is the whole of "reload when ammo allows". */
async function loadout():Promise<string|null> {
  const weapons=((acct().state.modules??[]) as V2Module[]).filter(module=>module.type==='weapon');
  if(!weapons.length)return 'no module of type weapon is fitted; the hangar is the stop before the hunt';
  const loaded=()=>weapons.filter(weapon=>weapon.ammo_type===undefined||Number(weapon.current_ammo??0)>0);
  if(loaded().length)return null;
  const held=new Set((acct().state.cargo??[]).map(row=>row.item_id));
  for(const weapon of weapons) {
    if(!weapon.ammo_type||!held.has(weapon.ammo_type))continue;
    step(`reload ${weapon.name} from the hold (${weapon.ammo_type})`);
    try {await command('spacemolt_battle/reload',{id:weapon.module_id});} catch {/* the check below decides */}
  }
  await acct().refresh();
  if(((acct().state.modules??[]) as V2Module[]).some(module=>module.type==='weapon'&&Number(module.current_ammo??0)>0))return null;
  return `${weapons.map(weapon=>`${weapon.name} has ${Number(weapon.current_ammo??0)} rounds of ${weapon.ammo_type}`).join('; ')}, and none is in the hold; the market is the stop before the hunt`;
}

/** Why this one is not the fight to take, or null when it is. Fauna is legal everywhere, so
 * the only creature rules are the world's own: a beast already in someone else's battle, and
 * a branded one, which is livestock rather than wildlife. Pirates are the pilot's call; only
 * police are declined outright. */
function decline(target:CreatureInfo|PirateInfo,named:string[]):string|null {
  if(isCreature(target)) {
    if(target.in_combat)return `${target.name} is already in someone else's battle`;
    if(target.branded)return `${target.name} is branded: someone's livestock, not wildlife`;
    if(named.length&&!named.includes(target.species))return `${target.name} is ${target.species}, not ${named.join(' or ')}`;
    return null;
  }
  if(/\[POLICE]/.test(target.name))return `${target.name} is police; attacking it is the crime, not the hunt`;
  return null;
}

/** The active missions' own words, flattened for a substring test. Mission data never carries
 * a species id — a hunt objective is prose ("Hunt 5 Belt-Grazer wildlife") — so this is what
 * `quarryOf` has to work with; there is no id to read off it.
 * ponytail: substring match on prose, not a real species id; a mission naming its quarry only
 * by a word that is not the species (a nickname, a typo) is missed. Upgrade the day a mission
 * objective carries `target_species`. */
async function huntText():Promise<string> {
  const mine=await activeMissions();
  return mine.active.map(m=>[m.title,m.description,...(m.objectives??[]).map(o=>o.description)].join(' ')).join(' ')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ');
}

/** Whether an active mission's own words name this species (its id, space for underscore). */
const namesSpecies=(text:string,species:string)=>text.includes(species.replace(/_/g,' '));

/** Break off, and see it through. `spacemolt_battle/retreat` is a RANGE maneuver, not an exit:
 * it sits beside `advance` in `BattleResponse.action`, the live server answers "Retreating from
 * the enemy." and the battle carries on. Re-issuing it waits for an end it cannot bring — on
 * 2026-09-25 that was one "breaking off" and fourteen "the battle has not ended yet" in ninety
 * seconds, and on 2026-09-24 the same shape lost the ship from hull 61 to 29.
 *
 * The exit is `stance flee`: 0% dealt, 100% taken, and it auto-retreats to escape. Two facts
 * bound it. Flee takes four times `brace`'s damage, and the escape can fail outright — an
 * equal or faster opponent kites the flee movement — so an unbounded flee against a faster
 * enemy is the worst cell in the stance table. And battles end on their own, every observed
 * one at 5–22 ticks. So the flee gets `FLEE_TICKS` ticks to work, and when it has not, the
 * fight is waited out under `brace` (0% dealt, 25% taken, shields regen 2×) instead, which is
 * a quarter of the damage for the same wait. A stance holds until it is changed, so each is
 * sent once rather than re-issued.
 *
 * The stop flag is deliberately not checked: a pilot asking to stop does not mean abandoning
 * the ship in a fight.
 *
 * True when the battle ended. False when the bound ran out with the battle still on, which is
 * the one state a pilot must be told about, because nothing will move the ship until it ends. */
export const FLEE_TICKS=3;
export async function disengage(bound=FIGHT_CEILING_MS):Promise<boolean> {
  const deadline=Date.now()+bound;
  let held:CombatStance|undefined,ticks=0;
  for(;;) {
    const want:CombatStance=ticks<FLEE_TICKS?'flee':'brace';
    if(want!==held) {
      try {
        await command('spacemolt_battle/stance',{id:want});
        held=want;
        step(want==='flee'
          ?'breaking off: stance flee, which auto-retreats to escape'
          :`flee has not got away in ${FLEE_TICKS} ticks: stance brace (25% taken, shields regen 2×) until the battle ends`);
      } catch {/* the battle may have ended already; the status read below decides */}
    }
    // The battle answering `not_in_battle` IS its end; that refusal is the evidence.
    try {
      const status=details(await command('spacemolt_battle/status',{})) as GetBattleStatusResponse;
      if(!status?.battle_id){battleEnded();return true;}
    } catch {battleEnded();return true;}
    if(Date.now()>=deadline)return false;
    ticks++;
    step(`${held??'breaking off'}: the battle has not ended yet`);
    await sleep(pace.tickMs);
  }
}

const STANCES=new Set<string>(['fire','evade','brace','flee']);
const MOVES:Record<string,string>={closeIn:'spacemolt_battle/advance',backOff:'spacemolt_battle/retreat'};

/** One fight, from the first shot to the end of the battle, paced on the battle's own tick.
 * Ships fire by themselves every tick under their stance — there is no fire command — and the
 * server takes one mutation a tick, so this reads the status once a tick, makes one decision
 * and sends at most one command: the pilot's `onTick` decision when it made one, otherwise the
 * `fire` stance and the focus at the open, then `advance` while the quarry is out of reach or
 * running. It breaks off when our hull crosses the mood's line or Tired lands mid-fight, and
 * that line outranks any decision the callback returns. */
async function engage(target:CreatureInfo|PirateInfo,floor:()=>number,
  onTick?:(view:TickView)=>TickDecision|undefined,stats?:CombatStats):Promise<Fight> {
  await acct().refresh();
  const hull_before=Number(acct().state.ship?.hull??0);
  const id=idOf(target);
  await command(isCreature(target)?'spacemolt/hunt':'spacemolt/attack',{id});
  const deadline=Date.now()+FIGHT_CEILING_MS;
  let outcome:Fight['outcome']='escaped',last:GetBattleStatusResponse|undefined;
  let tick=-1,fled=0;
  let seen:{hull:number;far:number}|undefined,first:{hull:number;far:number}|undefined;
  let stuck=false;
  // What the open still owes, tracked separately from the decision so a callback taking the
  // tick does not silently cost the fight its stance or its focus.
  let stanceNow:CombatStance|undefined,focused=false,braced=false,lastHull=hull_before;
  /** The callback, never trusted with the ship: a throw is logged and the default continues.
   * Stranding a ship mid-fight is exactly how the three ships went. */
  const ask=(view:TickView):TickDecision|undefined=>{
    if(!onTick)return undefined;
    try {return onTick(view)??undefined;}
    catch(error) {
      step(`onTick threw (${error instanceof Error?error.message:String(error)}); the default loop continues`);
      return undefined;
    }
  };
  /** Apply one field of a decision — the server takes one mutation a tick — in the order that
   * decides the fight, and say what was asked against what was sent. Null means the decision
   * had nothing this loop could act on, so the default ladder takes the tick instead.
   *
   * **A component already in force is not a mutation.** Asking for the stance the ship is already
   * holding spends the tick's one mutation on nothing and drops whatever came after it. Live
   * 2026-09-25, twice in one fight: `onTick asked {"stance":"fire","move":"closeIn"}; sent stance
   * fire` — while the ship sat at `outer`, zone_distance 6 against a max_weapon_reach of 3, firing
   * from outside its own reach and dealing zero. Closing the range was the whole point of the
   * decision and it was discarded in favour of re-sending a stance that was already set.
   *
   * What is in force is read from the server's own row (`BattleParticipant.stance` and
   * `target_id`, both self-only), never from what this loop believes it sent: the belief can be
   * wrong, and the server's answer is the thing the next tick will act on. `skipped` collects what
   * was passed over so the journal can say why the decision was reshaped. */
  const apply=async(asked:TickDecision,inForce:{stance?:string;target?:string},
    skipped:string[]):Promise<string|null>=>{
    if(asked.disengage)return 'disengage';
    if(asked.stance!==undefined) {
      if(!STANCES.has(asked.stance))return null;
      if(inForce.stance===asked.stance)skipped.push(`stance ${asked.stance} already in force`);
      else {
        await command('spacemolt_battle/stance',{id:asked.stance});
        stanceNow=asked.stance;
        return `stance ${asked.stance}`;
      }
    }
    if(asked.move!==undefined) {
      const action=MOVES[asked.move];
      // A move has no state to compare against — there is no "already advancing" — so it is
      // always a real mutation when the loop reaches it.
      if(action) {
        await command(action,{});
        return asked.move;
      }
      skipped.push(`move ${asked.move} is not one this loop can send`);
    }
    if(asked.focus!==undefined) {
      if(inForce.target===asked.focus)skipped.push(`focus ${asked.focus} already in force`);
      else {
        await command('spacemolt_battle/target',{id:asked.focus});
        if(asked.focus===id)focused=true;
        return `focus ${asked.focus}`;
      }
    }
    return null;
  };
  for(;;) {
    let status:GetBattleStatusResponse;
    // The battle answering `not_in_battle` IS its end; that refusal is the evidence.
    try {status=details(await command('spacemolt_battle/status',{})) as GetBattleStatusResponse;}
    catch {break;}
    if(!status?.battle_id)break;
    last=status;
    const rows=status.participants??[];
    // The quarry's own row, by id. Ours answers our shield, never the range to it.
    const theirs=rows.find(row=>row.player_id===id);
    if(!theirs)break;
    // Observe every poll, regardless of the tick: on the live server `tick_duration` is not
    // monotonic (it sat at 1 for two minutes straight), and a hull crossing the line while it
    // sits still still has to be seen. The tick below only limits ACTIONS to one a tick.
    await acct().refresh();
    const ship=acct().state.ship as V2Ship|undefined;
    const hull=Number(ship?.hull??0);
    const mine=rows.find(row=>row.kind==='player');
    const reach=Number(status.combat_state?.max_weapon_reach??0);
    const theirHull=Number(theirs.hull_pct??0),far=Number(theirs.zone_distance??0);
    const now=Number(status.tick_duration??tick+1);
    // `zone_distance` against `max_weapon_reach` is the API's own comparison for "can I fire at
    // all". Live, the opening ticks sat at 6 against a reach of 3 and dealt nothing, and the prose
    // said only "outer 6/3" — the fact that explained the zero was there and never spelled out.
    const outOfReach=reach>0&&far>reach;
    step(`tick ${now} vs ${nameOf(target)}: hull ${hull}/${ship?.max_hull??'?'}, shield ${mine?.shield_pct??0}%, theirs ${theirHull}% at ${theirs.zone??'?'} ${far}/${reach}${outOfReach?' — OUT OF REACH, closing costs nothing to try and firing from here deals nothing':''}`);
    if(ship?.incapacitated){outcome='unresolved';break;}
    const tired=pilot().mood==='Tired';
    // The decision is taken before the floor is checked so a reckless one can be named in the
    // override line; it is ACTED on after, and only if the floor let the fight carry on.
    // Every poll is a round. `tick_duration` is the API's own round counter — "Ticks the battle has
    // been running" — but it is not usable as one: live it stalls for minutes and was observed going
    // BACKWARDS (0,1,2,1,1,1,1,1,2 over nine polls of one continuous fight, while the quarry's hull
    // fell 100→20 and our shield fell monotonically). Gating the decision on it changing meant the
    // callback fired about once for every several rounds that actually resolved.
    //
    // So the poll is the round, and the poll is paced on `pace.tickMs`, which is the documented tick
    // length. The counter is still reported to the callback for what it is worth, and its own doc
    // comment says what it is worth.
    const decision=ask({tick:now,hull,max_hull:Number(ship?.max_hull??0),
      shield_pct:Number(mine?.shield_pct??0),opponent:nameOf(target),opponent_hull:theirHull/100,
      range:String(theirs.zone??''),distance:far,reach,damage_taken:Math.max(0,lastHull-hull),
      ...stanceNow?{stance:stanceNow}:{},floor:floor(),...stats?{stats}:{}});
    lastHull=hull;
    if(hull<floor()||tired) {
      // The mood's margin is the operator's bound, like `credit_reserve`, not the pilot's
      // tactical whim: a decision that would keep fighting under it is refused and said so.
      if(decision&&!decision.disengage)
        step(`override: onTick asked ${JSON.stringify(decision)}, and the ${pilot().mood??'Cautious'} walk-away line ${Math.floor(floor())} wins`);
      step(`breaking off: hull ${hull} under the line ${Math.floor(floor())}${tired?', and Tired':''}`);
      // Out of the battle is `broke off`; still in one when the bound ran out is unresolved,
      // and the caller must say so — no move will work until it ends.
      outcome=await disengage()?'broke off':'unresolved';
      if(outcome==='unresolved')stuck=true;
      break;
    }
    if(Date.now()>=deadline){outcome='unresolved';break;}
    tick=now;
    // A hull that is not falling while the range opens is the quarry running, not a miss.
    if(seen)fled=theirHull>=seen.hull&&far>seen.far?fled+1:0;else first={hull:theirHull,far};
    seen={hull:theirHull,far};
    // One mutation a tick. The pilot's own decision takes it when it made one; whatever the
    // open still owes is sent on a later tick rather than skipped.
    const skipped:string[]=[];
    const sent=decision
      ?await apply(decision,{...mine?.stance?{stance:mine.stance}:{},...mine?.target_id?{target:mine.target_id}:{}},skipped)
      :null;
    if(decision)step(`onTick asked ${JSON.stringify(decision)}; sent ${sent??'nothing it could act on'}${skipped.length?` (skipped: ${skipped.join('; ')})`:''}`);
    if(sent==='disengage') {
      outcome=await disengage()?'broke off':'unresolved';
      if(outcome==='unresolved')stuck=true;
      break;
    }
    if(sent===null) {
      // The default ladder, unchanged but for the brace: stance, focus, then the chase.
      if(!stanceNow){await command('spacemolt_battle/stance',{id:'fire'});stanceNow='fire';step('stance fire');}
      else if(!focused){await command('spacemolt_battle/target',{id});focused=true;step(`focus fire on ${nameOf(target)}`);}
      // Shields flat, their hull above ours and the walk-away line one bad tick away: one tick
      // of `brace` (0% dealt, 25% taken, shields regen 2×) buys the hull to keep firing to the
      // line instead of reaching it now. Once a fight, so it can never become the fight.
      else if(!braced&&Number(mine?.shield_pct??0)===0&&theirHull>100*hull/Number(ship?.max_hull??1)
        &&hull<floor()+0.05*Number(ship?.max_hull??0)) {
        await command('spacemolt_battle/stance',{id:'brace'});stanceNow='brace';braced=true;
        step(`stance brace: shields flat, theirs ${theirHull}% against ours, and the line ${Math.floor(floor())} is close`);
      }
      else if(stanceNow!=='fire'&&braced){await command('spacemolt_battle/stance',{id:'fire'});stanceNow='fire';step('stance fire again');}
      else if(far>reach||(fled>0&&far>0))await command('spacemolt_battle/advance',{});
    }
    await sleep(pace.tickMs);
  }
  await acct().refresh();
  // ponytail: the chase is `advance`, and the exit is `stance flee` (see `disengage`). `stance
  // board` would cancel a quarry's retreat outright, but it costs marines and suppresses our
  // weapons; take it the day a hunt needs a boarding party.
  const why=stuck
    ?'broke off at the hull line, but the battle had not ended when the retreat bound ran out: the ship is still in it and cannot travel or jump'
    :outcome==='escaped'&&fled&&seen&&first
      ?`hull flat at ${seen.hull}% for ${fled} tick(s) while it opened the range ${first.far}→${seen.far}`
      :undefined;
  return {target,...last?{last_status:last}:{},outcome,...why?{why}:{},hull_before,
    hull_after:Number(acct().state.ship?.hull??0),loot:[]};
}

const say=(rows:Row[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** Hunt a prey across a range of places to look. `look` is POI ids in the order to try them: at
 * each one the habitat is read, and the fight happens where the prey actually is. `poi` is the
 * one-place shorthand, and naming neither hunts where you stand. Up to `fights` fights (default
 * 1) in total across the whole search, against creatures (default) or pirates
 * (`target:'pirate'`), looting the wreck each kill leaves. Coming home, stowing and servicing
 * are `goTo`, `stow` and `service` — this function searches, fights and loots, nothing else.
 *
 * **Fauna is not knowable before arrival.** POI rows carry no fauna field and there is no
 * per-species query, so nothing can tell you which belt holds your prey before you are standing
 * in it. That is why this takes a list rather than a destination: being sent to one belt on a
 * guess is how a pilot spends a shift finding nothing. Every look is written to this runtime's
 * sighting memory, the empty ones included, so the next search starts from what was seen rather
 * than from the same guess — and a remembered look reports its own age, because stale fauna is
 * a lie (`sighting-memory.ts`).
 *
 * **The looking is bounded by fuel.** Before each hop the route is re-quoted and checked
 * against the tank, and the search ENDS rather than skipping on: a pilot that
 * cannot afford the next POI cannot afford the one after it either, and `ended:'fuel'` names the
 * place that stopped it. `goTo` enforces the same check itself — this check is what lets the
 * search stop cleanly and say where, instead of accumulating refusals.
 *
 * Nothing to hunt is `done`, never `refused`: the fact was learned and nothing was spent
 * fighting. One place looked at is `ended:'nothing here'`, several is `ended:'nothing found'`,
 * and `detail.looked` names each one and what was in it.
 *
 * `species` takes one id or a list — any of them counts as named. By default (`strict` unset or
 * false) a named species is a PREFERENCE: at each place, and again on every fight's fresh read,
 * a legal creature of a named species is fought if one is present, and the first legal creature
 * of any species otherwise — the same fallback an unnamed hunt already gives an active mission's
 * quarry. `strict:true` is today's stricter rule: only named species are fought, and everything
 * else here is declined with the same refusal text. Use `strict` only when a second species
 * would not do — a mission that counts kills of one species and nothing else. Left unset, a
 * species an active mission's own words name is preferred over the first legal one. Which
 * species was actually fought is on `fight.target.species`, so a fallback fight is never hidden.
 *
 * Refused before firing without a fitted weapon (`V2Module.type === 'weapon'`) holding
 * ammunition; an empty magazine whose rounds are in the hold is reloaded instead. Costs
 * ammunition and hull. Trains weapons, gunnery, tactics, and — by being hit — shields and
 * armor, plus xenobiology (creatures) or bounty_hunting (pirates). The mood's walk-away
 * fraction (Cautious 0.95 … Aggressive 0.80) breaks the fight off; a Tired imposed mid-fight
 * finishes the round, retreats, and returns `partial`.
 *
 * `onTick` is the pilot's own hand on the stance. It is called once a battle tick with a
 * `TickView` and returns a `TickDecision` or `undefined` for "no change" — synchronously,
 * because a tick is ten seconds and one model call is minutes, so the tactics have to be
 * authored in advance and run inside the fight. It issues no commands itself: `hunt` applies
 * one field a tick, validates it, and journals what was asked against what was sent. A callback
 * that throws is logged and the default loop carries on. The mood's walk-away line outranks it
 * always — a decision that would keep fighting under the line is refused and said so. */
export function hunt(opts:{poi?:string;look?:string[];fights?:number;species?:string|string[];
  strict?:boolean;target?:'creature'|'pirate';
  onTick?:(view:TickView)=>TickDecision|undefined}={}):Promise<Outcome<Hunted>> {
  const asked=Math.max(1,Math.trunc(opts.fights??1));
  // Any of these counts as named. A single id is the common case; the list is for a hunt that
  // will take more than one kind and should say so, not repeat itself.
  const species=opts.species===undefined?[]:Array.isArray(opts.species)?opts.species:[opts.species];
  const strict=opts.strict??false;
  // Where to look, in order. `poi` is the single-place case of `look`; naming neither looks
  // exactly once, where the ship already stands.
  const trail=opts.look?.length?opts.look:opts.poi?[opts.poi]:[];
  return job<Hunted>('hunt',[trail.join('/'),species.join('+'),opts.target,asked>1?`×${asked}`:''].filter(Boolean).join(' '),async()=>{
    const who=pilot();
    const result:Hunted={poi_id:trail[0]??acct().state.location?.poi_id??'',fights:[],looked:[],ended:'asked'};
    const refuse=(why:string)=>({status:'refused' as const,did:'hunted nothing',why,detail:result});
    const blocked=await admit('hunt');
    if(blocked)return refuse(blocked);
    const gap=await loadout();
    if(gap)return refuse(gap);
    /** Why the search stopped travelling, when the tank is what stopped it. */
    let shortFuel='';
    // The hull line the mood draws, read at each check rather than once at the top: the pilot
    // record moves under a running loop (the runtime imposes Tired, the observer rewrites the
    // file), and a fight carrying on under a line the pilot has left is the one thing this
    // loop exists to prevent.
    const floor=()=>resolveWalkAway(pilot().mood??'Cautious')*Number(acct().state.ship?.max_hull??0);
    const wantPirates=opts.target==='pirate';
    // No species named: an active mission's own words are the next best thing to ask.
    const quarry=!species.length&&!wantPirates?await huntText():'';
    // Under `strict`, a named species is the only legal prey — the same list `decline` enforces
    // below. Left loose, nothing here is illegal for being the wrong species: a name is a
    // preference, applied before the fallback loop, never a filter `legal` has to account for.
    const restrict=strict?species:[];
    // The places to try. An empty trail is one look, where the ship is: `hunt()` unchanged.
    const stops=trail.length?trail:[acct().state.location?.poi_id??''];
    search: for(const where of stops) {
      checkStop();
      let flew=false;
      if(where&&acct().state.location?.poi_id!==where) {
        // Re-quoted per hop, against the fuel as it stands now. The tank must cover the route and
        // nothing more: a hop that takes fuel under the mood's reserve imposes Tired, and the
        // search ends there, before a look can start a fight a Tired pilot may not.
        const fuel=Number(acct().state.ship?.fuel??0);
        let quoted=NaN;
        try {quoted=Number((await route(where)).estimated_fuel);} catch {/* unplaceable below */}
        if(!Number.isFinite(quoted)) {
          // A POI the server cannot place is skipped, not fatal: the rest of the list may be
          // real, and a typo in one id should not end a search that had four good ones.
          step(`${where}: no route there, skipped`);
          continue;
        }
        if(fuel<quoted) {
          shortFuel=`fuel ${fuel}, and reaching ${where} needs ${quoted}`;
          result.ended='fuel';
          break;
        }
        const out=await goTo(where);
        if(out.status!=='done') {
          shortFuel=out.why??`did not reach ${where}`;
          result.ended='fuel';
          break;
        }
        flew=true;
        if(pilot().mood==='Tired'){result.ended='tired';break;}
      }
      result.poi_id=acct().state.location?.poi_id??where;
      // The look. One read answers what is at this POI and nothing about any other, which is
      // the whole reason the search has to be flown rather than planned.
      const nearby=details(await command('spacemolt/get_nearby',{})) as GetNearbyResponse;
      const here:(CreatureInfo|PirateInfo)[]=wantPirates?nearby.pirates??[]:nearby.creatures??[];
      // Written whole, every species present, because `recall` reads a species missing from a
      // look as an absence and a filtered look would make that a lie (`sighting-memory.ts`).
      // Pirates are not wildlife and are not remembered: they move under their own orders, so
      // a sighting of one says nothing about tomorrow.
      const remember=runtimeDir();
      if(!wantPirates&&remember) {
        const tally=new Map<string,{species:string;count:number;legal:number}>();
        for(const one of nearby.creatures??[]) {
          const row=tally.get(one.species)??{species:one.species,count:0,legal:0};
          row.count+=1;
          if(decline(one,[])===null)row.legal+=1;
          tally.set(one.species,row);
        }
        writeLook(remember,{poi_id:result.poi_id,seen:[...tally.values()]});
      }
      // Not restricted (no species, or named but only a preference): every creature here is the
      // prey asked for. Restricted (named and strict): only those species are.
      const wanted=here.filter(one=>!restrict.length||(isCreature(one)&&restrict.includes(one.species)));
      result.looked.push({poi_id:result.poi_id,saw:wanted.length,
        legal:wanted.filter(one=>decline(one,restrict)===null).length,flew});
      for(;result.fights.length<asked;) {
      checkStop();
      const ship=acct().state.ship as V2Ship|undefined;
      if(Number(ship?.hull??0)<floor()){result.ended='hull';break search;}
      if(Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0)<=0){result.ended='hold full';break search;}
      // Re-read each fight: the last kill took one out of the habitat, so the second fight is
      // against what is left rather than against the list the arrival answered with.
      const round=details(await command('spacemolt/get_nearby',{})) as GetNearbyResponse;
      const standing:(CreatureInfo|PirateInfo)[]=wantPirates?round.pirates??[]:round.creatures??[];
      const refusals:string[]=[];
      let target:CreatureInfo|PirateInfo|undefined;
      // A named species, when legal to take, wins over the first thing here — the preference
      // applies on every fresh read, not only the look that opened the stop. Under `strict` the
      // fallback loop below enforces the same list anyway, so this pass only matters when it is
      // loose. A mission's quarry is the same idea for a hunt naming no species of its own.
      if(species.length)target=standing.find(one=>isCreature(one)&&species.includes(one.species)&&decline(one,[])===null);
      if(!target&&quarry)target=standing.find(one=>isCreature(one)&&namesSpecies(quarry,one.species)&&decline(one,[])===null);
      if(!target)for(const one of standing) {
        const why=decline(one,restrict);
        if(why===null){target=one;break;}
        refusals.push(why);
      }
      if(!target) {
        // A habitat with nothing in it is a fact learned, not a refusal. With one place looked
        // at that is `nothing here`; with a list it is the search moving on to the next place,
        // and only the end of the list is `nothing found`.
        if(refusals.length)step(`declined: ${[...new Set(refusals)].join('; ')}`);
        continue search;
      }
      // What memory remembers of this opponent, read once per fight and handed to the callback:
      // the same numbers the juncture showed when the pilot chose to come here.
      const remembered=statsFor(readCombat(runtimeDir()),nameOf(target));
      const fight=await engage(target,floor,opts.onTick,remembered);
      result.fights.push(fight);
      // A wreck with this one's name on it is the only evidence the fight was won.
      const wreck=(await wrecksHere()).find(row=>row.victim_id===idOf(target!));
      if(wreck) {
        fight.wreck=wreck;
        const took=await lootWreck(wreck);
        fight.loot=took.items;
        if(fight.outcome==='escaped'){fight.outcome='down';delete fight.why;}
      }
      step(`fight ${result.fights.length}: ${nameOf(target)} ${fight.outcome}${fight.why?` (${fight.why})`:''}, hull ${fight.hull_before}→${fight.hull_after}, ${say(fight.loot)||'no loot'}`);
      if(stopped()){result.ended='stopped';break search;}
      if(pilot().mood==='Tired'){result.ended='tired';break search;}
      if(fight.outcome==='broke off'||fight.outcome==='unresolved'){result.ended='hull';break search;}
      }
      // The fight budget is spent across the whole search, not per place: once it is gone there
      // is nothing left to look for.
      if(result.fights.length>=asked)break;
    }
    const loot=result.fights.flatMap(fight=>fight.loot);
    const hull=Number(acct().state.ship?.hull??0);
    /** Every place looked at and what was in it, which is what the search is worth when it
     * found nothing: the pilot can read it and not be sent back to the same rock. */
    const trailSaid=result.looked.map(row=>`${row.poi_id} (${row.saw?`${row.saw} seen, ${row.legal} legal`:'none'})`).join(', ');
    const seen=new Set([result.poi_id,...result.looked.map(row=>row.poi_id)]);
    let others:string[]=[];
    try {others=((details(await command('spacemolt/get_system',{})).system?.pois??[]) as {id:string}[]).map(row=>row.id).filter(id=>!seen.has(id)).slice(0,3);} catch {/* the placeholder wording stands */}
    const ids=others.length?others.map(id=>`'${id}'`).join(','):`'<poi id>','<and another>'`;
    const prey=species.length?species.join(' or '):(wantPirates?'pirates':'anything huntable');
    // Nothing anywhere, having fought nothing: a fact learned, and `done`, because the looking
    // is the job when the prey's whereabouts are not knowable in advance. One place looked at
    // keeps the older, shorter sentence; a real search says where it went.
    if(!result.fights.length&&(result.ended==='asked'||result.ended==='nothing here')) {
      result.ended=result.looked.length>1?'nothing found':'nothing here';
      return {status:'done',
        did:result.ended==='nothing here'
          ?`nothing to hunt at ${result.poi_id}`
          :`looked at ${trailSaid} and found no ${prey}`,
        detail:result,
        next:result.ended==='nothing here'
          // NOT `scout()`: with no argument it reports the system the ship is already in — the one
          // just looked at — and it counts creatures only where the ship stands, so it can say
          // nothing about a neighbour's fauna and spends the next juncture saying it.
          ?[`hunt({look:[${ids}]}) — scout() already listed this system's POIs, and fauna is not confined to belts`]
          // `{species, look}` was shorthand for two undefined identifiers and did not compile. And
          // only a creature look is written to sighting memory — a pirate sweep writes none — so
          // "remembered" is a claim that only holds for wildlife.
          : [wantPirates
            ?`hunt({target:'pirate',look:[${ids}]}) on a different list`
            :`every one of those is remembered as empty; hunt({look:[${ids}]}) on a different list, or scout('<neighbour system id>') first`]};
    }
    if(result.ended==='fuel')
      return {status:result.fights.length?'partial':'refused',
        did:result.fights.length?`${result.fights.length} fight(s), then the search stopped`:'hunted nothing',
        why:`${shortFuel}; looked at ${trailSaid}`,detail:result,
        next:['goTo a base and service(), then hunt a nearer list']};
    const did=`${result.fights.length} fight(s) at ${result.poi_id}: ${say(loot)||'no loot'}, hull ${hull}/${acct().state.ship?.max_hull??'?'}`;
    if(result.ended==='tired')return {status:'partial',did,why:result.fights.length?'Tired: broke off after the round in flight':'Tired on arrival, so no fight was started',detail:result,
      next:['goTo a base and service(); that clears Tired']};
    if(result.ended==='stopped')return {status:'partial',did,why:'stopped by the pilot',detail:result};
    // A fight that could not be broken off is the fact that outranks the hull number: nothing
    // the pilot does next will move the ship until that battle ends.
    if(result.ended==='hull')return {status:'partial',did,
      why:result.fights.at(-1)?.outcome==='unresolved'&&result.fights.at(-1)?.why
        ?result.fights.at(-1)!.why!
        :`hull ${hull} against the ${pilot().mood} walk-away line ${Math.floor(floor())}`,detail:result,
      next:['goTo a base and service(); ended on the hull line twice running means the habitat is wrong, not the script']};
    if(result.ended==='hold full')return {status:'partial',did,why:'the hold is full; loot fought for has nowhere to go',detail:result,
      next:['stow(rows) or sell(rows), then hunt again']};
    return {status:'done',did,detail:result,
      next:loot.length?['stow(rows) at a base: what is in the hold is lost with the hull']:[]};
  });
}
