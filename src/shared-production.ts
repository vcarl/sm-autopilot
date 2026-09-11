import type {Job} from './execution-store.ts';
import {details} from './industry.ts';

type Wire=Record<string,any>;
export const productionWaitSeconds=120;

export function productionReceipt(result:unknown):Wire|undefined {
  const value=result as Wire|undefined;
  return value?.production??(value?.partial?productionReceipt(value.partial):undefined);
}

/** Later settlement receipts supersede the same experiment, including across runs. */
export function productionExperiments(jobs:Job[]):Wire[] {
  const latest=new Map<string,Wire>();
  for(const job of jobs) {
    const production=productionReceipt(job.result);
    if(production?.experiment_id)latest.set(production.experiment_id,production);
  }
  return structuredClone([...latest.values()]);
}

export function unfinishedProduction(jobs:Job[]) {
  return productionExperiments(jobs).filter(row=>!['complete','aborted'].includes(row.status)||row.pending_action||row.accounting_unverified);
}

/** The command boundary can retain acceptance even when refresh/accounting throws. */
export function retainProductionAcceptance(job:Job) {
  const production=productionReceipt(job.result);
  if(!production?.pending_action)return;
  const pending=production.pending_action;
  const entry=job.actions.findLast(entry=>entry.action===pending.action&&JSON.stringify(entry.params)===JSON.stringify(pending.params));
  if(entry?.accepted_result===undefined)return;
  const receipt=details(entry.accepted_result);
  production.last_receipt=receipt;
  if(pending.action==='spacemolt/craft'&&receipt.job_id)production.job_id=receipt.job_id;
  production.status='needs_reconciliation';
  // Acceptance is not settlement or complete accounting; retain the pending action.
}
