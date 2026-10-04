/** Passenger lines: the best credits-and-reputation loop in the game once you have berths.
 * Fare = (200 + 150 × hops) × class × remoteness × surge, plus a speed bonus up to +50%;
 * first class also pays +1 empire standing per delivery. */
import type {PassengerView,StationPassengersResponse,UnloadPassengerCommandResponse,WaitingPassengerView} from '@spacemolt/lib';
import {Effect,Option,Result,Schema,Struct} from 'effect';
import {replyBody} from '../../storage.ts';
import * as Wire from '../../wire.gen.ts';
import {Game,field} from '../game.ts';
import {Stopped,acct,admit,edge,jobEffect,step,stopped} from '../runtime.ts';
import {folded} from '../storage.ts';
import {goToEffect} from '../travel.ts';
import type {Outcome} from '../types.ts';
import {kept,num} from '../rows.ts';

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

// The frozen surface promises the lib's types; a live reply is decoded only for the fields read below, because the server omits spec fields.
// oxlint-disable-next-line typescript/consistent-type-assertions
const asRider=(row:unknown)=>row as PassengerView; // cast: frozen surface (PassengerView)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asStation=(body:unknown)=>body as StationPassengersResponse; // cast: frozen surface (StationPassengersResponse)
// oxlint-disable-next-line typescript/consistent-type-assertions
const asOff=(body:unknown)=>body as UnloadPassengerCommandResponse; // cast: frozen surface (UnloadPassengerCommandResponse)
const decodeRider=Schema.decodeUnknownOption(Wire.PassengerView.mapFields(fields=>({...Struct.pick(fields,['citizen_id','class','destination','name']),
  ticks_remaining:Schema.optionalKey(fields.ticks_remaining)})));
const decodeWaiting=Schema.decodeUnknownOption(Wire.WaitingPassengerView.mapFields(fields=>({
  citizen_id:fields.citizen_id,class:fields.class,destination:fields.destination,estimated_fare:fields.estimated_fare})));
const riders=(action:string,key:string,list:unknown)=>kept(action,key,list,decodeRider,row=>field(row,'citizen_id')).map(asRider);

/** Who is aboard, as the manifest lists them: a row that does not read is left out and said; a `null` list is nobody. */
const readAboard=()=>Effect.gen(function*() {
  const body=replyBody(yield* (yield* Game).command('spacemolt/list_passengers',{}));
  return riders('spacemolt/list_passengers','passengers',field(body,'passengers'));
});
const berthsFree=()=>{const b=acct().state.ship?.berths;
  return b?(b.economy?.free??0)+(b.business?.free??0)+(b.first?.free??0):0;};
const emptyCarried=():Carried=>({station:asStation({}),loaded:[],landed:[],aboard:[]});

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
 * passenger already aboard bound for `destination` is still delivered — nobody new boards.
 * A reply lost on the boarding or on an unload is never re-sent: the manifest is re-read,
 * and an unload that may have landed leaves the trip `partial`. */
export function carryPassengers(destination?:string):Promise<Outcome<Carried>> {return edge(carryPassengersEffect(destination));}

/** `carryPassengers` as an Effect, for `edge` and for converted callers; never in a barrel. A refusal ends it naming the
 * action and the code; a lost reply on the boarding or an unload is never re-sent, and the manifest is re-read. */
