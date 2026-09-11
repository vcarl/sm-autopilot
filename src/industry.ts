import type { Account } from '@spacemolt/lib';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { snapshotSkills, skillProgress, productionMarginPolicy } from './progression.ts';
import { evaluateLoop, quoteDepth } from './economics.ts';
import { ensureReadiness } from './readiness.ts';
import { recommendStrategy } from './experiment-strategy.ts';
import { industryLocations } from './locations.ts';
import { discoverMarket } from './discovery.ts';
import { surveyMarkets } from './survey.ts';
import { getIndustryCatalog } from './persistent-catalog.ts';
import { screenCatalog } from './catalog-screen.ts';
import { stationSnapshot } from './station-snapshot.ts';
import type {ServiceClock} from './servicing.ts';
import {requireCommandSpend} from './spending.ts';

type Wire = Record<string, any>;
export type IndustryCommand = (action:string, params?:Record<string,unknown>)=>Promise<unknown>;
export interface IndustryControls extends ServiceClock {checkpoint?:()=>Promise<void>}
export interface IndustryContext extends IndustryControls {
  snapshot?:ReturnType<typeof stationSnapshot>;
  catalog?:ReturnType<typeof getIndustryCatalog>;
  record?:(event:Wire)=>void;
  existing_experiments?:Wire[];
}
const ledger = new URL('../runtime/industry.jsonl',import.meta.url);
export const details = (reply:any):Wire => reply?.structuredContent ?? reply?.delta?.details ?? reply ?? {};
const record = (event:Wire) => appendFileSync(ledger, JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});
const records = ():Wire[] => existsSync(ledger) ? readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)) : [];
const experiments = () => [...new Map(records().filter(r=>r.experiment_id).map(r=>[r.experiment_id,r])).values()];
const amount = (items:any[],id:string) => items.filter(x=>x.item_id===id).reduce((n,x)=>n+x.quantity,0);
const bounded = (n:unknown,fallback:number,max:number) => {const v=Number(n??fallback);if(!Number.isInteger(v)||v<1||v>max)throw new Error(`Expected integer 1..${max}`);return v;};


/** Aggregate recipe requirements so duplicate entries cannot overdraw carried stock. */
export function inventoryInputPlan(inputs:Wire[],storage:Wire[],cargo:Wire[]) {
  const required=new Map<string,number>();
  for(const item of inputs){if(typeof item.item_id!=='string'||!Number.isFinite(item.quantity)||item.quantity<0)throw new Error('Invalid recipe input quantity');required.set(item.item_id,(required.get(item.item_id)??0)+item.quantity);}
  return [...required].map(([item_id,quantity])=>{
    const stored=amount(storage,item_id),carried=amount(cargo,item_id),shortfall=Math.max(0,quantity-stored);
    return {item_id,required:quantity,stored,carried,available:stored+carried,deposit_from_cargo:Math.min(carried,shortfall),missing:Math.max(0,shortfall-carried)};
  });
}

export function sameQuantities(left:Wire[],right:Wire[]):boolean {
  const aggregate=(items:Wire[])=>{const map=new Map<string,number>();for(const i of items){if(typeof i.item_id!=='string'||!Number.isFinite(i.quantity)||i.quantity<0)return null;map.set(i.item_id,(map.get(i.item_id)??0)+i.quantity);}return map;};
  const a=aggregate(left),b=aggregate(right);
  return !!a&&!!b&&a.size===b.size&&[...a].every(([id,n])=>b.get(id)===n);
}
export function craftRouting(quote:Wire):Wire {
  return quote.venue_type==='workshop'?{preset:'workshop'}:{preset:'cheap',facility_id:quote.facility_id};
}
export function viableSpend(values:{spent:number;remaining:number;labor:number;revenue:number;opportunity:number;wallet:number;reserve:number;maxSpend:number;minProfit:number}):boolean {
  const {spent,remaining,labor,revenue,opportunity,wallet,reserve,maxSpend,minProfit}=values;
  return Object.values(values).every(Number.isFinite)&&spent+remaining+labor<=maxSpend&&wallet-remaining-labor>=reserve&&revenue-spent-remaining-labor-opportunity>=minProfit;
}

