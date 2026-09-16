/** One hunt, dock to dock: out to the habitat, take the fights the rules admit, loot what
 * fits, home, stow the take, service.
 *
 * The shape is gather's — out, work, home, dock, stow, service — and every step is named for
 * an end state and sends nothing when that state already holds, so a re-run after a restart
 * re-enters at the rung the world implies rather than opening a second battle.
 *
 * What the game gives this job, from a recorded hunt (`runtime/gameplay.jsonl` 2375-2620):
 * `spacemolt/get_nearby` lists creatures by id, species, role and hull; `spacemolt/hunt`
 * opens the battle; `spacemolt_battle/status` reports it and answers `not_in_battle` once it
 * is over; `spacemolt_battle/advance` closes the distance and `retreat` breaks off;
 * `spacemolt_salvage/wrecks` shows what the kill left and `spacemolt_salvage/loot` moves it.
 * Nothing here tows, sells or buys.
 */
import {miningInventory} from '../mining-inventory.ts';
import type {MineYieldRow} from '../mine.ts';
import {resolveWalkAway} from '../mood-policy.ts';
import {movedOutcome,position,reconcileMove,type Position} from '../reconcile.ts';
import {details} from '../response-details.ts';
import {ServiceBlocked} from '../servicing.ts';
import {Blocked,type Ctx,type JobOutcome} from './ctx.ts';
import {dock,route,service,step,storage,travel} from './helpers.ts';
import {stow} from './stow.ts';

export interface HuntParams {
  /** The habitat to work: the POI the creatures are at, in this system or another. */
  poi_id:string;
  /** Optional: the species to take. A species the pilot names is a kind it knows; without
   * one, only a creature the world says the speed of is admissible. */
  species?:string;
  /** Optional: how many fights to take before coming home. Default one. */
  fights?:number;
  /** The base the loot is stowed at. Defaults to the dock the ship left, then home. */
  base_id?:string;
}

/** ponytail: one poll interval and one ceiling, not a config system. A battle tick is ten
 * seconds of real time and a wildlife fight is a handful of them; five minutes is a fight
 * that is not going to end. Lift them the day a hunt legitimately runs longer. */
const POLL_MS=250;
const FIGHT_CEILING_MS=5*60_000;
/** The step ladder, which is also the resume ladder. */
const STEPS=['travel','fight','return','dock','stow','service'] as const;
type Step=typeof STEPS[number];

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const say=(rows:MineYieldRow[])=>rows.map(row=>`${row.quantity} ${row.item_id}`).join(', ');
const held=(rows:{item_id:string;quantity:number}[],item:string)=>
  rows.find(row=>row.item_id===item)?.quantity??0;

export interface Creature {
  creature_id:string;species:string;name:string;role:string;
  hull:number;max_hull:number;in_combat:boolean;branded:boolean;speed?:number;
}
export interface TargetReport {
  species:string;outcome:'down'|'escaped'|'broke off'|'unresolved';
  hull_before:number;hull_after:number;
}

/** The loadout floor the Hunter skill names, in the one form the state can answer: a fitted
 * module whose `type` is `weapon`, holding rounds for its `ammo_type`. The reason says the
 * check it failed, so reading the refusal teaches the rule. */
function loadout(modules:Record<string,any>[]):string|null {
  const weapons=modules.filter(module=>String(module.type)==='weapon');
  if(!weapons.length)
    return 'no module of type weapon is fitted; the hangar is the stop before the hunt';
  const loaded=weapons.filter(weapon=>
    weapon.ammo_type===undefined||Number(weapon.current_ammo??0)>0);
  if(!loaded.length)
    return `${weapons.map(weapon=>`${String(weapon.name??weapon.type_id)} has ${Number(weapon.current_ammo??0)} rounds of ${String(weapon.ammo_type)}`).join('; ')}; the market is the stop before the hunt`;
  return null;
}

