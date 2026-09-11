import type {Job} from './execution-store.ts';
import {details,executeIndustry,type IndustryContext,type IndustryCommand} from './industry.ts';
import type {Account} from '@spacemolt/lib';
import {getIndustryCatalog} from './persistent-catalog.ts';

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


/** Shared assessment names only actions exposed in the current tool catalog. */
export async function assessProduction(params:Wire,account:Account,command:IndustryCommand,context:IndustryContext) {
  context.catalog??=getIndustryCatalog();
  const catalog=await context.catalog;
  const recipe=params.recipe_id&&catalog.cache?.recipe(params.recipe_id);
  const unknown=Boolean(params.recipe_id&&catalog.cache&&(!recipe||!recipe.outputs.length));
  if(params.recipe_id&&!unknown)return executeIndustry('quote',params,account,command,context);
  const discovery=await executeIndustry('discover',{},account,command,context) as Wire;
  const available=Array.isArray(discovery.income_candidates)&&discovery.income_candidates.length>0;
  const assessment={...discovery,decision:available?'candidates_available':'no_profitable_candidate',
    guidance:available?'Choose an observed recipe_id and source from income_candidates; use assess with that recipe_id for its current quote.':
      'No profitable candidate was established by this bounded discovery. Inspect the observed blockers; do not guess recipe IDs. Return to base and report the blocker if no authorized alternative remains.'};
  if(!unknown)return assessment;
  return {status:'blocked',requested_recipe_id:params.recipe_id,
    reason:'Requested recipe_id is absent from the available catalog. Use assess without recipe_id to discover observed candidates and blockers.',
    next_action:{action:'assess',params:{}},discovery:assessment};
}
