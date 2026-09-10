import {type Account} from '@spacemolt/lib';
import {randomUUID} from 'node:crypto';
import {combat,battleStatus,controlHunt} from './combat.ts';
import {combatCatalog} from './combat-metadata.ts';
import {details,type IndustryCommand} from './industry.ts';
import {industryLocations} from './locations.ts';
import {routeSteps} from './survey.ts';
import {ensureReadiness} from './readiness.ts';
import {CommandBoundary} from './command-boundary.ts';
import {sendAndRefresh} from './execute.ts';
import {validateAction} from './policy.ts';
import {resolveContext,canHunt,type ExecutionContext,type Home} from './execution-policy.ts';
import {ExecutionStore,type Job} from './execution-store.ts';

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
  return common;
}
export class StopWork extends Error {}
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
  snapshot() {return structuredClone({credits:this.account.credits,ship:this.account.ship,cargo:this.account.cargo,modules:this.account.state.modules,skills:this.account.state.skills,location:this.account.location,missions:this.account.state.missions});}
  private command:IndustryCommand=async(action,params={})=>{
    this.boundary.assertHealthy();
    validateAction(action,params);
    if(this.stopping&&['spacemolt/hunt','spacemolt/buy','spacemolt/install_mod','spacemolt_storage/withdraw','spacemolt_salvage/loot','spacemolt/scan'].includes(action))throw new StopWork('Stop requested before productive command');
    const entry:Job['actions'][number]={action,params,status:'pending'};
    this.active?.actions.push(entry);this.store.save();
    try {
      const value=await this.boundary.run(async(sent,completed)=>{sent();return sendAndRefresh(this.account,action,params,completed);});
      entry.status='confirmed';entry.result=value;this.store.save();return value;
    } catch(error) {
      const status=this.boundary.status(error);
      this.uncertain ||= status.fatal;
      entry.status=status.fatal?'uncertain':'confirmed';entry.result={error:String(error),...status};this.store.save();throw error;
    }
  };
  async observe() {
    await this.account.refresh();
    const locations=await (this.deps.locations??industryLocations)(this.account.location?.system_id,{});
    this.stations=(locations.stations??[]).map((s:any)=>({...s,rationale:'',observed_at:new Date().toISOString()}));
    const obligations={missions:this.account.state.missions,freight:details(await this.command('spacemolt_shipping/active',{})),passengers:details(await this.command('spacemolt/list_passengers',{})),production:details(await this.command('spacemolt/craft',{}))};
    return {observed_at:new Date().toISOString(),source:'authenticated account and public station directory',state:this.snapshot(),locations,obligations,context:this.context,stop:this.store.data.stop,receipts:this.store.data.jobs.slice(-5)};
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
    if(await battleStatus(this.command))await controlHunt(this.account,this.command,'',{force_retreat:true,max_ticks:1,retreat_hull_fraction:0.95},{...this.deps.combat,stopped:this.stopped});
  }
  private async travel(home:Home,productive=false) {
    await this.account.refresh();
    await this.defend();
    if(this.account.location?.in_transit)throw new Error('Transit needs reconciliation; no movement replay');
    if(this.account.location!.system_id!==home.system_id) {
      const quote=details(await this.command('spacemolt/find_route',{id:home.system_id}));
      const steps=routeSteps(quote,this.account.location!.system_id,home.system_id);
      if(!Number.isFinite(quote.estimated_fuel)||this.account.ship!.fuel<quote.estimated_fuel+17)throw new Error('Route breaches fuel reserve');
      if(this.account.location!.docked_at)await this.command('spacemolt/undock',{});
      for(const next of steps) {
        if(productive&&this.stopping)throw new StopWork('Return requested during travel');
        const system=details(await this.command('spacemolt/get_system',{})).system;
        if(!system?.connections?.some((c:any)=>(typeof c==='string'?c:c.system_id)===next))throw new Error('Route is not a verified normal connection');
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
    if(this.account.location!.poi_id!==home.poi_id||this.account.location!.in_transit)throw new Error('POI arrival not verified');
    if(!this.account.location!.docked_at)await this.command('spacemolt/dock',{});
    if(this.account.location!.docked_at!==home.base_id)throw new Error('Docking identity not verified');
  }
  private async service() {
    const base=details(await this.command('spacemolt/get_base',{})),ship=this.account.ship!;
    const price=base.fuel_price_all_in;
    const quote=Number.isFinite(price)&&price>=0?(ship.max_fuel-ship.fuel)*price:undefined;
    const remaining=this.remainingSpend();
    const result=await ensureReadiness(this.account,this.command,{minFuel:ship.max_fuel,minHull:ship.max_hull,creditReserve:this.context.limits.credit_reserve,maxServiceSpend:remaining,serviceQuotes:{refuel:quote}},true);
    // The current API does not expose a verified all-in repair quote here. Keep that blocker.
    if(!result.verification.ready)throw new Error(result.verification.blockers.join('; ')||'Servicing did not reach readiness');
    if(this.account.ship!.shield<this.account.ship!.max_shield)throw new Error('Shields have not recovered; readiness remains blocked');
    return result;
  }
  private remainingSpend() {
    const before=(this.active?.before as Wire)?.credits??this.account.credits!;
    return Math.max(0,this.context.limits.max_spend-Math.max(0,before-this.account.credits!));
  }
  private async returnHome() {
    await this.defend();
    const home=this.context.home;
    if(!home)throw new Error('No chosen home; observe stations and deliberately select home before starting work');
    await this.travel(home);
    return {destination:home,service:await this.service()};
  }
  async dispatch(action:string,params:Wire={}) {
    if(action==='observe') {if(this.active)throw new Error('Job owns the connection');return this.observe();}
    if(action==='plan')return this.plan(params);
    if(this.active)throw new Error('A job already owns the connection');
    if(this.pending)throw new Error('Session handoff required before another job');
    if(!(action in executionCatalog(this.context)))throw new Error('Tool unavailable under current stance, mood or permission');
    if(this.stopping&&action!=='return_to_base')throw new Error('Stop latched: productive admission closed');
    if(this.store.unresolved())throw new Error('An unfinished job requires reconciliation; observe it without replay');
    if(action==='assess')return combat('assess',params,this.account,this.command,this.deps.combat);
    if(!this.context.home)throw new Error('Observe and choose home before work');
    if(Object.keys(params).some(k=>!((executionCatalog(this.context)[action].params??[]) as any[]).some(p=>p.name===k)))throw new Error('Unsupported job parameter');
    for(const field of executionCatalog(this.context)[action].params??[]) {
      const value=params[field.name];
      if(value===undefined&&!field.required)continue;
      const valid=field.type==='string[]'?Array.isArray(value)&&value.every(v=>typeof v==='string'&&v.trim()):field.type==='string'?typeof value==='string'&&Boolean(value.trim()):typeof value===field.type;
      if(!valid)throw new Error(`Invalid or missing ${field.name}`);
    }
    const limits=this.context.limits;
    if(params.max_ticks!==undefined&&(!Number.isInteger(params.max_ticks)||params.max_ticks<1||params.max_ticks>limits.max_ticks))throw new Error('max_ticks exceeds resolved policy');
    if(params.retreat_hull_fraction!==undefined&&(!Number.isFinite(params.retreat_hull_fraction)||params.retreat_hull_fraction<limits.retreat_hull_fraction||params.retreat_hull_fraction>0.95))throw new Error('Withdrawal override exceeds resolved policy');
    if(action==='return_to_base')this.signal();
    await this.account.refresh();
    const job:Job={id:randomUUID(),action,status:'running',context:structuredClone(this.context),started_at:new Date().toISOString(),before:this.snapshot(),actions:[]};
    this.active=job;this.store.data.jobs.push(job);this.store.save();
    let result:any;
    try {
      job.obligations=(await this.observe()).obligations;this.store.save();
      await this.defend();
      const handlers:Record<string,()=>Promise<unknown>>={
        return_to_base:()=>this.returnHome(),
        travel:async()=>{
          const destination=this.stations.find(s=>s.base_id===params.base_id);
          if(!destination)throw new Error('Observe destination before travel');
          await this.travel(destination,true);return {destination,service:await this.service()};
        },
        prepare:async()=>{await this.service();if(this.context.stance!=='Hunt')return {status:'serviced'};return combat('prepare',{execute:true,max_spend:this.remainingSpend(),credit_reserve:limits.credit_reserve},this.account,this.command,this.deps.combat);},
        track:()=>this.sortie('scout',params),hunt:()=>this.sortie('hunt',params),
      };
      if(this.stopping&&action!=='return_to_base')throw new StopWork('Stop requested before work');
      result=await handlers[action]!();
      job.result=result;
      job.status=result?.status==='blocked'?'blocked':this.stopping?'returned_to_base':action==='hunt'&&!result?.sortie?.fight?.verified_victory?'blocked':'completed';
    } catch(error) {
      job.error=error instanceof Error?error.message:String(error);
      try {
        this.boundary.assertHealthy();
        job.status='blocked';
        // Known failures and urgent exits still owe return and servicing.
        job.result={partial:result??job.result,cleanup:await this.returnHome()};
        if(this.stopping)job.status='returned_to_base';
      } catch(cleanupError) {
        job.result={partial:result??job.result,cleanup_error:String(cleanupError)};
        job.status=this.uncertain?'needs_reconciliation':'blocked';
      }
    } finally {
      job.after=this.snapshot();job.cash_delta=this.account.credits!-(job.before as Wire).credits;
      this.store.save();this.active=undefined;
    }
    return structuredClone(job);
  }
  private async sortie(action:string,params:Wire) {
    await this.service();
    const limits=this.context.limits;
    const sortie:any=await combat(action,{...params,max_ticks:params.max_ticks??limits.max_ticks,retreat_hull_fraction:params.retreat_hull_fraction??limits.retreat_hull_fraction},this.account,this.command,{...this.deps.combat,stopped:this.stopped});
    if(this.active){this.active.result={sortie};this.store.save();}
    return {sortie,cleanup:await this.returnHome(),status:sortie.status};
  }
}