const pick=(value:Wire,keys:string[]):Wire=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
const itemAmounts=(items:Wire[]|undefined)=>items?.map(item=>pick(item,['item_id','quantity']));
const compactEvaluation=(row:Wire)=>({
  ...pick(row,['feasible','blockers','unknowns','expectedProfit','processingAdvantage','purchaseCredits','saleCredits','rawSaleCredits','seconds','profitPerSecond']),
  inputs:row.inputs?.map((item:Wire)=>({...pick(item,['item_id','quantity','source']),...(item.purchase?{buy_credits:item.purchase.credits,unfilled:item.purchase.unfilled}:{})})),
  outputs:row.outputs?.map((item:Wire)=>({...pick(item,['item_id','quantity']),...(item.sale?{sale_credits:item.sale.credits,unsold:item.sale.unfilled}:{})})),
  costs:row.costs,
});
const compactCandidate=(row:Wire)=>({...pick(row,['id','recipe_id','source','venue','gross_margin','blockers','unknowns','inputs_needed','raw_sale_benchmark','potential_conversion_margin','output_sale_credits','benchmark_note']),inputs:itemAmounts(row.inputs),outputs:itemAmounts(row.outputs)});
const compactQuote=(quote:Wire)=>({
  ...pick(quote,['station','catalog','recipe_id','source','quantity','market_tick','output_scaling','assumptions','skill_context','input_locations']),
  evaluation:quote.evaluation?compactEvaluation(quote.evaluation):undefined,
  craft:quote.craft?pick(quote.craft,['kind','runs','credits_total','facility_id','venue','have_inputs','have_capacity','have_credits','est_completion_tick']):undefined,
  inputQuotes:quote.inputQuotes?.map((q:Wire)=>pick(q,['item_id','quantity_requested','available','unfilled','subtotal','sales_tax','total_cost'])),
});
const compactExperiment=(row:Wire)=>({
  ...pick(row,['experiment_id','key','station','status','reason','job_id','spent','earned','seconds','realized_credit_delta','incremental_profit_after_input_opportunity','prediction_error','budget_breach','retained_assets_note','pending_action','skill_context','skill_progress','learning_policy']),
  ...pick(row.quote??{},['recipe_id','source','quantity']),
  expected_profit:row.quote?.evaluation?.expectedProfit,
  expected_processing_advantage:row.quote?.evaluation?.processingAdvantage,
  outputs:row.quote?.evaluation?.outputs?.map((output:Wire)=>({item_id:output.item_id,planned:output.quantity,sold:row.sold?.[output.item_id]??0,
    in_cargo:Math.max(0,(row.withdrawn?.[output.item_id]??0)-(row.sold?.[output.item_id]??0)),
    not_withdrawn:Math.max(0,output.quantity-(row.withdrawn?.[output.item_id]??0))})),
  credits:row.after?.credits,
});

/** Only the model-facing view is compressed; all transaction evidence stays in the ledger. */
export function compactIndustryReply(action:string,result:any):unknown {
  if(action==='recipes'&&result?.recipes)return {catalog:result.catalog,recipes:compactIndustryReply('recipes',result.recipes)};
  if(action==='recipes'&&Array.isArray(result))return result.map(recipe=>({
    ...pick(recipe,['id','name','category','facility_only','crafting_time','required_skills','skills','skill_requirements','required_facility','package_operation']),
    inputs:itemAmounts(recipe.inputs),outputs:itemAmounts(recipe.outputs),
  }));
  if(!result||typeof result!=='object')return result;
  if(result.event==='experiment')return compactExperiment(result);
  if(result.quote)return {...pick(result,['status','reason','experiment_id','job_id','status_existing']),quote:compactQuote(result.quote)};
  if(action==='quote'&&result.evaluation)return compactQuote(result);
  if(action==='screen'&&result.candidates)return {...pick(result,['station','catalog','catalog_version','market_tick','warning','evaluated_recipe_count']),candidate_count:result.candidates.length,exploration_candidate_count:result.exploration_candidates?.length,candidates:result.candidates.slice(0,result.limit??15).map(compactCandidate),exploration_candidates:result.exploration_candidates?.slice(0,result.limit??15).map(compactCandidate)};
  if(action==='history')return {...result,observations:result.observations?.map((observation:Wire)=>({...pick(observation,['at','station']),candidates:observation.candidates?.slice(0,5).map(compactCandidate),candidate_count:observation.candidates?.length,exploration_candidates:observation.exploration_candidates?.slice(0,5).map(compactCandidate),exploration_candidate_count:observation.exploration_candidates?.length}))};
  if(action==='recommend')return {...pick(result,['budget','limitations','current_skill_context']),learningCandidates:result.learningCandidates?.slice(0,15),repeatCandidates:result.repeatCandidates,explorationCandidates:result.explorationCandidates?.slice(0,15),explorationCandidateCount:result.explorationCandidates?.length,
    discoveryCandidates:result.discoveryCandidates?.slice(0,15),discoveryCandidateCount:result.discoveryCandidates?.length,
    nextActions:result.nextActions?.slice(0,20)};
  if(result.craft)return {...pick(result,['status','reason']),craft:pick(result.craft,['kind','message','runs','credits_total','have_inputs','have_capacity','have_credits'])};
  return result;
}

