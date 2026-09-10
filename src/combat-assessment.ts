import type {Account, CreatureInfo, GetNearbyResponse} from '@spacemolt/lib';
import {assessEngagement, type CombatantEstimate, type ContactEstimate, type EngagementPolicy} from './threat-assessment.ts';

export interface WildlifeIntel {
  passive: boolean;
  maxHullObserved: number;
  damagePerTick: number;
  durability: number;
  speedEstimate: number;
  minimumOwnArmor: number;
  weaponTypes: string[];
  evidence: string;
}
/** Reviewed empirical estimates. Expanding this table requires evidence, not a model assertion. */
export const wildlifeIntel:Record<string,WildlifeIntel>={
  phase_lurker:{passive:true,maxHullObserved:55,damagePerTick:4,durability:1,speedEstimate:2,
    minimumOwnArmor:3,weaponTypes:['autocannon_i'],
    evidence:'September 9 live Phase-Lurker fights: 55 hull, observed 4-damage hits against armor 3, 10-damage autocannon hits. Speed 2 is a planning assumption, not a measured bound. See evidence/combat-proof.json and combat-training.json. Estimates are not guarantees.'},
};

export function selfEstimate(account:Account):CombatantEstimate {
  const ship=account.ship;
  return {id:account.state.player?.id??'self',hull:ship?.hull??NaN,maxHull:ship?.max_hull??NaN,
    shield:ship?.shield??NaN,shieldRecharge:ship?.shield_recharge??NaN,speed:ship?.operational_speed??ship?.speed??NaN,
    durability:1,shieldBypass:false,evidence:'Current canonical ship and fitted weapon stats; no speculative armor or skill bonus credit.',
    weapons:(account.state.modules??[]).filter(m=>m.slot==='weapon').map(m=>({
      damage:Number(m.stats?.damage??NaN),cooldown:Number(m.stats?.cooldown??NaN),reach:Number(m.stats?.reach??NaN),
      ...(m.ammo_type?{rounds:Number(m.current_ammo??NaN)}:{}),
    }))};
}

export function creatureEstimate(creature:CreatureInfo,account:Account,intel=wildlifeIntel):CombatantEstimate|undefined {
  const profile=intel[creature.species];
  if(!profile||!Number.isFinite(creature.max_hull)||creature.max_hull>profile.maxHullObserved
    ||(account.ship?.armor??-1)<profile.minimumOwnArmor
    ||!(account.state.modules??[]).filter(m=>m.slot==='weapon').every(m=>profile.weaponTypes.includes(m.type_id)))return undefined;
  return {id:creature.creature_id,hull:creature.hull,maxHull:creature.max_hull,shield:0,shieldRecharge:0,
    speed:profile.speedEstimate,durability:profile.durability,shieldBypass:false,evidence:profile.evidence,
    weapons:[{damage:profile.damagePerTick,cooldown:1,reach:3}]};
}

/** Ownership and an existing unrelated fight are execution constraints, not threat scores. */
export function targetUnavailable(c:CreatureInfo):string|undefined {
  if(c.branded||c.brand_faction||c.brand_ranch)return 'Owned creature is outside hunting authorization';
  if(c.in_combat)return 'Already in another battle; hunt cannot join it';
  if(!Number.isFinite(c.hull)||c.hull<=0)return 'No live target hull';
}

export function nearbyContacts(account:Account,nearby:Partial<GetNearbyResponse>,targetIds:string[],intel=wildlifeIntel):ContactEstimate[] {
  const contacts:ContactEstimate[]=(nearby.creatures??[]).map(c=>({id:c.creature_id,
    // Passive fauna do not dogpile. Unknown predators might be ship-aggressive apex fauna.
    participation:targetIds.includes(c.creature_id)?'target':intel[c.species]?.passive||c.role==='grazer'||c.role==='scavenger'?'bystander':'possible',
    capability:creatureEstimate(c,account,intel),
    ...(targetIds.includes(c.creature_id)?{unavailable:targetUnavailable(c)}:{}),
  }));
  if((nearby.creature_count??0)>(nearby.creatures?.length??0)||(nearby.pirate_count??0)>(nearby.pirates?.length??0))contacts.push({id:'incomplete-observation',participation:'possible'});
  for(const pirate of nearby.pirates??[])contacts.push({id:pirate.pirate_id,participation:'possible'});
  for(const player of nearby.nearby??[]) {
    if(player.player_id&&player.player_id!==account.state.player?.id)contacts.push({id:player.player_id,participation:'bystander'});
  }
  if(nearby.unknown_signature)contacts.push({id:'unknown-signature',participation:'possible'});
  for(const id of targetIds)if(!contacts.some(c=>c.id===id))contacts.push({id,participation:'target',unavailable:'Target absent from current observation'});
  for(const contact of contacts)if(targetIds.includes(contact.id)&&contact.participation!=='target') {
    contact.participation='target';contact.unavailable='Only wildlife hunts are executable';
  }
  return contacts;
}

export function assessNearby(account:Account,nearby:Partial<GetNearbyResponse>,targetIds:string[],policy:Partial<EngagementPolicy>={},intel=wildlifeIntel) {
  return assessEngagement(selfEstimate(account),nearbyContacts(account,nearby,targetIds,intel),policy);
}
