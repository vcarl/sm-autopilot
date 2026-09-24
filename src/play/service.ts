/** The service counter: fuel and hull. Insurance and dues wait for a later slice. */
import type {GetBaseResponse,SystemPoi} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {readJournal} from '../run-record.ts';
import {ServiceBlocked,serviceShip} from '../servicing.ts';
import {acct,command,job,pilot,runtimeDir} from './runtime.ts';
import type {Outcome} from './types.ts';

export interface Serviced {
  /** The counter's quote the spend was checked against (`fuel_price_all_in`). */
  base:GetBaseResponse;
  /** The commands sent (`spacemolt/refuel`, `spacemolt/repair`) and what they cost together. */
  issued:string[];
  spent:number;
  /** What could not be done here and why (no repair quote, over margin, under reserve). */
  short:string[];
  /** True when this call cleared a Tired mood. */
  cleared_tired:boolean;
}

/** One base worth flying to for a service, as a move: the call, and everything known about it.
 * The menu offers these and a refused (or partially filled) `service` names them in `next`, so
 * the advice a pilot is given is the same advice either way. */
export interface Elsewhere {call:string;why:string}

/** Where else the pilot could be brought up. Only a service clears Tired, so a station that
 * cannot quote what is missing leaves the mood standing: the route to a base that might is the
 * useful line, not a flat reserve.
 *
 * Reads only, and every read may fail — no advice beats a made-up one. What a read cannot answer
 * is said in the row rather than keeping the row off the list: an unverifiable trip the pilot may
 * attempt beats a verified dead end, and the judgement is the pilot's (the live deadlock,
 * 2026-09-24, where the only offered move was a `service()` that refuses every time).
 *
 * The prices are `inspect({id})`'s: it names a base by id and answers with the docked-base body
 * (`InspectResponse.base: GetBaseResponse`). Its reach is **this system only** — the live server
 * refuses a far id with "You can only inspect a point of interest in your current system"
 * (2026-09-24, a run that broke on exactly that) — so it is asked for in-system candidates and
 * not asked at all for a base the journal remembers in another system, whose row says plainly
 * that no price is readable from here. It may also decline in-system, so it is still guarded.
 *
 * ponytail: the candidates are this system's bases plus the ones the journal has docked at. Lib
 * 14.2.0's `get_system()`, `get_poi()` and `get_base()` all take no id (COMMANDS.md 61, 73, 79),
 * so no far system's station list is readable and a base the pilot has never stood at in one is
 * unnameable. Widen it when a read lists a far system's counters — the same reach limit
 * `systemBases` in travel.ts lives with. */
export async function serviceElsewhere(docked?:string):Promise<Elsewhere[]> {
  const trip=async(id:string):Promise<string>=>{
    try {
      const quote=details(await command('spacemolt/find_route',{id}));
      return quote.found?`${quote.estimated_fuel} fuel, ${quote.total_jumps} jump(s)`:'no route from here';
    } catch {return 'no route quote';}
  };
  /** What an in-system counter posts, read from here, or the plain admission that nothing does. */
  const posted=async(base:string,fuelPrice?:number):Promise<string>=>{
    let quoted:GetBaseResponse|undefined;
    try {quoted=(details(await command('spacemolt/inspect',{id:base})) as {base?:GetBaseResponse}).base;}
    catch {/* no quote from here is the answer, not a guess */}
    const fuel=quoted?.fuel_price_all_in??fuelPrice,hull=quoted?.base?.repair_price_per_hull;
    const prices=[...Number.isFinite(fuel)?[`refuel ${fuel} cr/unit`]:[],
      ...Number.isFinite(hull)&&Number(hull)>0?[`repair ${hull} cr/hull`]:[]];
    return prices.length?`posts ${prices.join(' and ')}; the rest is unknown until docked`
      :'no price readable from here; unknown until docked';
  };
  let pois:SystemPoi[]=[];
  try {pois=(details(await command('spacemolt/get_system',{})).system?.pois??[]) as SystemPoi[];} catch {/* no listing is no advice */}
  const system=acct().state.location?.system_id??'this system';
  const rows:Elsewhere[]=[];
  for(const row of pois.filter(poi=>poi.base_id&&poi.base_id!==docked).slice(0,3))
    rows.push({call:`goTo('${row.base_id}')`,
      why:`${row.base_name??row.base_id} in ${system}: ${await trip(row.base_id!)}; ${await posted(row.base_id!,row.fuel_price)}`});
  if(rows.length)return rows;
  // Nothing else in this system. A base the pilot has stood at is the only far one it can
  // name at all, so it is named as what it is: seen, with whatever a quote from here says.
  const runtime=runtimeDir(),seen=new Set<string>();
  for(const entry of runtime?readJournal(runtime,6_000):[]) {
    const result=entry.response?.result;
    const dock=result?.docked_at?.base_id??result?.location?.docked_at??result?.docked_at;
    if(typeof dock==='string'&&dock&&dock!==docked)seen.add(dock);
  }
  for(const base of [...seen].slice(-3))
    rows.push({call:`goTo('${base}')`,
      // No inspect: it is current-system only, so the call could only fail and break nothing usefully.
      why:`a base this pilot has docked at before: ${await trip(base)}; no price readable from here; unknown until docked`});
  return rows;
}