export async function industry(action:string, params:Wire, account:Account, command:IndustryCommand):Promise<unknown> {
  return compactIndustryReply(action,await executeIndustry(action,params,account,command));
}

export async function executeIndustry(action:string, params:Wire, account:Account, command:IndustryCommand, context:IndustryContext={}):Promise<unknown> {
  const observe=context.record??record;
  const existing=()=>context.existing_experiments??experiments();
  const now=context.now??Date.now;
  const credits=()=>{if(account.credits===undefined)throw new Error('Canonical credits unavailable');return account.credits;};
  const station = account.location?.docked_at;
  if(action==='history'||action==='recommend') {
    const rows=context.existing_experiments??records();
    const miningFile=new URL('../runtime/mining-experiments.jsonl',import.meta.url);
    const miningRows=existsSync(miningFile)?readFileSync(miningFile,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.event==='mining_experiment'):[];
    const mining=[...new Map(miningRows.map(r=>[r.id,r])).values()].slice(-20);
    if(action==='recommend')return recommendStrategy([...rows,...miningRows],credits(),{creditReserve:Number(params.credit_reserve??150000),initialExplorationBudget:Number(params.exploration_budget??1000),reinvestFraction:Number(params.reinvest_fraction??0.25),maxExperimentSpend:Number(params.max_spend??1000),nowMs:now(),maxLearningLoss:Number(params.max_learning_loss??0),currentSkillContext:{skills:snapshotSkills(account.state)}});
    return {mining_experiments:mining.map(r=>({id:r.id,at:r.at,status:r.status,measurement_note:r.measurement_note,skill_context:r.skill_context,skill_progress:r.skill_progress,yields:r.yields,retained:r.retained,unsold:r.unsold,seconds:r.seconds,hull_liability_units:r.hull_liability_units,source_measurements:r.source_measurements,origin_station:r.origin_station,poi_id:r.poi_id,cash_delta:r.cash_delta,realized_profit:r.realized_profit,fuel_liability_units:r.fuel_liability_units})),experiments:existing().slice(-30).map(r=>({experiment_id:r.experiment_id,key:r.key,station:r.station,status:r.status,reason:r.reason,job_id:r.job_id,recipe_id:r.quote?.recipe_id,source:r.quote?.source,quantity:r.quote?.quantity,expected_profit:r.quote?.evaluation?.expectedProfit,expected_processing_advantage:r.quote?.evaluation?.processingAdvantage,realized_credit_delta:r.realized_credit_delta,incremental_profit_after_input_opportunity:r.incremental_profit_after_input_opportunity,spent:r.spent,earned:r.earned,seconds:r.seconds,skill_context:r.skill_context,skill_progress:r.skill_progress,learning_policy:r.learning_policy})),observations:rows.filter(r=>r.event==='screen').map(r=>({at:r.at,station:r.station,candidates:r.candidates,exploration_candidates:r.exploration_candidates})).slice(-10),guidance:'Revalidate stale prices. Exploit positive realized loops to replenish exploration funds; cap each unfamiliar experiment by max_spend and maintain the credit reserve.'};
  }
  if(action==='locations')return industryLocations(account.location?.system_id,params);
  if(!station) return {status:'blocked',reason:'Dock at the target station first; location is an experiment variable.'};
  if(action==='discover')return discoverMarket(params,{screen:async p=>await executeIndustry('screen',p,account,command,context) as Wire,quote:async p=>await executeIndustry('quote',p,account,command,context) as Wire,record:observe});
  if(action==='survey')return surveyMarkets({...params,station_ids:params.station_ids},account,command,()=>executeIndustry('discover',{},account,command,{...context,snapshot:undefined}));
  if(action==='prepare_mining')return ensureReadiness(account,command,{requireMining:true,minFreeCargo:Number(params.min_free_cargo??20),minFuel:Number(params.min_fuel??10),creditReserve:Number(params.credit_reserve??150000)},params.execute===true);
  if(action==='settle') {
    const experiment=existing().find(e=>params.experiment_id ? e.experiment_id===params.experiment_id : params.job_id && e.job_id===params.job_id);
    if(!experiment)return {status:'blocked',reason:'Unknown experiment_id/job_id; consult history.'};
    return settleExperiment(experiment,params,account,command,observe,context);
  }
  context.catalog??=getIndustryCatalog();
  const catalogState=await context.catalog;
  const cache=catalogState.cache;
  const catalogMetadata={freshness:catalogState.freshness,fetchedAt:catalogState.fetchedAt,retryAt:catalogState.retryAt,reason:catalogState.reason};
  if(!cache)return {status:'blocked',reason:'Catalog unavailable; wait for catalog retryAt rather than switching tools.',catalog:catalogMetadata};
  if(action==='produce' && catalogState.freshness!=='fresh')return {status:'blocked',reason:'Catalog is stale; production waits for successful catalog revalidation.',catalog:catalogMetadata};
  if(action==='recipes') return {catalog:catalogMetadata,recipes:cache.recipes.filter(r=>!r.hidden && (!params.item_id||[...r.inputs,...r.outputs].some(i=>i.item_id===params.item_id))).slice(0,bounded(params.limit,30,100))};
  context.snapshot??=stationSnapshot(command,action==='screen');
  const snapshot=await context.snapshot;
  const market=snapshot.market;
  const books=new Map<string,Wire>((market.items??[]).map((i:Wire)=>[i.item_id,i]));
  const storage=snapshot.storage;
  const stock=storage.items??[];
  if(action==='screen') {
    const facilities=snapshot.facilities;
    const {candidates,exploration_candidates,evaluated_recipe_count}=screenCatalog({recipes:cache.recipes,station,market,storage,cargo:account.cargo??[],facilities,skills:snapshotSkills(account.state)});
    const limit=bounded(params.limit,15,50);
    observe({event:'screen',station,catalog_version:cache.version,market_tick:market.current_tick,candidates,exploration_candidates,market,storage,cargo:structuredClone(account.cargo),facilities});
    return {station,limit,catalog:catalogMetadata,catalog_version:cache.version,market_tick:market.current_tick,observation_key:createHash('sha256').update(JSON.stringify([cache.version,market.items,storage,account.cargo,snapshotSkills(account.state),facilities])).digest('hex'),evaluated_recipe_count,candidates,exploration_candidates,warning:'Screening margins exclude unknown labor and taxes. Quote before executing. Inventory is not free: compare processingAdvantage against raw sale value.'};
  }
  const recipe=cache.recipe(String(params.recipe_id));
  if(!recipe||!recipe.outputs.length)return {status:'blocked',reason:'Unknown recipe; discover with recipes or screen.'};
  const quantity=bounded(params.quantity,recipe.outputs[0]!.quantity,1000);
  if(params.source!==undefined && !['buy','inventory'].includes(params.source))return {status:'blocked',reason:'source must be buy or inventory'};
  const source=params.source==='buy'?'buy':'inventory';
  if(action==='produce') {
    const unfinished=existing().find(e=>e.station===station && !['complete','aborted'].includes(e.status));
    if(unfinished)return {status:'blocked',reason:'Settle the existing experiment before producing again.',experiment_id:unfinished.experiment_id,job_id:unfinished.job_id,status_existing:unfinished.status};
  }
  const craft=details(await command('spacemolt/craft',{id:recipe.id,quantity,dry_run:true,preset:'cheap'}));
  if(craft.kind!=='quote')return {status:'blocked',reason:'Server did not return a crafting quote',craft};
  if(!Array.isArray(craft.cost?.inputs)||!Number.isFinite(craft.credits_total))return {status:'blocked',reason:'Incomplete crafting quote',craft};
  let purchaseTax=0;
  const inputQuotes:Wire[]=[];
  if(source==='buy')for(const i of craft.cost.inputs) {
    const q=details(await command('spacemolt_market/estimate_purchase',{item_id:i.item_id,quantity:i.quantity}));
    if(!Number.isFinite(q.total_cost)||!Number.isFinite(q.sales_tax)||!Array.isArray(q.fills))return {status:'blocked',reason:'Incomplete purchase estimate',estimate:q};
    inputQuotes.push({...q,item_id:i.item_id});purchaseTax+=q.sales_tax;
  }
  if(!Array.isArray(craft.produces)||!craft.produces.length)return {status:'blocked',reason:'Craft quote omitted outputs',craft};
  const quotedRecipe={id:recipe.id,inputs:craft.cost.inputs,outputs:craft.produces};
  const evaluation=evaluateLoop({id:`${station}/${recipe.id}/${source}`,recipe:quotedRecipe,batches:1,
    inputs:quotedRecipe.inputs.map((i:Wire)=>({item_id:i.item_id,source,asks:source==='buy'?inputQuotes.find(q=>q.item_id===i.item_id)?.fills:books.get(i.item_id)?.sell_orders??[],rawSaleBids:books.get(i.item_id)?.buy_orders??[],availableQuantity:amount(stock,i.item_id)+amount(account.cargo??[],i.item_id)})),
    outputMarkets:quotedRecipe.outputs.map((i:Wire)=>({item_id:i.item_id,bids:books.get(i.item_id)?.buy_orders??[]})),
    costs:{travelCredits:0,laborCredits:craft.credits_total,taxCredits:purchaseTax,otherCredits:0,travelSeconds:0,craftSeconds:Math.max(1,Math.ceil(craft.effective_time_per_run*craft.runs))*10,otherSeconds:30,rawSaleCredits:0}});
  const currentSkills=snapshotSkills(account.state);
  const required=(recipe as Wire).required_skills??{};
  const skill_context={skills:Object.fromEntries(Object.entries(currentSkills).filter(([id])=>['crafting','refining','trading',...Object.keys(required)].includes(id))),required_skills:required};
  const quote={catalog:catalogMetadata,skill_context,input_locations:inventoryInputPlan(craft.cost.inputs,stock,account.cargo??[]),station,recipe_id:recipe.id,source,quantity,evaluation,craft,inputQuotes,market_tick:market.current_tick,output_scaling:craft.runs>1?'unverified: produces may be per run; quote conservatively uses it once':'single run',assumptions:['Immediate sale to observed buy orders; future fills can change.','Same-station processing; travel is zero here.','Seller proceeds use book prices; compare actual receipts.']};
  observe({event:'quote',...quote});
  if(action==='quote')return quote;
  if(action!=='produce')return {status:'blocked',reason:'Unknown industry action'};
  if(craft.runs>1)return {status:'blocked',reason:'Multi-run output scaling is not yet verified; use a single production run.',quote};
  const reserve=Number(params.credit_reserve??150000),maxSpend=Number(params.max_spend??1000);
  let learningPolicy;
  try{learningPolicy=productionMarginPolicy(params);}catch(error){return {status:'blocked',reason:error instanceof Error?error.message:String(error)};}
  const minProfit=learningPolicy.minimum_economic_margin;
  if(![reserve,maxSpend].every(Number.isFinite)||reserve<0||maxSpend<0)return {status:'blocked',reason:'Invalid budget'};
  if(craft.have_capacity===false||craft.have_credits===false)return {status:'blocked',reason:'Craft capacity or credits unavailable',quote};
  const plannedSpend=inputQuotes.reduce((n,q)=>n+q.total_cost,0)+craft.credits_total;
  const advantage=source==='inventory'?evaluation.processingAdvantage:evaluation.expectedProfit;
  if(!evaluation.feasible||advantage===null||advantage<minProfit||plannedSpend>maxSpend||credits()-plannedSpend<reserve)return {status:'blocked',reason:'Quote fails feasibility, profit or budget requirement',quote};
  const before={credits:credits(),cargo:structuredClone(account.cargo),storage:stock,skills:snapshotSkills(account.state)};
  const experiment:Wire={event:'experiment',experiment_id:randomUUID(),station,key:evaluation.id,quote,before,skill_context,learning_policy:learningPolicy,skill_progress:[],started:now(),status:'purchasing',spent:0,earned:0,sales:[],sold:{},withdrawn:{}};
  observe(experiment);
  const revalidateProfit=async(remaining:number,labor:number)=>{
    const current=details(await command('spacemolt_market/view_market',{}));
    if(!Array.isArray(current.items))throw new Error('Current output market unavailable');
    const currentBooks=new Map<string,Wire>(current.items.map((i:Wire)=>[i.item_id,i]));
    let revenue=0,opportunity=0;
    for(const output of evaluation.outputs){const fill=quoteDepth(currentBooks.get(output.item_id)?.buy_orders??[],output.quantity,'sell');if(!fill.complete)throw new Error('Output demand no longer covers production');revenue+=fill.credits;}
    if(source==='inventory')for(const input of evaluation.inputs)opportunity+=quoteDepth(currentBooks.get(input.item_id)?.buy_orders??[],input.quantity,'sell').credits;
    if(!viableSpend({spent:experiment.spent,remaining,labor,revenue,opportunity,wallet:credits(),reserve,maxSpend,minProfit}))throw new Error('Current prices fail profit or remaining budget requirement');
    return opportunity;
  };
  try {
    const purchases=source==='buy'?craft.cost.inputs:[];
    for(let index=0;index<purchases.length;index++) {
      const i=purchases[index];
      const q=details(await command('spacemolt_market/estimate_purchase',{item_id:i.item_id,quantity:i.quantity}));
      if(q.unfilled!==0||!Number.isFinite(q.total_cost)||experiment.spent+q.total_cost+craft.credits_total>maxSpend||credits()-q.total_cost-craft.credits_total<reserve)throw new Error('Fresh purchase estimate fails depth or remaining budget');
      let remaining=q.total_cost;
      for(const later of purchases.slice(index+1)){const estimate=details(await command('spacemolt_market/estimate_purchase',{item_id:later.item_id,quantity:later.quantity}));if(estimate.unfilled!==0||!Number.isFinite(estimate.total_cost))throw new Error('Remaining input supply unavailable');remaining+=estimate.total_cost;}
      await revalidateProfit(remaining,craft.credits_total);
      const receipt=await experimentCommand(experiment,command,'spacemolt/buy',{id:i.item_id,quantity:i.quantity,deliver_to:'storage',auto_list:false},account,observe,context);
      if(receipt.unfilled>0||receipt.delivered_to_storage!==i.quantity)throw new Error('Input purchase did not fully fill into storage; existing inventory must not cover it');
      if(experiment.spent+craft.credits_total>maxSpend||credits()-craft.credits_total<reserve)throw new Error('Actual purchase exceeds remaining budget; no further spending');
    }
    if(source==='inventory') {
      const currentStorage=details(await command('spacemolt_storage/view',{})).items;
      if(!Array.isArray(currentStorage))throw new Error('Storage unavailable before input preparation');
      const plan=inventoryInputPlan(craft.cost.inputs,currentStorage,account.cargo??[]);
      if(plan.some(input=>input.missing>0))throw new Error('Owned recipe inputs no longer available in storage and cargo');
      for(const input of plan.filter(input=>input.deposit_from_cargo>0)) {
        const carriedBefore=amount(account.cargo??[],input.item_id);
        await experimentCommand(experiment,command,'spacemolt_storage/deposit',{item_id:input.item_id,quantity:input.deposit_from_cargo},account,observe,context);
        const verified=details(await command('spacemolt_storage/view',{})).items;
        if(!Array.isArray(verified)||amount(verified,input.item_id)-input.stored!==input.deposit_from_cargo||carriedBefore-amount(account.cargo??[],input.item_id)!==input.deposit_from_cargo)throw new Error('Recipe input deposit not verified in personal storage and cargo');
      }
    }
    const updated=details(await command('spacemolt_storage/view',{})).items;
    if(!Array.isArray(updated)||craft.cost.inputs.some((i:Wire)=>amount(updated,i.item_id)<i.quantity))throw new Error('Craft inputs not verified in storage');
    const fresh=details(await command('spacemolt/craft',{id:recipe.id,quantity,dry_run:true,...craftRouting(craft)}));
    if(fresh.kind!=='quote'||fresh.have_inputs!==true||fresh.have_capacity===false||fresh.have_credits===false||!Number.isFinite(fresh.credits_total)||fresh.credits_total>craft.credits_total||fresh.runs!==craft.runs||!Array.isArray(fresh.cost?.inputs)||!Array.isArray(fresh.produces)||!sameQuantities(fresh.cost.inputs,craft.cost.inputs)||!sameQuantities(fresh.produces,craft.produces))throw new Error('Craft quote changed or is not ready');
    experiment.input_opportunity_at_enqueue=await revalidateProfit(0,fresh.credits_total);
    const job=await experimentCommand(experiment,command,'spacemolt/craft',{id:recipe.id,quantity,...craftRouting(craft)},account,observe,context);
    if(!job.job_id)throw new Error('Craft returned no job id; inspect queue before any new production');
    experiment.job_id=job.job_id;experiment.status='pending';observe(experiment);
    if(experiment.spent>maxSpend||credits()<reserve) {experiment.budget_breach=true;observe(experiment);}
    return settleExperiment(experiment,params,account,command,observe,context);
  } catch(error) {
    experiment.status=experiment.pending_action||experiment.accounting_unverified?'needs_reconciliation':experiment.job_id?'pending':'aborted';
    if(experiment.status==='aborted'){experiment.realized_credit_delta=experiment.earned-experiment.spent;experiment.incremental_profit_after_input_opportunity=experiment.realized_credit_delta;experiment.retained_assets_note='Any purchased inputs remain in storage. Unliquidated assets are not credited to the exploration fund.';}
    experiment.reason=error instanceof Error?error.message:String(error);observe(experiment);return experiment;
  }
}

