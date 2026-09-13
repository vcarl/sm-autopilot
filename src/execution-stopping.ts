import type {Job} from './execution-store.ts';
import {evaluateRules} from './rules.ts';

export function terminalDecision(job:Job) {
  const result=job.result as {sortie?:{observations?:{assessments?:{decision?:string}[]}[]}}|undefined;
  return evaluateRules({phase:'terminal',terminal:{status:job.status,action:job.action,error:job.error,
    eligibleQuarry:Boolean(result?.sortie?.observations?.some(observation=>observation.assessments?.some(assessment=>assessment.decision==='engage')))}});
}
export function terminalStoppingReason(job:Job):string|undefined {
  const decision=terminalDecision(job);
  return decision.exit==='finish_job'?undefined:decision.reasons.map(reason=>reason.text).join('; ');
}
