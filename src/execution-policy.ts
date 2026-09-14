import {evaluateRules,requireAllowed,type Decision} from './rules.ts';
export const stances = ['Combat','Hunt','Industry','Trade','Logistics','Explore','Salvage'] as const;
export const moods = ['Relaxed','Cautious','Focused','Opportunistic','Aggressive','Tired'] as const;
export type Stance = typeof stances[number];
export type Mood = typeof moods[number];
export const policyVersion = 'one-job-gross-home-1';
export interface Home {system_id:string; poi_id:string; base_id:string; rationale:string; observed_at:string}
export interface ExecutionContext {
  stance:Stance; mood:Mood; objective:string; home?:Home;
  limits:{max_spend:number; credit_reserve:number; max_ticks:number; retreat_hull_fraction:number; max_gather_cycles:number};
  permissions:{wildlife:boolean}; authority?:{stance?:Stance;mood?:Mood}; policy_version:string;
  policy_decision?:Decision;
  stop_condition:'one_job'|'objective'; return_policy:'home_or_explicit_fallback';
}
export function resolveContext(input:Record<string,any>, previous?:ExecutionContext):ExecutionContext {
  const stance=input.stance??previous?.stance??'Hunt', mood=input.mood??previous?.mood??'Cautious';
  if(!stances.includes(stance)||!moods.includes(mood))throw new Error('Choose a documented stance and mood');
  const stop_condition=input.stop_condition??previous?.stop_condition??'one_job';
  if(!['one_job','objective'].includes(stop_condition))throw new Error('Choose a documented stopping condition');
  const context:ExecutionContext={stance,mood,objective:input.objective??previous?.objective,home:previous?.home,
    limits:{} as ExecutionContext['limits'],
    authority:previous?.authority,permissions:previous?.permissions??{wildlife:false},policy_version:policyVersion,stop_condition,return_policy:'home_or_explicit_fallback'};
  const defaults=evaluateRules({phase:'resolve',context,previous});
  Object.assign(context.limits,Object.fromEntries(Object.entries(defaults.limits).filter(([key])=>['max_spend','credit_reserve','max_ticks','retreat_hull_fraction','max_gather_cycles'].includes(key))));
  const decision=requireAllowed(evaluateRules({phase:'resolve',context,input,previous}));
  Object.assign(context.limits,Object.fromEntries(Object.entries(decision.limits).filter(([key])=>key in context.limits)));
  // Context is cached across resumes; equivalent grants need byte-stable metadata.
  context.policy_decision=evaluateRules({phase:'bounds',context});
  return context;
}

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
