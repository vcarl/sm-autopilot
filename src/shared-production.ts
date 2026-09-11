import type {Job} from './execution-store.ts';
import {details,executeIndustry,type IndustryContext,type IndustryCommand} from './industry.ts';
import type {Account} from '@spacemolt/lib';
import {getIndustryCatalog} from './persistent-catalog.ts';
import {isDeepStrictEqual} from 'node:util';
import {commandSpend} from './spending.ts';

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

/** Resolve only a recorded craft acceptance; sourcing and output custody remain separate. */
export function reconcileProductionAcceptance(job:Job) {
  const production=productionReceipt(job.result);
  const pending=production?.pending_action??production?.accounting_unverified;
  if(!production||pending?.action!=='spacemolt/craft'||!production.job_id)return;
  const matches=job.actions.filter(entry=>entry.action===pending.action&&isDeepStrictEqual(entry.params,pending.params)&&entry.accepted_result!==undefined);
  if(matches.length!==1)return;
  const entry=matches[0]!,receipt=details(entry.accepted_result);
  if(receipt.kind!=='job'||receipt.job_id!==production.job_id)return;
  const cost=commandSpend(entry.action,entry.accepted_result,entry.params);
  if(cost===null||!Number.isFinite(production.spent)||production.spent<0)return;
  if(production.accounting_unverified&&(!isDeepStrictEqual(production.accounting_unverified.params,pending.params)||production.accounting_unverified.action!==pending.action))return;
  production.spent+=cost;
  production.last_receipt=receipt;
  delete production.pending_action;
  delete production.accounting_unverified;
  delete production.reason;
  production.status='pending';
}


/** Shared assessment names only actions exposed in the current tool catalog. */
export async function assessProduction(params:Wire,account:Account,command:IndustryCommand,context:IndustryContext) {
  if(params.output_search!==undefined&&(params.disposition!=='retain'||params.recipe_id||typeof params.output_search!=='string'||params.output_search.trim().length<1||params.output_search.length>80))throw new Error('output_search requires retain disposition, no recipe_id, and 1..80 characters');
  if(params.disposition==='retain'&&!params.recipe_id&&params.output_search===undefined)return {status:'blocked',reason:'Supply output_search text to discover observed recipes for retained own-use production'};
  context.catalog??=getIndustryCatalog();
  const catalog=await context.catalog;
  if(params.disposition==='retain'&&!params.recipe_id) {
    const metadata={freshness:catalog.freshness,fetchedAt:catalog.fetchedAt,retryAt:catalog.retryAt,reason:catalog.reason};
    if(!catalog.cache)return {status:'blocked',disposition:'retain',catalog:metadata,candidates:[],reason:'Catalog unavailable; wait for its retry before choosing a recipe'};
    const search=params.output_search.trim().toLocaleLowerCase('en-US');
    const items=new Map(catalog.cache.items.map(item=>[item.id,item]));
    const matches=catalog.cache.recipes.filter(recipe=>!recipe.hidden&&recipe.outputs.some(output=>
      output.item_id.toLocaleLowerCase('en-US').includes(search)||items.get(output.item_id)?.name?.toLocaleLowerCase('en-US').includes(search)));
    const candidates=matches.slice(0,6).map(recipe=>({recipe_id:recipe.id,name:recipe.name,disposition:'retain',
      inputs:recipe.inputs.map(row=>({item_id:row.item_id,quantity:row.quantity})),outputs:recipe.outputs.map(row=>({item_id:row.item_id,name:items.get(row.item_id)?.name,quantity:row.quantity})),
      readiness:'fresh_quote_required',estimated_spend:null}));
    return {disposition:'retain',output_search:params.output_search,catalog:metadata,candidates,more_matches:matches.length>candidates.length,
      decision:candidates.length?'candidates_available':'no_matching_recipe',
      guidance:'These catalog recipes are observations, not current capability or price quotes. Assess a returned recipe_id with disposition retain and source inventory or buy before producing. Output stays in personal storage; no sale earnings are assumed.'};
  }
  const recipe=params.recipe_id&&catalog.cache?.recipe(params.recipe_id);
  const unknown=Boolean(params.recipe_id&&catalog.cache&&(!recipe||!recipe.outputs.length));
  if(params.recipe_id&&!unknown) {
    const quote=await executeIndustry('quote',params,account,command,context) as Wire;
    if(!quote.evaluation)return quote;
    return {...quote,guidance:'This is a quote only; no production job or experiment_id exists yet. evaluation.id is a comparison key, never an experiment_id. Start a new job with recipe_id, source, disposition and quantity. Only a pending execution receipt supplies an experiment_id for later settlement.',
      ...(quote.evaluation.feasible?{next_action:{action:'produce',params:{recipe_id:quote.recipe_id,source:quote.source,disposition:quote.disposition,quantity:quote.quantity}}}:{})};
  }
  if(unknown&&params.disposition==='retain')return {status:'blocked',disposition:'retain',requested_recipe_id:params.recipe_id,reason:'Requested recipe is absent from the catalog; assess disposition retain with output_search to discover observed candidates'};
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
