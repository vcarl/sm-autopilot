/** Planning estimates, not an exact simulator or a probability of victory. */
export interface WeaponEstimate {
  damage: number;
  cooldown: number;
  reach: number;
  rounds?: number;
}
export interface CombatantEstimate {
  id: string;
  hull: number;
  maxHull: number;
  shield: number;
  shieldRecharge: number;
  speed: number;
  weapons: WeaponEstimate[];
  /** Multiplier on incoming damage needed to exhaust this hull (armor/resistance). */
  durability: number;
  shieldBypass: boolean;
  evidence: string;
}
export interface ContactEstimate {
  id: string;
  participation: 'target' | 'hostile' | 'possible' | 'bystander';
  capability?: CombatantEstimate;
  unavailable?: string;
}
export interface EngagementPolicy {
  retreatHullFraction: number;
  maxTicks: number;
  approachTicks: number;
  escapeTicks: number;
  outgoingAccuracy: number;
  incomingMargin: number;
}
export const engagementPolicy: EngagementPolicy = {
  retreatHullFraction: 0.8, maxTicks: 24, approachTicks: 3, escapeTicks: 3,
  outgoingAccuracy: 0.8, incomingMargin: 1.25,
};
const nonnegative=(n:number)=>Number.isFinite(n)&&n>=0;
function valid(c:CombatantEstimate) {
  return [c.hull,c.maxHull,c.shield,c.shieldRecharge,c.speed,c.durability].every(nonnegative)
    &&c.maxHull>0&&c.hull<=c.maxHull&&c.durability>=1&&c.speed>0&&Boolean(c.evidence)
    &&c.weapons.every(w=>[w.damage,w.cooldown,w.reach].every(nonnegative)&&w.cooldown>=1
      &&(w.rounds===undefined||(Number.isInteger(w.rounds)&&w.rounds>=0)));
}
const dpt=(c:CombatantEstimate)=>c.weapons.reduce((sum,w)=>sum+(w.rounds===0?0:w.damage/w.cooldown),0);

/** Every possible opponent contributes for the whole encounter; no speculative ally credit. */
export function assessEngagement(own:CombatantEstimate,contacts:ContactEstimate[],overrides:Partial<EngagementPolicy>={}) {
  const policy={...engagementPolicy,...overrides};
  const reasons:string[]=[],unknown:string[]=[];
  const opponents=contacts.filter(c=>c.participation!=='bystander');
  const targets=contacts.filter(c=>c.participation==='target');
  if(!valid(own))unknown.push('self');
  if(new Set(contacts.map(c=>c.id)).size!==contacts.length||contacts.some(c=>c.id===own.id))reasons.push('Duplicate or self contact');
  if(!targets.length)reasons.push('No selected target');
  for(const contact of opponents) {
    if(contact.unavailable)reasons.push(`${contact.id}: ${contact.unavailable}`);
    if(!contact.capability||!valid(contact.capability)||contact.capability.id!==contact.id)unknown.push(contact.id);
  }
  if(!Object.values(policy).every(nonnegative)||policy.retreatHullFraction<0.8||policy.retreatHullFraction>0.95
    ||policy.maxTicks<1||policy.maxTicks>24||policy.outgoingAccuracy<=0||policy.outgoingAccuracy>1||policy.incomingMargin<1
    ||policy.escapeTicks<3)throw new Error('Invalid engagement policy');
  const common={policy,own,contacts,unknown,reasons};
  if(unknown.length)return {...common,decision:'need_intelligence' as const,estimates:null};
  const enemies=opponents.map(c=>c.capability!);
  const outgoing=dpt(own)*policy.outgoingAccuracy;
  const durability=enemies.reduce((sum,c)=>sum+c.hull*c.durability+c.shield,0);
  // Include enemy regeneration; if we cannot overcome it there is no finite plan.
  const effectiveOutgoing=outgoing-enemies.reduce((sum,c)=>sum+c.shieldRecharge,0);
  const firingTicks=effectiveOutgoing>0?Math.ceil(durability/effectiveOutgoing):null;
  const fightTicks=firingTicks===null?null:firingTicks+policy.approachTicks;
  const exposureTicks=fightTicks===null?null:fightTicks+policy.escapeTicks;
  const incoming=enemies.reduce((sum,c)=>sum+dpt(c),0)*policy.incomingMargin;
  const bypass=enemies.some(c=>c.shieldBypass);
  const hullBudget=Math.max(0,own.hull-own.maxHull*policy.retreatHullFraction);
  const damageBudget=hullBudget+(bypass?0:own.shield);
  // Never credit armor or shield regeneration against an unknown bypass attack.
  const projectedDamage=exposureTicks===null?null:Math.max(0,incoming-(bypass?0:own.shieldRecharge))*exposureTicks;
  if(own.hull<=own.maxHull*policy.retreatHullFraction)reasons.push('Hull withdrawal threshold reached');
  if(fightTicks===null)reasons.push('Cannot overcome opposing durability/regeneration');
  else if(fightTicks>policy.maxTicks)reasons.push('Fight exceeds offensive time budget');
  if(projectedDamage===null||projectedDamage>=damageBudget)reasons.push('Aggregate damage exhausts survival and escape budget');
  if(enemies.some(c=>c.speed>own.speed))reasons.push('Escape against a faster opponent is not established');
  if(exposureTicks!==null&&own.weapons.some(w=>w.rounds!==undefined&&w.rounds<Math.ceil(exposureTicks/w.cooldown)))reasons.push('Insufficient ammunition through fight and escape');
  const estimates={outgoingDamagePerTick:outgoing,incomingDamagePerTick:incoming,opponentDurability:durability,
    firingTicks,fightTicks,exposureTicks,projectedDamage,damageBudget,margin:projectedDamage===null?null:damageBudget-projectedDamage};
  return {...common,decision:reasons.length?'avoid' as const:'engage' as const,estimates};
}
