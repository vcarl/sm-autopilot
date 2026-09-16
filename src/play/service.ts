/** The service counter: fuel and hull. Insurance and dues wait for a later slice. */
import type {GetBaseResponse} from '@spacemolt/lib';
import {details} from '../response-details.ts';
import {ServiceBlocked,serviceShip} from '../servicing.ts';
import {acct,command,job,pilot} from './runtime.ts';
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
      const done=await serviceShip(acct(),command,{mood:who.mood??'Cautious',creditReserve:who.permissions?.credit_reserve??0});
      const cleared=who.mood==='Tired'&&pilot().mood!=='Tired';
      const did=done.issued.length
        ?`serviced at ${docked}: ${done.issued.map(action=>action.split('/')[1]).join(' and ')} for ${done.spent} cr; fuel ${done.fuel}, hull ${done.hull}`
        :`already serviced at ${docked}: fuel ${done.fuel}, hull ${done.hull}`;
      return {status:'done',did,detail:{base,issued:done.issued,spent:done.spent,short,cleared_tired:cleared},
        next:cleared?['Tired cleared: the mood before it is back']:[]};
    } catch(error) {
      if(error instanceof ServiceBlocked)
        return {status:'refused',did:`not serviced at ${docked}`,why:error.blockers.join('; '),
          detail:{base,issued:[],spent:0,short:[...short,...error.blockers],cleared_tired:false},
          next:['a calmer bill, a bolder mood, or another station admits it']};
      throw error;
    }
  });
}
