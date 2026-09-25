/** More than one hull. One character flies one ship; the rest sit parked at stations, safe
 * from your death, and `switch_ship` at a shipyard swaps which one you fly. Several ships
 * flying at once is several characters: a freighter is one, flying a circuit on its own account
 * from this pilot's process (`assign`). */
import type {ListShipsResponse,MapSystemInfo,StoredShip,SwitchShipResponse,V2Ship} from '@spacemolt/lib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {details} from '../../response-details.ts';
import {closure,type Holding} from '../freighter/index.ts';
import {flying,gate,held,readFleet,recallLoop,row,script,scriptPath,start,writeFleet,type FreighterRow} from '../freighter/host.ts';
import {acct,command,job,runtimeDir} from '../runtime.ts';
import {buysOf,farBooks,hops,routes,type Circuit} from '../trading/trading.ts';
import type {Outcome} from '../types.ts';

/** Every ship you own and where it is parked (`ship/list_ships`), with the active one
 * marked and, for each parked hull, the base's shipyard service (needed to switch). Reads
 * only. `next` says which parked hull would suit the current stance. */
export function ships():Promise<Outcome<ListShipsResponse&{active:V2Ship;parked:(StoredShip&{base_id:string;shipyard:boolean})[]}>> {throw new Error('unimplemented');}

/** Swap to a hull parked at the station you are docked at. Needs a shipyard service here.
 * The hold moves to this base's store first (`stow`), modules stay on their own hulls, and
 * the new hull is serviced and insured before the
 * function returns. Refused undocked, without a shipyard, or when `minimum_crew` is unmet.
 * Costs the service; trains nothing. */
export function switchShip(shipId:string):Promise<Outcome<{switched:SwitchShipResponse;ship:V2Ship}>> {throw new Error('unimplemented');}

/** ponytail: the most credits a freighter may keep aboard to trade with; everything above its float
 * goes home at every stop. A cap on what one lost freighter can cost, not a measured number. Tunable. */
export const FLOAT_MAX=30_000;
const BUILD='use routes({circuit:{hold}})';

/** What of `holding` `circuit` never sells, and the hold it leaves the circuit to buy into; undefined
 * when the circuit sells all of it. Said, never refused: the cargo is the pilot's to clear. */
export function tiedUp(holding:Holding,circuit:Circuit):string|undefined {
  const unsold=Object.entries(holding).filter(([item])=>!circuit.stops.some(stop=>stop.sell.some(sale=>sale.item===item)));
  if(!unsold.length)return undefined;
  const k=unsold.reduce((sum,[,lot])=>sum+lot.quantity,0),free=circuit.hold-k;
  return `carrying ${unsold.map(([item,lot])=>`${lot.quantity} ${item}`).join(', ')} the circuit never sells; it fills ${k} of ${circuit.hold} hold, so `
    +(free>0?`the circuit buys into ${free} until it's sold`:"the circuit can't buy anything until the hold is cleared");
}

/** Hand `circuit` to the freighter `name`: another account, whose login the operator has put at
 * `freighters/<name>.txt` in this runtime, flies it lap after lap from this process, keeping
 * `caps.float` credits aboard and depositing the rest to you at every stop. Returns at once; the
 * freighter flies on. Refused unless the circuit is closed, of 2+ bases this pilot has read books
 * at, buys somewhere everything it sells, and every hop (the last back to the first too) is on the
 * map; refused over `FLOAT_MAX`, or while `name` is flying (recall it first). Cargo aboard the circuit
 * never sells is not refused: the `why` says how much of the hold it ties up. */
