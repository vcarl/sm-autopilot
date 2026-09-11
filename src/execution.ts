import {SpacemoltError,type Account} from '@spacemolt/lib';
import {randomUUID} from 'node:crypto';
import {combat,battleStatus,controlHunt} from './combat.ts';
import {combatCatalog} from './combat-metadata.ts';
import {details,executeIndustry,type IndustryCommand,type IndustryContext} from './industry.ts';
import {industryLocations,type DestinationResolution} from './locations.ts';
import {routeSteps} from './survey.ts';
import {serviceShip} from './servicing.ts';
import {CommandBoundary} from './command-boundary.ts';
import {sendAndRefresh} from './execute.ts';
import {validateAction} from './policy.ts';
import {resolveContext,canHunt,type ExecutionContext,type Home} from './execution-policy.ts';
import {reconcileJob} from './recovery.ts';
import {observeObligations,admitProductiveSortie,ObligationObservationError,type Obligations} from './obligations.ts';
import {ExecutionStore,type Job} from './execution-store.ts';
import {admissionBlocker,terminalStoppingReason} from './execution-stopping.ts';
import {isPaidCommand,jobSpending,jobBudget,requireCommandSpend} from './spending.ts';
import {locateHome} from './home-location.ts';
import {ensureReadiness} from './readiness.ts';
import {assessFreight,transportFreight,type FreightReceipt} from './logistics.ts';
import {assessPassengers,transportPassengers,type PassengerReceipt} from './passengers.ts';
import {discoverPassengerSupply} from './passenger-supply.ts';
import {preparePassengers} from './passenger-fit.ts';
import {logisticsPolicy} from './logistics-policy.ts';
import {validateTransportRoute,transportReceipt} from './execution-logistics.ts';
import {observeGathering,assessGathering,gatherResources,verifyGatherInventory,type GatherReceipt} from './gather.ts';
import {assessProduction,productionWaitSeconds,productionExperiments,productionReceipt,unfinishedProduction,retainProductionAcceptance} from './shared-production.ts';