/** Why this creature is not the fight to take, or null when it is.
 *
 * "Known kind" is the Hunter rule and D7's `need_intelligence`: a scan gives hull and a
 * description, never speed, so an individual merely seen is not known. A species the run
 * names is a kind the pilot has fought; anything else has to have the world say how fast it
 * is, and where it does not, the creature is declined rather than guessed at.
 */
function decline(creature:Creature,shipSpeed:number,named:string|undefined):string|null {
  if(creature.in_combat)return `${creature.name} is already in someone else's battle`;
  if(creature.branded)return `${creature.name} is branded: someone's livestock, not wildlife`;
  if(!creature.species)return `${creature.name} has no species; an unknown kind is declined`;
  if(named&&creature.species!==named)return `${creature.name} is ${creature.species}, not ${named}`;
  const speed=typeof creature.speed==='number'&&Number.isFinite(creature.speed)?creature.speed:undefined;
  if(speed===undefined&&!named)
    return `the scan gives ${creature.species} hull and description, never speed; name a species you have fought before`;
  if(speed!==undefined&&speed>shipSpeed)
    return `${creature.species} is faster than the ship (${speed} against ${shipSpeed})`;
  return null;
}

const creatures=async (ctx:Ctx):Promise<Creature[]>=>
  ((details(await ctx.command('spacemolt/get_nearby',{})).creatures??[]) as Record<string,any>[])
    .map(row=>({creature_id:String(row.creature_id),species:String(row.species??''),
      name:String(row.name??row.species??row.creature_id),role:String(row.role??''),
      hull:Number(row.hull??0),max_hull:Number(row.max_hull??0),
      in_combat:Boolean(row.in_combat),branded:Boolean(row.branded),
      ...typeof row.speed==='number'?{speed:row.speed}:{}}));

/** Where a hunt that was already under way re-enters, read from the world and nothing else. */
function entryStep(ctx:Ctx,site:{system_id:string;poi_id:string},
  home:{system_id:string;poi_id:string;base_id:string},take:number):Step|{blocked:string} {
  const {ship,location}=ctx.account.state;
  if(!ship||!location)return {blocked:'authoritative ship and location unavailable'};
  if(location.in_transit)
    return location.transit_dest_poi_id===site.poi_id?'travel':'return';
  if(location.docked_at)
    return location.docked_at!==home.base_id
      ?{blocked:`docked at ${location.docked_at}, which is neither this job's base ${home.base_id} nor a step of it`}
      :take>0?'stow':'service';
  if(location.system_id===site.system_id&&location.poi_id===site.poi_id)
    return take>0?'return':'fight';
  if(location.system_id===home.system_id&&location.poi_id===home.poi_id)return 'dock';
  return {blocked:`at ${location.system_id}/${location.poi_id??'nowhere'}, which is neither the habitat ${site.poi_id} nor ${home.poi_id}`};
}

/** One fight, from the first shot to the end of the battle. The battle is the game's to run
 * — it flies on auto-pilot in the `fire` stance — so this watches it, closes the distance
 * while the target is out of reach, and breaks off when the hull crosses the mood's line. */
async function engage(ctx:Ctx,target:Creature,floor:number):Promise<TargetReport> {
  await ctx.account.refresh();
  const hull_before=Number(ctx.account.state.ship?.hull??0);
  await ctx.command('spacemolt/hunt',{id:target.creature_id});
  const deadline=Date.now()+FIGHT_CEILING_MS;
  let outcome:TargetReport['outcome']='escaped';
  for(;;) {
    let status:Record<string,any>|null=null;
    // The battle answering `not_in_battle` IS its end; that refusal is the evidence.
    try {status=details(await ctx.command('spacemolt_battle/status',{}));}
    catch {break;}
    if(!status?.battle_id)break;
    // The fight being over is read before anything is decided about it: there is nothing to
    // break off from once the target has left the battle.
    const rows=(status.participants??[]) as Record<string,any>[];
    if(!rows.some(row=>String(row.player_id)===target.creature_id))break;
    await ctx.account.refresh();
    const ship=ctx.account.state.ship;
    if(ship?.incapacitated)return {species:target.species,outcome:'unresolved',hull_before,
      hull_after:Number(ship?.hull??0)};
    if(Number(ship?.hull??0)<floor) {
      try {await ctx.command('spacemolt_battle/retreat',{});} catch {/* the battle ended first */}
      outcome='broke off';
      break;
    }
    const mine=rows.find(row=>String(row.kind)==='player');
    const reach=Number(status.combat_state?.max_weapon_reach??0);
    if(Number(mine?.zone_distance??0)>reach)await ctx.command('spacemolt_battle/advance',{});
    if(Date.now()>=deadline){outcome='unresolved';break;}
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,POLL_MS);timer.unref?.();});
  }
  await ctx.account.refresh();
  return {species:target.species,outcome,hull_before,
    hull_after:Number(ctx.account.state.ship?.hull??0)};
}

