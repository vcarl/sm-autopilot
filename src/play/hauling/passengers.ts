/** Passenger lines: the best credits-and-reputation loop in the game once you have berths.
 * Fare = (200 + 150 × hops) × class × remoteness × surge, plus a speed bonus up to +50%;
 * first class also pays +1 empire standing per delivery. */
import type {ListPassengersResponse,LoadPassengersResponse,PassengerView,StationPassengersResponse,UnloadPassengerCommandResponse,WaitingPassengerView} from '@spacemolt/lib';
import {details} from '../../response-details.ts';
import {acct,admit,checkStop,command,job,pilot,step} from '../runtime.ts';
import {goTo} from '../travel.ts';
import type {Outcome} from '../types.ts';

export interface Carried {
  /** What was waiting when you looked (`demand_level`, `fare_surge`, `waiting`). */
  station:StationPassengersResponse;
  /** Who boarded, as `load_passenger` reported them (with the `berth_class` it assigned). */
  loaded:PassengerView[];
  /** Each stop's unloads; the fare is in the response. */
  landed:{base_id:string;unloaded:UnloadPassengerCommandResponse[]}[];
  /** Still aboard at the end, with `ticks_remaining` on their guarantee. */
  aboard:PassengerView[];
}

const RANK:Record<string,number>={first:0,business:1,economy:2};
/** First class first: the standing is theirs, and the guide's loader seats the pickiest
 * traveller first, so this is the order the board is read and reported in. */
const byClass=(a:{class:string},b:{class:string})=>(RANK[a.class]??9)-(RANK[b.class]??9);

const readAboard=async():Promise<ListPassengersResponse>=>
  details(await command('spacemolt/list_passengers',{})) as ListPassengersResponse;
const berthsFree=()=>{const b=acct().state.ship?.berths;
  return b?(b.economy?.free??0)+(b.business?.free??0)+(b.first?.free??0):0;};

/** Load everyone waiting here for `destination` (a base id) into your berths, fly there, and
 * put off only the passengers whose destination is that stop.
 *
 * With no `destination`, the destination with the highest total estimated fare among the
 * waiting is taken. `load_passenger` boards by destination, so the class ordering inside one
 * call is the server's; `loaded` reports the `berth_class` it assigned.
 *
 * Never sends `unload_passenger` with id `all` anywhere: it would strand everyone aboard
 * whose stop this is not, at −1 standing each, and unloading one passenger explicitly is
 * also what applies that passenger's own +1. The policy validator refuses the literal on
 * `account()` for the same reason.
 *
 * Refused without berths (`V2Ship['berths']`) or undocked; nobody waiting is `done`. Costs
 * fuel; pays fares measured into `gained.credits`. Trains navigation, piloting. Tired: a
 * passenger already aboard bound for `destination` is still delivered — nobody new boards. */
