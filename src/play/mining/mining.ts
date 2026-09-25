/** Mining: out to a belt, ice field or gas cloud, fill the hold, come back, stow, service. */
import type {SurveySystemResponse,SurveyedPoi,V2CargoItem,ViewStorageResponse} from '@spacemolt/lib';
import {gatherJob,type GatherStep} from '../../gather-job.ts';
import type {MineYieldRow} from '../../mine.ts';
import {details} from '../../response-details.ts';
import {sell} from '../market.ts';
import {acct,admit,checkStop,command,job,measured,pilot,step,stopped} from '../runtime.ts';
import {route} from '../travel.ts';
import type {Outcome,Row} from '../types.ts';

export interface Gathered {
  poi_id:string;base_id:string;
  trips:number;
  /** What came aboard over all trips, measured from `GameState['cargo']` before and after
   * each mining leg (never from `MineResponse`, which carries no yield). */
  yield:Row[];
  /** What reached the store (or the market, with `then:'sell'`). */
  settled:Row[];
  /** How the mining leg ended on the last trip. */
  ended:'full'|'depleted'|'stopped'|'tired'|'threat'|'blocked'|'failed';
  /** The hold at the end. */
  cargo:V2CargoItem[];
  /** The store's count of `until.item` when the function returned, if `until` was given. */
  held?:number;
}

const YIELD_LINE_MS=2*60_000;
const sum=(rows:Row[]):Row[]=>{
  const totals:Record<string,number>={};
  for(const row of rows)totals[row.item_id]=(totals[row.item_id]??0)+row.quantity;
  return Object.entries(totals).sort(([a],[b])=>a<b?-1:1).map(([item_id,quantity])=>({item_id,quantity}));
};
const say=(rows:Row[])=>rows.map(row=>`+${row.quantity} ${row.item_id}`).join(', ')||'nothing yet';
/** The paste-able sale of what was stowed: the take is in the store, not the hold. */
export const sellStowed=(rows:Row[]):string[]=>rows.length
  ?[`sell([${rows.map(row=>`{item_id:'${row.item_id}',quantity:${row.quantity}}`).join(', ')}], {from:'store'})`]:[];

async function storeCount(base:string,item:string):Promise<number> {
  const view=details(await command('spacemolt_storage/view',{station_id:base})) as ViewStorageResponse;
  return (view.items??[]).filter(row=>row.item_id===item).reduce((n,row)=>n+row.quantity,0);
}

/** One gather trip by default: fly to `poi`, mine until the hold is full (or the site is
 * dry), fly back to `base` (default: the base you left), dock, stow the take,
 * service. Over the raw legs it adds: every leg named for an end state and re-entered from
 * the live world, the take measured from cargo reads, the mood's fuel reserve, a streamed
 * yield line every ≤2 minutes, stop between ticks, and Tired ending the loop after the
 * return leg.
 *
 * - `until: {item, quantity}`: repeat trips until the store at `base` holds that much of
 *   `item`, up to `maxTrips` (default 6). Read from `storage/view` between trips.
 * - `then: 'stow' | 'sell'`: what to do with the take at the base. Default `stow`; `sell`
 *   withdraws the stowed take and sells it, row by row.
 * The take is what the site gives: at the base every hold row whose item is one of the
 * belt's own resources is stowed, whichever trip mined it, and nothing else is touched.
 * The trip ends stowed and docked, so the hold — `now.cargo` — is empty: read the take from
 * `gained.items` (measured) or `detail.settled` (what reached the store), never `now.cargo`.
 *
 * Mining while docked is refused by the game, so a station POI as `poi` is `refused`.
 * Trains mining (+ deep_core_mining with a power-3+ laser), piloting, navigation. */
/** How a trip is named in the journal and the run record. `maxTrips` is named only when it is in
 * force, which is only with an `until` target: without one this is a single trip by design (see
 * the note above), so advertising "≤3 trips" on a run that makes exactly one tells a pilot reading
 * its own record that it asked for something it did not get. The live pilot's own index.ts passes
 * `maxTrips` with no `until`, so this was being printed on every gather it ran. */
