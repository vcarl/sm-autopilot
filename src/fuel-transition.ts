import {FuelJournal,type ServicedStation} from './fuel-journal.ts';
import {resolveFuelReserve,type OperatorFuelPolicy} from './mood-policy.ts';
import {FuelRouteShortfall,TravelBlocked,travelTo,type TravelDestination,type TravelOptions,type FuelRouteEvidence} from './travel.ts';
import type {ReadinessAccount,ReadinessCommand} from './readiness.ts';
import {details} from './response-details.ts';
import {routeSteps} from './normal-route.ts';

export class FuelMarginUnresolved extends TravelBlocked {}
export class FuelTired extends TravelBlocked {}

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
  async check(account:ReadinessAccount,command:ReadinessCommand,operatorPolicy?:OperatorFuelPolicy) {
    this.journal.assertReady();
    const mood=this.journal.snapshot.state.mood;
    if(mood==='Tired')throw new FuelTired('Tired: recovery travel remains unresolved');
    const reserve=resolveFuelReserve(mood,operatorPolicy);
    const stations=this.stations.filter(s=>s.base_id&&s.poi_id&&s.system_id&&s.services?.refuel===true&&
      s.observation?.source&&Number.isFinite(Date.parse(s.observation.observedAt)));
    if(!stations.length)throw new FuelMarginUnresolved('fuel_margin_unresolved: no observed service-qualified station');
    const before=structuredClone({ship:account.state.ship,location:account.state.location});
    const same=()=>{
      const {ship,location}=account.state;
      return ship?.id===before.ship?.id&&ship?.fuel===before.ship?.fuel&&ship?.max_fuel===before.ship?.max_fuel&&
        ship?.cargo_used===before.ship?.cargo_used&&location?.system_id===before.location?.system_id&&
        location?.poi_id===before.location?.poi_id&&location?.docked_at===before.location?.docked_at&&!location?.in_transit;
    };
    await account.refresh();
    if(!same()||!before.location?.system_id||!before.ship||!Number.isFinite(before.ship.fuel)||before.ship.fuel<0)
      throw new FuelMarginUnresolved('fuel_margin_unresolved: authoritative ship or location changed before station quote');
    const quotes:{station:ServicedStation;cost:number}[]=[];
    for(const station of stations) {
      const quote=details(await command('spacemolt/find_route',{id:station.base_id}));
      await account.refresh();
      if(!same())throw new FuelMarginUnresolved('fuel_margin_unresolved: ship, fuel, load, capacity or location changed during station quote');
      try {routeSteps(quote,before.location.system_id,station.system_id,null);}
      catch(error){throw new FuelMarginUnresolved(`fuel_margin_unresolved: station ${station.base_id} quote: ${String(error)}`);}
      if(quote.target_poi!==station.poi_id||quote.fuel_available!==before.ship.fuel||quote.cargo_used!==before.ship.cargo_used)
        throw new FuelMarginUnresolved(`fuel_margin_unresolved: station ${station.base_id} quote lacks matching POI, fuel or cargo evidence`);
      quotes.push({station,cost:quote.estimated_fuel});
    }
    quotes.sort((a,b)=>a.cost-b.cost||(a.station.base_id<b.station.base_id?-1:a.station.base_id>b.station.base_id?1:0));
    const {station,cost}=quotes[0],required=cost+reserve;
    if(before.ship.fuel>=required)return;
    const refusal=new FuelRouteShortfall({kind:'available_fuel',actualFuel:before.ship.fuel,quotedCost:cost,
      effectiveReserve:reserve,requiredFuel:required,shortfall:required-before.ship.fuel,
      destination:{system_id:station.system_id,poi_id:station.poi_id,base_id:station.base_id},
      observed:before,quoteOrigin:before.location} satisfies FuelRouteEvidence);
    await this.journal.record({mood:'Tired',priorMood:mood,reason:refusal.message,rule:'D3.fuel',evidence:refusal.evidence,station});
    throw new FuelTired(`Tired recorded: ${refusal.message}`);
  }
}