export function carryPassengers(destination?:string):Promise<Outcome<Carried>> {
  return job<Carried>('carryPassengers',destination??'',async()=>{
    const result:Carried={station:{} as StationPassengersResponse,loaded:[],landed:[],aboard:[]};
    const docked=acct().state.location?.docked_at;
    if(!docked)return {status:'refused',did:'carried nobody',why:'not docked; the passenger board is a station counter',detail:result};
    if(!acct().state.ship?.berths)return {status:'refused',did:'carried nobody',
      why:'this hull has no passenger berths; a liner or a passenger cabin module is a hangar decision',
      detail:result,next:['shipsForSale() for a liner, or refit({install:["economy_passenger_cabin"]})']};

    result.aboard=(await readAboard()).passengers??[];
    // Tired may not start work, but it may finish a trip someone is already aboard for.
    const blocked=admit('carryPassengers');
    const carrying=destination?result.aboard.filter(row=>row.destination===destination):[];
    if(blocked&&!carrying.length)return {status:'refused',did:'carried nobody',why:blocked,detail:result};

    const station=details(await command('spacemolt/list_station_passengers',{})) as StationPassengersResponse;
    result.station=station;
    const waiting=(station.waiting??[]).slice().sort(byClass);
    const target=destination??tally(waiting)[0]?.[0];
    if(!target)return {status:'done',did:`nothing waiting at ${docked} and no destination named`,
      detail:result,next:['another station, or freightBoard() here']};

    const bound=waiting.filter(row=>row.destination===target);
    if(blocked)step(`${blocked}; flying the ${carrying.length} aboard to ${target}, boarding nobody`);
    else if(!bound.length&&!carrying.length)
      return {status:'done',did:`nobody at ${docked} is bound for ${target}${station.fare_surge?`; surge ${station.fare_surge}×`:''}`,
        detail:result,next:tally(waiting).slice(0,3).map(([id,fare])=>`carryPassengers('${id}') — ${Math.round(fare)} cr waiting`)};
    else if(bound.length) {
      const free=berthsFree();
      step(`load ${target}: ${bound.length} waiting (${bound.map(row=>row.class).join(', ')}), ${free} berth(s) free`);
      const boarded=details(await command('spacemolt/load_passenger',{id:target})) as LoadPassengersResponse;
      result.loaded=(boarded.loaded??[]).slice().sort(byClass);
      step(`boarded ${boarded.count??result.loaded.length} for ${target}, ${boarded.total_fare??0} cr of fare escrowed`+
        `${boarded.skipped_unfunded?`; ${boarded.skipped_unfunded} unfunded and skipped`:''}`);
    }

    const trip=await goTo(target);
    result.aboard=(await readAboard()).passengers??[];
    if(trip.status!=='done')return {status:trip.status==='partial'?'partial':'refused',
      did:`boarded ${result.loaded.length} for ${target} and did not arrive`,why:trip.why,detail:result,
      next:[`service(), then carryPassengers('${target}') again: the aboard manifest is still theirs`]};

    // Only this stop's passengers get off. Never `all` — it would strand the rest at −1 each.
    const here=acct().state.location?.docked_at??target;
    const unloaded:UnloadPassengerCommandResponse[]=[];
    for(const rider of result.aboard.filter(row=>row.destination===here).sort(byClass)) {
      checkStop();
      const off=details(await command('spacemolt/unload_passenger',{id:rider.citizen_id})) as UnloadPassengerCommandResponse;
      unloaded.push(off);
      step(`landed ${rider.name} (${rider.class}) at ${here}${'fare_collected' in off?` for ${off.fare_collected} cr`:''}`);
    }
    if(unloaded.length)result.landed.push({base_id:here,unloaded});
    result.aboard=(await readAboard()).passengers??[];

    const fares=unloaded.reduce((sum,off)=>sum+('fare_collected' in off?off.fare_collected:0),0);
    const firsts=result.loaded.filter(row=>row.class==='first').length;
    return {status:result.aboard.length?'partial':'done',
      did:`carried ${unloaded.length} passenger(s) to ${here} for ${fares} cr${firsts?`, ${firsts} first class`:''}`+
        `${result.aboard.length?`; ${result.aboard.length} still aboard`:''}`,
      ...result.aboard.length?{why:`${result.aboard.map(row=>`${row.name} → ${row.destination}`).join(', ')} are bound elsewhere`}:{},
      detail:result,
      next:result.aboard.length
        ?result.aboard.slice(0,3).map(row=>`carryPassengers('${row.destination}') — ${row.name}, ${row.ticks_remaining} ticks of guarantee left`)
        :[`carryPassengers() at ${here} reads this station's board and picks the best-paying destination`]};
  });
}

/** Total estimated fare per destination among the waiting, best first: the pick when no
 * destination was named. */
function tally(waiting:WaitingPassengerView[]):[string,number][] {
  const totals:Record<string,number>={};
  for(const row of waiting)totals[row.destination]=(totals[row.destination]??0)+(row.estimated_fare??0);
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]);
}