export function assign(name:string,circuit:Circuit,caps:{float:number}):Promise<Outcome<{freighter:FreighterRow|null}>> {
  return job<{freighter:FreighterRow|null}>('assign',name,async()=>{
    const refuse=(why:string)=>({status:'refused' as const,did:`assigned no freighter ${name}`,why,detail:{freighter:null}});
    const runtime=runtimeDir();
    if(!runtime)return refuse('this run has no runtime directory to keep a freighter in');
    if(!/^[a-z0-9_-]+$/.test(name))return refuse(`${JSON.stringify(name)}: a freighter's name is lower-case letters, digits, _ and -; it names its files`);
    const open=closure(circuit);
    if(open)return refuse(open);
    // Every base `routes()` may put on a circuit, and its system where a source kept one: a ledger
    // entry carries none, and `routes()` placed it with find_route, so the stop's own stands.
    const known=new Map<string,string|undefined>();
    for(const book of await farBooks('',0))if(!known.get(book.base_id))known.set(book.base_id,book.system_id);
    for(const stop of circuit.stops) {
      if(!known.has(stop.at))return refuse(`${stop.at}: no book for it remembered or on the faction ledger, so its system is unknown; ${BUILD}`);
      const system=known.get(stop.at);
      if(system&&system!==stop.system_id)return refuse(`${stop.at}: in ${system} by its book, not ${stop.system_id}; ${BUILD}`);
    }
    const links=new Map<string,string[]>();
    for(const system of (details(await command('spacemolt/get_map',{})) as {systems?:MapSystemInfo[]}).systems??[])
      links.set(system.system_id,system.connections??[]);
    const stranded=circuit.stops.find((stop,i)=>hops(links,stop.system_id,circuit.stops[(i+1)%circuit.stops.length]!.system_id)===null);
    if(stranded)return refuse(`no route on the map on from ${stranded.at} in ${stranded.system_id}: a freighter could not fly that hop; ${BUILD}`);
    if(!(Number.isFinite(caps?.float)&&caps.float>=0&&caps.float<=FLOAT_MAX))
      return refuse(`float ${caps?.float}: between 0 and ${FLOAT_MAX} credits`);
    if(flying(name))return refuse(`${name} is flying; recall('${name}') first, and assign it when it has parked`);
    const owner=acct().state.player?.username;
    if(!owner)return refuse('no username read for this pilot, so the profit has nowhere to go');
    // Only the fields a circuit has, so the script carries nothing else; a one-`buy` stop is written as `buys`.
    const {scope}=circuit;
    const clean:Circuit={closed:true,hold:circuit.hold,lap_jumps:circuit.lap_jumps,lap_net:circuit.lap_net,
      stops:circuit.stops.map(stop=>({at:stop.at,system_id:stop.system_id,buys:buysOf(stop).map(({item,qty,max_price})=>({item,qty,max_price})),
        sell:stop.sell.map(({item,min_price})=>({item,min_price}))})),
      ...scope?{scope:{maxStops:scope.maxStops,maxLegJumps:scope.maxLegJumps,maxJumps:scope.maxJumps}}:{}};
    const path=scriptPath(runtime,name);
    mkdirSync(dirname(path),{recursive:true});
    writeFileSync(path,script(clean));
    const errors=gate(path);
    if(errors.length)return refuse(errors.join('; '));
    const fleet=readFleet(runtime);
    // The cargo aboard stays aboard, and keeps what it cost.
    const holding=fleet[name]?.holding;
    fleet[name]={state:'running',circuit:clean,float:caps.float,owner,lap:0,returned:fleet[name]?.returned??0,
      ...holding?{holding}:{},at:new Date().toISOString()};
    writeFleet(runtime,fleet);
    const why=start(runtime,name),tied=holding&&tiedUp(holding,clean);
    if(why)return refuse(why);
    return {status:'done',did:`assigned ${name}: ${clean.stops.map(stop=>stop.at).join(' → ')} → back, ${clean.lap_net} cr a lap predicted; it flies on its own account now`,
      detail:{freighter:row(name,readFleet(runtime)[name]!)},next:['freighters()',`recall('${name}')`],...tied?{why:tied}:{}};
  });
}

/** Put the parked freighter `name` on a new circuit: `routes({circuit: {hold}})` for its hold,
 * within the scope its circuit was planned in (`circuit.scope`: maxStops, maxLegJumps, maxJumps),
 * which passes over the rings a freighter drained within `REST_TICKS`, then `assign` of the top
 * row at its float. Refused when no circuit pays, or wherever `routes` or `assign` refuse (not
 * docked; still flying). The cargo aboard rides into the new circuit at its cost; the `why` says
 * so when the new circuit does not sell it. */
export function reassign(name:string):Promise<Outcome<{freighter:FreighterRow|null}>> {
  return job<{freighter:FreighterRow|null}>('reassign',name,async()=>{
    const refuse=(why:string)=>({status:'refused' as const,did:`reassigned no freighter ${name}`,why,detail:{freighter:null}});
    const runtime=runtimeDir(),entry=runtime?readFleet(runtime)[name]:undefined;
    if(!entry)return refuse(`no freighter named ${name} is assigned`);
    const found=await routes({circuit:{hold:entry.circuit.hold},...entry.circuit.scope});
    const top=found.detail.routes?.[0]?.circuit;
    if(!top)return refuse(`no circuit for a ${entry.circuit.hold} hold: ${found.why??found.did}`);
    const out=await assign(name,top,{float:entry.float});
    if(out.status!=='done')return {status:out.status,did:out.did,why:out.why??'',detail:out.detail};
    return {status:'done',did:out.did,detail:out.detail,next:out.next??[],...out.why?{why:out.why}:{}};
  });
}

/** Ask the freighter `name` home: it finishes the stop it is on, buying nothing more, deposits its profit, and parks
 * docked there with its cargo aboard. */
export function recall(name:string):Promise<Outcome<{freighter:FreighterRow|null}>> {
  return job<{freighter:FreighterRow|null}>('recall',name,async()=>{
    const runtime=runtimeDir();
    const why=runtime?recallLoop(runtime,name):'this run has no runtime directory';
    if(why)return {status:'refused',did:`recalled no freighter ${name}`,why,detail:{freighter:null}};
    return {status:'done',did:`recalled ${name}: it parks after the stop it is on`,
      detail:{freighter:row(name,readFleet(runtime!)[name]!)},next:['freighters()']};
  });
}

/** Every freighter assigned from here: state, laps, the stop, its wallet, what it has sent home,
 * the last lap's net against the lap_net predicted, the cargo aboard at cost, and why it parked. Reads only. */
export function freighters():Promise<Outcome<{freighters:FreighterRow[]}>> {
  return job<{freighters:FreighterRow[]}>('freighters','',async()=>{
    const runtime=runtimeDir();
    const rows=runtime?Object.entries(readFleet(runtime)).map(([name,entry])=>row(name,entry)):[];
    return {status:'done',did:rows.length?rows.map(r=>`${r.name} ${r.state} lap ${r.lap}${r.stop?` at ${r.stop}`:''}, returned ${r.returned} cr`
      +(r.last_lap_net===null?'':`, last lap ${r.last_lap_net} of ${r.lap_net} predicted`)+(held(r.holding)?`, holding ${held(r.holding)}`:'')
      +(r.why?` (${r.why})`:'')).join('; '):'no freighters assigned',
      detail:{freighters:rows},next:rows.length?[]:['routes({circuit: {hold: 50}}), then assign the top row']};
  });
}
