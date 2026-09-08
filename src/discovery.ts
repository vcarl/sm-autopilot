/** Mechanical market discovery: observations and dry-run quotes only. */
import { SpacemoltError } from '@spacemolt/lib';
import {createHash} from 'node:crypto';
type Row = Record<string, any>;
export interface DiscoveryParams { limit?: number; max_learning_loss?: number }
export interface DiscoveryDependencies {
  screen(params: {limit:number}): Promise<Row>;
  quote(params: {recipe_id:string; quantity:number; source:'buy'|'inventory'}): Promise<Row>;
  record?(event:Row): void;
  now?(): number;
  blockedQuoteMemo?:Map<string,{at:number;response:Row}>;
}
const blockedQuotes=new Map<string,{at:number;response:Row}>();
const BLOCKED_QUOTE_TTL=300000;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const items=(rows:Row[]|undefined)=>[...new Set((rows??[]).map(row=>String(row.item_id)))].sort();
const score=(candidate:Row)=>finite(candidate.gross_margin)?candidate.gross_margin:finite(candidate.potential_conversion_margin)?candidate.potential_conversion_margin:-Infinity;

const knownBlockers=(row:Row):string[]=>[...(row.blockers??[]),...(row.inputs_needed??[]).filter((item:Row)=>finite(item.quantity)&&item.quantity>0).map((item:Row)=>`missing input: ${item.item_id} (${item.quantity})`)];

/** Never spend a live quote on a known unmet requirement. */
export function selectDiscoveryCandidates(screen:Row,limit:number,maxLearningLoss=0):Row[] {
  const unique=new Map<string,Row>();
  for(const [pool,candidates] of [['actionable',screen.candidates??[]],['exploration',screen.exploration_candidates??[]]] as const) {
    for(const candidate of candidates) {
      if(!candidate.recipe_id||knownBlockers(candidate).length)continue;
      if(finite(score(candidate))&&score(candidate)<-maxLearningLoss)continue;
      const sources=candidate.source==='mine_or_buy'?['buy','inventory']:[candidate.source];
      for(const source of sources) {
        if(source!=='buy'&&source!=='inventory')continue;
        const actionable=pool==='actionable'&&finite(candidate.gross_margin)&&candidate.gross_margin>0&&!(candidate.blockers??[]).length;
        const suppliedLearning=pool==='actionable'&&finite(candidate.gross_margin)&&candidate.gross_margin<=0&&!(candidate.blockers??[]).length;
        const row={...candidate,source,discovery_pool:actionable?'actionable':suppliedLearning?'learning':'exploration'};
        const key=`${row.recipe_id}/${source}`,existing=unique.get(key);
        if(!existing||(actionable&&existing.discovery_pool!=='actionable'))unique.set(key,row);
      }
    }
  }
  const selected:Row[]=[],seenOutputs=new Set<string>(),seenRecipes=new Set<string>();
  const actionable=[...unique.values()].filter(row=>row.discovery_pool==='actionable');
  const learning=[...unique.values()].filter(row=>row.discovery_pool==='learning');
  const exploration=[...unique.values()].filter(row=>row.discovery_pool==='exploration');
  const novel=(row:Row)=>Number(items(row.outputs).some(id=>!seenOutputs.has(id)));
  const take=(pool:Row[],count:number,exploring:boolean)=>{
    for(let n=0;n<count&&pool.length&&selected.length<limit;n++) {
      pool.sort((a,b)=>(exploring?Number(finite(score(b)))-Number(finite(score(a))):0)||novel(b)-novel(a)||Number(!seenRecipes.has(b.recipe_id))-Number(!seenRecipes.has(a.recipe_id))||score(b)-score(a)||a.recipe_id.localeCompare(b.recipe_id)||a.source.localeCompare(b.source));
      const row=pool.shift()!;selected.push(row);seenRecipes.add(row.recipe_id);
      for(const id of items(row.outputs))seenOutputs.add(id);
    }
  };
  take(actionable,Math.ceil(limit/2),false);
  take(learning,Math.min(1,limit-selected.length),false);
  take(actionable,limit-selected.length,false);
  take(learning,limit-selected.length,false);
  take(exploration,limit-selected.length,true);
  return selected;
}

