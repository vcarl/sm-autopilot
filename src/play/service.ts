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

/** Where else the pilot could be brought up, for a refusal's `next`. A Tired pilot may only
 * `goTo` a base and only a service clears Tired, so a station that cannot quote what is
 * missing strands it: the route to a base that can is the useful line, not a flat reserve.
 *
 * Reads only, and every read may fail — no advice beats a made-up one.
 *
 * ponytail: the honest reach is this system, plus the bases the journal has actually docked
 * at. In `@spacemolt/lib` 14.2.0 `get_system()`, `get_poi()` and `get_base()` all take no id
 * (COMMANDS.md lines 61, 73, 79): they answer for where the ship is, so no far station's
 * repair price is readable from here, and even a base in THIS system publishes only
 * `fuel_price` on its POI row (`SystemPoi`), never a repair price. So the lines below name
 * where to go and price the trip with `find_route`, and say plainly what they cannot know.
 * Widen it when a read lists a far system's service counters — the same reach limit
 * `systemBases` in travel.ts lives with. */
export async function serviceElsewhere(docked:string):Promise<string[]> {
  const trip=async(id:string):Promise<string>=>{
    try {
      const quote=details(await command('spacemolt/find_route',{id}));
      return quote.found?`${quote.estimated_fuel} fuel, ${quote.total_jumps} jump(s)`:'no route from here';
    } catch {return 'no route quote';}
  };
  let pois:SystemPoi[]=[];
  try {pois=(details(await command('spacemolt/get_system',{})).system?.pois??[]) as SystemPoi[];} catch {/* no listing is no advice */}
  const system=acct().state.location?.system_id??'this system';
  const lines:string[]=[];
  for(const row of pois.filter(poi=>poi.base_id&&poi.base_id!==docked).slice(0,3))
    lines.push(`goTo('${row.base_id}') — ${row.base_name??row.base_id} in ${system}: ${await trip(row.base_id!)}`
      +(Number.isFinite(row.fuel_price)?`, refuel ${row.fuel_price} cr/unit posted`:'')
      +'; price unknown until docked');
  if(lines.length)return lines;
  // Nothing else in this system. A base the pilot has stood at is the only far one it can
  // name at all, so it is named as what it is: seen, with nothing known about its counters.
  const runtime=runtimeDir(),seen=new Set<string>();
  for(const entry of runtime?readJournal(runtime,6_000):[]) {
    const result=entry.response?.result;
    const dock=result?.docked_at?.base_id??result?.location?.docked_at??result?.docked_at;
    if(typeof dock==='string'&&dock&&dock!==docked)seen.add(dock);
  }
  for(const base of [...seen].slice(-3))
    lines.push(`goTo('${base}') — a base this pilot has docked at before: ${await trip(base)}; what it services is unread`);
  return lines.length?lines
    :[`no other base in ${system}, and none in the journal: no station's service counter can be read from where you are`];
}

/** Bring the ship up at the counter you are docked at: full tank and full hull.
 *
 * Over `refuel` + `repair` it adds: the quote read first, the mood's per-service spend margin
 * and `permissions.credit_reserve` enforced, the charge checked against the quote, and the
 * post-state read to confirm the fill. A full ship sends nothing. Not docked: `refused`.
 *
 * Tired: resupplying back inside the margins is what clears it; the runtime restores the
 * mood Tired replaced and `cleared_tired` says so. `insure` and `dues` are accepted and
 * reported in `short` until a later slice implements them. */
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
      const did=done.issued.length
        ?`serviced at ${docked}: ${done.issued.map(action=>action.split('/')[1]).join(' and ')} for ${done.spent} cr; fuel ${done.fuel}, hull ${done.hull}`
        :`already serviced at ${docked}: fuel ${done.fuel}, hull ${done.hull}`;
      return {status:'done',did,detail:{base,issued:done.issued,spent:done.spent,short,cleared_tired:cleared},
        next:cleared?['Tired cleared: the mood before it is back']:[]};
    } catch(error) {
      if(error instanceof ServiceBlocked)
        return {status:'refused',did:`not serviced at ${docked}`,why:error.blockers.join('; '),
          detail:{base,issued:[],spent:0,short:[...short,...error.blockers],cleared_tired:false},
          next:[...await serviceElsewhere(docked),'a calmer bill, a bolder mood, or another station admits it']};
      throw error;
    }
  });
}
