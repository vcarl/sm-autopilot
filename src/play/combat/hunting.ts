/** Hunting: wildlife anywhere (legal everywhere), pirates in low-police space. The only loops
 * that train weapons, gunnery, tactics, and — by being hit — shields and armor. */
import type {CreatureInfo,EnrichedWreck,GetBattleStatusResponse,GetNearbyResponse,PirateInfo,V2Module,V2Ship} from '@spacemolt/lib';
import {resolveWalkAway} from '../../mood-policy.ts';
import {details} from '../../response-details.ts';
import {battleEnded} from '../../travel.ts';
import {active as activeMissions} from '../missions.ts';
import {acct,admit,checkStop,command,job,pilot,runtimeDir,step,stopped} from '../runtime.ts';
import {goTo} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';
import {readCombat,statsFor,type CombatStats} from '../../combat-memory.ts';
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

export interface Hunted {
  poi_id:string;
  fights:Fight[];
  /** Why the loop ended: `asked` fights done, nothing there, hull line, hold full, tired. */
  ended:'asked'|'nothing here'|'hull'|'hold full'|'stopped'|'tired';
}

/** The stances a decision may ask for. `board` is deliberately absent: it needs marines and
 * suppresses our own weapons, so it is a boarding party's call, not a tactical one, and a
 * callback that asks for it should not compile. Percentages are in `README.md`. */
export type CombatStance='fire'|'evade'|'brace'|'flee';

/** What the callback sees on one battle tick: a snapshot read from that tick's own
 * `battle/status`, never a handle on the fight. Every field is measured this tick except
 * `stats`, which is what memory remembers of earlier fights with this opponent. */
