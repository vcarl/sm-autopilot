import {SpacemoltError, type Account, type CreatureInfo} from '@spacemolt/lib';
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {details, type IndustryCommand} from './industry.ts';
import {CombatBlocked, prepareCombat, type FitParams} from './combat-fit.ts';
import {snapshotSkills, skillProgress} from './progression.ts';
import {routeSteps} from './normal-route.ts';
import {assessNearby, nearbyContacts, selfEstimate, targetUnavailable} from './combat-assessment.ts';
import {assessEngagement, type ContactEstimate} from './threat-assessment.ts';

type Wire=Record<string,any>;
const habitats=new Set(['asteroid_belt','gas_cloud','ice_field','nebula']);
const ledger=new URL('../runtime/combat.jsonl',import.meta.url);
const noBattle=(error:unknown)=>error instanceof SpacemoltError&&['not_in_battle','no_battle','no_active_battle'].includes(error.code);
interface CombatDeps {stopped?:()=>boolean; save?:(event:Wire)=>void; sleep?:(ms:number)=>Promise<void>; now?:()=>number}
const snapshot=(account:Account)=>structuredClone({credits:account.credits,ship:account.ship,cargo:account.cargo,location:account.location,skills:snapshotSkills(account.state)});

export async function battleStatus(command:IndustryCommand):Promise<Wire|null> {
  try {
    const status=details(await command('spacemolt_battle/status',{}));
    if(typeof status.is_participant!=='boolean'||(status.is_participant&&typeof status.battle_id!=='string'))throw new Error('Battle status is incomplete; cannot infer that combat has ended');
    return status.is_participant?status:null;
  } catch(error) {
    if(noBattle(error))return null;
    throw error;
  }
}

async function ready(account:Account,command:IndustryCommand) {
  await account.refresh();
  const ship=account.ship;
  if(!ship||!account.location?.docked_at)throw new CombatBlocked('Start the sortie docked with authoritative ship state');
  if(![ship.hull,ship.max_hull,ship.shield,ship.max_shield,ship.fuel,ship.cargo_capacity,ship.cargo_used,account.credits].every(Number.isFinite))throw new CombatBlocked('Ship readiness data is incomplete');
  if(ship.incapacitated||ship.hull<ship.max_hull||ship.shield<ship.max_shield||ship.fuel<30)throw new CombatBlocked('Restore hull/shields and carry at least 30 fuel before departure');
  if((account.credits??0)<150000)throw new CombatBlocked('Preserve the 150000-credit hunting reserve');
  if(await battleStatus(command))throw new CombatBlocked('An existing battle needs reconciliation before a new sortie');
  const weapons=(account.state.modules??[]).filter(m=>m.slot==='weapon');
  if(!weapons.length)throw new CombatBlocked('Fit a combat weapon before scouting or hunting');
  for(const weapon of weapons) {
    const item=details(await command('spacemolt/inspect',{id:weapon.type_id})).catalog?.items?.find((i:Wire)=>i.id===weapon.type_id);
    if(!item||!(item.damage>0))throw new CombatBlocked('Starter controller requires verified damage weapons');
    if(item.ammo_type&&(item.ammo_type!=='autocannon'||Number((weapon as any).current_ammo??0)<100))throw new CombatBlocked('Load at least 100 autocannon rounds before departing; other ammunition weapons are unsupported');
  }
  if(ship.cargo_capacity-ship.cargo_used<10)throw new CombatBlocked('Leave at least 10 cargo units for loot');
}

/** A retreat decision stays in force even if shields regenerate or the model budget expires. */
export function battleDecision(status:Wire,playerId:string,targetId:string,retreat:boolean,hullFraction:number,assessment?:ReturnType<typeof assessEngagement>) {
  const own=status.participants?.find((p:Wire)=>p.player_id===playerId);
  const target=status.participants?.find((p:Wire)=>p.player_id===targetId);
  const strangers=status.participants?.some((p:Wire)=>p.player_id!==playerId&&p.player_id!==targetId);
  const bail=retreat||!own||!target||(assessment?assessment.decision!=='engage':strangers)||!status.combat_state
    ||!Number.isFinite(own.hull_pct)||own.hull_pct<=hullFraction*100;
  if(bail)return {retreat:true,stance:'flee',advance:false};
  // Closing to point blank improves hit chance; a reach check alone stalls at 5% accuracy.
  return {retreat:false,stance:'fire',advance:own.zone!=='engaged'};
}