/** The same advice as one line per row, which is the shape an Outcome's `next` takes. */
const asNext=(rows:Elsewhere[],system:string):string[]=>rows.length
  ?rows.map(row=>`${row.call} — ${row.why}`)
  :[`no other base in ${system}, and none in the journal: no station's service counter can be read from where you are`];

/** Bring the ship up at the counter you are docked at: full tank and full hull.
 *
 * Over `refuel` + `repair` it adds: the quote read first, the mood's per-service spend margin
 * and `permissions.credit_reserve` enforced, the charge checked against the quote, and the
 * post-state read to confirm the fill. A full ship sends nothing. Not docked: `refused`.
 *
 * Tired: resupplying back inside the margins is what clears it; the runtime restores the
 * mood Tired replaced and `cleared_tired` says so. Tired also widens the fill — a counter that
 * posts no price for one of fuel or hull sells the other anyway, and what it could not do lands
 * in `short` with the bases that might, rather than refusing the lot. `insure` and `dues` are
 * accepted and reported in `short` until a later slice implements them. */
export function service(opts:{fuel?:number;hull?:number;insure?:boolean;dues?:boolean|'all'}={}):Promise<Outcome<Serviced>> {
  return job<Serviced>('service',Object.keys(opts).join(' '),async()=>{
    const who=pilot();
    const short:string[]=[];
    if(opts.insure)short.push('insure: not implemented yet; account().commands.spacemolt_salvage.quote/insure');
    if(opts.dues)short.push('dues: not implemented yet; account().commands.spacemolt.prepay_tax / pay_bounty');
    if(opts.fuel!==undefined||opts.hull!==undefined)short.push('partial targets: not implemented yet; a service is a full fill');
    const docked=acct().state.location?.docked_at;
    const empty={base:{} as GetBaseResponse,issued:[],spent:0,short,cleared_tired:false};
    if(!docked)return {status:'refused',did:'serviced nothing',why:'not docked; goTo a base first',detail:empty};
    let base:GetBaseResponse;
    try {base=details(await command('spacemolt/get_base',{})) as GetBaseResponse;}
    catch(error){return {status:'failed',did:`${docked} would not quote`,why:(error as Error).message,detail:empty};}
    try {
      // The quote above was a command, and a command is where Tired is imposed: the mood that
      // picks the spend margin is read here, not at the top of the job. Tired's row is "service
      // only" — the mood it replaced would refuse the very bill that clears it.
      const mood=pilot().mood??'Cautious';
      const done=await serviceShip(acct(),command,{mood,creditReserve:who.permissions?.credit_reserve??0});
      const cleared=mood==='Tired'&&pilot().mood!=='Tired';
      const left=done.short??[];
      const did=done.issued.length
        ?`serviced at ${docked}: ${done.issued.map(action=>action.split('/')[1]).join(' and ')} for ${done.spent} cr; fuel ${done.fuel}, hull ${done.hull}${left.length?`; ${docked} could not: ${left.join('; ')}`:''}`
        :`already serviced at ${docked}: fuel ${done.fuel}, hull ${done.hull}`;
      return {status:'done',did,detail:{base,issued:done.issued,spent:done.spent,short:[...short,...left],cleared_tired:cleared},
        next:cleared?['Tired cleared: the mood before it is back']
          :left.length?asNext(await serviceElsewhere(docked),acct().state.location?.system_id??'this system'):[]};
    } catch(error) {
      if(error instanceof ServiceBlocked)
        return {status:'refused',did:`not serviced at ${docked}`,why:error.blockers.join('; '),
          detail:{base,issued:[],spent:0,short:[...short,...error.blockers],cleared_tired:false},
          next:[...asNext(await serviceElsewhere(docked),acct().state.location?.system_id??'this system'),
            'a calmer bill, a bolder mood, or another station admits it']};
      throw error;
    }
  });
}