export interface TickView {
  /** The battle's own tick, 1 up — not the global engine tick. On the live server it can sit
   * still for minutes, and a repeated number means nothing new happened. */
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
const sleep=(ms:number)=>new Promise<void>(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();});

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
function decline(target:CreatureInfo|PirateInfo,named:string|undefined):string|null {
  if(isCreature(target)) {
    if(target.in_combat)return `${target.name} is already in someone else's battle`;
    if(target.branded)return `${target.name} is branded: someone's livestock, not wildlife`;
    if(named&&target.species!==named)return `${target.name} is ${target.species}, not ${named}`;
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
   * had nothing this loop could act on, so the default ladder takes the tick instead. */
  const apply=async(asked:TickDecision):Promise<string|null>=>{
    if(asked.disengage)return 'disengage';
    if(asked.stance!==undefined) {
      if(!STANCES.has(asked.stance))return null;
      await command('spacemolt_battle/stance',{id:asked.stance});
      stanceNow=asked.stance;
      return `stance ${asked.stance}`;
    }
    if(asked.move!==undefined) {
      const action=MOVES[asked.move];
      if(!action)return null;
      await command(action,{});
      return asked.move;
    }
    if(asked.focus!==undefined) {
      await command('spacemolt_battle/target',{id:asked.focus});
      if(asked.focus===id)focused=true;
      return `focus ${asked.focus}`;
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
    step(`tick ${now} vs ${nameOf(target)}: hull ${hull}/${ship?.max_hull??'?'}, shield ${mine?.shield_pct??0}%, theirs ${theirHull}% at ${theirs.zone??'?'} ${far}/${reach}`);
    if(ship?.incapacitated){outcome='unresolved';break;}
    const tired=pilot().mood==='Tired';
    // The decision is taken before the floor is checked so a reckless one can be named in the
    // override line; it is ACTED on after, and only if the floor let the fight carry on.
    const fresh=now!==tick;
    const decision=fresh?ask({tick:now,hull,max_hull:Number(ship?.max_hull??0),
      shield_pct:Number(mine?.shield_pct??0),opponent:nameOf(target),opponent_hull:theirHull/100,
      range:String(theirs.zone??''),distance:far,reach,damage_taken:Math.max(0,lastHull-hull),
      ...stanceNow?{stance:stanceNow}:{},floor:floor(),...stats?{stats}:{}}):undefined;
    if(fresh)lastHull=hull;
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
    // The same tick number is the same tick and nothing new to act on. Without one, every
    // read stands as its own tick. Checked after the observation above, never before it.
    if(now===tick){await sleep(pace.tickMs);continue;}
    tick=now;
    // A hull that is not falling while the range opens is the quarry running, not a miss.
    if(seen)fled=theirHull>=seen.hull&&far>seen.far?fled+1:0;else first={hull:theirHull,far};
    seen={hull:theirHull,far};
    // One mutation a tick. The pilot's own decision takes it when it made one; whatever the
    // open still owes is sent on a later tick rather than skipped.
    const sent=decision?await apply(decision):null;
    if(decision)step(`onTick asked ${JSON.stringify(decision)}; sent ${sent??'nothing it could act on'}`);
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

/** One engagement where you stand (or at `poi`, flown to first): read what is here, take up
 * to `fights` fights (default 1) against creatures (default) or pirates (`target:'pirate'`),
 * and loot the wreck each kill leaves. Coming home, stowing and servicing are `goTo`, `stow`
 * and `service` — this function fights and loots, and nothing else.
 *
 * Nothing to hunt here is `done` with `fights: []` and `ended:'nothing here'`: the fact was
 * learned and nothing was spent. `species` narrows to a kind you have fought before; left
 * unset, a species an active mission's own words name is preferred over the first legal one.
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
export function hunt(opts:{poi?:string;fights?:number;species?:string;target?:'creature'|'pirate';
  onTick?:(view:TickView)=>TickDecision|undefined}={}):Promise<Outcome<Hunted>> {
  const asked=Math.max(1,Math.trunc(opts.fights??1));
  return job<Hunted>('hunt',[opts.poi,opts.species,opts.target,asked>1?`×${asked}`:''].filter(Boolean).join(' '),async()=>{
    const who=pilot();
    const result:Hunted={poi_id:opts.poi??acct().state.location?.poi_id??'',fights:[],ended:'asked'};
    const refuse=(why:string)=>({status:'refused' as const,did:'hunted nothing',why,detail:result});
    const blocked=admit('hunt');
    if(blocked)return refuse(blocked);
    if(opts.poi&&acct().state.location?.poi_id!==opts.poi) {
      const out=await goTo(opts.poi);
      if(out.status!=='done')return {status:out.status,did:`did not reach ${opts.poi}`,why:out.why??'',detail:result};
    }
    result.poi_id=acct().state.location?.poi_id??result.poi_id;
    const gap=await loadout();
    if(gap)return refuse(gap);
    // The hull line the mood draws, read at each check rather than once at the top: the pilot
    // record moves under a running loop (the runtime imposes Tired, the observer rewrites the
    // file), and a fight carrying on under a line the pilot has left is the one thing this
    // loop exists to prevent.
    const floor=()=>resolveWalkAway(pilot().mood??'Cautious')*Number(acct().state.ship?.max_hull??0);
    const wantPirates=opts.target==='pirate';
    // No species named: an active mission's own words are the next best thing to ask.
    const quarry=!opts.species&&!wantPirates?await huntText():'';
    for(let n=0;n<asked;n++) {
      checkStop();
      const ship=acct().state.ship as V2Ship|undefined;
      if(Number(ship?.hull??0)<floor()){result.ended='hull';break;}
      if(Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0)<=0){result.ended='hold full';break;}
      const nearby=details(await command('spacemolt/get_nearby',{})) as GetNearbyResponse;
      const here:(CreatureInfo|PirateInfo)[]=wantPirates?nearby.pirates??[]:nearby.creatures??[];
      const refusals:string[]=[];
      let target:CreatureInfo|PirateInfo|undefined;
      // A mission's quarry, when one is named and legal to take, wins over the first thing here.
      if(quarry)target=here.find(one=>isCreature(one)&&namesSpecies(quarry,one.species)&&decline(one,undefined)===null);
      if(!target)for(const one of here) {
        const why=decline(one,opts.species);
        if(why===null){target=one;break;}
        refusals.push(why);
      }
      if(!target) {
        // A habitat with nothing in it is a fact learned, not a refusal: the first fight
        // finding nothing is `nothing here`, a later one is simply the loop running out.
        if(!result.fights.length)result.ended='nothing here';
        if(refusals.length)step(`declined: ${[...new Set(refusals)].join('; ')}`);
        break;
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
      if(stopped()){result.ended='stopped';break;}
      if(pilot().mood==='Tired'){result.ended='tired';break;}
      if(fight.outcome==='broke off'||fight.outcome==='unresolved'){result.ended='hull';break;}
    }
    const loot=result.fights.flatMap(fight=>fight.loot);
    const hull=Number(acct().state.ship?.hull??0);
    if(result.ended==='nothing here')
      return {status:'done',did:`nothing to hunt at ${result.poi_id}`,detail:result,
        next:['scout() a neighbouring belt or field; creatures are where the resources are']};
    const did=`${result.fights.length} fight(s) at ${result.poi_id}: ${say(loot)||'no loot'}, hull ${hull}/${acct().state.ship?.max_hull??'?'}`;
    if(result.ended==='tired')return {status:'partial',did,why:'Tired: broke off after the round in flight',detail:result,
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
