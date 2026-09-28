/** The service counter: fuel and hull. Insurance and dues wait for a later slice. */
import type {GetBaseResponse,SystemPoi} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {journalRun,readJournal} from '../run-record.ts';
import {ServiceBlocked,serviceShip} from '../servicing.ts';
import {acct,burnCells,command,job,line,pilot,runtimeDir,stopped} from './runtime.ts';
import {counter} from './counter.ts';
import {goTo} from './travel.ts';
import type {Outcome} from './types.ts';

export interface Serviced {
  /** The counter as it was read before the spend. A posted `fuel_price_all_in` or
   * `repair_price_per_hull` is an estimate; an absent one is not a refusal. */
  base:GetBaseResponse;
  /** The commands sent (`spacemolt/refuel`, `spacemolt/repair`) and what they cost together. */
  issued:string[];
  spent:number;
  /** What this call was asked for and did not do (`insure`, `dues`, partial targets). */
  short:string[];
  /** True when this call cleared a Tired mood. */
  cleared_tired:boolean;
}

/** One base worth flying to for a service, as a move: the call, and everything known about it.
 * The menu offers these and a refused (or partially filled) `service` names them in `next`, so
 * the advice a pilot is given is the same advice either way. */
export interface Elsewhere {call:string;why:string;base:string}

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
    rows.push({call:`goTo('${row.base_id}')`,base:row.base_id!,
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
    rows.push({call:`goTo('${base}')`,base,
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
 * Over `refuel` + `repair` it adds: the quote read first, the mood's spend margin on the repair
 * (never the fuel: a mood must not strand a ship) and `permissions.credit_reserve` enforced, the charge checked against the quote, and the
 * post-state read to confirm the fill. A full ship sends nothing. Not docked: `refused`.
 *
 * A counter bills on credits and reports the charge afterwards, so a station that posts no
 * price still refuels and repairs: the posted price is only a pre-flight estimate, and the
 * reserve is held against the charge itself.
 *
 * A wallet short of the whole bill buys what it can — the fuel first, then the repair if it still
 * fits — and the call is `partial`, with what was not bought in `short` and `why`.
 *
 * Tired: resupplying back inside the margins is what clears it (the mood is derived from the
 * ship), and `cleared_tired` says so. `insure` and `dues` are accepted and
 * reported in `short` until a later slice implements them. */
export function service(opts:{fuel?:number;hull?:number;insure?:boolean;dues?:boolean|'all'}={}):Promise<Outcome<Serviced>> {
  return job<Serviced>('service',Object.keys(opts).join(' '),async()=>{
    const who=pilot();
    const short:string[]=[];
    if(opts.insure)short.push('insure: not implemented yet; account().commands.spacemolt_salvage.quote/insure');
    if(opts.dues)short.push('dues: not implemented yet; account().commands.spacemolt.prepay_tax / pay_bounty');
    if(opts.fuel!==undefined||opts.hull!==undefined)short.push('partial targets: not implemented yet; a service is a full fill');
    const empty={base:{} as GetBaseResponse,issued:[],spent:0,short,cleared_tired:false};
    const at=await counter();
    if('refused' in at)return {status:'refused',did:'serviced nothing',why:at.refused,detail:empty};
    const docked=at.docked;
    let base:GetBaseResponse;
    try {base=details(await command('spacemolt/get_base',{})) as GetBaseResponse;}
    catch(error){return {status:'failed',did:`${docked} would not quote`,why:(error as Error).message,detail:empty};}
    try {
      // The quote above was a command, and a command is where Tired is imposed: the mood that
      // picks the spend margin is read here, not at the top of the job. Tired's row is "service
      // only" — the mood it replaced would refuse the very bill that clears it.
      const mood=pilot().mood??'Cautious';
      const done=await serviceShip(acct(),command,{mood,creditReserve:who.permissions?.credit_reserve??0,runtime:runtimeDir()});
      const cells=done.cells;
      const cleared=mood==='Tired'&&pilot().mood!=='Tired';
      const did=done.issued.length
        ?`serviced at ${docked}: ${done.issued.map(action=>action.split('/')[1]).join(' and ')} for ${done.spent} cr; fuel ${done.fuel}, hull ${done.hull}`
        :`already serviced at ${docked}: fuel ${done.fuel}, hull ${done.hull}`;
      const kept=cells?.target?`; fuel cells ${cells.held}/${cells.target}${cells.bought?` (bought ${cells.bought} for ${cells.spent} cr)`:''}${cells.skipped?`, none bought: ${cells.skipped.replace(/^fuel cells: /,'')}`:''}`:'';
      const detail={base,issued:done.issued,spent:done.spent+(cells?.spent??0),short:[...short,...done.short??[]],cleared_tired:cleared};
      if(done.short)return {status:'partial',did:did+kept,why:done.short.join('; '),detail,
        next:asNext(await serviceElsewhere(docked),acct().state.location?.system_id??'this system')};
      return {status:'done',did:did+kept,detail,next:cleared?['Tired cleared: the mood before it is back']:[]};
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

/** Tired's guarantee, kept by the runtime and not left to the script: bring the ship back inside
 * its margins. Docked, service here; otherwise (or when this counter could not clear it) fly to
 * each base `serviceElsewhere` names and service there, until one clears it. `travel:false`
 * services only where the ship stands — a stopped run does not fly off. Every attempt is
 * journalled as `resupply`. Away from a counter the fuel cells aboard are burned first
 * (`burnCells`), which may be all a fuel crossing needs.
 *
 * `cleared` when the ship is no longer Tired; `broke` when a counter was reached but the wallet
 * did not cover what clears it, so earning is the way out; `stranded` otherwise.
 *
 * ponytail: the bases are tried in `serviceElsewhere`'s order (this system first), not by route
 * cost, and a wallet refused here is still flown to the next counter. */
export async function resupply(opts:{travel?:boolean}={}):Promise<'cleared'|'broke'|'stranded'> {
  const tired=()=>pilot().mood==='Tired';
  await burnCells();
  if(!tired())return 'cleared';
  let broke=false;
  const runtime=runtimeDir(),tired_by=pilot().tired_by;
  const log=(entry:Record<string,unknown>)=>{if(runtime)journalRun(runtime,{tired_by,...entry},'resupply');};
  line(`tired (${tired_by}): the runtime is bringing the ship up`);
  const at=async(base:string)=>{
    const done=await service();
    log({base,status:done.status,spent:done.detail.spent,issued:done.detail.issued,cleared:!tired(),...done.why?{why:done.why}:{}});
    if(done.status==='refused'||done.status==='partial')broke=true;
    return !tired();
  };
  const docked=acct().state.location?.docked_at??undefined;
  if(docked&&await at(docked))return 'cleared';
  const failed=():'broke'|'stranded'=>{
    if(broke)return 'broke';
    // Its own event, beside the `resupply` lines: the one outcome that leaves the ship stuck.
    const {ship,location}=acct().state;
    if(runtime)journalRun(runtime,{tired_by,fuel:ship?.fuel??null,hull:ship?.hull??null,system:location?.system_id??null,
      poi:location?.poi_id??null,docked_at:location?.docked_at??null},'stranded');
    return 'stranded';
  };
  if(opts.travel===false) {
    log({cleared:false,why:'the run is stopping: no flight to another counter'});
    return failed();
  }
  for(const row of await serviceElsewhere(docked)) {
    if(stopped())break;
    const trip=await goTo(row.base);
    if(trip.status==='done'&&trip.detail.docked) {
      if(await at(row.base))return 'cleared';
    } else log({base:row.base,cleared:false,why:`did not reach it: ${trip.why??trip.did}`});
  }
  log({cleared:false,stranded:!broke,why:broke?'no counter reached had anything the wallet covers':'no base this runtime can name was reached and serviced'});
  line(`still tired (${pilot().tired_by}): ${broke?'the wallet covers nothing at the counters reached':'no base this runtime can name was reached and serviced'}`);
  return failed();
}
