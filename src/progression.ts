import {evaluateRules,requireAllowed} from './rules.ts';
/** Canonical counters only: XP may reset on level-up, so cross-level deltas are unknown. */
export interface SkillCounter { level: number | null; xp: number | null; next_level_xp?: number }
export type SkillSnapshot = Record<string,SkillCounter>;
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function snapshotSkills(state:any):SkillSnapshot {
  const ids=new Set([...Object.keys(state?.skills??{}),...Object.keys(state?.player?.skills??{}),...Object.keys(state?.player?.skill_xp??{})]);
  return Object.fromEntries([...ids].sort().map(id=>{
    const detailed=state?.skills?.[id];
    const level=typeof detailed==='number'?detailed:detailed?.level??state?.player?.skills?.[id];
    const xp=detailed?.xp??state?.player?.skill_xp?.[id];
    return [id,{level:valid(level)?level:null,xp:valid(xp)?xp:null,...(valid(detailed?.next_level_xp)?{next_level_xp:detailed.next_level_xp}:{})}];
  }));
}
export function skillProgress(before:SkillSnapshot,after:SkillSnapshot) {
  return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().flatMap(skill_id=>{
    const first=before[skill_id],last=after[skill_id];
    if(first&&last&&first.level===last.level&&first.xp===last.xp)return [];
    const sameLevel=first?.level!==null&&first?.level!==undefined&&first.level===last?.level;
    const knownXp=sameLevel&&valid(first?.xp)&&valid(last?.xp)&&last.xp>=first.xp;
    return [{skill_id,before:first??null,after:last??null,
      level_gain:valid(first?.level)&&valid(last?.level)?last.level-first.level:null,
      verified_xp_gain:knownXp?last!.xp!-first!.xp!:null,
      xp_note:knownXp?'Verified counter increase at the same level.':'XP gained across level changes or missing/reset counters is unknown.'}];
  });
}
export function productionMarginPolicy(params:{learning_goal?:unknown;max_learning_loss?:unknown;min_profit?:unknown}) {
  const minProfit=Number(params.min_profit??1),loss=Number(params.max_learning_loss??0);
  if(params.learning_goal!==undefined&&typeof params.learning_goal!=='string')throw new Error('learning_goal must be text');
  const goal=typeof params.learning_goal==='string'?params.learning_goal.trim():'';
  const policy_decision=requireAllowed(evaluateRules({phase:'bounds',learning:{goal,loss,minimum:minProfit}}));
  return {policy_decision,mode:goal&&loss>0?'learning':'income',learning_goal:goal||undefined,max_learning_loss:loss,minimum_economic_margin:policy_decision.limits.minimum_economic_margin!,
    allowance_note:goal&&loss>0?'Predicted loss allowance; actual market execution and measured progression are recorded separately.':undefined};
}