export async function controlHunt(account:Account,command:IndustryCommand,targetId:string,params:Wire,deps:CombatDeps={}) {
  const sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now=deps.now??Date.now,start=now(),playerId=account.state.player!.id;
  let retreat=Boolean(params.force_retreat),lastManeuver=-Infinity,battleId:string|undefined=params.observed_battle?.battle_id,ownSide:number|undefined=params.observed_battle?.participants?.find((p:Wire)=>p.player_id===playerId)?.side_id;
  // Waiting for the first observed battle is separate from submitting hunt. Never resubmit.
  for(;;) {
    const status=await battleStatus(command);
    if(!status) {
      if(battleId)break;
      if(now()-start>30000)throw new Error('Hunt accepted but no battle observed; reconcile action log, do not hunt again');
      await sleep(2000);continue;
    }
    battleId=status.battle_id;
    const own=status.participants?.find((p:Wire)=>p.player_id===playerId);
    ownSide=own?.side_id??ownSide;
    let assessment:ReturnType<typeof assessEngagement>|undefined;
    if(params.contacts&&own) {
      const self=selfEstimate(account);
      self.hull=self.maxHull*own.hull_pct/100;
      self.shield=account.ship!.max_shield*(own.shield_pct??0)/100;
      const contacts:ContactEstimate[]=(status.participants??[]).filter((p:Wire)=>p.player_id!==playerId).map((p:Wire)=>{
        const known:ContactEstimate|undefined=params.contacts.find((c:ContactEstimate)=>c.id===p.player_id);
        const capability=known?.capability?{...known.capability,hull:Math.ceil(known.capability.maxHull*Math.min(100,p.hull_pct+1)/100)}:undefined;
        return {id:p.player_id,participation:p.player_id===targetId?'target':p.side_id===own.side_id?'bystander':'hostile',capability};
      });
      assessment=assessEngagement(self,contacts,{maxTicks:Math.max(1,params.max_ticks-Math.floor((now()-start)/10000)),
        retreatHullFraction:params.retreat_hull_fraction,approachTicks:({outer:3,mid:2,inner:1,engaged:0} as Record<string,number>)[own.zone]??3});
    }
    const emptyWeapon=(account.state.modules??[]).some((m:any)=>m.slot==='weapon'&&m.current_ammo!==undefined&&m.current_ammo<=0);
    const decision=battleDecision(status,playerId,targetId,retreat||Boolean(deps.stopped?.())||emptyWeapon||(account.ship?.fuel??0)<15||now()-start>=params.max_ticks*10000,params.retreat_hull_fraction,assessment);
    // Live tick_duration can stay unchanged while combat advances. Pace maneuvers
    // by the game's ten-second cadence, but react immediately to a new retreat.
    if(now()-lastManeuver>=10000||(decision.retreat&&!retreat)) {
      deps.save?.({event:'battle_tick',battle_id:battleId,status,assessment});
      lastManeuver=now();
      retreat=decision.retreat;
      try {
        if(own?.stance!==decision.stance)await command('spacemolt_battle/stance',{id:decision.stance});
        if(decision.advance)await command('spacemolt_battle/advance',{});
      } catch(error) {
        // A simultaneous tick can end the fight between observation and maneuver.
        if(noBattle(error)&&!(await battleStatus(command)))break;
        throw error;
      }
    }
    // Do not close a live fight merely because the offensive budget has elapsed.
    await sleep(2000);
  }
  await account.refresh();
  const summary=details(await command('spacemolt_battle/summary',{id:battleId}));
  return {battle_id:battleId,retreated:retreat,summary,verified_victory:summary.status!=='active'&&summary.outcome==='victory'&&ownSide!==undefined&&summary.winning_side===ownSide};
}

export async function combat(action:string,params:Wire,account:Account,command:IndustryCommand,deps:CombatDeps={}) {
  try { return await executeCombat(action,params,account,command,deps); }
  catch(error) {
    if(error instanceof CombatBlocked)return {status:'blocked',reason:error.message};
    throw error;
  }
}

