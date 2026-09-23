/** Hunting: wildlife anywhere (legal everywhere), pirates in low-police space. The only loops
 * that train weapons, gunnery, tactics, and — by being hit — shields and armor. */
import type {CreatureInfo,EnrichedWreck,GetBattleStatusResponse,GetNearbyResponse,PirateInfo,V2Module,V2Ship} from '@spacemolt/lib';
import {resolveWalkAway} from '../../mood-policy.ts';
import {details} from '../../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step,stopped} from '../runtime.ts';
import {goTo} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';
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
 * a branded one, which is livestock rather than wildlife. */
function decline(target:CreatureInfo|PirateInfo,named:string|undefined,mayAttack:string[]):string|null {
  if(isCreature(target)) {
    if(target.in_combat)return `${target.name} is already in someone else's battle`;
    if(target.branded)return `${target.name} is branded: someone's livestock, not wildlife`;
    if(named&&target.species!==named)return `${target.name} is ${target.species}, not ${named}`;
    return null;
  }
  if(/\[POLICE]/.test(target.name))return `${target.name} is police; attacking it is the crime, not the hunt`;
  if(!mayAttack.includes('pirate')&&!mayAttack.includes(target.faction??''))
    return `${target.name} flies for ${target.faction_name??target.faction??'no crew'}; permissions.may_attack admits ${mayAttack.join(', ')||'nothing'}`;
  return null;
}

/** One fight, from the first shot to the end of the battle, paced on the battle's own tick.
 * Ships fire by themselves every tick under their stance — there is no fire command — and the
 * server takes one mutation a tick, so this reads the status once a tick, makes one decision
 * and sends at most one command: the `fire` stance and the focus at the open, then `advance`
 * while the quarry is out of reach or running. It breaks off when our hull crosses the mood's
 * line or Tired lands mid-fight. */
async function engage(target:CreatureInfo|PirateInfo,floor:number):Promise<Fight> {
  await acct().refresh();
  const hull_before=Number(acct().state.ship?.hull??0);
  const id=idOf(target);
  await command(isCreature(target)?'spacemolt/hunt':'spacemolt/attack',{id});
  const deadline=Date.now()+FIGHT_CEILING_MS;
  let outcome:Fight['outcome']='escaped',last:GetBattleStatusResponse|undefined;
  let tick=-1,opened=0,fled=0;
  let seen:{hull:number;far:number}|undefined,first:{hull:number;far:number}|undefined;
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
    if(hull<floor||tired) {
      try {await command('spacemolt_battle/retreat',{});} catch {/* the battle ended first */}
      outcome='broke off';
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
    // One mutation a tick, in the order that decides the fight: stance, focus, then the chase.
    if(opened===0){await command('spacemolt_battle/stance',{id:'fire'});step('stance fire');opened=1;}
    else if(opened===1){await command('spacemolt_battle/target',{id});step(`focus fire on ${nameOf(target)}`);opened=2;}
    else if(far>reach||(fled>0&&far>0))await command('spacemolt_battle/advance',{});
    await sleep(pace.tickMs);
  }
  await acct().refresh();
  // ponytail: the chase is `advance`. `stance board` would cancel its retreat outright, but it
  // costs marines and suppresses our weapons; take it the day a hunt needs a boarding party.
  const why=outcome==='escaped'&&fled&&seen&&first
    ?`hull flat at ${seen.hull}% for ${fled} tick(s) while it opened the range ${first.far}→${seen.far}`
    :undefined;
  return {target,...last?{last_status:last}:{},outcome,...why?{why}:{},hull_before,
    hull_after:Number(acct().state.ship?.hull??0),loot:[]};
}

const say=(rows:Row[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');

/** One engagement where you stand (or at `poi`, flown to first): read what is here, take up
 * to `fights` fights (default 1) against creatures (default) or pirates (`target:'pirate'`,
 * only with `permissions.may_attack` admitting the crew), and loot the wreck each kill
 * leaves. Coming home, stowing and servicing are `goTo`, `stow` and `service` — this
 * function fights and loots, and nothing else.
 *
 * Nothing to hunt here is `done` with `fights: []` and `ended:'nothing here'`: the fact was
 * learned and nothing was spent. `species` narrows to a kind you have fought before.
 *
 * Refused before firing without a fitted weapon (`V2Module.type === 'weapon'`) holding
 * ammunition; an empty magazine whose rounds are in the hold is reloaded instead. Costs
 * ammunition and hull. Trains weapons, gunnery, tactics, and — by being hit — shields and
 * armor, plus xenobiology (creatures) or bounty_hunting (pirates). The mood's walk-away
 * fraction (Cautious 0.95 … Aggressive 0.80) breaks the fight off; a Tired imposed mid-fight
 * finishes the round, retreats, and returns `partial`. */
export function hunt(opts:{poi?:string;fights?:number;species?:string;target?:'creature'|'pirate'}={}):Promise<Outcome<Hunted>> {
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
    const floor=resolveWalkAway(who.mood??'Cautious')*Number(acct().state.ship?.max_hull??0);
    const mayAttack=(who.permissions?.may_attack??[]).map(String);
    const wantPirates=opts.target==='pirate';
    for(let n=0;n<asked;n++) {
      checkStop();
      const ship=acct().state.ship as V2Ship|undefined;
      if(Number(ship?.hull??0)<floor){result.ended='hull';break;}
      if(Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0)<=0){result.ended='hold full';break;}
      const nearby=details(await command('spacemolt/get_nearby',{})) as GetNearbyResponse;
      const here:(CreatureInfo|PirateInfo)[]=wantPirates?nearby.pirates??[]:nearby.creatures??[];
      const refusals:string[]=[];
      let target:CreatureInfo|PirateInfo|undefined;
      for(const one of here) {
        const why=decline(one,opts.species,mayAttack);
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
      const fight=await engage(target,floor);
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
    if(result.ended==='hull')return {status:'partial',did,why:`hull ${hull} against the ${who.mood} walk-away line ${Math.floor(floor)}`,detail:result,
      next:['goTo a base and service(); ended on the hull line twice running means the habitat is wrong, not the script']};
    if(result.ended==='hold full')return {status:'partial',did,why:'the hold is full; loot fought for has nowhere to go',detail:result,
      next:['stow(rows) or sell(rows), then hunt again']};
    return {status:'done',did,detail:result,
      next:loot.length?['stow(rows) at a base: what is in the hold is lost with the hull']:[]};
  });
}
