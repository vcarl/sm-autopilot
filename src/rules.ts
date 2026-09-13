import {allowed,combatActions} from './rules-actions.ts';
import {policyVersion,type ExecutionContext,type Mood} from './execution-policy.ts';

export interface PolicyReason {id:string;text:string;denied:boolean}
export interface Decision {
  policy_version:string; allowed:boolean; reasons:PolicyReason[]; obligations:string[]; limits:Record<string,number>;
  exit:'finish_job'|'next_checkpoint'|'return_now';
}
export interface RuleFacts {
  phase:'bounds'|'resolve'|'catalog'|'job'|'checkpoint'|'command'|'spent'|'obligation'|'budget'|'battle'|'terminal'|'raw';
  context?:ExecutionContext; input?:Record<string,any>; previous?:ExecutionContext;
  action?:string; jobAction?:string; params?:Record<string,any>; tired?:boolean; paid?:boolean;
  admitted?:{action:string}[]; pending?:boolean; unresolved?:boolean; homeRequired?:boolean; unfinishedProduction?:boolean;
  custody?:boolean; readiness?:string[];
  budget?:{gross_spend:number|null;max_spend:number;credit_reserve:number}; credits?:number;
  ownerLimits?:ExecutionContext['limits']; policyLimits?:Record<string,number>;
  logistics?:{liability?:unknown;exposure?:unknown;credits?:unknown;jumps?:number};
  battle?:{retreat:boolean;own?:Record<string,any>;target?:Record<string,any>;strangers:boolean;combatState:boolean;assessment?:string;hullFraction:number;stopped?:boolean;emptyWeapon?:boolean;fuel?:number;elapsed?:number;maxTicks?:number};
  terminal?:{status:string;action:string;error?:string;eligibleQuarry:boolean};
  attention?:{related:boolean;safe:boolean;bounded:boolean;advantage?:number;switchingCost?:number};
  raw?:{known:boolean;catalog?:boolean};
  transport?:{returnAvailable?:boolean;arrived?:boolean;fuelReady?:boolean;fuelBlockers?:string[];deadlineReady?:boolean;deadlineBlockers?:string[]};
  newRun?:{unresolved:boolean;running:boolean;docked:boolean;serviced:boolean};
  budgetConfig?:{kind:'combat_fit'|'production';maxSpend?:unknown;reserve?:unknown};
  production?:{feasible:boolean;retaining:boolean;margin:number|null;minimum:number};
  learning?:{goal:unknown;loss:number;minimum:number};
  affordability?:{amount:number;available:number;credits:number|undefined;reserve:number};
  time?:{elapsed:number;maximum:number};
}
export interface Rule {id:string;when:(facts:RuleFacts)=>boolean;then:(facts:RuleFacts)=>Partial<Omit<Decision,'reasons'>>&{reason:string}}
export const deniedTexts=(decision:Decision)=>decision.reasons.filter(reason=>reason.denied).map(reason=>reason.text);
const lowerBounds=new Set(['credit_reserve','retreat_hull_fraction','minimum_economic_margin']);
const exitRank={finish_job:0,next_checkpoint:1,return_now:2} as const;
/** All matching rules contribute. Denials cannot be undone by an allowance. */
export function evaluateRules(facts:RuleFacts,rules:readonly Rule[]=policyRules):Decision {
  const result:Decision={policy_version:policyVersion,allowed:true,reasons:[],obligations:[],limits:{},exit:'finish_job'};
  for(const rule of rules) {
    if(!rule.when(facts))continue;
    const contribution=rule.then(facts);
    result.allowed &&= contribution.allowed!==false;
    const existing=result.reasons.find(reason=>reason.id===rule.id&&reason.text===contribution.reason);
    if(existing)existing.denied ||= contribution.allowed===false;
    else result.reasons.push({id:rule.id,text:contribution.reason,denied:contribution.allowed===false});
    for(const obligation of contribution.obligations??[])if(!result.obligations.includes(obligation))result.obligations.push(obligation);
    for(const [key,value] of Object.entries(contribution.limits??{})) {
      if(!Number.isFinite(value))throw new Error(`Invalid rule limit ${rule.id}.${key}`);
      result.limits[key]=result.limits[key]===undefined?value:(lowerBounds.has(key)?Math.max:Math.min)(result.limits[key]!,value);
    }
    if(contribution.exit&&exitRank[contribution.exit]>exitRank[result.exit])result.exit=contribution.exit;
  }
  return result;
}
export class PolicyDenied extends Error {
  readonly decision:Decision;
  constructor(decision:Decision) {super(decision.reasons.filter(reason=>reason.denied).map(reason=>reason.text).join('; '));this.name='PolicyDenied';this.decision=decision;}
}
export function requireAllowed(decision:Decision):Decision {if(!decision.allowed)throw new PolicyDenied(decision);return decision;}
const rule=(id:string,when:Rule['when'],reason:string,effect:Partial<Omit<Decision,'reasons'>>={}):Rule=>({id,when,then:()=>({...effect,reason})});
const deny=(id:string,when:Rule['when'],reason:string)=>rule(id,when,reason,{allowed:false});
const moodRows:{mood:Mood;ticks:number;hull:number;cycles:number;jumps:number;liability:number}[]=[
  {mood:'Relaxed',ticks:12,hull:.9,cycles:2,jumps:1,liability:500},
  {mood:'Cautious',ticks:16,hull:.95,cycles:2,jumps:1,liability:500},
  {mood:'Focused',ticks:20,hull:.9,cycles:4,jumps:2,liability:1000},
  {mood:'Opportunistic',ticks:20,hull:.9,cycles:4,jumps:2,liability:1000},
  {mood:'Aggressive',ticks:24,hull:.8,cycles:6,jumps:2,liability:2000},
  {mood:'Tired',ticks:1,hull:.95,cycles:0,jumps:0,liability:0},
];
export const productiveJobs=new Set(['hunt','gather','produce','transport']);
const jobStances:Record<string,string[]>={hunt:['Hunt'],track:['Hunt'],gather:['Industry'],produce:['Industry'],transport:['Logistics']};
const stanceOwners=(action:string)=>Object.hasOwn(jobStances,action)?jobStances[action]:undefined;
const commonJobs=new Set(['observe','plan','return_to_base','assess','prepare','travel']);
const productiveCommands=new Set(['spacemolt_shipping/accept','spacemolt_shipping/deliver','spacemolt/load_passenger','spacemolt/unload_passenger','spacemolt/hunt','spacemolt/mine','spacemolt/buy','spacemolt/sell','spacemolt/install_mod','spacemolt/uninstall_mod','spacemolt_storage/deposit','spacemolt_storage/withdraw','spacemolt_salvage/loot','spacemolt/scan']);
const productiveCommand=(f:RuleFacts)=>productiveCommands.has(f.action??'')||(f.action==='spacemolt/craft'&&f.params?.id!==undefined&&f.params.dry_run!==true);
const requestBounds=(f:RuleFacts)=>f.phase==='bounds'||admission(f);
const admission=(f:RuleFacts)=>['catalog','job','checkpoint'].includes(f.phase);
const mood=(f:RuleFacts)=>f.context?.mood;
const limitsInvalid=(f:RuleFacts)=>{
  const l=f.input?.limits??{},base=f.context!.limits;
  return Object.entries(l).some(([key,value])=>!['max_spend','credit_reserve','max_ticks','retreat_hull_fraction','max_gather_cycles'].includes(key)||typeof value!=='number'||!Number.isFinite(value))
    ||(l.max_spend!==undefined&&(l.max_spend<0||l.max_spend>10000))
    ||(l.credit_reserve!==undefined&&l.credit_reserve<150000)
    ||(l.max_ticks!==undefined&&(!Number.isInteger(l.max_ticks)||l.max_ticks<1||l.max_ticks>base.max_ticks))
    ||(l.retreat_hull_fraction!==undefined&&(l.retreat_hull_fraction<base.retreat_hull_fraction||l.retreat_hull_fraction>.95))
    ||(l.max_gather_cycles!==undefined&&(!Number.isInteger(l.max_gather_cycles)||l.max_gather_cycles<0||l.max_gather_cycles>base.max_gather_cycles));
};
const relatedCommands:Record<string,string[]>={
  'spacemolt/mine':['gather'], 'spacemolt/hunt':['hunt'],
  'spacemolt_shipping/accept':['transport'], 'spacemolt_shipping/deliver':['transport'],
  'spacemolt/load_passenger':['transport'], 'spacemolt/unload_passenger':['transport'],
  'spacemolt/sell':['produce'], 'spacemolt_salvage/loot':['hunt'],
  'spacemolt/buy':['prepare','produce'],
  'spacemolt/install_mod':['prepare','gather','hunt','track'],
  'spacemolt/uninstall_mod':['prepare','gather','hunt','track'],
  'spacemolt_storage/withdraw':['prepare','produce','transport','hunt','track'],
  'spacemolt_storage/deposit':['produce','prepare'],
  'spacemolt/scan':['track','hunt'],
};
const unrelatedCommand=(f:RuleFacts)=>{
  const command=f.phase==='command'?f.action:f.params?.command;
  if(typeof command!=='string')return false;
  const owners=(Object.hasOwn(relatedCommands,command)?relatedCommands[command]:undefined)??(command==='spacemolt/craft'&&f.params?.id!==undefined&&f.params?.dry_run!==true?['produce']:undefined);
  return owners?!owners.includes(f.jobAction??f.action??''):productiveCommands.has(command);
};
const diversion=(f:RuleFacts)=>f.attention?.related===false||(f.phase==='command'&&Boolean(f.jobAction)&&unrelatedCommand(f));
export const policyRules:readonly Rule[]=[
  deny('command.internal',f=>f.raw?.catalog===true&&(combatActions.has(f.action??'')||f.action==='spacemolt_intel/query_trade_intel'),'Tactical commands and trade intelligence are internal to bounded job scripts'),
  rule('run.checkpoint',f=>Boolean(f.newRun),'A new operating run requires reconciled, docked and fully serviced state'),
  rule('run.readiness',f=>Boolean(f.newRun)&&(f.newRun!.unresolved||f.newRun!.running||!f.newRun!.docked||!f.newRun!.serviced),'Cannot start a new run before reconciled, docked and fully serviced state',{allowed:false,obligations:['reconcile_before_work','service_before_departure']}),
  {id:'budget.defaults',when:f=>Boolean(f.budgetConfig),then:f=>({limits:{max_spend:typeof f.budgetConfig!.maxSpend==='number'&&Number.isFinite(f.budgetConfig!.maxSpend)?f.budgetConfig!.maxSpend:f.budgetConfig!.kind==='combat_fit'?10000:1000,credit_reserve:typeof f.budgetConfig!.reserve==='number'&&Number.isFinite(f.budgetConfig!.reserve)?f.budgetConfig!.reserve:150000},reason:'Explicit or default mechanical job allowance'})},
  deny('budget.config',f=>Boolean(f.budgetConfig)&&((f.budgetConfig!.maxSpend!==undefined&&(!Number.isFinite(f.budgetConfig!.maxSpend)||(f.budgetConfig!.maxSpend as number)<0||(f.budgetConfig!.kind==='combat_fit'&&(f.budgetConfig!.maxSpend as number)>50000)))||(f.budgetConfig!.reserve!==undefined&&(!Number.isFinite(f.budgetConfig!.reserve)||(f.budgetConfig!.reserve as number)<0))),'Invalid fitting or production budget'),
  deny('production.feasibility',f=>Boolean(f.production)&&!f.production!.feasible,'Quote fails input feasibility requirement'),
  deny('production.margin',f=>Boolean(f.production)&&!f.production!.retaining&&(!Number.isFinite(f.production!.margin)||!Number.isFinite(f.production!.minimum)||f.production!.margin!<f.production!.minimum),'Quote fails economic profit or authorized learning-loss requirement'),
  deny('learning.budget',f=>Boolean(f.learning)&&(!Number.isFinite(f.learning!.minimum)||f.learning!.minimum<0||!Number.isFinite(f.learning!.loss)||f.learning!.loss<0),'Invalid production profit or learning loss budget'),
  deny('learning.goal',f=>Boolean(f.learning)&&f.learning!.loss>0&&(typeof f.learning!.goal!=='string'||!f.learning!.goal.trim()),'A nonempty learning_goal is required for a predicted learning loss allowance'),
  {id:'learning.margin',when:f=>Boolean(f.learning)&&Number.isFinite(f.learning!.minimum)&&Number.isFinite(f.learning!.loss),then:f=>({limits:{minimum_economic_margin:typeof f.learning!.goal==='string'&&f.learning!.goal.trim()&&f.learning!.loss>0?-f.learning!.loss:f.learning!.minimum},reason:'Income or explicitly bounded learning-loss margin'})},
  rule('allocation.funds',f=>Boolean(f.affordability)&&(!Number.isFinite(f.affordability!.amount)||f.affordability!.amount<0||!Number.isFinite(f.affordability!.available)||f.affordability!.available<f.affordability!.amount),'Remaining gross job budget cannot fund the cleanup allocation or purchase',{allowed:false,exit:'next_checkpoint'}),
  rule('allocation.wallet',f=>Boolean(f.affordability)&&(!Number.isFinite(f.affordability!.credits)||f.affordability!.credits!-f.affordability!.reserve<f.affordability!.amount),'Wallet headroom cannot fund cleanup or purchase without anticipated income',{allowed:false,exit:'next_checkpoint'}),
  rule('transport.return',f=>f.transport?.returnAvailable===false&&!f.transport.arrived,'Transport return unavailable; reassess before taking custody or traveling',{allowed:false,exit:'return_now',obligations:['preserve_custody']}),
  {id:'transport.fuel',when:f=>f.transport?.fuelReady===false,then:f=>({allowed:false,reason:f.transport!.fuelBlockers?.join('; ')||'Transport fuel itinerary is not verified',exit:'return_now',obligations:['preserve_custody']})},
  {id:'transport.deadline',when:f=>f.transport?.deadlineReady===false,then:f=>({allowed:false,reason:f.transport!.deadlineBlockers?.join('; ')||'Transport deadline evidence is unavailable',exit:'return_now',obligations:['preserve_custody']})},
  rule('transport.elapsed',f=>Boolean(f.time)&&(!Number.isFinite(f.time!.elapsed)||!Number.isFinite(f.time!.maximum)||f.time!.elapsed>=f.time!.maximum),'Observed transport elapsed-tick allocation exhausted; no further productive movement',{allowed:false,exit:'return_now',obligations:['preserve_custody','record_unfinished']}),
  deny('command.enabled',f=>Boolean(f.raw)&&(!allowed.has(f.action??'')||!f.raw!.known),'Action is outside the enabled gameplay toolset'),
  deny('command.craft_fields',f=>Boolean(f.raw)&&f.action==='spacemolt/craft'&&Object.keys(f.params??{}).some(key=>!['id','quantity','dry_run','preset','facility_id','job_id','source','deliver_to'].includes(key)),'Use one personal crafting job per request'),
  deny('command.craft_storage',f=>Boolean(f.raw)&&f.action==='spacemolt/craft'&&['source','deliver_to'].some(key=>f.params?.[key]!==undefined&&f.params[key]!=='storage'),'Crafting uses personal station storage'),
  deny('command.storage',f=>Boolean(f.raw)&&Boolean(f.action?.startsWith('spacemolt_storage/'))&&['target','source','credits','message'].some(key=>f.params?.[key]!==undefined),'Only personal item storage is enabled'),
  deny('command.self_service',f=>Boolean(f.raw)&&['spacemolt/refuel','spacemolt/repair'].includes(f.action??'')&&f.params?.target!==undefined,'Only servicing your own ship is enabled'),
  deny('command.personal_freight',f=>Boolean(f.raw)&&Boolean(f.action?.startsWith('spacemolt_shipping/'))&&f.params?.carrier!==undefined&&f.params.carrier!=='player','Only personal freight contracts are enabled'),
  {id:'resolve.defaults',when:f=>f.phase==='resolve',then:f=>({limits:{max_spend:typeof f.input?.limits?.max_spend==='number'&&Number.isFinite(f.input.limits.max_spend)?f.input.limits.max_spend:f.previous?.limits.max_spend??1000,credit_reserve:f.previous?.limits.credit_reserve??150000},reason:'Host default gross allowance and wallet reserve'})},
  {id:'resolve.tightening',when:f=>f.phase==='resolve'&&Boolean(f.input?.limits),then:f=>({limits:Object.fromEntries(Object.entries(f.input!.limits).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1]))),reason:'Requested overrides remain within host and mood bounds'})},
  ...moodRows.map(row=>rule(`mood.${row.mood.toLowerCase()}`,f=>mood(f)===row.mood,`${row.mood} bounded execution allocation`,{limits:{max_ticks:row.ticks,retreat_hull_fraction:row.hull,max_gather_cycles:row.cycles,max_route_jumps:row.jumps,max_liability:row.liability}})),
  {id:'allocation.context',when:f=>Boolean(f.context)&&f.phase!=='resolve',then:f=>({limits:f.phase==='budget'?{credit_reserve:f.context!.limits.credit_reserve}:{...f.context!.limits},reason:'Use the resolved host allocation'})},
  deny('authority.stance',f=>f.phase==='resolve'&&Boolean(f.previous?.authority?.stance)&&f.context?.stance!==f.previous!.authority!.stance,'User-selected stance is locked; scripts may only suspend or become Tired'),
  deny('authority.mood',f=>f.phase==='resolve'&&Boolean(f.previous?.authority?.mood)&&mood(f)!==f.previous!.authority!.mood&&mood(f)!=='Tired','User-selected mood is locked; scripts may only suspend or become Tired'),
  deny('context.objective',f=>f.phase==='resolve'&&(typeof f.context?.objective!=='string'||!f.context.objective.trim()),'A nonempty objective is required'),
  deny('limits.tighten',f=>f.phase==='resolve'&&limitsInvalid(f),'Limits may only tighten mood risk bounds; spending 0..10000, reserve >=150000; gather cycles within the resolved mood bound'),
  deny('activity.supported',f=>admission(f)&&!commonJobs.has(f.action??'')&&!stanceOwners(f.action??''),'Tool unavailable under current stance, mood or permission'),
  deny('activity.stance',f=>admission(f)&&Boolean(f.context)&&Boolean(stanceOwners(f.action??''))&&!stanceOwners(f.action!)!.includes(f.context!.stance),'Tool unavailable under current stance, mood or permission'),
  deny('hunt.permission',f=>(admission(f)&&f.action==='hunt'||f.phase==='command'&&f.action==='spacemolt/hunt')&&!f.context?.permissions.wildlife,'Wildlife permission absent; hunting is not authorized'),
  deny('hunt.initiative',f=>(admission(f)&&f.action==='hunt'||f.phase==='command'&&f.action==='spacemolt/hunt')&&['Relaxed','Tired'].includes(mood(f)??''),'Relaxed or Tired forbids initiating hostilities'),
  deny('request.gather_cycles',f=>requestBounds(f)&&f.params?.cycles!==undefined&&(!Number.isInteger(f.params.cycles)||f.params.cycles<1||f.params.cycles>f.context!.limits.max_gather_cycles),'cycles exceeds resolved gathering policy'),
  deny('request.ticks',f=>requestBounds(f)&&f.params?.max_ticks!==undefined&&(!Number.isInteger(f.params.max_ticks)||f.params.max_ticks<1||f.params.max_ticks>f.context!.limits.max_ticks),'max_ticks exceeds resolved policy'),
  deny('request.withdrawal',f=>requestBounds(f)&&f.params?.retreat_hull_fraction!==undefined&&(!Number.isFinite(f.params.retreat_hull_fraction)||f.params.retreat_hull_fraction<f.context!.limits.retreat_hull_fraction||f.params.retreat_hull_fraction>.95),'Withdrawal override exceeds resolved policy'),
  deny('gather.allocation',f=>admission(f)&&Boolean(f.context)&&f.action==='gather'&&!(f.context!.limits.max_gather_cycles>0),'Gathering allocation is exhausted'),
  rule('stop.productive',f=>Boolean(f.tired||mood(f)==='Tired')&&((admission(f)&&!['observe','plan','return_to_base'].includes(f.action??''))||(f.phase==='command'&&productiveCommand(f))),'Stop latched: productive admission closed; Stop requested before productive command',{allowed:false,obligations:['record_unfinished','preserve_custody','return_and_service'],exit:'return_now'}),
  rule('stop.return',f=>Boolean(f.tired||mood(f)==='Tired')&&f.action==='return_to_base','Tired overrides normal work; preserve custody and verify return',{obligations:['record_unfinished','preserve_custody','return_and_service'],exit:'return_now'}),
  deny('plan.stopped',f=>admission(f)&&f.action==='plan'&&Boolean(f.tired),'Stop is latched; start an explicit new session after return/reconciliation'),
  deny('session.handoff',f=>admission(f)&&Boolean(f.pending)&&f.action!=='return_to_base','Session handoff required before another job'),
  deny('session.reconciliation',f=>admission(f)&&Boolean(f.unresolved),'An unfinished job requires reconciliation; observe it without replay'),
  deny('home.required',f=>admission(f)&&Boolean(f.homeRequired)&&!f.context?.home,'Observe and choose home before work'),
  deny('production.unfinished',f=>admission(f)&&Boolean(f.unfinishedProduction)&&f.action!=='return_to_base','Unfinished production requires settlement by experiment_id before new productive work'),
  deny('one_job.scout',f=>f.phase==='job'&&f.action==='track'&&Boolean(f.admitted?.some(job=>job.action==='track')),'one_job scouting allowance exhausted; no second tracking sortie'),
  deny('one_job.principal',f=>f.phase==='job'&&productiveJobs.has(f.action??'')&&Boolean(f.admitted?.some(job=>productiveJobs.has(job.action))),'one_job productive attempt already admitted'),
  rule('custody.sortie',f=>f.phase==='obligation'&&f.custody===true,'Sortie blocked by active freight or onboard passengers; resolve transport commitments before productive sorties. Return preserves them but does not deliver them.',{allowed:false,obligations:['preserve_custody']}),
  rule('readiness.verified',f=>Array.isArray(f.readiness)&&f.readiness.length===0,'Canonical readiness evidence has no blockers'),
  rule('battle.checkpoint',f=>f.phase==='battle','Evaluate observed participation, assessment, hull, fuel, ammunition and elapsed limits before continuing combat'),
  {id:'readiness.blocked',when:f=>Boolean(f.readiness?.length),then:f=>({allowed:false,reason:f.readiness!.join('; '),obligations:['service_before_departure']})},
  rule('attention.focused',f=>diversion(f)&&mood(f)==='Focused','Focused excludes unrelated work; continue the assigned objective',{allowed:false,exit:'next_checkpoint'}),
  rule('attention.diversion',f=>diversion(f)&&mood(f)!=='Opportunistic'&&mood(f)!=='Focused','This mood does not authorize unrelated diversions',{allowed:false,exit:'next_checkpoint'}),
  rule('attention.opportunistic',f=>diversion(f)&&mood(f)==='Opportunistic'&&(!f.attention||!f.attention.safe||!f.attention!.bounded||f.custody!==false||!Number.isFinite(f.attention!.advantage)||!Number.isFinite(f.attention!.switchingCost)||f.attention!.switchingCost!<0||f.attention!.advantage!<=f.attention!.switchingCost!),'Opportunistic diversion requires a safe checkpoint, no custody, bounded work and measured advantage above switching cost',{allowed:false,exit:'next_checkpoint'}),
  rule('attention.bounded',f=>diversion(f)&&mood(f)==='Opportunistic','Any diversion retains the original objective, gross allowance and stopping bound',{obligations:['preserve_original_allocation']}),
  {id:'allocation.consumer',when:f=>Boolean(f.policyLimits),then:f=>({limits:f.policyLimits,reason:'Consumer retains the resolved policy limits'})},
  deny('logistics.liability',f=>Boolean(f.logistics)&&'liability' in f.logistics!&&(!Number.isFinite(f.logistics!.liability)||(f.logistics!.liability as number)<0||(f.logistics!.liability as number)>(f.policyLimits?.max_liability??0)),'Contract exceeds resolved contingent-liability allocation'),
  deny('logistics.exposure',f=>Boolean(f.logistics)&&'exposure' in f.logistics!&&(!Number.isFinite(f.logistics!.exposure)||(f.logistics!.exposure as number)<0),'Contract exposure is not verified'),
  deny('logistics.reserve',f=>Boolean(f.logistics)&&'credits' in f.logistics!&&(!Number.isFinite(f.logistics!.credits)||(f.logistics!.credits as number)<(f.policyLimits?.credit_reserve??f.context?.limits.credit_reserve??0)),'Wallet reserve unavailable'),
  deny('logistics.route',f=>f.logistics?.jumps!==undefined&&f.logistics.jumps>(f.policyLimits?.max_route_jumps??0),'Route exceeds resolved jump allocation'),
  deny('spend.unknown',f=>['command','spent'].includes(f.phase)&&Boolean(f.paid)&&f.budget?.gross_spend===null,'Unpriced paid command prevents further spending until reconciliation'),
  deny('spend.exceeded',f=>['command','spent'].includes(f.phase)&&Boolean(f.paid)&&Boolean(f.budget)&&f.budget!.gross_spend!==null&&f.budget!.gross_spend>f.budget!.max_spend,'Gross spending already exceeded the job budget'),
  deny('spend.reserve',f=>f.phase==='spent'&&Boolean(f.budget)&&(!Number.isFinite(f.credits)||f.credits!<f.budget!.credit_reserve),'Accepted command exceeded gross job spending budget or wallet reserve'),
  {id:'budget.owner',when:f=>f.phase==='budget'&&Boolean(f.ownerLimits),then:f=>({limits:{max_spend:f.ownerLimits!.max_spend,credit_reserve:f.ownerLimits!.credit_reserve},reason:'Cleanup retains the original gross spending owner and the tighter wallet reserve'})},
  rule('battle.retreat',f=>f.phase==='battle'&&Boolean(f.battle?.retreat||f.battle?.stopped||f.battle?.emptyWeapon),'Retreat remains latched; resolve immediate danger',{allowed:false,exit:'return_now',obligations:['preserve_custody']}),
  rule('battle.evidence',f=>f.phase==='battle'&&(!f.battle?.own||!f.battle.target||!f.battle.combatState||(f.battle.assessment!==undefined?f.battle.assessment!=='engage':f.battle.strangers)),'Combat participation or favorable assessment is not verified',{allowed:false,exit:'return_now'}),
  rule('battle.hull',f=>f.phase==='battle'&&(!Number.isFinite(f.battle?.hullFraction)||f.battle!.hullFraction<0||f.battle!.hullFraction>1||!Number.isFinite(f.battle?.own?.hull_pct)||f.battle!.own!.hull_pct<=f.battle!.hullFraction*100),'Hull reached the enforced retreat margin',{allowed:false,exit:'return_now'}),
  rule('battle.resources',f=>f.phase==='battle'&&((f.battle?.fuel!==undefined&&(!Number.isFinite(f.battle.fuel)||f.battle.fuel<15))||(f.battle?.elapsed!==undefined&&(!Number.isFinite(f.battle.elapsed)||!Number.isFinite(f.battle.maxTicks)||f.battle.maxTicks!<=0||f.battle.elapsed>=f.battle.maxTicks!*10000))),'Combat fuel or duration allowance reached',{allowed:false,exit:'return_now'}),
  rule('terminal.uncertain',f=>f.phase==='terminal'&&f.terminal?.status==='needs_reconciliation','Uncertain job suspended this operating run',{exit:'return_now',obligations:['record_unfinished','reconcile_before_work']}),
  {id:'terminal.blocked',when:f=>f.phase==='terminal'&&f.terminal?.status==='blocked',then:f=>({exit:'return_now',reason:`Blocked ${f.terminal!.action} job: ${f.terminal!.error??'see the job receipt'}`})},
  {id:'terminal.principal',when:f=>f.phase==='terminal'&&f.terminal?.status!=='running'&&productiveJobs.has(f.terminal?.action??''),then:f=>({exit:'return_now',reason:`one_job ${f.terminal!.action} attempt finished`})},
  rule('terminal.scout',f=>f.phase==='terminal'&&f.terminal?.status!=='running'&&f.terminal?.action==='track'&&!f.terminal.eligibleQuarry,'one_job scouting found no eligible quarry',{exit:'return_now'}),
];