async function experimentCommand(experiment:Wire,command:IndustryCommand,action:string,params:Wire,account:Account,save:(event:Wire)=>void=record,controls:IndustryControls={}):Promise<Wire> {
  await controls.checkpoint?.();
  experiment.pending_action={action,params};save(experiment);
  const receipt=details(await command(action,params));
  // Retain acceptance evidence before validating its quantities or accounting.
  experiment.last_receipt=receipt;
  if(action==='spacemolt/craft'&&receipt.job_id)experiment.job_id=receipt.job_id;
  save(experiment);
  if(action==='spacemolt_storage/deposit'){experiment.deposited??={};experiment.deposited[params.item_id]=(experiment.deposited[params.item_id]??0)+params.quantity;}
  if(action==='spacemolt_storage/withdraw')experiment.withdrawn[params.item_id]=(experiment.withdrawn[params.item_id]??0)+params.quantity;
  if(action==='spacemolt/sell') {
    if(!Number.isInteger(receipt.quantity_sold)||receipt.quantity_sold<0||receipt.quantity_sold>params.quantity)throw new Error('Invalid sale receipt');
    experiment.sales.push(receipt);experiment.sold[params.id]=(experiment.sold[params.id]??0)+receipt.quantity_sold;
  }
  if(action==='spacemolt/craft') {if(!receipt.job_id)throw new Error('Craft response missing job id; reconcile queue before retry');experiment.job_id=receipt.job_id;}
  experiment.skills_after=snapshotSkills(account.state);
  experiment.skill_progress=skillProgress(experiment.before.skills??{},experiment.skills_after);
  delete experiment.pending_action;
  try {
    experiment.spent+=requireCommandSpend(action,receipt,params);
    if(action==='spacemolt/sell') {
      if(typeof receipt.total_earned!=='number'||!Number.isFinite(receipt.total_earned)||receipt.total_earned<0)throw new Error('Accepted sale omitted authoritative total_earned');
      experiment.earned+=receipt.total_earned;
    }
  } catch(error) {
    experiment.accounting_unverified={action,params,reason:error instanceof Error?error.message:String(error)};
    save(experiment);throw error;
  }
  save(experiment);
  await controls.checkpoint?.();
  return receipt;
}

