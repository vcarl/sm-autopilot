import {FuelJournal,lastCrossing,moodBeforeTired,recoveryRungs,type CrossingRule,type FuelTransition,
  type MarginEvidence,type ServicedStation} from './fuel-journal.ts';
import {resolveFuelReserve,resolveWalkAway,type Mood,type OperatorFuelPolicy} from './mood-policy.ts';
import {FuelRouteShortfall,TravelBlocked,travelTo,type TravelDestination,type TravelOptions,type FuelRouteEvidence} from './travel.ts';
import {DockBlocked} from './dock.ts';
import {ServiceBlocked,serviceShip} from './servicing.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {routeSteps} from './normal-route.ts';

export class FuelMarginUnresolved extends TravelBlocked {}
export class FuelTired extends TravelBlocked {}

/** D3's resources. Ammunition needs a magazine read this tree does not have yet. */
export type MarginName='fuel'|'hull'|'credits';
type FuelRow={name:'fuel';rule:'D3.fuel';shortfall:number;message:string;evidence:FuelRouteEvidence};
type MarginRow={name:'hull'|'credits';rule:'D3.hull'|'D3.credits';shortfall:number;message:string;evidence:MarginEvidence};
type Row=FuelRow|MarginRow;
export interface TiredCycleOptions {
  operatorPolicy?:OperatorFuelPolicy;
  /** Operator permission (D11), passed through to the service counter. */
  creditReserve?:number;
  /** Rungs of R13's ladder before the pilot asks strangers for help. */
  maxWaits?:number;
  travel?:Omit<TravelOptions,'mood'|'reserve'|'fuelExecution'>;
}
export interface TiredCycleResult {
  outcome:'restored'|'waiting'|'distress'|'failed';
  crossed:MarginName[];
  restored_mood?:Mood;
  reason?:string;
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const gap=(label:string,have:number,need:number,unit:string)=>
  `${label}: have ${have}, need ${need}; shortfall ${need-have} ${unit}`;
const marginOf=(rule:CrossingRule)=>rule.split('.')[1] as MarginName;

/** Concrete execution consumer; borrows the runner's connection and persists before returning control. */
export class FuelTravelExecution {
  readonly journal:FuelJournal;
  private stations:ServicedStation[];
  constructor(journal:FuelJournal,stations:ServicedStation[]) {
    this.journal=journal;this.stations=structuredClone(stations);
  }
  async travel(account:ReadinessAccount,command:ReadinessCommand,destination:TravelDestination,
    options:Omit<TravelOptions,'mood'|'reserve'|'fuelExecution'>={}) {
    this.journal.assertReady();
    const mood=this.journal.snapshot.state.mood;
    if(mood==='Tired')throw new FuelTired('Tired: recovery travel remains unresolved');
    return travelTo(account,command,destination,{...options,mood,fuelExecution:this});
  }
  /** D3 at a checkpoint: any crossed margin imposes Tired, whatever the agent wanted. */
  async check(account:ReadinessAccount,command:ReadinessCommand,operatorPolicy?:OperatorFuelPolicy) {
    this.journal.assertReady();
    const mood=this.journal.snapshot.state.mood;
    if(mood==='Tired')throw new FuelTired('Tired: recovery travel remains unresolved');
    const {station,rows}=await this.margins(account,command,mood,false,operatorPolicy);
    const crossed=rows.filter(row=>row.shortfall>0);
    if(!crossed.length)return;
    const reason=crossed.map(row=>row.message).join('; ');
    const first=crossed[0],entry={mood:'Tired' as const,priorMood:mood,reason,station};
    await this.journal.record(first.name==='fuel'?{...entry,rule:'D3.fuel',evidence:first.evidence}:
      {...entry,rule:first.rule,evidence:first.evidence});
    throw new FuelTired(`Tired recorded: ${reason}`);
  }
  /** D3's lines from one authoritative read. `restore` asks the resupply question —
   * a serviced dock owes a full tank and a whole hull, away from one the line is the
   * route to it plus the reserve. A margin the read cannot measure is not claimed. */
  private async margins(account:ReadinessAccount,command:ReadinessCommand,mood:Mood,restore:boolean,
    operatorPolicy?:OperatorFuelPolicy) {
    const {observed,station,cost}=await this.nearest(account,command);
    const {ship,location,player}=observed;
    const serviced=restore&&location.docked_at===station.base_id&&cost===0;
    const reserve=resolveFuelReserve(mood,operatorPolicy);
    const rows:Row[]=[];
    const required=serviced?ship.max_fuel:cost+reserve;
    const fuel={kind:'available_fuel',actualFuel:ship.fuel,quotedCost:cost,effectiveReserve:reserve,
      requiredFuel:required,shortfall:required-ship.fuel,
      destination:{system_id:station.system_id,poi_id:station.poi_id,base_id:station.base_id},
      observed:{ship,location},quoteOrigin:location} satisfies FuelRouteEvidence;
    rows.push({name:'fuel',rule:'D3.fuel',shortfall:fuel.shortfall,
      message:new FuelRouteShortfall(fuel).message,evidence:fuel});
    const margin=(name:'hull'|'credits',rule:'D3.hull'|'D3.credits',have:number,need:number,unit:string)=>
      rows.push({name,rule,shortfall:need-have,message:gap(`${name}_below_line`,have,need,unit),
        evidence:{kind:name,have,need,shortfall:need-have,observed:{ship,location}}});
    if(finite(ship.hull)&&finite(ship.max_hull))
      margin('hull','D3.hull',ship.hull,serviced?ship.max_hull:resolveWalkAway(mood)*ship.max_hull,'hull points');
    // Data-driven and identical for every mood: twice a full refuel plus a full repair
    // at the station's posted prices. Without those prices the line cannot be drawn.
    if(finite(player?.credits)&&finite(ship.max_fuel)&&finite(ship.max_hull)&&station.prices)
      margin('credits','D3.credits',player.credits,
        2*(ship.max_fuel*station.prices.fuel_all_in+ship.max_hull*station.prices.repair_per_hull),'credits');
    return {observed,station,cost,rows};
  }
  /** D3: a resupply that puts fuel back over the line clears Tired and restores the mood
   * held at the crossing. Decided from a live read, so a stale cache never un-Tires the pilot. */
  async resupply(account:ReadinessAccount,command:ReadinessCommand,operatorPolicy?:OperatorFuelPolicy):Promise<Mood> {
    this.journal.assertReady();
    const {state,transitions}=this.journal.snapshot;
    if(state.mood!=='Tired')return state.mood;
    const prior=moodBeforeTired(transitions);
    if(!prior)throw new FuelMarginUnresolved('fuel_margin_unresolved: Tired journal lacks the mood to restore');
    await account.refresh();
    const {observed,rows}=await this.margins(account,command,prior,true,operatorPolicy);
    const crossed=rows.filter(row=>row.shortfall>0);
    if(crossed.length)throw new FuelTired(`Tired: ${crossed.map(row=>row.message).join('; ')}`);
    const reason=`resupplied: ${rows.map(row=>row.message.split(';')[0]).join('; ')}; ${prior} restored`;
    await this.journal.restore({mood:prior,priorMood:'Tired',reason,rule:'D3.resupply',
      observed:{ship:observed.ship,location:observed.location}});
    return prior;
  }
  /** R13 dock to dock: the crossing is imposed, the recovery leg is the only trip Tired
   * may fly, the ladder runs when it cannot, and a resupply verified by a live read
   * gives the mood back. Nobody un-Tires the pilot by hand; this script is the only way. */
  async tiredCycle(account:ReadinessAccount,command:ReadinessCommand,options:TiredCycleOptions={}):Promise<TiredCycleResult> {
    this.journal.assertReady();
    const opening=this.journal.snapshot.state.mood;
    if(opening!=='Tired') {
      try {await this.check(account,command,options.operatorPolicy);}
      catch(error) {
        if(error instanceof FuelMarginUnresolved)return {outcome:'failed',crossed:[],reason:error.message};
        if(!(error instanceof FuelTired))throw error;
      }
      // Re-read: the check above may have imposed Tired between these two lines.
      const mood:Mood=this.journal.snapshot.state.mood;
      if(mood!=='Tired')return {outcome:'restored',crossed:[],restored_mood:mood,reason:'no margin crossed'};
    }
    const {transitions}=this.journal.snapshot;
    const prior=moodBeforeTired(transitions);
    if(!prior)return {outcome:'failed',crossed:[],reason:'fuel_margin_unresolved: Tired journal lacks the mood to restore'};
    const imposed=lastCrossing(transitions)!.rule;
    let crossed:MarginName[]=[];
    try {
      await account.refresh();
      const {observed,station,cost,rows}=await this.margins(account,command,prior,true,options.operatorPolicy);
      crossed=[...new Set([...rows.filter(row=>row.shortfall>0).map(row=>row.name),marginOf(imposed)])];
      if(observed.ship.fuel<cost)
        return this.rung(command,crossed,options,`recovery leg unreachable: nearest serviced station ${station.base_id} `+
          `costs ${cost} fuel units from here, have ${observed.ship.fuel}; ${cost-observed.ship.fuel} more fuel units, `+
          `or a nearer serviced station, would unblock it`);
      if(observed.location.docked_at!==station.base_id)
        await travelTo(account,command,{system_id:station.system_id,poi_id:station.poi_id,base_id:station.base_id},
          {...options.travel,mood:'Tired'});
      await serviceShip(account,command,{mood:'Tired',creditReserve:options.creditReserve});
      return {outcome:'restored',crossed,restored_mood:await this.resupply(account,command,options.operatorPolicy)};
    } catch(error) {
      if(error instanceof FuelMarginUnresolved)return {outcome:'failed',crossed,reason:error.message};
      // A script refusing the recovery leg is the world saying no: that is the ladder's cue.
      if(error instanceof TravelBlocked||error instanceof ServiceBlocked||error instanceof DockBlocked)
        return this.rung(command,crossed,options,error.message);
      throw error;
    }
  }
  /** One rung at a time, journaled: a bounded wait naming its blocker, then the distress
   * call. Whatever answers is recorded as data; no answer authorizes anything. */
  private async rung(command:ReadinessCommand,crossed:MarginName[],options:TiredCycleOptions,blocker:string):Promise<TiredCycleResult> {
    const waited=recoveryRungs(this.journal.snapshot.transitions).filter(rule=>rule==='R13.wait').length;
    if(waited<(options.maxWaits??1)) {
      await this.journal.note({mood:'Tired',priorMood:'Tired',rule:'R13.wait',reason:blocker});
      return {outcome:'waiting',crossed,reason:blocker};
    }
    const distress_type=crossed.includes('fuel')||!crossed.includes('hull')?'fuel':'repair';
    const answer=details(await command('spacemolt/distress_signal',{distress_type}));
    await this.journal.note({mood:'Tired',priorMood:'Tired',rule:'R13.distress',reason:blocker,answer});
    return {outcome:'distress',crossed,reason:blocker};
  }
  /** Lowest validated route cost to an observed refuel station, from an authoritative read. */
  private async nearest(account:ReadinessAccount,command:ReadinessCommand) {
    const stations=this.stations.filter(s=>s.base_id&&s.poi_id&&s.system_id&&s.services?.refuel===true&&
      s.observation?.source&&Number.isFinite(Date.parse(s.observation.observedAt)));
    if(!stations.length)throw new FuelMarginUnresolved('fuel_margin_unresolved: no observed service-qualified station');
    // The wallet rides along for D3's credits line; route quotes do not depend on it,
    // so a credit push mid-quote is not a reason to refuse the quote.
    const before=structuredClone({ship:account.state.ship,location:account.state.location,player:account.state.player});
    const same=()=>{
      const {ship,location}=account.state;
      return ship?.id===before.ship?.id&&ship?.fuel===before.ship?.fuel&&ship?.max_fuel===before.ship?.max_fuel&&
        ship?.cargo_used===before.ship?.cargo_used&&location?.system_id===before.location?.system_id&&
        location?.poi_id===before.location?.poi_id&&location?.docked_at===before.location?.docked_at&&!location?.in_transit;
    };
    await account.refresh();
    const ship=before.ship,location=before.location;
    if(!same()||!location?.system_id||!ship||!Number.isFinite(ship.fuel)||ship.fuel<0)
      throw new FuelMarginUnresolved('fuel_margin_unresolved: authoritative ship or location changed before station quote');
    const quotes:{station:ServicedStation;cost:number}[]=[];
    for(const station of stations) {
      const quote=details(await command('spacemolt/find_route',{id:station.base_id}));
      await account.refresh();
      if(!same())throw new FuelMarginUnresolved('fuel_margin_unresolved: ship, fuel, load, capacity or location changed during station quote');
      try {routeSteps(quote,location.system_id,station.system_id,null);}
      catch(error){throw new FuelMarginUnresolved(`fuel_margin_unresolved: station ${station.base_id} quote: ${String(error)}`);}
      if(quote.target_poi!==station.poi_id||quote.fuel_available!==ship.fuel||quote.cargo_used!==ship.cargo_used)
        throw new FuelMarginUnresolved(`fuel_margin_unresolved: station ${station.base_id} quote lacks matching POI, fuel or cargo evidence`);
      quotes.push({station,cost:quote.estimated_fuel});
    }
    quotes.sort((a,b)=>a.cost-b.cost||(a.station.base_id<b.station.base_id?-1:a.station.base_id>b.station.base_id?1:0));
    return {observed:{ship,location,player:before.player},station:quotes[0].station,cost:quotes[0].cost};
  }
}