type Wire=Record<string,any>;
const parameter=(name:string,type:string,description:string,required=false)=>({name,type,description,required});
const meta=(summary:string,params:unknown[]=[])=>({summary,params});
export function executionCatalog(context:ExecutionContext):Record<string,any> {
  const common:Record<string,any>={
    'observe':meta('Refresh authoritative pilot, obligations, nearby stations and recent receipts. No game mutation.'),
    'plan':meta('Choose stance, mood, objective, or an observed home with rationale. Stance/mood changes request a new session; no game mutation.',[
      parameter('stance','string','Stance name'),parameter('mood','string','Mood name'),parameter('objective','string','Objective'),parameter('home_base_id','string','Observed station base ID'),parameter('home_rationale','string','Why this home suits the objective')]),
  };
  if(context.mood==='Tired')return {...common,return_to_base:meta('Safely return to remembered home or explicit observed service fallback, service, and stop. Blockers remain in receipt.')};
  Object.assign(common,{
    assess:combatCatalog['combat/assess'],
    prepare:meta('Service ship and prepare existing hunting fit within the resolved job budget. No equipment replacement.'),
    travel:meta('Travel to an observed station, verify docking, and service. Does not change home.',[parameter('base_id','string','Observed station base ID',true)]),
    return_to_base:meta('Latch stop, return and service; preserves home and unfinished obligations.'),
  });
  if(context.stance==='Hunt') {
    common.track={...(combatCatalog['combat/scout'] as Wire),summary:'One optional scouting sortie for this operating run: visit up to three habitats in one destination system, assess quarry, return and service. No eligible quarry or a blocker stops the run; another tracking sortie is not allowed.'};
    if(canHunt(context))common.hunt=combatCatalog['combat/hunt'];
  }
  if(context.stance==='Industry') {
    common.assess=meta('With poi_id assess gathering. With recipe_id quote local production; without either discover local economic candidates. disposition retain assesses owned output without requiring a profitable sale. Inventory inputs have opportunity cost; quotes are not realized profit.',[
      parameter('poi_id','string','Observed local asteroid belt POI'),parameter('recipe_id','string','Recipe to quote'),parameter('source','string','inventory (default) or buy'),parameter('quantity','number','Output count for a single production run'),parameter('disposition','string','sell (default) or retain in personal station storage'),parameter('output_search','string','With disposition retain and no recipe_id, discover up to six recipes matching an output item ID or name; 1..80 characters')]);
    common.prepare=meta('Service and install owned mining equipment where supported, preserving displaced equipment. No purchases.');
    if(context.limits.max_gather_cycles>0)common.gather=meta('Gather for bounded cycles at a local asteroid belt, retain all new cargo, return home and service. Records partial yield and blockers.',[
      parameter('poi_id','string','Observed local asteroid belt POI',true),parameter('cycles','number','Optional cycle count, only tighter than resolved max_gather_cycles')]);
    common.produce=meta('At home, source inputs and execute one assessed production run, verify sold output or retained personal-storage output, and service. Pending/partial work is unfinished. In a later operating run, pass experiment_id to continue recorded settlement without crafting again or changing disposition.',[
      parameter('recipe_id','string','Recipe for new production'),parameter('source','string','inventory (default) or buy'),parameter('quantity','number','Output count; only one recipe run is supported'),parameter('disposition','string','sell (default) or retain in personal station storage; fixed for the experiment'),parameter('experiment_id','string','Known unfinished experiment to settle, exclusive with recipe/source/quantity/disposition'),parameter('max_wait_seconds','number','Queue waiting bound, 0..120 seconds (default 120)')]);
  }
  if(context.stance==='Logistics') {
    common.assess=meta('Observe freight and passenger opportunities, or assess a selected shipment/destination. Eligibility does not guarantee capacity, timely delivery or profit.',[
      parameter('kind','string','freight or passengers; omit to compare both; passenger_fit quotes economy berth preparation'),parameter('shipment_id','string','Freight contract ID'),parameter('destination','string','Exact destination token from an observed passenger offer; scripts resolve the station')]);
    common.prepare=meta('Service ship. With kind passengers, fit an economy cabin within the host budget, preserving a displaced mining laser in cargo. Quote first with assess kind passenger_fit.',[
      parameter('kind','string','passengers to prepare economy berths; omit for servicing only')]);
    common.transport=meta('Carry one freight contract or passengers for one destination, verify delivery/payment, then return and service. Records unfinished custody. Resume a known interrupted job only by resume_job_id.',[
      parameter('kind','string','freight or passengers'),parameter('shipment_id','string','Freight contract ID'),parameter('destination','string','Passenger destination base ID'),parameter('resume_job_id','string','Prior transport job, exclusive with other fields')]);
  }
  return common;
}
export class StopWork extends Error {}
class DefenseInterruption extends StopWork {}
class TravelBlocked extends Error {}
export interface ExecutionDeps {
  locations?:typeof industryLocations;
  combat?:Parameters<typeof combat>[4];
  industry?:Pick<IndustryContext,'catalog'>;
}
export class Execution {
  context:ExecutionContext;
  pending?:ExecutionContext;
  active?:Job;
  private stations:Home[]=[];
  private passengerSuppliers=new Set<string>();
  private stopping=false;
  private uncertain=false;
  private dangerPending=false;
  private defending=false;
  private observedDanger?:Wire;
  private boundary=new CommandBoundary();
  readonly account:Account;
  readonly store:ExecutionStore;
  readonly deps:ExecutionDeps;
  constructor(account:Account,store:ExecutionStore,context:ExecutionContext,deps:ExecutionDeps={}) {
    this.account=account;this.store=store;this.deps=deps;
    this.context={...context,home:store.data.home};
    store.data.context=this.context;store.save();
    this.stopping=Boolean(store.data.stop)||context.mood==='Tired';
  }
  signal(reason='Tired') {this.stopping=true;this.store.data.stop??=reason;this.store.save();}
  stopped=()=>this.stopping;
  requestDefense() {this.dangerPending=true;}
  async respondToDanger() {
    if(!this.dangerPending)return {status:'no_pending_danger'};
    if(this.active)throw new Error('Active job owns defense checkpoints');
    if(this.store.unresolved())return this.reconcile();
    this.dangerPending=false;
    // A notification is a wake signal, not participation evidence. This probe is
    // read-only; mutations begin only under the durable return job below.
    let battle:Wire|null;
    try {battle=await battleStatus(async(action,params)=>{
      const [tool,name]=action.split('/');return this.account.send(tool!,name!,params);
    });}
    catch(error){this.dangerPending=true;throw error;}
    if(!battle)return {status:'no_active_battle'};
    this.observedDanger=battle;
    return this.dispatch('return_to_base');
  }
  snapshot() {return structuredClone({credits:this.account.credits,ship:this.account.ship,cargo:this.account.cargo,modules:this.account.state.modules,skills:this.account.state.skills,location:this.account.location,missions:this.account.state.missions});}
  private command:IndustryCommand=async(action,params={})=>{
    this.boundary.assertHealthy();
    validateAction(action,params);
    if(this.active&&this.dangerPending&&!this.defending&&!action.startsWith('spacemolt_battle/')) {
      if(await this.defend())throw new DefenseInterruption('Unexpected combat invalidated the pending operation; return before reconsidering work');
    }
    if(this.stopping&&(['spacemolt_shipping/accept','spacemolt_shipping/deliver','spacemolt/load_passenger','spacemolt/unload_passenger','spacemolt/hunt','spacemolt/mine','spacemolt/buy','spacemolt/sell','spacemolt/install_mod','spacemolt/uninstall_mod','spacemolt_storage/deposit','spacemolt_storage/withdraw','spacemolt_salvage/loot','spacemolt/scan'].includes(action)||(action==='spacemolt/craft'&&params.id!==undefined&&params.dry_run!==true)))throw new StopWork('Stop requested before productive command');
    if(this.active&&isPaidCommand(action,params)) {
      const spending=jobBudget(this.active,this.store.data.jobs);
      if(spending.gross_spend===null)throw new Error('Unpriced paid command prevents further spending until reconciliation');
      if(spending.gross_spend>spending.max_spend)throw new Error('Gross spending already exceeded the job budget');
    }
    const entry:Job['actions'][number]={action,params,status:'pending',before:this.snapshot()};
    this.active?.actions.push(entry);this.store.save();
    let value:unknown;
    try {
      value=await this.boundary.run(async(sent,completed)=>{sent();return sendAndRefresh(this.account,action,params,result=>{
        completed();entry.accepted_result=result;
        if(this.active){this.active.spending=jobSpending(this.active);this.active.budget_spending=jobBudget(this.active,this.store.data.jobs);}
        this.store.save();
      });});
      entry.status='confirmed';entry.result=value;this.store.save();
    } catch(error) {
      const status=this.boundary.status(error);
      this.uncertain ||= status.fatal;
      entry.status=status.fatal?'uncertain':'confirmed';entry.result={error:String(error),...status};this.store.save();throw error;
    }
    // An accepted command with missing cost is not an unaccepted command. Keep
    // the healthy boundary available for defensive return, but block more spend.
    if(this.active&&isPaidCommand(action,params)) {
      requireCommandSpend(action,value,params);
      const spending=jobBudget(this.active,this.store.data.jobs);
      if(spending.known_gross_spend>spending.max_spend||this.account.credits!<spending.credit_reserve)throw new Error('Accepted command exceeded gross job spending budget or wallet reserve');
    }
    return value;
  };
  async observe(includeGathering=true) {
    await this.account.refresh();
    const locations=await (this.deps.locations??industryLocations)(this.account.location?.system_id,{});
    this.stations=(locations.stations??[]).map((s:any)=>({...s,rationale:'',observed_at:new Date().toISOString()}));
    const obligations=await observeObligations(this.account,this.command);
    const gathering=includeGathering&&this.context.stance==='Industry'?await observeGathering(this.account,this.command):undefined;
    return {observed_at:new Date().toISOString(),source:'authenticated account and public station directory',state:this.snapshot(),locations,home_location:locateHome(this.context.home,this.account.location,this.stations),obligations,production_experiments:productionExperiments(this.store.data.jobs),gathering,context:this.context,stop:this.store.data.stop,receipts:this.store.data.jobs.slice(-5)};
  }
  plan(params:Wire) {
    if(this.active)throw new Error('Wait for the active job receipt before a normal transition');
    if(this.stopping)throw new Error('Stop is latched; start an explicit new session after return/reconciliation');
    if(Object.keys(params).some(k=>!['stance','mood','objective','home_base_id','home_rationale'].includes(k)))throw new Error('Unsupported plan field; permissions and budgets are host controlled');
    const next=resolveContext(params,this.context);
    if(params.home_base_id!==undefined) {
      const observed=this.stations.find(s=>s.base_id===params.home_base_id);
      if(!observed||typeof params.home_rationale!=='string'||!params.home_rationale.trim())throw new Error('Observe stations first and give a home rationale');
      next.home={...observed,rationale:params.home_rationale};
    }
    this.store.data.home=next.home;this.store.data.context=next;this.store.save();
    this.pending=next;
    return {status:'handoff_required',context:next};
  }
  handoff() {
    if(this.active)throw new Error('Cannot hand off an active job');
    if(this.pending) {this.context=this.pending;this.pending=undefined;if(this.context.mood==='Tired')this.signal();}
    return {context:this.context,catalog:executionCatalog(this.context)};
  }
  private async defend() {
    if(this.defending)return false;
    this.defending=true;
    this.dangerPending=false;
    const observed=this.observedDanger;this.observedDanger=undefined;
    try {
      const battle=observed??await battleStatus(this.command);
      if(!battle)return false;
      this.signal('Unexpected battle: productive work suspended for defensive return');
      const evidence:Wire={observed_at:new Date().toISOString(),battle,status:'running'};
      if(this.active){this.active.defense??=[];this.active.defense.push(evidence);this.store.save();}
      evidence.result=await controlHunt(this.account,this.command,'',{observed_battle:battle,force_retreat:true,max_ticks:1,retreat_hull_fraction:0.95},{...this.deps.combat,stopped:this.stopped});
      evidence.status='completed';this.store.save();
      return true;
    } finally {this.defending=false;}
  }
  private async travel(home:Home,productive=false) {
    await this.account.refresh();
    await this.defend();
    if(this.account.location?.in_transit)throw new Error('Transit needs reconciliation; no movement replay');
    if(this.account.location!.system_id!==home.system_id) {
      const quote=details(await this.command('spacemolt/find_route',{id:home.system_id}));
      let steps:string[];
      try {steps=routeSteps(quote,this.account.location!.system_id,home.system_id);}
      catch(error) {throw new TravelBlocked(String(error));}
      if(!Number.isFinite(quote.estimated_fuel)||this.account.ship!.fuel<quote.estimated_fuel+17)throw new TravelBlocked('Route breaches fuel reserve');
      if(this.account.location!.docked_at)await this.command('spacemolt/undock',{});
      for(const next of steps) {
        if(productive&&this.stopping)throw new StopWork('Return requested during travel');
        const system=details(await this.command('spacemolt/get_system',{})).system;
        if(!system?.connections?.some((c:any)=>(typeof c==='string'?c:c.system_id)===next))throw new TravelBlocked('Route is not a verified normal connection');
        await this.command('spacemolt/jump',{id:next});
        if(this.account.location!.system_id!==next||this.account.location!.in_transit)throw new Error('Jump not verified');
        await this.defend();
      }
    }
    if(productive&&this.stopping)throw new StopWork('Return requested during travel');
    if(this.account.location!.poi_id!==home.poi_id) {
      if(this.account.location!.docked_at)await this.command('spacemolt/undock',{});
      await this.command('spacemolt/travel',{id:home.poi_id});await this.defend();
    }
    if(productive&&this.stopping)throw new StopWork('Return requested after travel checkpoint');
    if(this.account.location!.poi_id!==home.poi_id||this.account.location!.in_transit)throw new Error('POI arrival not verified');
    if(!this.account.location!.docked_at)await this.command('spacemolt/dock',{});
    if(this.account.location!.docked_at!==home.base_id)throw new Error('Docking identity not verified');
  }
  private async service() {
    const creditReserve=this.active?jobBudget(this.active,this.store.data.jobs).credit_reserve:this.context.limits.credit_reserve;
    return serviceShip(this.account,this.command,{maxSpend:this.remainingSpend(),creditReserve},async()=>{await this.defend();},this.deps.combat);
  }
  private remainingSpend() {
    if(!this.active)return this.context.limits.max_spend;
    const spending=jobBudget(this.active,this.store.data.jobs);
    return spending.gross_spend===null?0:Math.max(0,spending.max_spend-spending.gross_spend);
  }
  private async returnHome() {
    for(let replan=0;;replan++) {
      try {return await this.returnAttempt();}
      catch(error) {
        if(!(error instanceof DefenseInterruption)||replan>=1)throw error;
        // Defense invalidated a safety operation, not its obligation to return.
        // Recompute route/service inputs once; never resend the stale command.
        if(this.active){this.active.return_reassessments??=[];this.active.return_reassessments.push({at:new Date().toISOString(),reason:error.message,state:this.snapshot()});this.store.save();}
      }
    }
  }
  private async homeLocation() {
    await this.account.refresh();
    const resolved=locateHome(this.context.home,this.account.location);
    if(resolved.source==='authenticated_home_dock'||!this.context.home)return resolved;
    const directory=await (this.deps.locations??industryLocations)(this.account.location?.system_id,{});
    return locateHome(this.context.home,this.account.location,directory.stations??[]);
  }
  private async returnAttempt() {
    await this.account.refresh();
    await this.defend();
    const home=this.context.home;
    const location=this.account.location;
    if(location?.in_transit)throw new Error('Return requires transit reconciliation; no movement replay');
    const owner=this.active?.budget_owner_id??this.active?.id;
    const prior=this.store.runJobs().filter(job=>job!==this.active&&(job.budget_owner_id??job.id)===owner).at(-1);
    const previous=prior?.return_plan;
    // A final return re-verifies the safe destination already reached by this
    // job. It must not restart a known-failed home route or acquire a new budget.
    if(previous?.temporary&&location?.system_id&&location.poi_id&&previous.home?.base_id===home?.base_id&&
      previous.destination.base_id===location?.docked_at&&
      (prior?.after as Wire)?.ship?.id===this.account.ship?.id&&
      (prior?.after as Wire)?.location?.docked_at===location?.docked_at) {
      const destination={base_id:previous.destination.base_id,rationale:previous.destination.rationale,system_id:location.system_id,poi_id:location.poi_id,observed_at:new Date().toISOString()};
      const plan={...previous,home,destination,reused_from_job_id:prior!.id};
      if(this.active){this.active.return_plan=plan;this.store.save();}
      return {...plan,service:await this.service()};
    }
    let destination=home,fallbackReason:string|undefined;
    let homeLocationSource:string|undefined;
    if(home) {
      const resolved=await this.homeLocation();
      destination=resolved.destination!;homeLocationSource=resolved.source;
      if(this.active){this.active.return_plan={home,destination,temporary:false,home_location_source:homeLocationSource};this.store.save();}
      try {await this.travel(destination);}
      catch(error) {
        this.boundary.assertHealthy();
        if(!(error instanceof TravelBlocked)&&!(error instanceof SpacemoltError))throw error;
        fallbackReason=String(error);
      }
    } else fallbackReason='No home chosen; use a temporary service stop without establishing home';
    if(fallbackReason) {
      const location=this.account.location;
      if(location?.in_transit)throw new Error('Return requires transit reconciliation; no fallback movement');
      const observedAt=new Date().toISOString();
      if(location?.docked_at&&location.docked_at!==home?.base_id) {
        destination={system_id:location.system_id,poi_id:location.poi_id!,base_id:location.docked_at,rationale:'Already at a verified temporary dock',observed_at:observedAt};
      } else {
        const directory=await (this.deps.locations??industryLocations)(location?.system_id,{});
        // One candidate per return attempt; no unbounded station hopping after rejection.
        const candidate=(directory.stations??[]).find(s=>s.base_id!==home?.base_id&&s.services.includes('refuel'));
        if(!candidate)throw new Error(`No observed service fallback: ${fallbackReason}`);
        destination={...candidate,rationale:'Nearest observed refuel station after home return was unavailable',observed_at:observedAt};
      }
      if(this.active){this.active.return_plan={home,destination,temporary:true,reason:fallbackReason};this.store.save();}
      await this.travel(destination!);
    }
    const returnPlan={home,destination:destination!,temporary:Boolean(fallbackReason),reason:fallbackReason,home_location_source:homeLocationSource};
    if(this.active){this.active.return_plan=returnPlan;this.store.save();}
    return {...returnPlan,service:await this.service()};
  }
  async reconcile() {
    if(this.active)throw new Error('Wait for current command ownership before reconciliation');
    const job=this.store.unresolved();
    if(!job)return {status:'no_unfinished_job',stopping_reason:this.stopping?(this.store.data.stop??'Tired'):undefined,
      receipts:this.stopping?structuredClone(this.store.runJobs()):[]};
    this.signal('Recovery: productive work remains stopped');
    const nextContext=this.context;
    this.context=job.context;this.active=job;
    try {
      await reconcileJob(this.account,this.store,job,{
        command:this.command,snapshot:()=>this.snapshot(),
        resetBoundary:()=>{this.boundary=new CommandBoundary();this.uncertain=false;},
        returnHome:()=>this.returnHome(),uncertain:()=>this.uncertain,clock:this.deps.combat,
      });
      retainProductionAcceptance(job);
      const production=productionReceipt(job.result);
      if(production?.pending_action||production?.accounting_unverified)job.status='needs_reconciliation';
      const transport=transportReceipt(job.result);
      if(transport?.pending_action||transport?.accounting_unverified)job.status='needs_reconciliation';
      job.stopping_reason=this.store.data.stop;this.store.save();return structuredClone(job);
    } finally {this.context=nextContext;this.active=undefined;}
  }
  async dispatch(action:string,params:Wire={}) {
    if(this.dangerPending&&!this.active&&!this.observedDanger)await this.respondToDanger();
    if(action==='observe') {if(this.active)throw new Error('Job owns the connection');return this.observe();}
    if(action==='plan')return this.plan(params);
    if(this.active)throw new Error('A job already owns the connection');
    if(this.pending&&action!=='return_to_base')throw new Error('Session handoff required before another job');
    if(!(action in executionCatalog(this.context)))throw new Error('Tool unavailable under current stance, mood or permission');
    if(this.store.unresolved())throw new Error('An unfinished job requires reconciliation; observe it without replay');
    if(this.stopping&&action!=='return_to_base')throw new Error('Stop latched: productive admission closed');
    if(action==='assess'&&!['Industry','Logistics'].includes(this.context.stance))return combat('assess',params,this.account,this.command,this.deps.combat);
    if(!this.context.home&&action!=='return_to_base'&&!(action==='assess'&&(this.context.stance==='Logistics'||this.context.stance==='Industry'&&!params.poi_id)))throw new Error('Observe and choose home before work');
    if(Object.keys(params).some(k=>!((executionCatalog(this.context)[action].params??[]) as any[]).some(p=>p.name===k)))throw new Error('Unsupported job parameter');
    for(const field of executionCatalog(this.context)[action].params??[]) {
      const value=params[field.name];
      if(value===undefined&&!field.required)continue;
      const valid=field.type==='string[]'?Array.isArray(value)&&value.every(v=>typeof v==='string'&&v.trim()):field.type==='string'?typeof value==='string'&&Boolean(value.trim()):typeof value===field.type;
      if(!valid)throw new Error(`Invalid or missing ${field.name}`);
    }
    if(this.context.stance==='Logistics') {
      const kinds=action==='assess'?['freight','passengers','passenger_fit']:action==='prepare'?['passengers']:['freight','passengers'];
      if(params.kind!==undefined&&!kinds.includes(params.kind))throw new Error('Unsupported Logistics kind for this tool');
      if(params.kind==='passenger_fit'&&(params.shipment_id||params.destination))throw new Error('Passenger fitting assessment takes no shipment or destination');
      if(params.resume_job_id&&Object.keys(params).some(key=>key!=='resume_job_id'))throw new Error('Resume uses only resume_job_id');
      if(params.kind==='freight'&&params.destination||params.kind==='passengers'&&params.shipment_id)throw new Error('Select one transport kind');
      if(action==='transport'&&!params.resume_job_id&&(!params.kind||params.kind==='freight'&&!params.shipment_id||params.kind==='passengers'&&!params.destination))throw new Error('Select a freight shipment or passenger destination');
      if(action==='assess')return this.assessLogistics(params);
    }
    const limits=this.context.limits;
    if(params.cycles!==undefined&&(!Number.isInteger(params.cycles)||params.cycles<1||params.cycles>limits.max_gather_cycles))throw new Error('cycles exceeds resolved gathering policy');
    if(params.max_ticks!==undefined&&(!Number.isInteger(params.max_ticks)||params.max_ticks<1||params.max_ticks>limits.max_ticks))throw new Error('max_ticks exceeds resolved policy');
    if(params.retreat_hull_fraction!==undefined&&(!Number.isFinite(params.retreat_hull_fraction)||params.retreat_hull_fraction<limits.retreat_hull_fraction||params.retreat_hull_fraction>0.95))throw new Error('Withdrawal override exceeds resolved policy');
    if(params.source!==undefined&&!['inventory','buy'].includes(params.source))throw new Error('source must be inventory or buy');
    if(params.disposition!==undefined&&!['sell','retain'].includes(params.disposition))throw new Error('disposition must be sell or retain');
    if(params.output_search!==undefined&&(action!=='assess'||params.disposition!=='retain'||params.recipe_id||params.poi_id||params.output_search.length>80))throw new Error('output_search requires retained-output assessment without recipe_id or poi_id, at most 80 characters');
    if(params.quantity!==undefined&&(!Number.isInteger(params.quantity)||params.quantity<1||params.quantity>1000))throw new Error('quantity must be an integer 1..1000');
    if(params.max_wait_seconds!==undefined&&(!Number.isFinite(params.max_wait_seconds)||params.max_wait_seconds<0||params.max_wait_seconds>productionWaitSeconds))throw new Error('max_wait_seconds must be 0..120');
    if(action==='assess') {
      if(params.poi_id) {
        if(params.recipe_id||params.source||params.quantity!==undefined||params.disposition!==undefined)throw new Error('Assess gathering or production separately');
        return assessGathering(this.account,this.command,{...this.context,home:(await this.homeLocation()).destination},{poi_id:params.poi_id,cycles:limits.max_gather_cycles});
      }
      await this.account.refresh();
      return assessProduction(params,this.account,this.command,{...this.deps.industry,record:()=>{},existing_experiments:productionExperiments(this.store.data.jobs)});
    }
    if(action==='produce'&&((!params.recipe_id&&!params.experiment_id)||(params.experiment_id&&(params.recipe_id||params.source||params.quantity!==undefined||params.disposition!==undefined))))throw new Error('Provide recipe_id for new production or only experiment_id for settlement');
    if(action==='return_to_base')this.signal();
    const allowanceBlocker=admissionBlocker(action,this.store.runJobs());
    await this.account.refresh();
    const job:Job={id:randomUUID(),action,status:'running',context:structuredClone(this.context),started_at:new Date().toISOString(),before:this.snapshot(),actions:[]};
    const predecessor=this.store.runJobs().at(-1);
    if(action==='return_to_base'&&predecessor)job.budget_owner_id=predecessor.budget_owner_id??predecessor.id;
    if(action==='produce'&&params.experiment_id) {
      const owner=this.store.data.jobs.find(previous=>productionReceipt(previous.result)?.experiment_id===params.experiment_id);
      if(owner)job.budget_owner_id=owner.budget_owner_id??owner.id;
    }
    if(action==='transport'&&params.resume_job_id) {
      const owner=this.store.data.jobs.find(previous=>previous.id===params.resume_job_id&&previous.action==='transport');
      if(!owner)throw new Error('Unknown transport job');
      job.budget_owner_id=owner.budget_owner_id??owner.id;
    }
    this.active=job;this.store.data.jobs.push(job);this.store.save();
    let result:any;
    try {
      if(allowanceBlocker)throw new Error(allowanceBlocker);
      const unfinished=unfinishedProduction(this.store.data.jobs);
      if(action!=='return_to_base'&&unfinished.some(row=>action!=='produce'||row.experiment_id!==params.experiment_id))throw new Error('Unfinished production requires settlement by experiment_id before new productive work');
      if(this.observedDanger)await this.defend();
      let obligations:Obligations|undefined;
      try {
        obligations=(await this.observe(action!=='return_to_base')).obligations;
        job.obligations=obligations;
      } catch(error) {
        if(action!=='return_to_base'||!(error instanceof ObligationObservationError))throw error;
        job.obligation_admission_error=String(error);
      }
      this.store.save();
      await this.defend();
      const handlers:Record<string,()=>Promise<unknown>>={
        return_to_base:()=>this.returnHome(),
        travel:async()=>{
          if(this.context.stance==='Logistics'&&this.passengerSuppliers.has(params.base_id)) {
            const matches=await this.resolvePassengerDestinations([params.base_id]);
            const match=matches.find(row=>row.requested_id===params.base_id);
            if(match?.status!=='resolved'||match.station?.base_id!==params.base_id)throw new Error(`Observed cabin supplier cannot be resolved within current route policy: ${match?.status??'missing'}`);
          }
          const destination=this.stations.find(s=>s.base_id===params.base_id);
          if(!destination)throw new Error('Observe destination before travel');
          await this.travel(destination,true);return {destination,service:await this.service()};
        },
        prepare:()=>this.prepare(params),
        track:()=>this.sortie('scout',params),hunt:()=>this.sortie('hunt',params),
        gather:()=>this.gather(params),
        produce:()=>this.produce(params,obligations!),
        transport:()=>this.transport(params,obligations!),
      };
      if(this.stopping&&action!=='return_to_base')throw new StopWork('Stop requested before work');
      if(['hunt','track','gather','produce'].includes(action))admitProductiveSortie(obligations!,this.context.stance);
      result=await handlers[action]!();
      job.result=result;
      if(result?.status==='blocked'&&action!=='return_to_base'&&!job.return_plan)throw new Error(result.reason??'Job returned a blocker');
      if(this.stopping&&action!=='return_to_base'&&!job.return_plan)throw new StopWork('Productive work suspended; return and service before stopping');
      job.status=action==='transport'&&result?.transport?.status!=='completed'?(result?.transport?.status==='needs_reconciliation'?'needs_reconciliation':'blocked'):action==='produce'&&result?.production?.status!=='complete'?(result?.production?.status==='needs_reconciliation'?'needs_reconciliation':'blocked'):result?.status==='blocked'?'blocked':this.stopping?'returned_to_base':action==='hunt'&&!result?.sortie?.fight?.verified_victory?'blocked':'completed';
    } catch(error) {
      job.error=error instanceof Error?error.message:String(error);
      try {
        this.boundary.assertHealthy();
        job.status='blocked';
        // Known failures and urgent exits still owe return and servicing.
        if(action==='return_to_base'||job.return_plan)throw error;
        job.result={partial:result??job.result,cleanup:await this.returnHome()};
        if(this.stopping)job.status='returned_to_base';
      } catch(cleanupError) {
        job.result={partial:result??job.result,cleanup_error:String(cleanupError)};
        job.status=this.uncertain?'needs_reconciliation':'blocked';
      }
    } finally {
      retainProductionAcceptance(job);
      if(this.uncertain)job.obligation_verification={status:'unavailable',reason:'Command uncertainty prevents terminal observation; admission evidence is retained'};
      else {
        try {
          await this.account.refresh();
          job.obligations_after=await observeObligations(this.account,this.command);
          job.obligation_verification={status:'observed',reason:'Outstanding commitments are recorded, not declared delivered or settled'};
        } catch(error) {
          job.obligation_verification={status:'unavailable',reason:String(error)};
          job.status=this.uncertain?'needs_reconciliation':'blocked';
        }
        if(action==='gather'&&!this.uncertain) {
          let progress=job.result as Wire|undefined;
          while(progress?.partial)progress=progress.partial;
          if(progress?.gather) {
            try {verifyGatherInventory(progress.gather as GatherReceipt,this.account);}
            catch(error){job.error??=String(error);job.status='blocked';}
          }
        }
      }
      job.after=this.snapshot();job.cash_delta=this.account.credits!-(job.before as Wire).credits;
      job.spending=jobSpending(job);
      job.budget_spending=jobBudget(job,this.store.data.jobs);
      const transport=transportReceipt(job.result);
      if(transport?.pending_action||transport?.accounting_unverified)job.status='needs_reconciliation';
      else if(action==='transport'&&transport?.status!=='completed'&&job.status!=='needs_reconciliation')job.status='blocked';
      const production=productionReceipt(job.result);
      if(production?.pending_action||production?.accounting_unverified)job.status='needs_reconciliation';
      else if(action==='produce'&&production?.status!=='complete'&&job.status!=='needs_reconciliation')job.status='blocked';
      if(job.budget_spending.gross_spend===null)job.status='needs_reconciliation';
      else if(job.budget_spending.gross_spend>job.budget_spending.max_spend)job.status='blocked';
      const stoppingReason=this.store.data.stop??terminalStoppingReason(job);
      if(stoppingReason){this.signal(stoppingReason);job.stopping_reason=stoppingReason;}
      this.store.save();this.active=undefined;
    }
    return structuredClone(job);
  }
  private async prepare(params:Wire={}):Promise<any> {
    await this.service();
    const limits=this.context.limits;
    if(this.context.stance==='Logistics'&&params.kind==='passengers') {
      admitProductiveSortie(await observeObligations(this.account,this.command),'Passenger fitting');
      const fit=await preparePassengers({execute:true,max_spend:this.remainingSpend(),credit_reserve:limits.credit_reserve},this.account,this.command);
      return {...fit,...(fit.status==='blocked'?{reason:fit.blockers.join('; ')}:{})};
    }
    if(this.context.stance==='Industry') {
      if(this.stopping)throw new StopWork('Stop requested before mining preparation');
      const readiness=await ensureReadiness(this.account,this.command,{requireMining:true,minFreeCargo:10,creditReserve:limits.credit_reserve},true);
      return {status:readiness.verification.ready?'prepared':'blocked',readiness};
    }
    if(this.context.stance==='Hunt')return combat('prepare',{execute:true,max_spend:this.remainingSpend(),credit_reserve:limits.credit_reserve},this.account,this.command,this.deps.combat);
    return {status:'serviced'};
  }
  private async gather(params:Wire) {
    const cycles=params.cycles??this.context.limits.max_gather_cycles;
    const plan={poi_id:params.poi_id,cycles};
    // Home bounds precede fitting or departure.
    const homeLocation=await this.homeLocation();
    if(homeLocation.destination?.system_id!==this.account.location?.system_id)throw new Error('Gather requires home in the current system');
    const prepared=await this.prepare();
    if(prepared.status==='blocked') {
      if(this.active){this.active.result={preparation:prepared};this.store.save();}
      throw new Error('Gather mining preparation blocked: '+prepared.readiness.verification.blockers.join('; '));
    }
    const assessment=await assessGathering(this.account,this.command,{...this.context,home:homeLocation.destination},plan);
    const gathered=await gatherResources(this.account,this.command,plan,assessment,{
      checkpoint:async()=>{await this.defend();if(this.stopping)throw new StopWork('Productive gathering suspended; return and preserve gathered cargo');},
      save:gather=>{if(this.active){this.active.result={gather};this.store.save();}},
    });
    const cleanup=await this.returnHome();
    verifyGatherInventory(gathered,this.account);
    return {gather:gathered,cleanup,status:gathered.status};
  }
  private async resolvePassengerDestinations(ids:string[]):Promise<DestinationResolution[]> {
    const observation=await (this.deps.locations??industryLocations)(this.account.location?.system_id,{
      max_jumps:logisticsPolicy(this.context).max_route_jumps,observed_destination_ids:ids,
    });
    const matches=observation.destination_matches??ids.map(requested_id=>({requested_id,status:'missing' as const}));
    for(const match of matches)if(match.status==='resolved'&&match.station) {
      this.stations=this.stations.filter(row=>row.base_id!==match.station!.base_id);
      this.stations.push(match.station);
    }
    return matches;
  }
  private async assessLogistics(params:Wire) {
    await this.observe(false);
    const policy={...logisticsPolicy(this.context),stations:this.stations,resolveDestinations:(ids:string[])=>this.resolvePassengerDestinations(ids)};
    if(params.kind==='passenger_fit') {
      const fitting=await preparePassengers({max_spend:this.context.limits.max_spend,credit_reserve:this.context.limits.credit_reserve},this.account,this.command);
      const quote=fitting.plan.find(step=>step.action==='spacemolt/buy')?.quote;
      if(fitting.status!=='blocked'||fitting.blockers.some(reason=>reason!=='Complete economy cabin purchase quote unavailable')||quote?.quantity_requested!==1||quote.available!==0||quote.unfilled!==1||!Array.isArray(quote.fills)||quote.fills.length!==0)return fitting;
      const supply_discovery=await discoverPassengerSupply(this.account.location?.system_id,policy.max_route_jumps,this.command,this.deps.locations);
      for(const candidate of supply_discovery.candidates) {
        this.passengerSuppliers.add(candidate.base_id as string);
        this.stations=this.stations.filter(station=>station.base_id!==candidate.base_id);
        this.stations.push({...candidate,rationale:'Dated cabin supply lead matched to public station identity',observed_at:supply_discovery.observed_at} as Home);
      }
      return {...fitting,supply_discovery};
    }
    if(params.kind==='freight'||params.shipment_id)return assessFreight(this.account,this.command,params,policy);
    if(params.kind==='passengers'||params.destination)return assessPassengers(this.account,this.command,params,policy);
    return {policy,freight:await assessFreight(this.account,this.command,{},policy),passengers:await assessPassengers(this.account,this.command,{},policy)};
  }
  private async transport(params:Wire,obligations:Obligations) {
    const previous=params.resume_job_id?this.store.data.jobs.find(job=>job.id===params.resume_job_id):undefined;
    const resume=previous?transportReceipt(previous.result):undefined;
    if(previous&&(!resume||resume.pending_action||resume.accounting_unverified||resume.status==='completed'))throw new Error('Transport must have verified unfinished custody before resuming');
    if(!resume)admitProductiveSortie(obligations,'Transport');
    await this.service();
    const policy=logisticsPolicy(this.context),kind=resume?.kind??params.kind;
    const destination=(id:string)=>{
      const station=this.stations.find(row=>row.base_id===id);
      if(!station)throw new Error('Observe transport destination before departure');
      return station;
    };
    const controls={
      checkpoint:async()=>{await this.defend();if(this.stopping)throw new StopWork('Transport suspended; preserve cargo and passenger obligations');},
      record:(receipt:any)=>{this.active!.result={transport:{...receipt,kind},transport_policy:policy};this.store.save();},
      validateRoute:(id:string)=>validateTransportRoute(this.account,this.command,destination(id),this.context),
      travel:async(id:string)=>{
        const start=this.active!.actions.length;
        await this.travel(destination(id),true);
        return {dock_receipts:this.active!.actions.slice(start).filter(entry=>entry.action==='spacemolt/dock').map(entry=>entry.accepted_result??entry.result)};
      },
    };
    let receipt:any;
    if(kind==='passengers') {
      const token=resume?.destination??params.destination;
      let base=this.stations.find(row=>row.base_id===token)?.base_id;
      if(!base) {
        const match=(await this.resolvePassengerDestinations([token])).find(row=>row.requested_id===token);
        if(match?.status!=='resolved'||!match.station)throw new Error(`Passenger destination resolution: ${match?.status??'missing'}`);
        base=match.station.base_id;
      }
      receipt=await transportPassengers(this.account,this.command,{destination:token,destination_base_id:base,resume:resume as PassengerReceipt|undefined},controls);
    }
    else {
      const assessment=resume?.assessment??await assessFreight(this.account,this.command,params,{...policy,stations:this.stations});
      receipt=await transportFreight(this.account,this.command,{shipment_id:resume?.shipment_id??params.shipment_id,...(resume?{resume:resume as FreightReceipt,policy:{...policy,stations:this.stations}}: {})},assessment,controls);
    }
    controls.record(receipt);
    return {transport:{...receipt,kind},transport_policy:policy,cleanup:await this.returnHome()};
  }
  private async produce(params:Wire,obligations:Obligations) {
    const home=(await this.homeLocation()).destination;
    if(!home||this.account.location?.docked_at!==home.base_id)throw new Error('Local production requires docking at the chosen home; travel there first');
    const experiments=productionExperiments(this.store.data.jobs);
    const existing=params.experiment_id?experiments.find(row=>row.experiment_id===params.experiment_id):undefined;
    if(params.experiment_id&&(!existing||existing.station!==home.base_id))throw new Error('Unknown experiment or wrong station for settlement');
    if(existing&&['complete','aborted'].includes(existing.status))throw new Error('Experiment is already terminal; settlement cannot be counted again');
    if(existing&&(existing.pending_action||existing.accounting_unverified))throw new Error('Unresolved production acceptance/accounting requires reconciliation; no automatic settlement');
    if((obligations.production.jobs??[]).some((queued:Wire)=>queued.job_id!==existing?.job_id))throw new Error('Other queued production must be resolved before this local production job');
    await this.service();
    const production=await executeIndustry(existing?'settle':'produce',{
      ...params,max_wait_seconds:params.max_wait_seconds??productionWaitSeconds,
      max_spend:this.remainingSpend(),credit_reserve:this.active?jobBudget(this.active,this.store.data.jobs).credit_reserve:this.context.limits.credit_reserve,
    },this.account,this.command,{
      ...this.deps.industry,...this.deps.combat,existing_experiments:experiments,
      checkpoint:async()=>{await this.defend();if(this.stopping)throw new StopWork('Production suspended; preserve queued work and unsold output before return');},
      record:row=>{if(row.experiment_id&&this.active){this.active.result={production:structuredClone(row)};this.store.save();}},
    });
    if(this.active){this.active.result={production};retainProductionAcceptance(this.active);this.store.save();}
    return {production,cleanup:await this.returnHome()};
  }
  private async sortie(action:string,params:Wire) {
    await this.service();
    const limits=this.context.limits;
    const sortie:any=await combat(action,{...params,max_ticks:params.max_ticks??limits.max_ticks,retreat_hull_fraction:params.retreat_hull_fraction??limits.retreat_hull_fraction},this.account,this.command,{...this.deps.combat,stopped:this.stopped});
    if(this.active){this.active.result={sortie};this.store.save();}
    return {sortie,cleanup:await this.returnHome(),status:sortie.status};
  }
}