export async function discoverMarket(params:DiscoveryParams,dependencies:DiscoveryDependencies):Promise<Row> {
  const limit=params.limit??6,learningLossCap=params.max_learning_loss??0;
  if(!finite(learningLossCap)||learningLossCap<0)throw new Error('Learning loss cap must be finite and nonnegative');
  if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error('Discovery limit must be an integer in 1..12');
  const now=dependencies.now??Date.now,started=now();
  const screen=await dependencies.screen({limit:50});
  if(screen.status==='blocked')return {status:'blocked',reason:screen.reason,station:screen.station,catalog:screen.catalog,catalog_version:screen.catalog_version,retryAt:screen.retryAt,evaluated_recipe_count:screen.evaluated_recipe_count};
  const selected=selectDiscoveryCandidates(screen,limit,learningLossCap),observations:Row[]=[],fullQuotes:Row[]=[];
  const deferred=new Map<string,Row>();
  for(const candidate of [...screen.candidates??[],...screen.exploration_candidates??[]]) {
    if(!candidate.recipe_id)continue;
    const blockers=knownBlockers(candidate);
    const overCap=finite(score(candidate))&&score(candidate)<-learningLossCap;
    if(!blockers.length&&!overCap)continue;
    const reason=overCap?['Screened loss already exceeds the learning allowance before unquoted fees']:[];
    deferred.set(`${candidate.recipe_id}/${candidate.source}`,{
      recipe_id:candidate.recipe_id,source:candidate.source,station:screen.station,quantity:1,inputs:candidate.inputs,outputs:candidate.outputs,
      venue:candidate.venue,inputs_needed:candidate.inputs_needed,blockers:[...blockers,...reason],
      status:'blocked_hypothesis',learning_kind:'future_hypothesis',quote_skipped:true,
      economic_profit:null,economic_profit_per_second:null,expected_cash_profit:null,processing_advantage:null,
      theoretical_processing_advantage:candidate.potential_conversion_margin??null,expected_learning_loss:null,within_learning_loss_cap:false,
      skill_context:candidate.skill_context??screen.skill_context??null,skill_progress:[],requires_fresh_quote:true,
      valuation_note:'Known unmet requirements or a screened loss beyond the allowance: no live quote was requested. Re-screen after inputs, facilities, skills or budget change.',
    });
  }
  const futureHypotheses=[...deferred.values()];
  const memo=dependencies.blockedQuoteMemo??blockedQuotes;
  const fingerprint=screen.observation_key??createHash('sha256').update(JSON.stringify(screen,(key,value)=>['at','timestamp','observed_at','seconds'].includes(key)?undefined:value)).digest('hex');
  let quoteCalls=0,cacheReuseCount=0;
  for(const candidate of selected) {
    let response:Row;
    const memoKey=JSON.stringify([screen.station,screen.catalog_version,fingerprint,candidate.recipe_id,candidate.source]);
    const cached=memo.get(memoKey),cacheHit=!!cached&&now()>=cached.at&&now()-cached.at<BLOCKED_QUOTE_TTL;
    if(cacheHit){response=cached!.response;cacheReuseCount++;}
    else try {
      quoteCalls++;
      response=await dependencies.quote({recipe_id:candidate.recipe_id,quantity:1,source:candidate.source});}
    catch(error) {
      const code=(error as {code?:unknown})?.code;
      // Transport/unknown failures require reconciliation by the existing caller.
      if(!(error instanceof SpacemoltError)||error.pendingCommand||typeof code!=='string'||/timeout|disconnect|connection|transport|action_pending|rate|busy/i.test(code))throw error;
      response={status:'blocked',reason:error instanceof Error?error.message:String(error),code};
      if(!/rate|busy|auth/i.test(code)&&/skill|facility|recipe|material|ingredient|supply|require/i.test(code)){
        memo.set(memoKey,{at:now(),response});
        while(memo.size>256)memo.delete(memo.keys().next().value!);
      }
    }
    fullQuotes.push({candidate,response});
    const quote=response.quote??response,evaluation=quote.evaluation;
    const economicProfit=candidate.source==='inventory'?evaluation?.processingAdvantage:evaluation?.expectedProfit;
    const seconds=evaluation?.seconds;
    const blockers=[...(evaluation?.blockers??[]),...(evaluation?.unknowns??[])];
    if(response.status==='blocked')blockers.push(response.reason??'Quote blocked');
    if(!evaluation&&response.status!=='blocked')blockers.push('No economic evaluation returned');
    if(quote.craft?.runs>1)blockers.push('Multi-run output scaling is unverified');
    if(finite(economicProfit)&&economicProfit<=0)blockers.push('Nonpositive economic margin at current prices');
    if(!finite(economicProfit)&&evaluation)blockers.push('Economic margin remains unknown');
    const valued=response.status!=='blocked'&&evaluation?.feasible===true&&quote.craft?.runs===1;
    const executable=response.status!=='blocked'&&evaluation?.feasible===true&&quote.craft?.runs===1&&finite(economicProfit)&&economicProfit>0&&blockers.length===0;
    observations.push({recipe_id:candidate.recipe_id,source:candidate.source,quantity:1,station:quote.station??screen.station,
      venue:quote.craft?.venue??candidate.venue,inputs:evaluation?.inputs?.map((item:Row)=>({item_id:item.item_id,quantity:item.quantity}))??candidate.inputs,
      outputs:evaluation?.outputs?.map((item:Row)=>({item_id:item.item_id,quantity:item.quantity}))??candidate.outputs,
      status:executable?'profitable_quote':'blocked_hypothesis',blockers,
      quote_cache_reused:cacheHit,
      learning_kind:valued&&finite(economicProfit)&&economicProfit<=0?'supplied_single_run_probe':!valued?'future_hypothesis':undefined,
      expected_learning_loss:valued&&finite(economicProfit)?Math.max(0,-economicProfit):null,
      within_learning_loss_cap:valued&&finite(economicProfit)&&Math.max(0,-economicProfit)<=learningLossCap,
      skill_context:quote.skill_context??null,skill_progress:quote.skill_progress??[],
      learning_note:'Skill gains are not predicted. A learning probe needs an explicit learning goal, a fresh quote and its own bounded loss allowance.',
      expected_cash_profit:valued?(evaluation?.expectedProfit??null):null,processing_advantage:valued?(evaluation?.processingAdvantage??null):null,
      theoretical_processing_advantage:evaluation?.processingAdvantage??null,valuation_note:valued?undefined:'Requirements are unmet; theoretical conversion excludes unresolved acquisition, skill or facility constraints.',
      economic_profit:valued&&finite(economicProfit)?economicProfit:null,
      economic_profit_per_second:valued&&finite(economicProfit)&&finite(seconds)&&seconds>0?economicProfit/seconds:null,
      estimated_seconds:seconds??null,purchase_credits:evaluation?.purchaseCredits??null,
      crafting_credits:quote.craft?.credits_total??null,raw_sale_opportunity:evaluation?.rawSaleCredits??null,
      inputs_needed:candidate.inputs_needed,requires_fresh_quote:true});
  }
  observations.push(...futureHypotheses.slice(0,limit));
  observations.sort((a,b)=>Number(b.status==='profitable_quote')-Number(a.status==='profitable_quote')||(b.economic_profit_per_second??-Infinity)-(a.economic_profit_per_second??-Infinity)||(b.economic_profit??-Infinity)-(a.economic_profit??-Infinity)||a.recipe_id.localeCompare(b.recipe_id));
  const summary={event:'market_discovery',at:new Date(now()).toISOString(),station:screen.station,catalog:screen.catalog,catalog_version:screen.catalog_version,evaluated_recipe_count:screen.evaluated_recipe_count,market_tick:screen.market_tick,
    seconds:(now()-started)/1000,quote_count:quoteCalls,cache_reuse_count:cacheReuseCount,requested_limit:limit,local_hypothesis_count:futureHypotheses.length,
    screened_actionable_count:screen.candidates?.length??0,screened_exploration_count:screen.exploration_candidates?.length??0,
    ranked:observations,income_candidates:observations.filter(row=>row.status==='profitable_quote'),learning_candidates:observations.filter(row=>row.learning_kind),learning_loss_cap:learningLossCap,limitations:['The available full catalog is screened locally; live quotes are limited to the selected feasible shortlist, so quoted discovery is not exhaustive.','Inventory profit subtracts raw-sale opportunity. Mining and travel costs need separate measurements.','Quotes do not reserve market depth or authorize spending.']};
  dependencies.record?.({...summary,screen,selected,future_hypotheses:futureHypotheses,quotes:fullQuotes});
  return summary;
}