/** What the kill left, as much of it as the hold has room for. Never towed: a tow costs the
 * speed the way home needs (Hunter skill), so what does not fit stays in the wreck. */
async function loot(ctx:Ctx,creature_id:string):Promise<{took:MineYieldRow[];wrecked:boolean}> {
  const wrecks=(details(await ctx.command('spacemolt_salvage/wrecks',{})).wrecks??[]) as Record<string,any>[];
  const wreck=wrecks.find(row=>String(row.victim_id)===creature_id);
  if(!wreck)return {took:[],wrecked:false};
  const took:MineYieldRow[]=[];
  for(const row of (wreck.cargo??[]) as {item_id:string;quantity:number}[]) {
    await ctx.account.refresh();
    const {ship}=ctx.account.state;
    const room=Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0);
    const quantity=Math.min(Number(row.quantity),Math.max(0,room));
    if(quantity<=0)break;
    const before=miningInventory(ctx.account.state)[String(row.item_id)]??0;
    try {await ctx.command('spacemolt_salvage/loot',{id:String(wreck.id),item_id:String(row.item_id),quantity});}
    catch {continue;}
    // The reply's claim is not evidence; the hold after the send is.
    await ctx.account.refresh();
    const moved=(miningInventory(ctx.account.state)[String(row.item_id)]??0)-before;
    if(moved>0)took.push({item_id:String(row.item_id),quantity:moved});
  }
  return {took,wrecked:true};
}

