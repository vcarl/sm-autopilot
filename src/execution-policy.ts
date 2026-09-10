export const stances = ['Combat','Hunt','Industry','Trade','Logistics','Explore','Salvage'] as const;
export const moods = ['Relaxed','Cautious','Focused','Opportunistic','Aggressive','Tired'] as const;
export type Stance = typeof stances[number];
export type Mood = typeof moods[number];
export const policyVersion = 'one-job-1';
export interface Home {system_id:string; poi_id:string; base_id:string; rationale:string; observed_at:string}
export interface ExecutionContext {
  stance:Stance; mood:Mood; objective:string; home?:Home;
  limits:{max_spend:number; credit_reserve:number; max_ticks:number; retreat_hull_fraction:number; max_gather_cycles:number};
  permissions:{wildlife:boolean}; authority?:{stance?:Stance;mood?:Mood}; policy_version:string;
  stop_condition:'one_job'; return_policy:'home_or_explicit_fallback';
}
// Unknown capability is never discounted by enthusiasm. No offensive retries or diversions
// are supported by the one-encounter consumer, including Opportunistic.
const presets:Record<Mood,{ticks:number; hull:number; initiate:boolean}> = {
  Relaxed:{ticks:12,hull:0.9,initiate:false}, Cautious:{ticks:16,hull:0.95,initiate:true},
  Focused:{ticks:20,hull:0.9,initiate:true}, Opportunistic:{ticks:20,hull:0.9,initiate:true},
  Aggressive:{ticks:24,hull:0.8,initiate:true}, Tired:{ticks:1,hull:0.95,initiate:false},
};
const gatheringCycles:Record<Mood,number>={Relaxed:2,Cautious:2,Focused:4,Opportunistic:4,Aggressive:6,Tired:0};
export function resolveContext(input:Record<string,any>, previous?:ExecutionContext):ExecutionContext {
  const stance=input.stance??previous?.stance??'Hunt', mood=input.mood??previous?.mood??'Cautious';
  if(!stances.includes(stance)||!moods.includes(mood))throw new Error('Choose a documented stance and mood');
  if((previous?.authority?.stance&&stance!==previous.authority.stance)||(previous?.authority?.mood&&mood!==previous.authority.mood&&mood!=='Tired'))throw new Error('User-selected stance/mood is locked; scripts may only suspend or become Tired');
  const objective=input.objective??previous?.objective;
  if(typeof objective!=='string'||!objective.trim())throw new Error('A nonempty objective is required');
  const preset=presets[mood as Mood], overrides=input.limits??{};
  if(Object.keys(overrides).some(k=>!['max_spend','credit_reserve','max_ticks','retreat_hull_fraction','max_gather_cycles'].includes(k)))throw new Error('Unknown limit');
  const limits={max_spend:previous?.limits.max_spend??1000,credit_reserve:previous?.limits.credit_reserve??150000,max_ticks:preset.ticks,retreat_hull_fraction:preset.hull,max_gather_cycles:gatheringCycles[mood as Mood],...overrides};
  if(!Object.values(limits).every(v=>typeof v==='number'&&Number.isFinite(v))||limits.max_spend<0||limits.max_spend>10000||limits.credit_reserve<150000||!Number.isInteger(limits.max_ticks)||limits.max_ticks<1||limits.max_ticks>preset.ticks||limits.retreat_hull_fraction<preset.hull||limits.retreat_hull_fraction>0.95)throw new Error('Limits may only tighten mood risk bounds; spending 0..10000, reserve >=150000');
  if(!Number.isInteger(limits.max_gather_cycles)||limits.max_gather_cycles<0||limits.max_gather_cycles>gatheringCycles[mood as Mood])throw new Error('Gather cycles may only tighten the resolved mood bound');
  // Authority is set by the host, never by an agent plan or a mood change.
  return {stance,mood,objective,home:previous?.home,limits,authority:previous?.authority,permissions:previous?.permissions??{wildlife:false},policy_version:policyVersion,stop_condition:'one_job',return_policy:'home_or_explicit_fallback'};
}
export function canHunt(context:ExecutionContext) {return context.stance==='Hunt'&&context.permissions.wildlife&&presets[context.mood].initiate;}

/** Host configuration preserves original lock identities through a Tired override. */
export function resolveHostContext(input:Record<string,any>):ExecutionContext {
  const context=resolveContext(input);
  const authority={
    stance:input.lock_stance===true?(input.authority?.stance??context.stance):undefined,
    mood:input.lock_mood===true?(input.authority?.mood??context.mood):undefined,
  };
  if((authority.stance!==undefined&&!stances.includes(authority.stance))||(authority.mood!==undefined&&!moods.includes(authority.mood)))throw new Error('Invalid host lock');
  return resolveContext(context,{...context,authority,permissions:{wildlife:input.wildlife===true}});
}