export const tripLabel=(opts:{poi:string;base?:string;until?:{item:string;quantity:number};
  maxTrips?:number;then?:'stow'|'sell'}):string=>
  `${opts.poi}${opts.base?` → ${opts.base}`:''}${opts.until?` until ${opts.until.item} ≥ ${opts.until.quantity}`:''}${opts.until&&opts.maxTrips?` ≤${opts.maxTrips} trips`:''}${opts.then==='sell'?' then sell':''}`;

export function gatherUntil(opts:{poi:string;base?:string;until?:{item:string;quantity:number};
  maxTrips?:number;then?:'stow'|'sell'}):Promise<Outcome<Gathered>> {
  const label=tripLabel(opts);
  return job<Gathered>('gatherUntil',label,async()=>{
    const who=pilot();
    const result:Gathered={poi_id:opts.poi,base_id:opts.base??'',trips:0,yield:[],settled:[],ended:'blocked',cargo:[]};
    const cargo=()=>(acct().state.cargo??[]) as V2CargoItem[];
    const stop=admit('gatherUntil');
    if(stop)return {status:'refused',did:'gathered nothing',why:stop,detail:result};
    const baseId=opts.base??acct().state.location?.docked_at;
    if(!baseId)return {status:'refused',did:'gathered nothing',why:'no base to return to: pass base, or dock first',detail:result};
    result.base_id=baseId;
    let site,home;
    try {site=await route(opts.poi);home=await route(baseId);}
    catch(error){return {status:'refused',did:'gathered nothing',why:(error as Error).message,detail:result};}
    if(site.target_poi&&site.target_poi!==opts.poi)return {status:'refused',did:'gathered nothing',why:`${opts.poi} is a base, not a mining site; pass its belt's POI id`,detail:result};
    const ship=acct().state.ship;
    if(ship&&ship.cargo_used>=ship.cargo_capacity)return {status:'refused',did:'gathered nothing',why:'the hold is full; sell(rows) or stow(rows) first',detail:result};
    const plan={home:{system_id:String(home.target_system),poi_id:String(home.target_poi??baseId),base_id:baseId},
      site:{system_id:String(site.target_system),poi_id:opts.poi},mood:who.mood??'Cautious'};
    const maxTrips=opts.until?opts.maxTrips??6:1;
    let lastLine=0,depleted=false;
    const onStep=(done:GatherStep,moved:{yield:MineYieldRow[];deposited?:MineYieldRow[]})=>{
      const extra=done.name==='mine'?`  ${say(moved.yield)}`:done.name==='settle'?`  ${say(moved.deposited??[])}`:'';
      step(`${done.name==='travel'?`goTo ${opts.poi}`:done.name==='return'?`goTo ${plan.home.poi_id}`:done.name}  ${done.outcome}${extra}${done.reason?`: ${done.reason}`:''}`);
    };
    const mine={
      stop:()=>stopped()?'stopped by pilot':pilot().mood==='Tired'?'tired':null,
      onCycle:(rows:MineYieldRow[],cycles:number)=>{
        if(Date.now()-lastLine<YIELD_LINE_MS)return;
        lastLine=Date.now();
        step(`mine  ${cycles} ticks, hold ${acct().state.ship?.cargo_used}/${acct().state.ship?.cargo_capacity}  ${say(rows)}`);
      },
    };
    for(let trip=1;trip<=maxTrips;trip++) {
      if(opts.until) {
        const have=await storeCount(baseId,opts.until.item);
        result.held=have;
        if(have>=opts.until.quantity){result.ended='full';break;}
        step(`store ${baseId} ${opts.until.item} ${have} of ${opts.until.quantity}; trip ${trip} of ${maxTrips}`);
      }
      checkStop();
      lastLine=Date.now();
      // `moodNow`: the pilot record, not `plan.mood`, says what each leg flies on — the runtime
      // imposes Tired mid-trip and the leg home is quoted against the mood in force by then.
      const trek=await gatherJob(acct(),command,plan,{onStep,mine,checkpoint:async()=>checkStop(),
        moodNow:()=>pilot().mood??'Cautious'});
      result.trips=trip;
      result.yield=sum([...result.yield,...trek.yield]);
      const deposited=trek.settled?.deposited??[];
      const held=trek.settled?.held??[];
      if(opts.then==='sell'&&(deposited.length||held.length)) {
        const sold=await sell([...deposited.map(row=>({...row})),...held.map(row=>({...row}))],deposited.length?{from:'store'}:{});
        result.settled=sum([...result.settled,...sold.detail.fills.map(f=>({item_id:f.item_id,quantity:f.quantity_sold}))]);
      } else result.settled=sum([...result.settled,...deposited]);
      const mineStep=trek.steps.find(s=>s.name==='mine');
      depleted=Boolean(mineStep?.reason?.includes('depleted')||mineStep?.reason?.includes('no cargo change'));
      if(trek.outcome!=='done') {
        result.ended=trek.reason?.includes('stopped by pilot')?'stopped':trek.outcome==='blocked'?'blocked':'failed';
        result.cargo=cargo();
        if(opts.until)result.held=await storeCount(baseId,opts.until.item).catch(()=>result.held);
        // The did is the measurement, never the tally: a leg that broke mid-mine still put
        // ore aboard, and `trek.yield` is empty when the step never returned.
        const took=measured().length?measured():sum(trek.yield);
        const units=took.reduce((n,row)=>n+row.quantity,0);
        const ship=acct().state.ship;
        return {status:result.ended==='stopped'?'partial':trek.outcome==='blocked'?'refused':'failed',
          did:`trip ${trip}: mined ${units} units${units?` (${took.map(row=>`${row.quantity} ${row.item_id}`).join(', ')})`:''} at ${opts.poi}`+
            `${ship?`, hold ${ship.cargo_used}/${ship.cargo_capacity}`:''}; ended at ${trek.steps.at(-1)?.name}`,
          why:trek.reason,detail:result,
          // The world, not a record, says where the next run re-enters: every leg is named
          // for an end state and sends nothing when it already holds.
          next:[`gatherUntil with the same arguments resumes from here: it re-enters at the leg the live world implies`]};
      }
      result.ended=depleted?'depleted':'full';
      if(pilot().mood==='Tired'){result.ended='tired';break;}
      if(depleted)break;
    }
    result.cargo=cargo();
    if(opts.until&&result.ended!=='tired')result.held=await storeCount(baseId,opts.until.item).catch(()=>result.held);
    const short=opts.until&&(result.held??0)<opts.until.quantity;
    const did=`${result.trips} trip(s) to ${opts.poi}: ${say(result.yield)}; ${opts.then==='sell'?'sold':'stowed'} ${say(result.settled)} at ${baseId}`+
      (opts.until?`; store holds ${result.held??'?'} of ${opts.until.quantity} ${opts.until.item}`:'');
    if(result.ended==='tired')return {status:'partial',did,why:'Tired: home and serviced, no new trip',detail:result};
    if(short)return {status:'partial',did,why:depleted?'the site is depleted':`${maxTrips} trips made`,detail:result,
      // `survey()` is not built yet, so it is not offered: scout() already lists this system's
      // belts, and naming an unbuilt call here spends the juncture that follows a dry site.
      next:depleted?["another belt: this site gave nothing; scout() lists them"]:[]};
    return {status:'done',did,detail:result,
      next:[...(opts.then==='sell'?[]:sellStowed(result.settled)),
        ...(result.ended==='depleted'?['the site is depleting; scout another belt']:[])]};
  });
}

/** Survey the system you are in for hidden deep-core deposits. Not built in slice 1. */
export function survey():Promise<Outcome<{response:SurveySystemResponse;deposits:SurveyedPoi[]}>> {throw new Error('unimplemented: survey; account().commands.spacemolt.survey_system()');}
