/** Suggestions from recorded outcomes, never permission to execute a stale quote. */
export interface StrategyOptions {
  creditReserve?: number;
  initialExplorationBudget?: number;
  reinvestFraction?: number;
  maxExperimentSpend?: number;
  /** Caller supplies the observation clock to keep this helper deterministic. */
  nowMs?: number;
  maxQuoteAgeMs?: number;
  currentSkillContext?: Record<string, any>;
  maxLearningLoss?: number;
}
type Row = Record<string, any>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const retained = (row: Row) => (row.disposition ?? row.quote?.disposition) === 'retain';
const identity = (row: Row) => row.key ?? [row.station ?? row.origin_station, row.recipe_id ?? row.quote?.recipe_id ?? row.poi_id, row.source ?? row.quote?.source ?? 'mine'].join('/');

export function recommendStrategy(history: readonly Row[], wallet: number, options: StrategyOptions = {}) {
  const creditReserve = options.creditReserve ?? 150000;
  const initialExplorationBudget = options.initialExplorationBudget ?? 1000;
  const reinvestFraction = options.reinvestFraction ?? 0.25;
  const maxExperimentSpend = options.maxExperimentSpend ?? 1000;
  const maxQuoteAgeMs = options.maxQuoteAgeMs ?? 60000;
  const maxLearningLoss=options.maxLearningLoss??0;
  const skillChanged=(previous:Row|undefined):boolean|null=>{
    const before=previous?.skills,after=options.currentSkillContext?.skills;
    if(!before||!after)return null;
    const ids=Object.keys(before).filter(id=>after[id]);
    if(!ids.length)return null;
    return ids.some(id=>['level','xp'].some(key=>finite(before[id]?.[key])&&finite(after[id]?.[key])&&before[id][key]!==after[id][key]));
  };
  if (![wallet, creditReserve, initialExplorationBudget, reinvestFraction, maxExperimentSpend, maxQuoteAgeMs,maxLearningLoss].every(n => finite(n) && n >= 0) || reinvestFraction > 1 || (options.nowMs !== undefined && !finite(options.nowMs))) throw new Error('Invalid strategy budget or observation clock');
  // Ledgers append snapshots of the same experiment; count its latest state once.
  const latest = new Map<string, Row>();
  for (const row of history) {
    const id = row.experiment_id ?? (row.event?.startsWith('mining_experiment') ? row.id : undefined);
    if (id) latest.set(id, row);
  }
  let positiveEconomicProfit = 0, realizedLosses = 0, excludedOutcomes = 0;
  const profitable = new Map<string, Row>();
  const attempted = new Set<string>();
  const sampleCounts = new Map<string, number>();
  const observedLearning=new Map<string,Row>();
  for (const row of latest.values()) {
    // Own-use custody has no realized economic margin; wallet headroom still applies.
    if (retained(row)) { excludedOutcomes++; continue; }
    attempted.add(identity(row));
    const mining = row.event === 'mining_experiment';
    const settled = ['complete', 'completed', 'aborted'].includes(row.status) && !row.pending_action;
    const liabilitiesSettled = !mining || (row.fuel_liability_units === 0 && row.hull_liability_units === 0);
    // Cash from consuming existing stock is not economic profit.
    const profit = mining ? row.realized_profit : (row.quote?.source ?? row.source) === 'inventory'
      ? row.incremental_profit_after_input_opportunity
      : row.incremental_profit_after_input_opportunity ?? row.realized_credit_delta;
    if (!settled || !liabilitiesSettled || !finite(profit)) { excludedOutcomes++; continue; }
    observedLearning.set(identity(row),{...row,economic_profit:profit});
    sampleCounts.set(identity(row),(sampleCounts.get(identity(row))??0)+1);
    positiveEconomicProfit += Math.max(0, profit);
    realizedLosses += Math.max(0, -profit);
    // A later losing observation supersedes an earlier successful loop.
    if (profit > 0) profitable.set(identity(row), { ...row, economic_profit: profit });
    else profitable.delete(identity(row));
  }
  const explorationFund = Math.max(0, initialExplorationBudget + reinvestFraction * positiveEconomicProfit - realizedLosses);
  const liquidHeadroom = Math.max(0, wallet - creditReserve);
  const availableExploration = Math.min(explorationFund, liquidHeadroom);
  const nextExperimentCap = Math.min(availableExploration, maxExperimentSpend);
  const quotes = new Map<string, Row>();
  for (const row of history) if (row.event === 'quote' && !retained(row)) quotes.set(identity(row), row);
  const candidates = [...quotes.values()].filter(row => !attempted.has(identity(row))).map(row => {
    const timestamp = typeof row.at === 'number' ? row.at : Date.parse(row.at);
    const quoteAgeMs = options.nowMs !== undefined && finite(timestamp) && timestamp <= options.nowMs ? options.nowMs - timestamp : null;
    const evaluation = row.evaluation;
    const purchases = row.source === 'buy' ? (Array.isArray(row.inputQuotes) && row.inputQuotes.length
      ? row.inputQuotes.reduce((n: number, q: Row) => finite(q.total_cost) ? n + q.total_cost : NaN, 0) : NaN) : 0;
    const spend = finite(evaluation?.purchaseCredits) && finite(row.craft?.credits_total) && finite(purchases)
      ? purchases + row.craft.credits_total : null;
    return { key: identity(row), station: row.station, recipe_id: row.recipe_id, source: row.source,
      quoteAgeMs, quoteStale: quoteAgeMs === null || quoteAgeMs > maxQuoteAgeMs,
      quotedSpend: finite(spend) ? spend : null,
      withinBudget: finite(spend) && spend <= nextExperimentCap && nextExperimentCap > 0,
      feasible: evaluation?.feasible === true, requiresFreshQuote: true };
  });
  const repeats = [...profitable.values()].map(row => ({ action: 'repeat_after_revalidation', key: identity(row), station: row.station ?? row.origin_station,
    recipe_id: row.quote?.recipe_id ?? row.recipe_id, source: row.quote?.source ?? row.source ?? 'mine', poi_id: row.poi_id,
    observedEconomicProfit: row.economic_profit,
    skill_context:row.skill_context??row.quote?.skill_context??null,skill_progress:row.skill_progress??[],
    skill_context_changed:skillChanged(row.skill_context??row.quote?.skill_context),
    seconds:finite(row.seconds)&&row.seconds>0?row.seconds:null,
    observedEconomicProfitPerSecond:finite(row.seconds)&&row.seconds>0?row.economic_profit/row.seconds:null,
    sampleCount:sampleCounts.get(identity(row))??1, requiresFreshQuote: true }))
    .sort((a,b)=>(b.observedEconomicProfitPerSecond??-Infinity)-(a.observedEconomicProfitPerSecond??-Infinity)||b.observedEconomicProfit-a.observedEconomicProfit);
  const latestScreens=new Map<string,Row>();
  for(const row of history)if(row.event==='screen'&&typeof row.station==='string')latestScreens.set(row.station,row);
  const discoveries=[...latestScreens.values()].flatMap(screen=>(screen.exploration_candidates??[]).map((row:Row)=>({
    key:row.id??`${screen.station}/${row.recipe_id}/mine_or_buy`,station:screen.station,recipe_id:row.recipe_id,source:row.source??'mine_or_buy',observedAt:screen.at,
    blockers:row.blockers??[],inputs_needed:row.inputs_needed??[],venue:row.venue,
    output_sale_credits:row.output_sale_credits,raw_sale_benchmark:row.raw_sale_benchmark,potential_conversion_margin:row.potential_conversion_margin,
    quoted:false,executable:false,expectedProfit:null,requiresFreshQuote:true,
    unknowns:[...new Set([...(row.unknowns??[]),'Input acquisition cost and availability','Travel and operating costs','Current crafting labor and taxes'])],
    next_step:'Locate or quote the missing inputs, resolve skill/facility blockers, then obtain a fresh full-loop quote. Screened output value is not executable profit.',
  }))).sort((a,b)=>(b.potential_conversion_margin??-Infinity)-(a.potential_conversion_margin??-Infinity)||(b.output_sale_credits??0)-(a.output_sale_credits??0));
  const learningCandidates=[...new Map([
    ...discoveries.map(row=>[row.key,{...row,learning_kind:'future_hypothesis',skill_progress:[],expected_learning_loss:null}] as const),
    ...[...quotes.values()].map(row=>{
      const economic=row.source==='inventory'?row.evaluation?.processingAdvantage:row.evaluation?.expectedProfit;
      const context=row.skill_context??row.quote?.skill_context;
      return [identity(row),{key:identity(row),station:row.station,recipe_id:row.recipe_id,source:row.source,
        learning_kind:row.evaluation?.feasible&&row.craft?.runs===1&&finite(economic)&&economic<=0?'supplied_single_run_probe':'reevaluate_hypothesis',
        expected_learning_loss:finite(economic)?Math.max(0,-economic):null,blockers:row.evaluation?.blockers??[],
        skill_context:context??null,skill_progress:[],skill_context_changed:skillChanged(context)}] as const;
    }),
    ...[...observedLearning.values()].map(row=>[identity(row),{key:identity(row),station:row.station??row.origin_station,recipe_id:row.quote?.recipe_id??row.recipe_id,source:row.quote?.source??row.source??'mine',
      learning_kind:'observed_outcome',observed_economic_profit:row.economic_profit,skill_progress:row.skill_progress??[],skill_context:row.skill_context??row.quote?.skill_context??null,
      skill_context_changed:skillChanged(row.skill_context??row.quote?.skill_context),expected_learning_loss:null,
      learning_goal:row.learning_policy?.learning_goal}] as const),
  ]).values()].map((row:Row):Row=>({...row,executable:false,requiresFreshQuote:true,max_learning_loss:Math.min(maxLearningLoss,availableExploration),
    within_learning_loss_cap:finite(row.expected_learning_loss)&&row.expected_learning_loss<=Math.min(maxLearningLoss,availableExploration),
    note:'Current losses do not permanently reject a recipe. Re-evaluate after skill, input or market changes; XP shown is observed only, never projected.'}));
  return {
    current_skill_context:options.currentSkillContext??null,
    learningCandidates,
    incomeCandidates:repeats,
    budget: { creditReserve, initialExplorationBudget, reinvestFraction, positiveEconomicProfit, realizedLosses, explorationFund, liquidHeadroom, availableExploration, nextExperimentCap, excludedOutcomes },
    repeatCandidates: repeats,
    explorationCandidates: candidates,
    discoveryCandidates: discoveries,
    nextActions: [...learningCandidates.filter(row=>row.skill_context_changed===true||row.learning_kind==='supplied_single_run_probe').map(row=>({action:'reevaluate_learning_probe',...row})),...discoveries.map(row=>({action:'investigate_unquoted_recipe',...row,maxSpend:nextExperimentCap})),...repeats, ...candidates.filter(row => row.withinBudget && row.feasible).map(row => ({ action: 'revalidate_untried_quote', ...row })),
      { action: 'observe_recipes_and_locations', maxSpend: nextExperimentCap, guidance: nextExperimentCap > 0
        ? 'Compare untried recipes, input sources and stations. Quote travel and operating costs before committing exploration funds.'
        : 'Exploration spending is exhausted. Gather free observations and revalidate previously profitable loops to replenish funds.' }],
    limitations: ['Historical profits do not guarantee repeat fills.', 'Unknown travel costs are not assumed zero.', 'Pending or unverified outcomes do not fund exploration.'],
  };
}
