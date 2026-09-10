import {SpacemoltError,type Account} from '@spacemolt/lib';
import {randomUUID} from 'node:crypto';
import {combat,battleStatus,controlHunt} from './combat.ts';
import {combatCatalog} from './combat-metadata.ts';
import {details,type IndustryCommand} from './industry.ts';
import {industryLocations} from './locations.ts';
import {routeSteps} from './survey.ts';
import {serviceShip} from './servicing.ts';
import {CommandBoundary} from './command-boundary.ts';
import {sendAndRefresh} from './execute.ts';
import {validateAction} from './policy.ts';
import {resolveContext,canHunt,type ExecutionContext,type Home} from './execution-policy.ts';
import {reconcileJob} from './recovery.ts';
import {observeObligations,admitProductiveSortie,ObligationObservationError,type Obligations} from './obligations.ts';
import {ExecutionStore,type Job} from './execution-store.ts';
import {ensureReadiness} from './readiness.ts';
import {observeGathering,assessGathering,gatherResources,verifyGatherInventory,type GatherReceipt} from './gather.ts';

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
    common.track=combatCatalog['combat/scout'];
    if(canHunt(context))common.hunt=combatCatalog['combat/hunt'];
  }
  if(context.stance==='Industry') {
    common.assess=meta('Assess a local asteroid belt verification visit, mining readiness and home bounds. Resource contents require arrival observation.',[parameter('poi_id','string','Observed local asteroid belt POI',true)]);
    common.prepare=meta('Service and install owned mining equipment where supported, preserving displaced equipment. No purchases.');
    if(context.limits.max_gather_cycles>0)common.gather=meta('Gather for bounded cycles at a local asteroid belt, retain all new cargo, return home and service. Records partial yield and blockers.',[
      parameter('poi_id','string','Observed local asteroid belt POI',true),parameter('cycles','number','Optional cycle count, only tighter than resolved max_gather_cycles')]);
  }
  return common;
}
export class StopWork extends Error {}
class DefenseInterruption extends StopWork {}
class TravelBlocked extends Error {}
export interface ExecutionDeps {
  locations?:typeof industryLocations;
  combat?:Parameters<typeof combat>[4];
}
export class Execution {
  context:ExecutionContext;
  pending?:ExecutionContext;
  active?:Job;
  private stations:Home[]=[];
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
  signal(reason='Tired') {this.stopping=true;this.store.data.stop=reason;this.store.save();}
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
    if(this.stopping&&['spacemolt/hunt','spacemolt/mine','spacemolt/buy','spacemolt/install_mod','spacemolt/uninstall_mod','spacemolt_storage/withdraw','spacemolt_salvage/loot','spacemolt/scan'].includes(action))throw new StopWork('Stop requested before productive command');
    const entry:Job['actions'][number]={action,params,status:'pending',before:this.snapshot()};
    this.active?.actions.push(entry);this.store.save();
    try {
      const value=await this.boundary.run(async(sent,completed)=>{sent();return sendAndRefresh(this.account,action,params,result=>{completed();entry.accepted_result=result;this.store.save();});});
      entry.status='confirmed';entry.result=value;this.store.save();return value;
    } catch(error) {
      const status=this.boundary.status(error);
      this.uncertain ||= status.fatal;
      entry.status=status.fatal?'uncertain':'confirmed';entry.result={error:String(error),...status};this.store.save();throw error;
    }
  };
  async observe(includeGathering=true) {
    await this.account.refresh();
    const locations=await (this.deps.locations??industryLocations)(this.account.location?.system_id,{});
    this.stations=(locations.stations??[]).map((s:any)=>({...s,rationale:'',observed_at:new Date().toISOString()}));
    const obligations=await observeObligations(this.account,this.command);
    const gathering=includeGathering&&this.context.stance==='Industry'?await observeGathering(this.account,this.command):undefined;
    return {observed_at:new Date().toISOString(),source:'authenticated account and public station directory',state:this.snapshot(),locations,obligations,gathering,context:this.context,stop:this.store.data.stop,receipts:this.store.data.jobs.slice(-5)};
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
    return serviceShip(this.account,this.command,{maxSpend:this.remainingSpend(),creditReserve:this.context.limits.credit_reserve},async()=>{await this.defend();},this.deps.combat);
  }
  private remainingSpend() {
    const before=(this.active?.before as Wire)?.credits??this.account.credits!;
    return Math.max(0,this.context.limits.max_spend-Math.max(0,before-this.account.credits!));
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
  private async returnAttempt() {
    await this.defend();
    const home=this.context.home;
    let destination=home,fallbackReason:string|undefined;
    if(home) {
      if(this.active){this.active.return_plan={home,destination:home,temporary:false};this.store.save();}
      try {await this.travel(home);}
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
    const returnPlan={home,destination:destination!,temporary:Boolean(fallbackReason),reason:fallbackReason};
    if(this.active){this.active.return_plan=returnPlan;this.store.save();}
    return {...returnPlan,service:await this.service()};
  }
  async reconcile() {
    if(this.active)throw new Error('Wait for current command ownership before reconciliation');
    const job=this.store.unresolved();
    if(!job)return {status:'no_unfinished_job'};
    this.signal('Recovery: productive work remains stopped');
    const nextContext=this.context;
    this.context=job.context;this.active=job;
    try {
      return await reconcileJob(this.account,this.store,job,{
        command:this.command,snapshot:()=>this.snapshot(),
        resetBoundary:()=>{this.boundary=new CommandBoundary();this.uncertain=false;},
        returnHome:()=>this.returnHome(),uncertain:()=>this.uncertain,clock:this.deps.combat,
      });
    } finally {this.context=nextContext;this.active=undefined;}
  }
  async dispatch(action:string,params:Wire={}) {
    if(this.dangerPending&&!this.active&&!this.observedDanger)await this.respondToDanger();
    if(action==='observe') {if(this.active)throw new Error('Job owns the connection');return this.observe();}
    if(action==='plan')return this.plan(params);
    if(this.active)throw new Error('A job already owns the connection');
    if(this.pending&&action!=='return_to_base')throw new Error('Session handoff required before another job');
    if(!(action in executionCatalog(this.context)))throw new Error('Tool unavailable under current stance, mood or permission');
    if(this.stopping&&action!=='return_to_base')throw new Error('Stop latched: productive admission closed');
    if(this.store.unresolved())throw new Error('An unfinished job requires reconciliation; observe it without replay');
    if(action==='assess'&&this.context.stance!=='Industry')return combat('assess',params,this.account,this.command,this.deps.combat);
    if(!this.context.home&&action!=='return_to_base')throw new Error('Observe and choose home before work');
    if(Object.keys(params).some(k=>!((executionCatalog(this.context)[action].params??[]) as any[]).some(p=>p.name===k)))throw new Error('Unsupported job parameter');
    for(const field of executionCatalog(this.context)[action].params??[]) {
      const value=params[field.name];
      if(value===undefined&&!field.required)continue;
      const valid=field.type==='string[]'?Array.isArray(value)&&value.every(v=>typeof v==='string'&&v.trim()):field.type==='string'?typeof value==='string'&&Boolean(value.trim()):typeof value===field.type;
      if(!valid)throw new Error(`Invalid or missing ${field.name}`);
    }
    const limits=this.context.limits;
    if(params.cycles!==undefined&&(!Number.isInteger(params.cycles)||params.cycles<1||params.cycles>limits.max_gather_cycles))throw new Error('cycles exceeds resolved gathering policy');
    if(params.max_ticks!==undefined&&(!Number.isInteger(params.max_ticks)||params.max_ticks<1||params.max_ticks>limits.max_ticks))throw new Error('max_ticks exceeds resolved policy');
    if(params.retreat_hull_fraction!==undefined&&(!Number.isFinite(params.retreat_hull_fraction)||params.retreat_hull_fraction<limits.retreat_hull_fraction||params.retreat_hull_fraction>0.95))throw new Error('Withdrawal override exceeds resolved policy');
    if(action==='assess')return assessGathering(this.account,this.command,this.context,{poi_id:params.poi_id,cycles:limits.max_gather_cycles});
    if(action==='return_to_base')this.signal();
    await this.account.refresh();
    const job:Job={id:randomUUID(),action,status:'running',context:structuredClone(this.context),started_at:new Date().toISOString(),before:this.snapshot(),actions:[]};
    this.active=job;this.store.data.jobs.push(job);this.store.save();
    let result:any;
    try {
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
          const destination=this.stations.find(s=>s.base_id===params.base_id);
          if(!destination)throw new Error('Observe destination before travel');
          await this.travel(destination,true);return {destination,service:await this.service()};
        },
        prepare:()=>this.prepare(),
        track:()=>this.sortie('scout',params),hunt:()=>this.sortie('hunt',params),
        gather:()=>this.gather(params),
      };
      if(this.stopping&&action!=='return_to_base')throw new StopWork('Stop requested before work');
      if(['hunt','track','gather'].includes(action))admitProductiveSortie(obligations!,action==='gather'?'Gather':'Hunt');
      result=await handlers[action]!();
      job.result=result;
      if(this.stopping&&action!=='return_to_base'&&!job.return_plan)throw new StopWork('Productive work suspended; return and service before stopping');
      job.status=result?.status==='blocked'?'blocked':this.stopping?'returned_to_base':action==='hunt'&&!result?.sortie?.fight?.verified_victory?'blocked':'completed';
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
      this.store.save();this.active=undefined;
    }
    return structuredClone(job);
  }
  private async prepare():Promise<any> {
    await this.service();
    const limits=this.context.limits;
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
    if(this.context.home?.system_id!==this.account.location?.system_id)throw new Error('Gather requires home in the current system');
    const prepared=await this.prepare();
    if(prepared.status==='blocked') {
      if(this.active){this.active.result={preparation:prepared};this.store.save();}
      throw new Error('Gather mining preparation blocked: '+prepared.readiness.verification.blockers.join('; '));
    }
    const assessment=await assessGathering(this.account,this.command,this.context,plan);
    const gathered=await gatherResources(this.account,this.command,plan,assessment,{
      checkpoint:async()=>{await this.defend();if(this.stopping)throw new StopWork('Productive gathering suspended; return and preserve gathered cargo');},
      save:gather=>{if(this.active){this.active.result={gather};this.store.save();}},
    });
    const cleanup=await this.returnHome();
    verifyGatherInventory(gathered,this.account);
    return {gather:gathered,cleanup,status:gathered.status};
  }
  private async sortie(action:string,params:Wire) {
    await this.service();
    const limits=this.context.limits;
    const sortie:any=await combat(action,{...params,max_ticks:params.max_ticks??limits.max_ticks,retreat_hull_fraction:params.retreat_hull_fraction??limits.retreat_hull_fraction},this.account,this.command,{...this.deps.combat,stopped:this.stopped});
    if(this.active){this.active.result={sortie};this.store.save();}
    return {sortie,cleanup:await this.returnHome(),status:sortie.status};
  }
}