export async function settleExperiment(experiment:Wire,params:Wire,account:Account,command:IndustryCommand,save:(event:Wire)=>void=record,controls:IndustryControls={}):Promise<Wire> {
  if(experiment.station!==account.location?.docked_at)return {status:'blocked',reason:'Return to experiment station',station:experiment.station};
  if(['complete','aborted'].includes(experiment.status))return experiment;
  if(experiment.accounting_unverified)return {...experiment,status:'needs_reconciliation',reason:'Accepted action has unresolved monetary evidence; automatic settlement is disabled.'};
  if(experiment.pending_action||!experiment.job_id)return {...experiment,status:'needs_reconciliation',reason:'Unresolved mutation: inspect action log/queue/storage; automatic replay is disabled.'};
  const wait=Number(params.max_wait_seconds??300);
  if(!Number.isFinite(wait)||wait<0||wait>600)return {status:'blocked',reason:'max_wait_seconds must be 0..600'};
  const now=controls.now??Date.now,sleep=controls.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const deadline=now()+wait*1000;
  let pendingInQueue=false;
  try {
    while(true) {
      await controls.checkpoint?.();
      const queue=details(await command('spacemolt/craft',{}));
      // Live empty queues use null, while the generated schema declares an array.
      if(queue.kind==='queue'&&queue.total_jobs===0&&queue.jobs===null)queue.jobs=[];
      if(queue.kind!=='queue'||!Array.isArray(queue.jobs))throw new Error('Malformed crafting queue response');
      pendingInQueue=queue.jobs.some((j:Wire)=>j.job_id===experiment.job_id);
      if(!pendingInQueue)break;
      if(now()>=deadline){experiment.status='pending';save(experiment);return experiment;}
      await controls.checkpoint?.();
      await sleep(Math.min(2000,Math.max(0,deadline-now())));
      await controls.checkpoint?.();
    }
    for(const output of experiment.quote.evaluation.outputs) {
      await controls.checkpoint?.();
      const stock=details(await command('spacemolt_storage/view',{})).items;
      if(!Array.isArray(stock))throw new Error('Storage unavailable');
      const sold=experiment.sold[output.item_id]??0,withdrawn=experiment.withdrawn[output.item_id]??0;
      const inputUsed=experiment.quote.evaluation.inputs.find((i:Wire)=>i.item_id===output.item_id)?.quantity??0;
      const original=amount(experiment.before.storage,output.item_id)+(experiment.deposited?.[output.item_id]??0)-(experiment.quote.source==='inventory'?inputUsed:0);
      if(amount(stock,output.item_id)-original+withdrawn<output.quantity)throw new Error('Completed output not verified in storage');
      let remaining=output.quantity-sold;
      while(remaining>0) {
        const inCargo=(experiment.withdrawn[output.item_id]??0)-(experiment.sold[output.item_id]??0);
        let chunk=inCargo;
        if(!chunk) {
          const size=stock.find((i:Wire)=>i.item_id===output.item_id)?.size;
          const ship=account.ship;
          if(!ship||!Number.isFinite(size)||size<=0)throw new Error('Output cargo size unavailable');
          chunk=Math.min(remaining,Math.floor((ship.cargo_capacity-ship.cargo_used)/size));
          if(chunk<1)throw new Error('No cargo room for output; free cargo then settle again');
          await experimentCommand(experiment,command,'spacemolt_storage/withdraw',{item_id:output.item_id,quantity:chunk},account,save,controls);

        }
        const receipt=await experimentCommand(experiment,command,'spacemolt/sell',{id:output.item_id,quantity:chunk,auto_list:false},account,save,controls);
        if(!Number.isInteger(receipt.quantity_sold)||receipt.quantity_sold<0||receipt.quantity_sold>chunk)throw new Error('Invalid sale receipt');

        remaining-=receipt.quantity_sold;
        if(receipt.quantity_sold<chunk){experiment.status='partial';experiment.reason='Demand did not fill output; remaining inventory retained for later settlement';save(experiment);return experiment;}
      }
    }
    experiment.skills_after=snapshotSkills(account.state);
    experiment.skill_progress=skillProgress(experiment.before.skills??{},experiment.skills_after);
    experiment.after={skills:experiment.skills_after,credits:account.credits,cargo:account.cargo,storage:details(await command('spacemolt_storage/view',{})).items};
    const realized=experiment.earned-experiment.spent;
    Object.assign(experiment,{status:'complete',seconds:(now()-experiment.started)/1000,realized_credit_delta:realized,incremental_profit_after_input_opportunity:realized-(experiment.quote.source==='inventory'?(experiment.input_opportunity_at_enqueue??experiment.quote.evaluation.rawSaleCredits??0):0),prediction_error:realized-(experiment.quote.evaluation.expectedProfit??0)});
    delete experiment.reason;save(experiment);return experiment;
  } catch(error) {
    experiment.status=experiment.pending_action||experiment.accounting_unverified?'needs_reconciliation':pendingInQueue?'pending':'partial';experiment.reason=error instanceof Error?error.message:String(error);save(experiment);return experiment;
  }
}