export const carryPassengersEffect=(destination?:string)=>
  jobEffect<Carried>('carryPassengers',destination??'',folded<Carried>('carryPassengers',emptyCarried,Effect.gen(function*() {
    const game=yield* Game;
    const result=emptyCarried();
    const docked=acct().state.location?.docked_at;
    if(!docked)return {status:'refused' as const,did:'carried nobody',why:'not docked; the passenger board is a station counter',detail:result};
    if(!acct().state.ship?.berths)return {status:'refused' as const,did:'carried nobody',
      why:'this hull has no passenger berths; a liner or a passenger cabin module is a hangar decision',
      detail:result,next:['shipsForSale() for a liner, or refit({install:["economy_passenger_cabin"]})']};

    result.aboard=yield* readAboard();
    // Tired may not start work, but it may finish a trip someone is already aboard for.
    const blocked=yield* admit('carryPassengers');
    const carrying=destination?result.aboard.filter(row=>row.destination===destination):[];
    if(blocked&&!carrying.length)return {status:'refused' as const,did:'carried nobody',why:blocked,detail:result};

    const board=replyBody(yield* game.command('spacemolt/list_station_passengers',{}));
    result.station=asStation(board);
    const waiting=kept('spacemolt/list_station_passengers','waiting',field(board,'waiting'),decodeWaiting,row=>field(row,'citizen_id')).flatMap(row=>Option.toArray(decodeWaiting(row))).sort(byClass);
    const target=destination??tally(waiting)[0]?.[0];
    if(!target)return {status:'done' as const,did:`nothing waiting at ${docked} and no destination named`,
      detail:result,next:['another station, or freightBoard() here']};

    const bound=waiting.filter(row=>row.destination===target);
    const surge=num(board,'fare_surge');
    if(blocked)step(`${blocked}; flying the ${carrying.length} aboard to ${target}, boarding nobody`);
    else if(!bound.length&&!carrying.length)
      return {status:'done' as const,did:`nobody at ${docked} is bound for ${target}${surge?`; surge ${surge}×`:''}`,
        detail:result,next:tally(waiting).slice(0,3).map(([id,fare])=>`carryPassengers('${id}') — ${Math.round(fare)} cr waiting`)};
    else if(bound.length) {
      const free=berthsFree();
      step(`load ${target}: ${bound.length} waiting (${bound.map(row=>row.class).join(', ')}), ${free} berth(s) free`);
      const before=new Set(result.aboard.map(row=>row.citizen_id));
      const sent=yield* Effect.result(game.command('spacemolt/load_passenger',{id:target}));
      if(Result.isSuccess(sent)) {
        const boarded=replyBody(sent.success);
        result.loaded=riders('spacemolt/load_passenger','loaded',field(boarded,'loaded')).sort(byClass);
        const unfunded=num(boarded,'skipped_unfunded');
        step(`boarded ${num(boarded,'count')??result.loaded.length} for ${target}, ${num(boarded,'total_fare')??0} cr of fare escrowed`+
          `${unfunded?`; ${unfunded} unfunded and skipped`:''}`);
      } else {
        // A refusal ends the trip with its code. A lost reply is never re-sent: the manifest says who boarded.
        if(sent.failure._tag!=='ReplyLost')return yield* sent.failure;
        result.loaded=(yield* readAboard()).filter(row=>row.destination===target&&!before.has(row.citizen_id)).sort(byClass);
        if(!result.loaded.length)return yield* sent.failure;
        step(`load ${target}: reply lost on ${sent.failure.action}; ${result.loaded.length} are aboard now, so it landed`);
      }
    }

    const trip=yield* goToEffect(target);
    result.aboard=yield* readAboard();
    if(trip.status!=='done')return {status:trip.status==='partial'?'partial' as const:'refused' as const,
      did:`boarded ${result.loaded.length} for ${target} and did not arrive`,...trip.why===undefined?{}:{why:trip.why},detail:result,
      next:[`service(), then carryPassengers('${target}') again: the aboard manifest is still theirs`]};

    // Only this stop's passengers get off. Never `all` — it would strand the rest at −1 each.
    const here=acct().state.location?.docked_at??target;
    const unloaded:UnloadPassengerCommandResponse[]=[];
    const lost:{id:string;name:string}[]=[];
    let fares=0;
    for(const rider of result.aboard.filter(row=>row.destination===here).sort(byClass)) {
      if(stopped())return yield* Effect.fail(new Stopped());
      const sent=yield* Effect.result(game.command('spacemolt/unload_passenger',{id:rider.citizen_id}));
      if(Result.isFailure(sent)) {
        if(sent.failure._tag!=='ReplyLost')return yield* sent.failure;
        // Never re-sent: the manifest re-read below says whether this rider got off.
        lost.push({id:rider.citizen_id,name:rider.name});
        step(`${rider.name}: reply lost on ${sent.failure.action}; not re-sent, the manifest is re-read`);
        continue;
      }
      const off=replyBody(sent.success),fare=num(off,'fare_collected');
      unloaded.push(asOff(off));
      fares+=fare??0;
      step(`landed ${rider.name} (${rider.class}) at ${here}${fare===undefined?'':` for ${fare} cr`}`);
    }
    if(unloaded.length)result.landed.push({base_id:here,unloaded});
    result.aboard=yield* readAboard();

    const firsts=result.loaded.filter(row=>row.class==='first').length;
    const elsewhere=result.aboard.filter(row=>!lost.some(one=>one.id===row.citizen_id));
    const why=[elsewhere.length?`${elsewhere.map(row=>`${row.name} → ${row.destination}`).join(', ')} are bound elsewhere`:'',
      lost.length?`reply lost on spacemolt/unload_passenger for ${lost.map(one=>one.name).join(', ')}: they may have landed, and the manifest was re-read`:''].filter(Boolean).join('; ');
    return {status:result.aboard.length||lost.length?'partial' as const:'done' as const,
      did:`carried ${unloaded.length} passenger(s) to ${here} for ${fares} cr${firsts?`, ${firsts} first class`:''}`+
        `${result.aboard.length?`; ${result.aboard.length} still aboard`:''}`,
      ...why?{why}:{},
      detail:result,
      next:result.aboard.length
        ?result.aboard.slice(0,3).map(row=>`carryPassengers('${row.destination}') — ${row.name}, ${row.ticks_remaining} ticks of guarantee left`)
        :[`carryPassengers() at ${here} reads this station's board and picks the best-paying destination`]};
  })));

/** Total estimated fare per destination among the waiting, best first: the pick when no
 * destination was named. */
function tally(waiting:readonly Pick<WaitingPassengerView,'destination'|'estimated_fare'>[]):[string,number][] {
  const totals:Record<string,number>={};
  for(const row of waiting)totals[row.destination]=(totals[row.destination]??0)+(row.estimated_fare??0);
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]);
}
