import type {Job} from './execution-store.ts';

/** A Hunt objective permits one scout precursor, then one principal attempt. */
export function admissionBlocker(action:string,admitted:Job[]):string|undefined {
  if(action==='track'&&admitted.some(job=>job.action==='track'))return 'one_job scouting allowance exhausted; no second tracking sortie';
  if(['hunt','gather'].includes(action)&&admitted.some(job=>['hunt','gather'].includes(job.action)))return 'one_job productive attempt already admitted';
}

export function terminalStoppingReason(job:Job):string|undefined {
  if(job.context.stop_condition!=='one_job'||job.status==='running')return;
  if(job.status==='needs_reconciliation')return 'Uncertain job suspended this operating run';
  if(job.status==='blocked')return `Blocked ${job.action} job: ${job.error??'see the job receipt'}`;
  if(['hunt','gather'].includes(job.action))return `one_job ${job.action} attempt finished`;
  if(job.action==='track') {
    const result=job.result as {sortie?:{observations?:{assessments?:{decision?:string}[]}[]}}|undefined;
    if(!result?.sortie?.observations?.some(observation=>observation.assessments?.some(assessment=>assessment.decision==='engage')))return 'one_job scouting found no eligible quarry';
  }
}