export async function hunt(ctx:Ctx,params:HuntParams):Promise<JobOutcome> {
  await ctx.check('hunt');
  const resuming=ctx.resuming();
  const poi_id=String(params.poi_id??'');
  if(!poi_id)throw new Error('hunt requires a poi_id: the habitat to work');
  const asked=params.fights===undefined?1:Number(params.fights);
  if(!Number.isInteger(asked)||asked<1)
    throw new Error('hunt requires fights: a whole number of fights, at least one');
  const named=params.species===undefined?undefined:String(params.species);
  const targets:TargetReport[]=[];
  // The rung the job is standing on, so a job that ends mid-ladder names where it stopped.
  let at='fit';
  const end=(outcome:JobOutcome['outcome'],reason:string,extra:Partial<JobOutcome>={}):JobOutcome=>{
    step(ctx,'hunt',at,outcome,{poi_id,reason,n:targets.length,
      ...extra.yield?{yield:extra.yield}:{}});
    const row:JobOutcome={job:'hunt',outcome,reason,...extra};
    ctx.jobs.push(row);
    return row;
  };

  ctx.progress({last_job:'hunt',last_step:'loadout'});
  await ctx.account.refresh();
  const gap=loadout((ctx.account.state.modules??[]) as Record<string,any>[]);
  if(gap)return end('failed',gap);

  const baseId=String(params.base_id??ctx.account.state.location?.docked_at??ctx.home??'');
  if(!baseId)throw new Error('hunt needs a base_id to stow the loot at: pass one or set a home');
  const found=await route(ctx,poi_id);
  const home=await route(ctx,baseId);
  const site={system_id:String(found.target_system),poi_id};
  const back={system_id:String(home.target_system),poi_id:String(home.target_poi),base_id:baseId};
  // The hold at departure is the pilot's own and is never stowed. A resumed job never saw
  // its departure, so `keep` is the whole of what it may treat as the pilot's own.
  const own=new Set(ctx.keep);
  if(!resuming)for(const item of Object.keys(miningInventory(ctx.account.state)))own.add(item);

  let from=0;
  if(resuming) {
    const aboard=Object.entries(miningInventory(ctx.account.state))
      .filter(([item,quantity])=>quantity>0&&!own.has(item)).length;
    const entry=entryStep(ctx,site,back,aboard);
    if(typeof entry!=='string')return end('blocked',`resume blocked: ${entry.blocked}`);
    from=STEPS.indexOf(entry);
  }

  let expected:Position|null=null,blocked:string|undefined,failure:string|undefined;
  const hullStart=Number(ctx.account.state.ship?.hull??0);
  const floor=resolveWalkAway(ctx.mood)*Number(ctx.account.state.ship?.max_hull??0);
  const taken:MineYieldRow[]=[];

  step(ctx,'hunt','fit','done',{poi_id,base_id:baseId});
  at='travel';
  if(from<=STEPS.indexOf('travel')) {
    ctx.progress({last_job:'hunt',last_step:'travel'});
    const out=await travel(ctx,poi_id);
    if(!out.arrived)return end('blocked',`hunt did not reach ${poi_id}: ${out.reason}`);
    step(ctx,'hunt','travel','done',{poi_id});
  } else step(ctx,'hunt','travel','skipped',{poi_id});

  at='fight';
  if(from<=STEPS.indexOf('fight')) {
    ctx.progress({last_job:'hunt',last_step:'fight'});
    await ctx.account.refresh();
    expected=position(ctx.account.state);
    for(let round=0;round<asked;round++) {
      if(round>0) {
        // The rules between one fight and the next are the rules between jobs (R5).
        try {await ctx.check('hunt');}
        catch(error){if(error instanceof Blocked){blocked=message(error);break;}throw error;}
      }
      await ctx.account.refresh();
      const ship=ctx.account.state.ship;
      const hull=Number(ship?.hull??0);
      if(hull<floor) {
        blocked=`hull ${hull} of ${ship?.max_hull} is under the ${ctx.mood} walk-away line ${floor}`;
        break;
      }
      if(Number(ship?.cargo_capacity??0)-Number(ship?.cargo_used??0)<=0) {
        blocked='the hold is full; loot fought for has nowhere to go';
        break;
      }
      const seen=await creatures(ctx);
      const speed=Number(ship?.speed??ship?.operational_speed??0);
      const refusals:string[]=[];
      let target:Creature|undefined;
      for(const creature of seen) {
        const why=decline(creature,speed,named);
        if(why===null){target=creature;break;}
        refusals.push(why);
      }
      if(!target) {
        blocked=seen.length
          ?`no creature here is a fight worth taking: ${[...new Set(refusals)].join('; ')}`
          :`no creature is at ${poi_id}`;
        break;
      }
      const report=await engage(ctx,target,floor);
      targets.push(report);
      step(ctx,'hunt',`fight ${targets.length}`,report.outcome==='down'?'done':'blocked',
        {species:report.species,hull:report.hull_after,reason:report.outcome});
      // The world may have taken the pilot out of the fight with no command behind it.
      const drift=await reconcileMove(ctx.account,expected);
      if(drift.moved)
        return end(movedOutcome(drift.cause),
          `hunt stopped after ${targets.length} fight${targets.length===1?'':'s'}: unsolicited move (${drift.cause}): ${drift.evidence}`,
          {moved:drift,yield:taken,result:{poi_id,fights:targets.length,targets,loot:taken,
            hull:Number(ctx.account.state.ship?.hull??0),base_id:baseId}});
      // A wreck with this creature's name on it is the only evidence the fight was won.
      const salvage=await loot(ctx,target.creature_id);
      for(const row of salvage.took)taken.push(row);
      step(ctx,'hunt','loot',salvage.wrecked?'done':'skipped',
        {species:target.species,yield:salvage.took});
      if(report.outcome==='escaped'&&salvage.wrecked)report.outcome='down';
      await ctx.account.refresh();
      expected=position(ctx.account.state);
      if(report.outcome==='broke off'||report.outcome==='unresolved') {
        blocked=`broke off after ${target.species}: hull ${report.hull_after} against the ${ctx.mood} line ${floor}`;
        break;
      }
    }
  }

  at='return';
  if(from<=STEPS.indexOf('return')) {
    ctx.progress({last_job:'hunt',last_step:'return'});
    const back_=await travel(ctx,back.poi_id);
    if(!back_.arrived)return end('failed',`hunt did not get home to ${back.poi_id}: ${back_.reason}`,
      {yield:taken,result:{poi_id,fights:targets.length,targets,loot:taken,base_id:baseId}});
    step(ctx,'hunt','return','done',{poi_id:back.poi_id});
  } else step(ctx,'hunt','return','skipped',{poi_id:back.poi_id});

  at='dock';
  if(from<=STEPS.indexOf('dock')) {
    ctx.progress({last_job:'hunt',last_step:'dock'});
    const docked=await dock(ctx,baseId);
    if(!docked.docked)return end('failed',`hunt reached ${back.poi_id} but did not dock: ${docked.reason}`,
      {yield:taken,result:{poi_id,fights:targets.length,targets,loot:taken,base_id:baseId}});
    step(ctx,'hunt','dock','done',{base_id:baseId});
  } else step(ctx,'hunt','dock','skipped',{base_id:baseId});

  // The store is where the loot went, so the store's delta is what this job yielded.
  let stowed:MineYieldRow[]=[];
  at='stow';
  if(from<=STEPS.indexOf('stow')) {
    ctx.progress({last_job:'hunt',last_step:'stow'});
    const before=await storage(ctx,baseId);
    const counter=await stow({...ctx,keep:[...own],jobs:[]},{base_id:baseId});
    if(counter.outcome!=='done')failure=String(counter.reason);
    const after=await storage(ctx,baseId);
    stowed=after.items.map(item=>({item_id:item.item_id,
      quantity:item.quantity-held(before.items,item.item_id)}))
      .filter(row=>row.quantity>0).sort((a,b)=>a.item_id<b.item_id?-1:1);
    step(ctx,'hunt','stow',failure?'failed':'done',
      {base_id:baseId,yield:stowed,...failure?{reason:failure}:{}});
  } else step(ctx,'hunt','stow','skipped',{base_id:baseId});

  at='service';
  if(from<=STEPS.indexOf('service')&&!failure) {
    ctx.progress({last_job:'hunt',last_step:'service'});
    try {await service(ctx);step(ctx,'hunt','service','done',{base_id:baseId});}
    catch(error) {
      if(error instanceof ServiceBlocked)blocked=blocked??message(error);
      else failure=message(error);
      step(ctx,'hunt','service',failure?'failed':'blocked',{base_id:baseId,reason:message(error)});
    }
  } else step(ctx,'hunt','service','skipped',{base_id:baseId});

  at='finish';
  await ctx.account.refresh();
  const hull=Number(ctx.account.state.ship?.hull??0);
  const result={poi_id,fights:targets.length,targets,loot:stowed.length?stowed:taken,
    hull,hull_before:hullStart,base_id:baseId};
  const sentence=`${targets.length} fight${targets.length===1?'':'s'} at ${poi_id}: ${say(stowed.length?stowed:taken)||'no loot'}, hull ${hullStart} to ${hull}, stowed at ${baseId}`;
  if(failure)return end('failed',`hunt did not finish: ${failure}`,{yield:stowed,result});
  if(blocked)return end('blocked',`${sentence}; stopped: ${blocked}`,{yield:stowed,result});
  return end('done',`hunted ${sentence}`,{yield:stowed,result});
}