async function executeCombat(action:string,params:Wire,account:Account,command:IndustryCommand,deps:CombatDeps={}) {
  const save=deps.save??(event=>appendFileSync(ledger,JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600}));
  if(action==='prepare') {
    const result=await prepareCombat(params as FitParams,account,command);
    save({event:'fitting',...result});return result;
  }
  if(action==='history')return existsSync(ledger)?readFileSync(ledger,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.event!=='battle_tick').slice(-10):[];
  if(action==='assess') {
    await account.refresh();
    const nearby=details(await command('spacemolt/get_nearby',{}));
    const ids=params.target_ids;
    if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length))throw new CombatBlocked('target_ids must be distinct nonempty IDs');
    return ids?assessNearby(account,nearby,ids):{
      self:selfEstimate(account),contacts:nearbyContacts(account,nearby,[]),candidates:(nearby.creatures??[]).map((c:CreatureInfo)=>({id:c.creature_id,species:c.species,assessment:assessNearby(account,nearby,[c.creature_id])})),
    };
  }
  if(!['scout','hunt'].includes(action))throw new Error('Unknown combat workflow');
  const maxTicks=params.max_ticks??24,fraction=params.retreat_hull_fraction??0.8;
  if(!Number.isInteger(maxTicks)||maxTicks<1||maxTicks>24||!Number.isFinite(fraction)||fraction<0.8||fraction>0.95)throw new Error('Invalid combat withdrawal budget');
  await ready(account,command);
  const before=snapshot(account),origin=account.location!.poi_id!,originBase=account.location!.docked_at!,system=account.location!.system_id;
  const destination=params.target_system_id??system;
  const jumpTo=async(target:string,reserve:number)=>{
    if(account.location!.system_id===target)return;
    const quote=details(await command('spacemolt/find_route',{id:target}));
    const steps=routeSteps(quote,account.location!.system_id,target,2);
    const required=quote.estimated_fuel+reserve+2;
    if(account.ship!.fuel<required)throw new Error('Bounded hunting route would breach return fuel reserve');
    if(account.location!.docked_at)await command('spacemolt/undock',{});
    for(const next of steps) {
      if(target!==system&&deps.stopped?.())throw new CombatBlocked('Return requested during outward travel');
      const local=details(await command('spacemolt/get_system',{})).system;
      if(!local?.connections?.some((c:Wire|string)=>(typeof c==='string'?c:c.system_id)===next))throw new Error('Hunting route is not a verified normal connection');
      await command('spacemolt/jump',{id:next});
      if(account.location!.system_id!==next||account.location!.in_transit)throw new Error('Jump arrival not verified');
    }
  };
  if(params.creature_id!==undefined&&(typeof params.creature_id!=='string'||!params.creature_id))throw new CombatBlocked('creature_id must be a nonempty identifier');
  if(params.species!==undefined&&(typeof params.species!=='string'||!params.species))throw new CombatBlocked('species must be a nonempty identifier');
  const id=randomUUID(),observations:Wire[]=[],loot:Wire[]=[];
  let fight:Wire|undefined;
  save({event:'sortie_started',id,action,before,target_system_id:destination,params});
  try {
    // Budget two loaded return jumps plus local travel before leaving the station.
    await jumpTo(destination,30+2*Math.max(2,Math.ceil(account.ship!.cargo_capacity/10)));
    const info=details(await command('spacemolt/get_system',{}));
    const choices:Wire[]=(info.system?.pois??[]).filter((p:Wire)=>habitats.has(p.type));
    const ids=action==='hunt'?[params.poi_id]:params.poi_ids??choices.slice(0,3).map(p=>p.id);
    if(!Array.isArray(ids)||ids.length>3||ids.some(id=>!choices.some(p=>p.id===id)))throw new Error('Choose up to three verified wildlife habitats in the destination system');
    for(const poi of ids) {
      if(deps.stopped?.())break;
      if(account.ship!.fuel<20)throw new Error('Return fuel reserve reached');
      if(account.location!.docked_at)await command('spacemolt/undock',{});
      await command('spacemolt/travel',{id:poi});
      if(account.location!.system_id!==destination||account.location!.poi_id!==poi)throw new Error('Arrival not verified');
      if(await battleStatus(command)) {
        fight=await controlHunt(account,command,'',{max_ticks:maxTicks,retreat_hull_fraction:fraction,force_retreat:true},{...deps,save});
        break;
      }
      const nearby=details(await command('spacemolt/get_nearby',{}));
      const creatures:CreatureInfo[]=nearby.creatures??[];
      const policy={maxTicks,retreatHullFraction:fraction};
      const candidates=creatures.filter(c=>action==='scout'||
        ((!params.creature_id||c.creature_id===params.creature_id)&&(!params.species||c.species===params.species)))
        .map(c=>({creature:c,assessment:assessNearby(account,nearby,[c.creature_id],policy)}));
      const target=candidates.filter(c=>c.assessment.decision==='engage').sort((a,b)=>
        (a.assessment.estimates?.fightTicks??Infinity)-(b.assessment.estimates?.fightTicks??Infinity))[0]?.creature;
      // An unknown candidate may be scanned for intelligence, but never attacked on role alone.
      const scanTarget=target??candidates.find(c=>!targetUnavailable(c.creature))?.creature;
      const observation:Wire={system_id:destination,poi_id:poi,creatures,
        assessments:candidates.map(c=>({id:c.creature.creature_id,...c.assessment}))};
      if(scanTarget)observation.scan=details(await command('spacemolt/scan',{id:scanTarget.creature_id}));
      observations.push(observation);save({event:'habitat',id,...observation});
      if(await battleStatus(command)) {
        fight=await controlHunt(account,command,'',{max_ticks:maxTicks,retreat_hull_fraction:fraction,force_retreat:true},{...deps,save});
        break;
      }
      if(action==='scout')continue;
      if(!target) {fight={status:'engagement_declined',message:'No requested target passes the encounter assessment',assessments:observation.assessments};break;}
      if(observation.scan?.success!==true) {fight={status:'scan_unverified'};break;}
      // Confirm combat state before committing to the scanned individual.
      if(await battleStatus(command))throw new Error('Battle state changed before hunt');
      const freshNearby=details(await command('spacemolt/get_nearby',{}));
      const assessment=assessNearby(account,freshNearby,[target.creature_id],policy);
      save({event:'engagement_assessment',id,assessment});
      if(assessment.decision!=='engage') {fight={status:'engagement_declined',assessment};break;}
      const wrecksBefore=details(await command('spacemolt_salvage/wrecks',{})).wrecks??[];
      if(deps.stopped?.())break;
      await command('spacemolt/hunt',{id:target.creature_id});
      fight=await controlHunt(account,command,target.creature_id,{max_ticks:maxTicks,retreat_hull_fraction:fraction,contacts:assessment.contacts},{...deps,save});
      fight.target=target;
      if(account.ship?.id!==before.ship?.id)throw new Error('Ship changed during hunt; stop for loss reconciliation');
      if(fight.verified_victory&&!deps.stopped?.()) {
        const wrecks=details(await command('spacemolt_salvage/wrecks',{})).wrecks??[];
        for(const wreck of wrecks.filter((w:Wire)=>w.victim_id===target.creature_id&&!wrecksBefore.some((old:Wire)=>old.id===w.id))) {
          for(const item of wreck.cargo??[]) {
            if(!(item.size>0))continue;
            const quantity=Math.min(item.quantity,Math.floor((account.ship!.cargo_capacity-account.ship!.cargo_used)/item.size));
            if(quantity>0)loot.push(details(await command('spacemolt_salvage/loot',{id:wreck.id,item_id:item.item_id,quantity})));
          }
        }
      }
    }
    await jumpTo(system,15);
    if(account.location!.poi_id!==origin)await command('spacemolt/travel',{id:origin});
    if(!account.location!.docked_at)await command('spacemolt/dock',{});
    if(account.location!.docked_at!==originBase)throw new Error('Return station changed; verify docking');
    const after=snapshot(account);
    const result={event:'sortie_completed',id,action,before,after,observations,fight,loot,
      skill_progress:skillProgress(before.skills,after.skills),cash_delta:after.credits!-before.credits!,
      fuel_liability_units:Math.max(0,before.ship!.fuel-after.ship!.fuel),hull_liability_units:Math.max(0,after.ship!.max_hull-after.ship!.hull),
      accounting:'Loot is retained inventory, not profit. Restore fuel and hull and account for equipment separately.'};
    save(result);return result;
  } catch(error) {
    save({event:'sortie_interrupted',id,error:error instanceof Error?error.message:String(error),state:snapshot(account),observations,fight});
    // No automatic movement after an ambiguous command; the boundary must stay latched.
    throw error;
  }
}
